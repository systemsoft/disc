/**
 * Tests for schema introspection REST endpoint and schema:: built-in functions
 *
 * Covers:
 *   - GET /schema: full schema description
 *   - GET /schema/types: all type descriptions
 *   - GET /schema/types/:name: single type description
 *   - schema::types(), schema::get_type(), schema::functions() built-in functions
 */

import { assertEquals } from "@std/assert";
import { createTestSchema } from "../compiler/context.ts";
import type { Schema, TypeDef } from "../compiler/context.ts";
import { getBuiltinFunctions } from "../compiler/builtin-functions.ts";
import { handleGetSchema, handleGetSchemaType, handleGetSchemaTypes } from "./schema-endpoint.ts";
import type { SchemaRouteContext } from "./schema-endpoint.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { SQLCodeGenerator } from "../compiler/codegen.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const schema = createTestSchema();

function makeCtx(s: Schema = schema): SchemaRouteContext {
  return {
    schemaProvider: () => s,
    defaultHeaders: () => new Headers({ "Content-Type": "application/json" }),
  };
}

function compileEdgeQL(edgeql: string, s: Schema = schema): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(s, { enableAccessControl: false });
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value);
}

// =========================================================================
// GET /schema
// =========================================================================

Deno.test("GET /schema - returns full schema with types and functions", async () => {
  const ctx = makeCtx();
  const response = handleGetSchema(ctx);

  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());

  assertEquals(Array.isArray(body.types), true);
  assertEquals(Array.isArray(body.functions), true);
  assertEquals(Array.isArray(body.modules), true);
  assertEquals(body.types.length >= 3, true); // User, Post, Status
  assertEquals(body.functions.length > 0, true);
});

Deno.test("GET /schema - returns JSON content-type", () => {
  const ctx = makeCtx();
  const response = handleGetSchema(ctx);

  assertEquals(response.headers.get("Content-Type"), "application/json");
});

Deno.test("GET /schema - returns empty schema when no types defined", async () => {
  const emptySchema: Schema = {
    types: new Map(),
    functions: new Map(),
  };
  const ctx = makeCtx(emptySchema);
  const response = handleGetSchema(ctx);

  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());

  assertEquals(body.types.length, 0);
  assertEquals(body.functions.length, 0);
  assertEquals(body.modules.length, 0);
});

// =========================================================================
// GET /schema/types
// =========================================================================

Deno.test("GET /schema/types - returns all types as array", async () => {
  const ctx = makeCtx();
  const url = new URL("http://localhost/schema/types");
  const response = handleGetSchemaTypes(ctx, url);

  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());

  assertEquals(Array.isArray(body), true);
  assertEquals(body.length >= 3, true);
});

Deno.test("GET /schema/types - each type has name and properties", async () => {
  const ctx = makeCtx();
  const url = new URL("http://localhost/schema/types");
  const response = handleGetSchemaTypes(ctx, url);

  const body = JSON.parse(await response.text());
  const userType = body.find((t: any) => t.name === "User");

  assertEquals(userType !== undefined, true);
  assertEquals(typeof userType.name, "string");
  assertEquals(Array.isArray(userType.properties), true);
  assertEquals(userType.properties.length > 0, true);
});

Deno.test("GET /schema/types - filtered by module query param", async () => {
  // Create a schema with types in different modules
  const otherType: TypeDef = {
    name: "other::Widget",
    kind: "object",
    tableName: "widgets",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
      }],
    ]),
    links: new Map(),
  };

  const multiModuleSchema: Schema = {
    types: new Map([
      ...schema.types.entries(),
      ["other::Widget", otherType],
    ]),
    functions: schema.functions,
  };

  const ctx = makeCtx(multiModuleSchema);
  const url = new URL("http://localhost/schema/types?module=other");
  const response = handleGetSchemaTypes(ctx, url);

  const body = JSON.parse(await response.text());
  assertEquals(body.length, 1);
  assertEquals(body[0].name, "other::Widget");
});

// =========================================================================
// GET /schema/types/:name
// =========================================================================

Deno.test("GET /schema/types/:name - returns type description for valid name", async () => {
  const ctx = makeCtx();
  const response = handleGetSchemaType(ctx, "User");

  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());

  assertEquals(body.name, "User");
  assertEquals(body.module, "default");
  assertEquals(Array.isArray(body.properties), true);
  assertEquals(Array.isArray(body.links), true);
});

Deno.test("GET /schema/types/:name - returns 404 for unknown type", async () => {
  const ctx = makeCtx();
  const response = handleGetSchemaType(ctx, "UnknownType");

  assertEquals(response.status, 404);
  const body = JSON.parse(await response.text());
  assertEquals(typeof body.error, "string");
  assertEquals(body.error.includes("not found"), true);
});

Deno.test("GET /schema/types/:name - includes properties, links, constraints", async () => {
  const ctx = makeCtx();
  const response = handleGetSchemaType(ctx, "User");

  const body = JSON.parse(await response.text());

  // Check properties
  const emailProp = body.properties.find((p: any) => p.name === "email");
  assertEquals(emailProp !== undefined, true);
  assertEquals(emailProp.required, true);
  assertEquals(emailProp.constraints.includes("exclusive"), true);

  // Check links
  const postsLink = body.links.find((l: any) => l.name === "posts");
  assertEquals(postsLink !== undefined, true);
  assertEquals(postsLink.target, "Post");
  assertEquals(postsLink.cardinality, "multi");
});

Deno.test("GET /schema/types/:name - handles qualified names (default::User)", async () => {
  // Add User under its qualified name
  const qualifiedSchema: Schema = {
    types: new Map([
      ["default::User", {
        name: "default::User",
        kind: "object" as const,
        tableName: "users",
        properties: new Map([
          ["id", {
            name: "id",
            type: "uuid",
            required: true,
            multi: false,
            columnName: "id",
          }],
        ]),
        links: new Map(),
      }],
    ]),
    functions: new Map(),
  };

  const ctx = makeCtx(qualifiedSchema);
  const response = handleGetSchemaType(ctx, "default::User");

  assertEquals(response.status, 200);
  const body = JSON.parse(await response.text());
  assertEquals(body.name, "default::User");
  assertEquals(body.module, "default");
});

// =========================================================================
// schema:: built-in functions
// =========================================================================

Deno.test("schema::types() - returns type name array", () => {
  const sql = compileEdgeQL("select schema::types()");
  assertEquals(sql.includes("SELECT"), true);
  assertEquals(sql.includes("::jsonb"), true);

  // Extract JSON and verify it's an array of type names
  const match = sql.match(/'(.+)'::jsonb/s);
  assertEquals(match !== null, true);
  const json = JSON.parse(match![1].replace(/''/g, "'"));
  assertEquals(Array.isArray(json), true);
  assertEquals(json.includes("User"), true);
  assertEquals(json.includes("Post"), true);
  assertEquals(json.includes("Status"), true);
});

Deno.test("schema::get_type('User') - returns type description", () => {
  const sql = compileEdgeQL('select schema::get_type("User")');
  assertEquals(sql.includes("SELECT"), true);
  assertEquals(sql.includes("::jsonb"), true);

  const match = sql.match(/'(.+)'::jsonb/s);
  assertEquals(match !== null, true);
  const json = JSON.parse(match![1].replace(/''/g, "'"));
  assertEquals(json.name, "User");
  assertEquals(Array.isArray(json.properties), true);
  assertEquals(Array.isArray(json.links), true);
});

Deno.test("schema::get_type('Unknown') - returns compilation error", () => {
  const parser = new EdgeQLParser('select schema::get_type("Unknown")');
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("not found"), true);
  }
});

Deno.test("schema::functions() - returns function name array", () => {
  const sql = compileEdgeQL("select schema::functions()");
  assertEquals(sql.includes("SELECT"), true);
  assertEquals(sql.includes("::jsonb"), true);

  const match = sql.match(/'(.+)'::jsonb/s);
  assertEquals(match !== null, true);
  const json = JSON.parse(match![1].replace(/''/g, "'"));
  assertEquals(Array.isArray(json), true);
  assertEquals(json.includes("count"), true);
  assertEquals(json.includes("len"), true);
});

Deno.test("schema:: functions are registered in builtin registry", () => {
  const builtins = getBuiltinFunctions();

  const typesFunc = builtins.get("schema::types");
  assertEquals(typesFunc !== undefined, true);
  assertEquals(typesFunc!.introspection, true);
  assertEquals(typesFunc!.returnType, "json");

  const getTypeFunc = builtins.get("schema::get_type");
  assertEquals(getTypeFunc !== undefined, true);
  assertEquals(getTypeFunc!.introspection, true);
  assertEquals(getTypeFunc!.args.length, 1);

  const functionsFunc = builtins.get("schema::functions");
  assertEquals(functionsFunc !== undefined, true);
  assertEquals(functionsFunc!.introspection, true);
});

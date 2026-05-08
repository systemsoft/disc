/**
 * Tests for DESCRIBE TYPE and DESCRIBE SCHEMA
 *
 * Covers:
 *   - describeType: basic type, properties, links, constraints, unknown type,
 *     abstract type, type with parent
 *   - describeSchema: all types listed, modules extracted, functions included
 *   - Parser: DESCRIBE TYPE / DESCRIBE SCHEMA parsing
 *   - Compiler: DescribeType and DescribeSchema compile to SELECT jsonb
 */

import { assertEquals, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema } from "./context.ts";
import type { Schema, TypeDef } from "./context.ts";
import { describeSchema, describeType } from "./introspection.ts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const schema = createTestSchema();

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
// describeType unit tests
// =========================================================================

Deno.test("describeType - basic object type returns correct name and module", () => {
  const desc = describeType(schema, "User");
  assertEquals(desc.name, "User");
  assertEquals(desc.module, "default");
  assertEquals(desc.abstract, false);
  assertEquals(desc.parentTypes, []);
});

Deno.test("describeType - properties are listed with correct metadata", () => {
  const desc = describeType(schema, "User");

  const emailProp = desc.properties.find(p => p.name === "email");
  assertEquals(emailProp !== undefined, true);
  assertEquals(emailProp!.type, "str");
  assertEquals(emailProp!.required, true);
  assertEquals(emailProp!.constraints.length > 0, true);
  assertEquals(emailProp!.constraints.includes("exclusive"), true);

  const createdAtProp = desc.properties.find(p => p.name === "createdAt");
  assertEquals(createdAtProp !== undefined, true);
  assertEquals(createdAtProp!.readonly, true);
  assertEquals(createdAtProp!.hasDefault, true);
});

Deno.test("describeType - computed property is flagged", () => {
  const desc = describeType(schema, "User");
  const postCountProp = desc.properties.find(p => p.name === "postCount");
  assertEquals(postCountProp !== undefined, true);
  assertEquals(postCountProp!.computed, true);
});

Deno.test("describeType - links are listed with correct metadata", () => {
  const desc = describeType(schema, "User");

  const postsLink = desc.links.find(l => l.name === "posts");
  assertEquals(postsLink !== undefined, true);
  assertEquals(postsLink!.target, "Post");
  assertEquals(postsLink!.cardinality, "multi");
  assertEquals(postsLink!.required, false);
});

Deno.test("describeType - single link shows correct cardinality", () => {
  const desc = describeType(schema, "Post");

  const authorLink = desc.links.find(l => l.name === "author");
  assertEquals(authorLink !== undefined, true);
  assertEquals(authorLink!.target, "User");
  assertEquals(authorLink!.cardinality, "single");
  assertEquals(authorLink!.required, true);
});

Deno.test("describeType - constraints include args", () => {
  const desc = describeType(schema, "User");
  const nameProp = desc.properties.find(p => p.name === "name");
  assertEquals(nameProp !== undefined, true);
  const maxLenConstraint = nameProp!.constraints.find(c => c.startsWith("max_length"));
  assertEquals(maxLenConstraint !== undefined, true);
  assertEquals(maxLenConstraint!.includes("255"), true);
});

Deno.test("describeType - unknown type throws CompilationError", () => {
  assertThrows(
    () => describeType(schema, "NonExistentType"),
    Error,
    "not found"
  );
});

Deno.test("describeType - abstract type is flagged", () => {
  // Build a schema with an abstract type
  const abstractType: TypeDef = {
    name: "Shape",
    kind: "object",
    tableName: "shapes",
    abstract: true,
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id"
      }]
    ]),
    links: new Map()
  };

  const testSchema: Schema = {
    types: new Map([["Shape", abstractType]]),
    functions: new Map()
  };

  const desc = describeType(testSchema, "Shape");
  assertEquals(desc.abstract, true);
});

Deno.test("describeType - type with parent reports parentTypes", () => {
  const parentType: TypeDef = {
    name: "Shape",
    kind: "object",
    tableName: "shapes",
    abstract: true,
    properties: new Map(),
    links: new Map(),
    subtypes: ["Circle"]
  };

  const childType: TypeDef = {
    name: "Circle",
    kind: "object",
    tableName: "shapes",
    parentTypes: ["Shape"],
    properties: new Map([
      ["radius", {
        name: "radius",
        type: "float64",
        required: true,
        multi: false,
        columnName: "radius",
        edgeqlType: "float64"
      }]
    ]),
    links: new Map()
  };

  const testSchema: Schema = {
    types: new Map([["Shape", parentType], ["Circle", childType]]),
    functions: new Map()
  };

  const desc = describeType(testSchema, "Circle");
  assertEquals(desc.parentTypes, ["Shape"]);
});

// =========================================================================
// describeSchema unit tests
// =========================================================================

Deno.test("describeSchema - all types are listed", () => {
  const desc = describeSchema(schema);
  const typeNames = desc.types.map(t => t.name);

  assertEquals(typeNames.includes("User"), true);
  assertEquals(typeNames.includes("Post"), true);
  assertEquals(typeNames.includes("Status"), true);
});

Deno.test("describeSchema - modules are extracted", () => {
  const desc = describeSchema(schema);
  assertEquals(desc.modules.includes("default"), true);
});

Deno.test("describeSchema - functions are included", () => {
  const desc = describeSchema(schema);
  assertEquals(desc.functions.length > 0, true);

  // Check that some builtin functions appear
  const funcNames = desc.functions.map(f => f.name);
  assertEquals(funcNames.includes("count"), true);
});

Deno.test("describeSchema - functions have params and returnType", () => {
  const desc = describeSchema(schema);
  const countFn = desc.functions.find(f => f.name === "count");
  assertEquals(countFn !== undefined, true);
  assertEquals(typeof countFn!.returnType, "string");
});

// =========================================================================
// Parser tests
// =========================================================================

Deno.test("Parser - DESCRIBE TYPE parses correctly", () => {
  const parser = new EdgeQLParser("DESCRIBE TYPE User");
  const ast = parser.parse();
  assertEquals(ast.kind, "DescribeType");
  if (ast.kind === "DescribeType") {
    assertEquals(ast.typeName, "User");
  }
});

Deno.test("Parser - DESCRIBE TYPE with qualified name parses correctly", () => {
  const parser = new EdgeQLParser("DESCRIBE TYPE default::User");
  const ast = parser.parse();
  assertEquals(ast.kind, "DescribeType");
  if (ast.kind === "DescribeType") {
    assertEquals(ast.typeName, "default::User");
  }
});

Deno.test("Parser - DESCRIBE SCHEMA parses correctly", () => {
  const parser = new EdgeQLParser("DESCRIBE SCHEMA");
  const ast = parser.parse();
  assertEquals(ast.kind, "DescribeSchema");
});

Deno.test("Parser - DESCRIBE TYPE with semicolon parses correctly", () => {
  const parser = new EdgeQLParser("DESCRIBE TYPE Post;");
  const ast = parser.parse();
  assertEquals(ast.kind, "DescribeType");
  if (ast.kind === "DescribeType") {
    assertEquals(ast.typeName, "Post");
  }
});

Deno.test("Parser - invalid DESCRIBE target throws error", () => {
  const parser = new EdgeQLParser("DESCRIBE FUNCTION foo");
  try {
    parser.parse();
    throw new Error("Expected parse error");
  } catch (e) {
    assertEquals(
      (e as Error).message.includes("TYPE") ||
        (e as Error).message.includes("SCHEMA"),
      true
    );
  }
});

// =========================================================================
// Compiler tests
// =========================================================================

Deno.test("Compiler - DescribeType compiles to SELECT jsonb", () => {
  const sql = compileEdgeQL("DESCRIBE TYPE User");
  assertEquals(sql.includes("SELECT"), true);
  assertEquals(sql.includes("::jsonb"), true);
  assertEquals(sql.includes("\"User\"") || sql.includes("User"), true);
});

Deno.test("Compiler - DescribeType result contains expected fields", () => {
  const sql = compileEdgeQL("DESCRIBE TYPE User");

  // Extract the JSON from the SQL
  const match = sql.match(/'(.+)'::jsonb/s);
  assertEquals(match !== null, true);
  const json = JSON.parse(match![1].replace(/''/g, "'"));

  assertEquals(json.name, "User");
  assertEquals(json.module, "default");
  assertEquals(Array.isArray(json.properties), true);
  assertEquals(Array.isArray(json.links), true);

  // Check specific properties exist
  const propNames = json.properties.map((p: { name: string; }) => p.name);
  assertEquals(propNames.includes("email"), true);
  assertEquals(propNames.includes("name"), true);
});

Deno.test("Compiler - DescribeSchema compiles to SELECT jsonb", () => {
  const sql = compileEdgeQL("DESCRIBE SCHEMA");
  assertEquals(sql.includes("SELECT"), true);
  assertEquals(sql.includes("::jsonb"), true);
});

Deno.test("Compiler - DescribeSchema result contains types and functions", () => {
  const sql = compileEdgeQL("DESCRIBE SCHEMA");

  const match = sql.match(/'(.+)'::jsonb/s);
  assertEquals(match !== null, true);
  const json = JSON.parse(match![1].replace(/''/g, "'"));

  assertEquals(Array.isArray(json.modules), true);
  assertEquals(Array.isArray(json.types), true);
  assertEquals(Array.isArray(json.functions), true);
  assertEquals(json.types.length >= 3, true); // User, Post, Status
});

Deno.test("Compiler - DescribeType for unknown type returns error", () => {
  const parser = new EdgeQLParser("DESCRIBE TYPE Ghost");
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.includes("not found"), true);
  }
});

Deno.test("Compiler - DescribeType includes properties and links in JSON", () => {
  const sql = compileEdgeQL("DESCRIBE TYPE Post");

  const match = sql.match(/'(.+)'::jsonb/s);
  assertEquals(match !== null, true);
  const json = JSON.parse(match![1].replace(/''/g, "'"));

  assertEquals(json.name, "Post");

  // Check properties
  const propNames = json.properties.map((p: { name: string; }) => p.name);
  assertEquals(propNames.includes("title"), true);
  assertEquals(propNames.includes("body"), true);

  // Check links
  const linkNames = json.links.map((l: { name: string; }) => l.name);
  assertEquals(linkNames.includes("author"), true);
  assertEquals(
    json.links.find((l: { name: string; }) => l.name === "author").target,
    "User"
  );
});

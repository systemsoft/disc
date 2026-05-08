// deno-lint-ignore-file no-console
/**
 * Simple test for basic SELECT compilation
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import * as Context from "./context.ts";

// Create a minimal schema for testing
function createTestSchema(): Context.Schema {
  const types = new Map<string, Context.TypeDef>();

  // Add a simple User type
  types.set("User", {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id"
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name"
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email"
      }],
      ["active", {
        name: "active",
        type: "bool",
        required: false,
        multi: false,
        columnName: "active"
      }]
    ]),
    links: new Map([
      ["posts", {
        name: "posts",
        target: "Post",
        required: false,
        multi: true,
        backlink: "author"
      }]
    ])
  });

  // Add a simple Post type
  types.set("Post", {
    name: "Post",
    kind: "object",
    tableName: "posts",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id"
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title"
      }],
      ["body", {
        name: "body",
        type: "str",
        required: true,
        multi: false,
        columnName: "body"
      }],
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: true,
        multi: false,
        columnName: "createdAt"
      }]
    ]),
    links: new Map([
      ["author", {
        name: "author",
        target: "User",
        required: true,
        multi: false,
        columnName: "author_id",
        backlink: "posts"
      }]
    ])
  });

  const functions = new Map<string, Context.FunctionDef>();

  // Add count function
  functions.set("count", {
    name: "count",
    args: [{ name: "set", type: "any", required: false }],
    returnType: "int64",
    sqlName: "count"
  });

  return { types, functions };
}

Deno.test("Simple SELECT - Basic query", () => {
  const edgeql = "SELECT User";

  // Parse
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  // Compile with schema
  const schema = createTestSchema();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  // Generate SQL
  const generator = new SQLCodeGenerator();
  const sql = generator.generate(result.value);

  console.log("Generated SQL:", sql);

  // The basic SELECT should generate a SELECT * FROM the table
  assertEquals(sql.includes("SELECT"), true);
  assertEquals(sql.includes("FROM"), true);
  assertEquals(sql.includes("users"), true); // Should use the table name
});

Deno.test("Simple SELECT - With filter", () => {
  const edgeql = "SELECT User FILTER .name = \"Ada\"";

  // Parse
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  // Compile with schema
  const schema = createTestSchema();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  // Generate SQL
  const generator = new SQLCodeGenerator();
  const sql = generator.generate(result.value);

  console.log("Generated SQL with filter:", sql);

  // Should have a WHERE clause
  assertEquals(sql.includes("WHERE"), true);
  assertEquals(sql.includes("name"), true);
  assertEquals(sql.includes("Ada"), true);
});

Deno.test("Simple SELECT - With shape", () => {
  const edgeql = "SELECT User { name, email }";

  // Parse
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  // Compile with schema
  const schema = createTestSchema();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  // Generate SQL
  const generator = new SQLCodeGenerator();
  const sql = generator.generate(result.value);

  console.log("Generated SQL with shape:", sql);

  // Should select specific columns
  assertEquals(sql.includes("name"), true);
  assertEquals(sql.includes("email"), true);
  // Should use JSON building for shapes
  assertEquals(
    sql.includes("jsonb_build_object") || sql.includes("json_build_object"),
    true
  );
});

Deno.test("Simple SELECT - With ORDER BY", () => {
  const edgeql = "SELECT User ORDER BY .name";

  // Parse
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  // Compile with schema
  const schema = createTestSchema();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  // Generate SQL
  const generator = new SQLCodeGenerator();
  const sql = generator.generate(result.value);

  console.log("Generated SQL with ORDER BY:", sql);

  // Should have ORDER BY clause
  assertEquals(sql.includes("ORDER BY"), true);
  assertEquals(sql.includes("name"), true);
});

Deno.test("Simple SELECT - With LIMIT", () => {
  const edgeql = "SELECT User LIMIT 10";

  // Parse
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();

  // Compile with schema
  const schema = createTestSchema();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  // Generate SQL
  const generator = new SQLCodeGenerator();
  const sql = generator.generate(result.value);

  console.log("Generated SQL with LIMIT:", sql);

  // Should have LIMIT clause
  assertEquals(sql.includes("LIMIT"), true);
  assertEquals(sql.includes("10"), true);
});

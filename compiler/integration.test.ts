/**
 * Integration tests for EdgeQL to SQL compilation
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import * as Context from "./context.ts";

function createTestSchema(): Context.Schema {
  const types = new Map<string, Context.TypeDef>();
  types.set("User", {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id" }],
      ["name", { name: "name", type: "str", required: true, multi: false, columnName: "name" }],
      ["email", { name: "email", type: "str", required: true, multi: false, columnName: "email" }],
      ["first_name", { name: "first_name", type: "str", required: false, multi: false, columnName: "first_name" }],
      ["last_name", { name: "last_name", type: "str", required: false, multi: false, columnName: "last_name" }],
      ["active", { name: "active", type: "bool", required: false, multi: false, columnName: "active" }],
      ["role", { name: "role", type: "str", required: false, multi: false, columnName: "role" }],
    ]),
    links: new Map([
      ["posts", { name: "posts", target: "Post", multi: true, required: false }],
    ]),
  });
  types.set("Post", {
    name: "Post",
    kind: "object",
    tableName: "posts",
    properties: new Map([
      ["id", { name: "id", type: "uuid", required: true, multi: false, columnName: "id" }],
      ["title", { name: "title", type: "str", required: true, multi: false, columnName: "title" }],
      ["created_at", { name: "created_at", type: "datetime", required: false, multi: false, columnName: "created_at" }],
    ]),
    links: new Map([
      ["author", { name: "author", target: "User", multi: false, columnName: "author_id", required: true }],
    ]),
  });

  const functions = new Map<string, Context.FunctionDef>();
  functions.set("count", {
    name: "count",
    args: [{ name: "set", type: "any", required: false }],
    returnType: "int64",
    sqlName: "count",
  });

  return { types, functions };
}

/**
 * Helper function to compile EdgeQL to SQL
 */
function compileToSQL(edgeql: string): string {
  try {
    // Parse EdgeQL
    const parser = new EdgeQLParser(edgeql);
    const ast = parser.parse();

    // Compile to SQL AST
    const compiler = new EdgeQLCompiler(createTestSchema());
    const compileResult = compiler.compile(ast);
    
    if (!compileResult.ok) {
      throw new Error(`Compile error: ${compileResult.error.message}`);
    }
    
    // Generate SQL string
    const generator = new SQLCodeGenerator();
    return generator.generate(compileResult.value);
  } catch (error) {
    throw new Error(`Compilation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

Deno.test("EdgeQL to SQL - Simple SELECT", () => {
  const edgeql = `SELECT User`;
  const sql = compileToSQL(edgeql);
  
  // Should generate a basic SELECT * from users table
  assertEquals(
    sql,
    `SELECT * FROM "User"`
  );
});

Deno.test("EdgeQL to SQL - SELECT with specific fields", () => {
  const edgeql = `SELECT User { name, email }`;
  const sql = compileToSQL(edgeql);
  
  // Should select specific fields as JSON
  assertEquals(
    sql,
    `SELECT jsonb_build_object('name', "User"."name", 'email', "User"."email") FROM "User"`
  );
});

Deno.test("EdgeQL to SQL - SELECT with filter", () => {
  const edgeql = `SELECT User FILTER .email = "test@example.com"`;
  const sql = compileToSQL(edgeql);
  
  assertEquals(
    sql,
    `SELECT * FROM "User" WHERE ("User"."email" = 'test@example.com')`
  );
});

Deno.test("EdgeQL to SQL - SELECT with ORDER BY and LIMIT", () => {
  const edgeql = `SELECT User ORDER BY .name LIMIT 10`;
  const sql = compileToSQL(edgeql);
  
  assertEquals(
    sql,
    `SELECT * FROM "User" ORDER BY "User"."name" ASC LIMIT 10`
  );
});

Deno.test("EdgeQL to SQL - SELECT with nested shape", () => {
  const edgeql = `
    SELECT User {
      name,
      posts: {
        title,
        created_at
      }
    }
  `;
  const sql = compileToSQL(edgeql);
  
  // Should generate a subquery for the nested relationship
  const expected = `SELECT jsonb_build_object('name', "User"."name", 'posts', (SELECT jsonb_agg(jsonb_build_object('title', "posts"."title", 'created_at', "posts"."created_at")) FROM "posts" WHERE "posts"."author_id" = "User"."id")) FROM "User"`;
  
  assertEquals(sql, expected);
});

Deno.test("EdgeQL to SQL - Complex filter with AND", () => {
  const edgeql = `
    SELECT User 
    FILTER .email = "admin@example.com" AND .active = true
  `;
  const sql = compileToSQL(edgeql);
  
  assertEquals(
    sql,
    `SELECT * FROM "User" WHERE (("User"."email" = 'admin@example.com') AND ("User"."active" = true))`
  );
});

Deno.test("EdgeQL to SQL - SELECT with computed field", () => {
  const edgeql = `
    SELECT User {
      name,
      full_name := .first_name ++ " " ++ .last_name
    }
  `;
  const sql = compileToSQL(edgeql);
  
  const expected = `SELECT jsonb_build_object('name', "User"."name", 'full_name', (("User"."first_name" || ' ') || "User"."last_name")) FROM "User"`;
  
  assertEquals(sql, expected);
});

Deno.test("EdgeQL to SQL - SELECT with function call", () => {
  const edgeql = `SELECT count(User)`;
  const sql = compileToSQL(edgeql);
  
  assertEquals(
    sql,
    `SELECT count(*) FROM "User"`
  );
});

Deno.test("EdgeQL to SQL - SELECT with DISTINCT", () => {
  const edgeql = `SELECT DISTINCT User.email`;
  const sql = compileToSQL(edgeql);
  
  assertEquals(
    sql,
    `SELECT DISTINCT "User"."email" FROM "User"`
  );
});

Deno.test("EdgeQL to SQL - SELECT with IN filter", () => {
  const edgeql = `
    SELECT User 
    FILTER .role IN {"admin", "moderator"}
  `;
  const sql = compileToSQL(edgeql);
  
  assertEquals(
    sql,
    `SELECT * FROM "User" WHERE ("User"."role" IN ('admin', 'moderator'))`
  );
});
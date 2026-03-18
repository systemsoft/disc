/**
 * Integration tests for EdgeQL to SQL compilation
 */

import { assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import * as Context from "./context.ts";

/** Normalize SQL whitespace for comparison: collapse newlines and multi-spaces to single space, trim */
function normalizeSQL(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function createTestSchema(): Context.Schema {
  const types = new Map<string, Context.TypeDef>();
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
        columnName: "id",
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
      }],
      ["first_name", {
        name: "first_name",
        type: "str",
        required: false,
        multi: false,
        columnName: "first_name",
      }],
      ["last_name", {
        name: "last_name",
        type: "str",
        required: false,
        multi: false,
        columnName: "last_name",
      }],
      ["active", {
        name: "active",
        type: "bool",
        required: false,
        multi: false,
        columnName: "active",
      }],
      ["role", {
        name: "role",
        type: "str",
        required: false,
        multi: false,
        columnName: "role",
      }],
    ]),
    links: new Map([
      ["posts", {
        name: "posts",
        target: "Post",
        multi: true,
        required: false,
        backlink: "author",
      }],
    ]),
  });
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
        columnName: "id",
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
      }],
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: false,
        multi: false,
        columnName: "createdAt",
      }],
    ]),
    links: new Map([
      ["author", {
        name: "author",
        target: "User",
        multi: false,
        columnName: "author_id",
        required: true,
      }],
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
    throw new Error(
      `Compilation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

Deno.test("EdgeQL to SQL - Simple SELECT", () => {
  const edgeql = `SELECT User`;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should generate a SELECT with all properties as JSON from the users table
  assertStringIncludes(normalized, "SELECT");
  assertStringIncludes(normalized, "jsonb_build_object(");
  assertStringIncludes(normalized, "FROM users AS");
});

Deno.test("EdgeQL to SQL - SELECT with specific fields", () => {
  const edgeql = `SELECT User { name, email }`;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should select specific fields as JSON from the users table
  assertStringIncludes(normalized, "jsonb_build_object(");
  assertStringIncludes(normalized, "'name'");
  assertStringIncludes(normalized, "'email'");
  assertStringIncludes(normalized, "FROM users AS");
});

Deno.test("EdgeQL to SQL - SELECT with filter", () => {
  const edgeql = `SELECT User FILTER .email = "test@example.com"`;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should generate SELECT from users with WHERE clause on email
  assertStringIncludes(normalized, "FROM users AS");
  assertStringIncludes(normalized, "WHERE");
  assertStringIncludes(normalized, "email = 'test@example.com'");
});

Deno.test("EdgeQL to SQL - SELECT with ORDER BY and LIMIT", () => {
  const edgeql = `SELECT User ORDER BY .name LIMIT 10`;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should generate SELECT with ORDER BY and LIMIT
  assertStringIncludes(normalized, "FROM users AS");
  assertStringIncludes(normalized, "ORDER BY");
  assertStringIncludes(normalized, "name ASC");
  assertStringIncludes(normalized, "LIMIT 10");
});

Deno.test("EdgeQL to SQL - SELECT with nested shape", () => {
  const edgeql = `
    SELECT User {
      name,
      posts: {
        title,
        createdAt
      }
    }
  `;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should generate a subquery for the nested relationship
  assertStringIncludes(normalized, "jsonb_build_object(");
  assertStringIncludes(normalized, "'name'");
  assertStringIncludes(normalized, "'posts'");
  assertStringIncludes(
    normalized,
    "jsonb_agg(jsonb_build_object('title', posts.title, 'createdAt', posts.createdAt))",
  );
  assertStringIncludes(normalized, "FROM posts");
  assertStringIncludes(normalized, "posts.author_id =");
  assertStringIncludes(normalized, "FROM users AS");
});

Deno.test("EdgeQL to SQL - Complex filter with AND", () => {
  const edgeql = `
    SELECT User
    FILTER .email = "admin@example.com" AND .active = true
  `;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should generate SELECT with AND condition in WHERE clause
  assertStringIncludes(normalized, "FROM users AS");
  assertStringIncludes(normalized, "WHERE");
  assertStringIncludes(normalized, "email = 'admin@example.com'");
  assertStringIncludes(normalized, "AND");
  assertStringIncludes(normalized, "active = TRUE");
});

Deno.test("EdgeQL to SQL - SELECT with computed field", () => {
  const edgeql = `
    SELECT User {
      name,
      full_name := .first_name ++ " " ++ .last_name
    }
  `;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should generate JSON with computed concatenation field
  assertStringIncludes(normalized, "jsonb_build_object(");
  assertStringIncludes(normalized, "'name'");
  assertStringIncludes(normalized, "'full_name'");
  assertStringIncludes(normalized, "first_name || ' '");
  assertStringIncludes(normalized, "last_name");
  assertStringIncludes(normalized, "FROM users AS");
});

Deno.test("EdgeQL to SQL - SELECT with function call", () => {
  const edgeql = `SELECT count(User)`;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should generate count(*) with FROM for the User type's table
  assertStringIncludes(normalized, "count(*)");
  assertStringIncludes(normalized, "FROM users AS");
});

Deno.test("EdgeQL to SQL - SELECT with DISTINCT", () => {
  const edgeql = `SELECT DISTINCT User.email`;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should generate SELECT DISTINCT with the email column from users
  assertStringIncludes(normalized, "SELECT DISTINCT");
  assertStringIncludes(normalized, "email");
  assertStringIncludes(normalized, "FROM users AS");
});

Deno.test("EdgeQL to SQL - SELECT with IN filter", () => {
  const edgeql = `
    SELECT User
    FILTER .role IN {"admin", "moderator"}
  `;
  const sql = compileToSQL(edgeql);
  const normalized = normalizeSQL(sql);

  // Should generate SELECT with IN filter for role
  assertStringIncludes(normalized, "FROM users AS");
  assertStringIncludes(normalized, "WHERE");
  assertStringIncludes(normalized, "role IN ('admin', 'moderator')");
});

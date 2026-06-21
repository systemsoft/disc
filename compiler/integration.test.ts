/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Integration tests for EdgeQL to SQL compilation
 */

import { assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
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
      ["first_name", {
        name: "first_name",
        type: "str",
        required: false,
        multi: false,
        columnName: "first_name"
      }],
      ["last_name", {
        name: "last_name",
        type: "str",
        required: false,
        multi: false,
        columnName: "last_name"
      }],
      ["active", {
        name: "active",
        type: "bool",
        required: false,
        multi: false,
        columnName: "active"
      }],
      ["role", {
        name: "role",
        type: "str",
        required: false,
        multi: false,
        columnName: "role"
      }]
    ]),
    links: new Map([
      ["posts", {
        name: "posts",
        target: "Post",
        multi: true,
        required: false,
        backlink: "author"
      }]
    ])
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
        columnName: "id"
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title"
      }],
      ["createdAt", {
        name: "createdAt",
        type: "datetime",
        required: false,
        multi: false,
        columnName: "createdAt"
      }]
    ]),
    links: new Map([
      ["author", {
        name: "author",
        target: "User",
        multi: false,
        columnName: "author_id",
        required: true
      }]
    ])
  });

  const functions = new Map<string, Context.FunctionDef>();
  functions.set("count", {
    name: "count",
    args: [{ name: "set", type: "any", required: false }],
    returnType: "int64",
    sqlName: "count"
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
      `Compilation failed: ${error instanceof Error ? error.message : String(error)}`
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
    "jsonb_agg(jsonb_build_object('title', posts.title, 'createdAt', posts.createdAt))"
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

Deno.test("EdgeQL to SQL - backlink through junction-table multi-link", async () => {
  // The forward link `multi options -> PaymentOption` is junction-backed, so
  // the computed reverse-link `requirements` reuses that junction with its
  // source/target columns swapped — aggregating the source-side ids where the
  // target side matches the current row.
  const { SchemaManager } = await import("../migration/schema-manager.ts");
  const manager = new SchemaManager({});
  const parseResult = manager.parseSDL(`
    type PaymentOption {
      required name: str;
      requirements := .<options[is PaymentRequirements];
    }
    type PaymentRequirements {
      required name: str;
      multi options -> PaymentOption;
    }
  `);
  if (!parseResult.ok) {
    throw new Error(`SDL parse failed: ${parseResult.error.message}`);
  }
  const schema = manager.modulesToSchema(parseResult.value);

  const parser = new EdgeQLParser("SELECT PaymentOption { id, requirements }");
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema);
  const compileResult = compiler.compile(ast);
  if (!compileResult.ok) {
    throw new Error(`Compile failed: ${compileResult.error.message}`);
  }
  const sql = new SQLCodeGenerator().generate(compileResult.value);
  const normalized = normalizeSQL(sql);

  // Aggregates source-side ids from the reversed junction, correlated on the
  // target side.
  assertStringIncludes(normalized, "'requirements'");
  assertStringIncludes(normalized, "jsonb_agg");
  assertStringIncludes(normalized, "payment_requirements_options");
  assertStringIncludes(normalized, "source_id");
  assertStringIncludes(normalized, "target_id = paymentoption_1.id");
});

Deno.test("EdgeQL to SQL - SELECT with computed backlink + type intersection", async () => {
  // The forward link `options` is a single FK (colon-form), so the computed
  // reverse-link `requirements` resolves to an FK backlink: aggregate target
  // rows whose `options_id` points back to the current row.
  const { SchemaManager } = await import("../migration/schema-manager.ts");
  const manager = new SchemaManager({});
  const parseResult = manager.parseSDL(`
    type PaymentOption {
      required name: str;
      requirements := .<options[is PaymentRequirements];
    }
    type PaymentRequirements {
      required name: str;
      required options: PaymentOption;
    }
  `);
  if (!parseResult.ok) {
    throw new Error(`SDL parse failed: ${parseResult.error.message}`);
  }
  const schema = manager.modulesToSchema(parseResult.value);

  const parser = new EdgeQLParser("SELECT PaymentOption { id, requirements }");
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema);
  const compileResult = compiler.compile(ast);
  if (!compileResult.ok) {
    throw new Error(`Compile failed: ${compileResult.error.message}`);
  }
  const sql = new SQLCodeGenerator().generate(compileResult.value);
  const normalized = normalizeSQL(sql);

  // Correlated subquery against the target table, filtered by the FK column
  // that points back to the current type.
  assertStringIncludes(normalized, "'requirements'");
  assertStringIncludes(normalized, "FROM payment_requirements");
  assertStringIncludes(normalized, "payment_requirements.options_id = paymentoption_1.id");
  assertStringIncludes(normalized, "jsonb_agg");
});

Deno.test("EdgeQL to SQL - SELECT with SDL-declared computed property", async () => {
  // Regression: a computed property declared in SDL like
  // `expires := .created + ...` has no physical column. The compiler must
  // inline the captured expression at shape resolution, NOT emit
  // `<alias>.expires` (which would fail at runtime with "column does not
  // exist"). Exercises the full SDL -> SchemaManager -> Compiler path.
  const { SchemaManager } = await import("../migration/schema-manager.ts");
  const manager = new SchemaManager({});
  const parseResult = manager.parseSDL(`
    type Token {
      required created: datetime;
      expires := .created + <duration>'7 days';
    }
  `);
  if (!parseResult.ok) {
    throw new Error(`SDL parse failed: ${parseResult.error.message}`);
  }
  const schema = manager.modulesToSchema(parseResult.value);

  const parser = new EdgeQLParser("SELECT Token { id, created, expires }");
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema);
  const compileResult = compiler.compile(ast);
  if (!compileResult.ok) {
    throw new Error(`Compile failed: ${compileResult.error.message}`);
  }
  const sql = new SQLCodeGenerator().generate(compileResult.value);
  const normalized = normalizeSQL(sql);

  // The `created` column reference is fine — it's a stored property.
  assertStringIncludes(normalized, "created");
  // The computed `expires` must NOT appear as a bare column ref. Instead,
  // its expression (`.created + <duration>...`) is inlined under the
  // 'expires' JSON key.
  assertStringIncludes(normalized, "'expires'");
  if (/[A-Za-z_]\.expires\b/.test(normalized)) {
    throw new Error(
      `Generated SQL references a non-existent 'expires' column: ${normalized}`
    );
  }
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

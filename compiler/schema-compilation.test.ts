/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * End-to-End Schema Compilation Tests
 *
 * Tests the full pipeline: SDL parsing -> Schema construction -> EdgeQL
 * compilation -> SQL generation. Uses SchemaManager.parseSDL() and
 * modulesToSchema() to build a real Schema from SDL source, then compiles
 * EdgeQL queries against that schema and validates the generated SQL.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { Schema } from "./context.ts";

// ---------------------------------------------------------------------------
// Test SDL
// ---------------------------------------------------------------------------

const TEST_SDL = `
  type User {
    required name: str;
    required email: str;
    multi link posts -> Post;
  }

  type Post {
    required title: str;
    required body: str;
    required link author -> User;
    createdAt: datetime;
  }
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse SDL source into a compiler-ready Schema via SchemaManager.
 */
function createSchemaFromSDL(sdl: string): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parseResult = manager.parseSDL(sdl);
  if (!parseResult.ok) {
    throw parseResult.error;
  }
  return manager.modulesToSchema(parseResult.value);
}

/**
 * Compile an EdgeQL query string against the given schema and return the
 * generated SQL (lowercased for easy assertion).
 */
function compileWithSchema(schema: Schema, edgeql: string): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema);
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value).toLowerCase();
}

// Build the schema once for all tests
const schema = createSchemaFromSDL(TEST_SDL);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("Schema Compilation - SDL produces correct types", () => {
  assertEquals(schema.types.has("User"), true);
  assertEquals(schema.types.has("Post"), true);

  const user = schema.types.get("User")!;
  assertEquals(user.tableName, "user");
  assertEquals(user.properties.has("name"), true);
  assertEquals(user.properties.has("email"), true);
  assertEquals(user.links.has("posts"), true);

  const post = schema.types.get("Post")!;
  assertEquals(post.tableName, "post");
  assertEquals(post.properties.has("title"), true);
  assertEquals(post.properties.has("body"), true);
  assertEquals(post.links.has("author"), true);
});

Deno.test("Schema Compilation - stored multi-link gets its own junction table", () => {
  // A plain `multi posts -> Post` is its own relationship, stored in a
  // junction table — matching the DDL generator (which always emits
  // `<table>_<link>`) and Gel semantics. It is NOT silently folded into
  // `Post.author`'s FK; the reverse of a single link is a separate computed
  // `:= .<author[is Post]` backlink.
  const postsLink = schema.types.get("User")!.links.get("posts")!;
  assertEquals(postsLink.multi, true);
  assertEquals(postsLink.backlink, undefined);
  assertEquals(postsLink.junctionTable, "user_posts");
  assertEquals(postsLink.junctionSourceColumn, "source_id");
  assertEquals(postsLink.junctionTargetColumn, "target_id");
});

Deno.test("Schema Compilation - SELECT User without shape", () => {
  const sql = compileWithSchema(schema, "SELECT User");
  assertStringIncludes(sql, "select");
  assertStringIncludes(sql, "user");
  assertStringIncludes(sql, "jsonb_build_object");
});

Deno.test("Schema Compilation - SELECT User with shape", () => {
  const sql = compileWithSchema(
    schema,
    `
    SELECT User {
      name,
      email
    }
  `
  );
  assertStringIncludes(sql, "jsonb_build_object");
  assertStringIncludes(sql, "'name'");
  assertStringIncludes(sql, "'email'");
  assertStringIncludes(sql, "user");
});

Deno.test("Schema Compilation - SELECT with FILTER", () => {
  const sql = compileWithSchema(
    schema,
    `
    SELECT User
    FILTER .name = "Ada"
  `
  );
  assertStringIncludes(sql, "where");
  assertStringIncludes(sql, "name");
  assertStringIncludes(sql, "'ada'");
});

Deno.test("Schema Compilation - SELECT with ORDER BY, LIMIT, OFFSET", () => {
  const sql = compileWithSchema(
    schema,
    `
    SELECT User {
      name
    }
    ORDER BY .name ASC
    OFFSET 5
    LIMIT 10
  `
  );
  assertStringIncludes(sql, "order by");
  assertStringIncludes(sql, "limit 10");
  assertStringIncludes(sql, "offset 5");
});

Deno.test("Schema Compilation - select count(User)", () => {
  const sql = compileWithSchema(schema, "select count(User)");
  assertStringIncludes(sql, "count");
  assertStringIncludes(sql, "user");
});

Deno.test("Schema Compilation - select str_lower function", () => {
  const sql = compileWithSchema(schema, `select str_lower("HELLO")`);
  assertStringIncludes(sql, "lower");
  assertStringIncludes(sql, "'hello'");
});

Deno.test("Schema Compilation - INSERT User", () => {
  const sql = compileWithSchema(
    schema,
    `
    INSERT User {
      name := "Billie",
      email := "billie@test.com"
    }
  `
  );
  assertStringIncludes(sql, "insert into");
  assertStringIncludes(sql, "user");
  assertStringIncludes(sql, "'billie'");
  assertStringIncludes(sql, "'billie@test.com'");
  assertStringIncludes(sql, "returning");
});

Deno.test("Schema Compilation - UPDATE User", () => {
  const sql = compileWithSchema(
    schema,
    `
    UPDATE User
    FILTER .name = "Ada"
    SET {
      name := "Alicia"
    }
  `
  );
  assertStringIncludes(sql, "update");
  assertStringIncludes(sql, "user");
  assertStringIncludes(sql, "set");
  assertStringIncludes(sql, "'alicia'");
  assertStringIncludes(sql, "where");
  assertStringIncludes(sql, "'ada'");
  assertStringIncludes(sql, "returning");
});

Deno.test("Schema Compilation - DELETE User", () => {
  const sql = compileWithSchema(
    schema,
    `
    DELETE User
    FILTER .name = "Ada"
  `
  );
  assertStringIncludes(sql, "delete from");
  assertStringIncludes(sql, "user");
  assertStringIncludes(sql, "where");
  assertStringIncludes(sql, "'ada'");
  assertStringIncludes(sql, "returning");
});

Deno.test("Schema Compilation - SELECT with nested shape joins the junction table", () => {
  const sql = compileWithSchema(
    schema,
    `
    SELECT User {
      name,
      posts: {
        title
      }
    }
  `
  );
  assertStringIncludes(sql, "jsonb_build_object");
  assertStringIncludes(sql, "'name'");
  assertStringIncludes(sql, "'posts'");
  assertStringIncludes(sql, "jsonb_agg");
  assertStringIncludes(sql, "'title'");
  // The subquery joins through the `user_posts` junction table — the stored
  // multi-link's own storage — not `Post.author`'s FK.
  assertStringIncludes(sql, "user_posts");
  assertStringIncludes(sql, "source_id");
  assertStringIncludes(sql, "target_id");
});

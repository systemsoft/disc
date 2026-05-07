/**
 * PostgreSQL Integration Tests for GraphQL Extension
 *
 * Tests GraphQL query translation and execution against a real PostgreSQL
 * instance. These tests verify the full pipeline: GraphQL -> EdgeQL -> SQL.
 *
 * Requires a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable these tests.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { GraphQLExtension } from "./extension.ts";
import { parseGraphQLQuery, translateToEdgeQL } from "./query-translator.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import type { Schema, TypeDef } from "../compiler/context.ts";

const RUN_PG = canRunPgTests();

// ── Helpers ───────────────────────────────────────────────────────────

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

/**
 * Create a minimal Schema that matches the PG test tables.
 */
function makeTestSchema(): Schema {
  const userType: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "disc_gql_users",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true,
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
      }],
    ]),
    links: new Map([
      ["posts", {
        name: "posts",
        target: "Post",
        required: false,
        multi: true,
        backlink: "author",
      }],
    ]),
  };

  const postType: TypeDef = {
    name: "Post",
    kind: "object",
    tableName: "disc_gql_posts",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid",
        hasDefault: true,
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
        edgeqlType: "str",
      }],
    ]),
    links: new Map([
      ["author", {
        name: "author",
        target: "User",
        required: true,
        multi: false,
        columnName: "author_id",
      }],
    ]),
  };

  return {
    types: new Map([
      ["User", userType],
      ["Post", postType],
    ]),
    functions: new Map(),
  };
}

function makeContext(schema: Schema): ExtensionContext {
  return {
    schema,
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 5,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false,
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function () {
        return this;
      },
      withRequest: function () {
        return this;
      },
    } as unknown as ExtensionContext["logger"],
  };
}

// ---------------------------------------------------------------------------
// Test 1: POST /graphql with SELECT query returns translated EdgeQL
// ---------------------------------------------------------------------------

Deno.test({
  name: "GraphQL PG - POST /graphql with SELECT query returns data",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Create test table
      await pool.query(`
        CREATE TABLE disc_gql_users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          email TEXT NOT NULL
        )
      `);

      // Insert test data
      await pool.query(
        "INSERT INTO disc_gql_users (name, email) VALUES ($1, $2)",
        ["Ada", "ada@example.com"],
      );

      // Translate a GraphQL query to EdgeQL
      const schema = makeTestSchema();
      const parsed = parseGraphQLQuery("{ allUsers { name, email } }");
      const result = translateToEdgeQL(parsed, schema);

      // Verify EdgeQL was generated correctly
      assertEquals(result.edgeql, "SELECT User {name, email}");

      // Execute the equivalent SQL directly to verify end-to-end
      const pgResult = await pool.query(
        `SELECT jsonb_build_object('name', name, 'email', email) AS data
         FROM disc_gql_users
         ORDER BY name`,
      );
      assertEquals(pgResult.rows.length, 1);
      const data = pgResult.rows[0]["data"] as Record<string, string>;
      assertEquals(data.name, "Ada");
      assertEquals(data.email, "ada@example.com");
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 2: POST /graphql with mutation (INSERT) creates record
// ---------------------------------------------------------------------------

Deno.test({
  name: "GraphQL PG - POST /graphql with mutation INSERT creates record",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await pool.query(`
        CREATE TABLE disc_gql_users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          email TEXT NOT NULL
        )
      `);

      // Translate a create mutation to EdgeQL
      const schema = makeTestSchema();
      const parsed = parseGraphQLQuery(
        'mutation { createUser(input: {name: "Billie", email: "billie@example.com"}) { id } }',
      );
      const result = translateToEdgeQL(parsed, schema);

      // Verify EdgeQL is an INSERT
      assertEquals(
        result.edgeql,
        'INSERT User {name := "Billie", email := "billie@example.com"}',
      );

      // Execute the equivalent SQL INSERT
      await pool.query(
        "INSERT INTO disc_gql_users (name, email) VALUES ($1, $2)",
        ["Billie", "billie@example.com"],
      );

      // Verify the record was created
      const pgResult = await pool.query(
        "SELECT name, email FROM disc_gql_users WHERE name = $1",
        ["Billie"],
      );
      assertEquals(pgResult.rows.length, 1);
      assertEquals(String(pgResult.rows[0]["name"]), "Billie");
      assertEquals(String(pgResult.rows[0]["email"]), "billie@example.com");
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 3: GET /graphql/schema returns valid GraphQL SDL
// ---------------------------------------------------------------------------

Deno.test({
  name: "GraphQL PG - GET /graphql/schema returns valid GraphQL SDL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const schema = makeTestSchema();
      const ext = new GraphQLExtension();
      await ext.initialize(makeContext(schema));

      const routes = ext.getRoutes();
      const schemaRoute = routes.find((r) => r.path === "/graphql/schema")!;
      const response = await schemaRoute.handler(
        new Request("http://localhost/graphql/schema"),
      );

      assertEquals(response.status, 200);
      const sdl = await response.text();

      // Verify the SDL contains expected types
      assertStringIncludes(sdl, "type User {");
      assertStringIncludes(sdl, "type Post {");
      assertStringIncludes(sdl, "type Query {");
      assertStringIncludes(sdl, "scalar DateTime");
      assertStringIncludes(sdl, "scalar JSON");
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 4: POST /graphql with nested query (link traversal)
// ---------------------------------------------------------------------------

Deno.test({
  name: "GraphQL PG - POST /graphql with nested query translates link traversal",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Create tables for the nested query test
      await pool.query(`
        CREATE TABLE disc_gql_users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          email TEXT NOT NULL
        )
      `);

      await pool.query(`
        CREATE TABLE disc_gql_posts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          author_id UUID REFERENCES disc_gql_users(id)
        )
      `);

      // Insert test data
      const userResult = await pool.query(
        "INSERT INTO disc_gql_users (name, email) VALUES ($1, $2) RETURNING id",
        ["Cher", "cher@example.com"],
      );
      const userId = userResult.rows[0]["id"];

      await pool.query(
        "INSERT INTO disc_gql_posts (title, author_id) VALUES ($1, $2)",
        ["Hello World", userId],
      );

      // Translate nested GraphQL query to EdgeQL
      const schema = makeTestSchema();
      const parsed = parseGraphQLQuery(
        "{ allUsers { name, posts { title } } }",
      );
      const result = translateToEdgeQL(parsed, schema);

      // Verify nested shape in EdgeQL
      assertEquals(result.edgeql, "SELECT User {name, posts: {title}}");

      // Execute a SQL query that matches the nested structure
      const pgResult = await pool.query(
        `SELECT jsonb_build_object(
           'name', u.name,
           'posts', (
             SELECT jsonb_agg(jsonb_build_object('title', p.title))
             FROM disc_gql_posts p WHERE p.author_id = u.id
           )
         ) AS data
         FROM disc_gql_users u
         ORDER BY u.name`,
      );

      assertEquals(pgResult.rows.length, 1);
      const data = pgResult.rows[0]["data"] as {
        name: string;
        posts: { title: string }[];
      };
      assertEquals(data.name, "Cher");
      assertEquals(data.posts.length, 1);
      assertEquals(data.posts[0].title, "Hello World");
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  },
});

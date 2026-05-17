/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL End-to-End Tests -- DESCRIBE TYPE / DESCRIBE SCHEMA
 *
 * Tests the full pipeline against real PostgreSQL for introspection:
 *   - DESCRIBE TYPE returns valid JSON for a migrated type
 *   - DESCRIBE SCHEMA returns all types
 *   - DESCRIBE TYPE for unknown type returns error
 *   - DESCRIBE TYPE includes properties and links
 *   - DESCRIBE SCHEMA includes module info
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema, TypeDef } from "./context.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0
  });
}

function compileEdgeQL(edgeql: string, schema: Schema): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value);
}

function buildTestSchema(): Schema {
  const userType: TypeDef = {
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
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
        constraints: [{ name: "exclusive" }]
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
  };

  const postType: TypeDef = {
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
        edgeqlType: "uuid",
        hasDefault: true
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
        edgeqlType: "str"
      }]
    ]),
    links: new Map([
      ["author", {
        name: "author",
        target: "User",
        required: true,
        multi: false,
        columnName: "author_id"
      }]
    ])
  };

  return {
    types: new Map([["User", userType], ["Post", postType]]),
    functions: getBuiltinFunctions()
  };
}

// =========================================================================
// PG E2E: DESCRIBE TYPE returns valid JSON
// =========================================================================

Deno.test({
  name: "PG Introspection: DESCRIBE TYPE returns valid JSON for a type",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const schema = buildTestSchema();
      const sql = compileEdgeQL("DESCRIBE TYPE User", schema);

      // Execute against PG — the SQL is SELECT '<json>'::jsonb
      const result = await pool.query(sql);
      assertEquals(result.rows.length, 1);

      const row = result.rows[0];
      const json = Object.values(row)[0] as Record<string, unknown>;

      assertExists(json);
      assertEquals(json.name, "User");
      assertEquals(Array.isArray(json.properties), true);
      assertEquals(Array.isArray(json.links), true);
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// PG E2E: DESCRIBE SCHEMA returns all types
// =========================================================================

Deno.test({
  name: "PG Introspection: DESCRIBE SCHEMA returns all types",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const schema = buildTestSchema();
      const sql = compileEdgeQL("DESCRIBE SCHEMA", schema);

      const result = await pool.query(sql);
      assertEquals(result.rows.length, 1);

      const row = result.rows[0];
      const json = Object.values(row)[0] as Record<string, unknown>;

      assertExists(json);
      assertEquals(Array.isArray(json.types), true);

      const types = json.types as Array<{ name: string; }>;
      const typeNames = types.map(t => t.name);
      assertEquals(typeNames.includes("User"), true);
      assertEquals(typeNames.includes("Post"), true);
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// PG E2E: DESCRIBE TYPE for unknown type returns error
// =========================================================================

Deno.test({
  name: "PG Introspection: DESCRIBE TYPE for unknown type returns compile error",
  ignore: !RUN_PG,
  fn: () => {
    const schema = buildTestSchema();
    const parser = new EdgeQLParser("DESCRIBE TYPE Ghost");
    const ast = parser.parse();
    const compiler = new EdgeQLCompiler(schema, {
      enableAccessControl: false
    });
    const result = compiler.compile(ast);

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.message.includes("not found"), true);
    }
  }
});

// =========================================================================
// PG E2E: DESCRIBE TYPE includes properties and links
// =========================================================================

Deno.test({
  name: "PG Introspection: DESCRIBE TYPE includes properties and links",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const schema = buildTestSchema();
      const sql = compileEdgeQL("DESCRIBE TYPE Post", schema);

      const result = await pool.query(sql);
      const row = result.rows[0];
      const json = Object.values(row)[0] as Record<string, unknown>;

      // Check properties
      const props = json.properties as Array<{ name: string; type: string; }>;
      const propNames = props.map(p => p.name);
      assertEquals(propNames.includes("title"), true);
      assertEquals(propNames.includes("id"), true);

      // Check links
      const links = json.links as Array<
        { name: string; target: string; cardinality: string; }
      >;
      const authorLink = links.find(l => l.name === "author");
      assertExists(authorLink);
      assertEquals(authorLink!.target, "User");
      assertEquals(authorLink!.cardinality, "single");
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// PG E2E: DESCRIBE SCHEMA includes module info
// =========================================================================

Deno.test({
  name: "PG Introspection: DESCRIBE SCHEMA includes module info",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const schema = buildTestSchema();
      const sql = compileEdgeQL("DESCRIBE SCHEMA", schema);

      const result = await pool.query(sql);
      const row = result.rows[0];
      const json = Object.values(row)[0] as Record<string, unknown>;

      const modules = json.modules as string[];
      assertEquals(Array.isArray(modules), true);
      assertEquals(modules.includes("default"), true);
    } finally {
      await pool.close();
    }
  }
});

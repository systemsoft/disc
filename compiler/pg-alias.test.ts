/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL End-to-End Tests -- Expression Alias Queries
 *
 * Tests the full pipeline against real PostgreSQL for expression aliases:
 *   SDL -> migrate -> add alias to schema -> compile EdgeQL -> execute -> verify
 *
 * Aliases are compile-time constructs (no DDL generated), so we create the
 * underlying tables via SchemaManager.applySchema(), then add aliases to the
 * schema object before compiling EdgeQL queries.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import type { AliasDef, Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * SDL schema with a TestAccount type that has an `active` boolean property.
 * Uses "TestAccount" to avoid PostgreSQL reserved word conflicts ("user").
 */
const TEST_SDL = `
  type TestAccount {
    required name: str;
    required email: str;
    active: bool;
  }
`;

/** The expected table name after PascalCase -> snake_case conversion. */
const TEST_TABLE = "test_account";

/**
 * Apply the test SDL schema via SchemaManager and return the schema for the
 * compiler. Adds the provided aliases to the returned schema.
 */
async function applyTestSchema(
  pool: ConnectionPool,
  aliases?: Map<string, AliasDef>
): Promise<{ manager: SchemaManager; schema: Schema; }> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  const result = await manager.applySchema(TEST_SDL);
  assertEquals(
    result.ok,
    true,
    `applySchema should succeed: ${result.ok ? "" : JSON.stringify(result)}`
  );

  const baseSchema = manager.getSchema();
  assertExists(baseSchema, "Schema should exist after applySchema");

  // Add aliases to the schema (aliases are compile-time only, not stored in DB)
  const schema: Schema = {
    ...baseSchema!,
    aliases: aliases ?? new Map()
  };

  return { manager, schema };
}

/**
 * Clean up test tables and migration tracking.
 */
async function cleanup(pool: ConnectionPool, manager: SchemaManager) {
  await manager.close();
  await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

// =========================================================================
// Tests
// =========================================================================

Deno.test({
  name: "PG Alias: alias query with shape returns only matching rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const aliases = new Map<string, AliasDef>([
        ["ActiveAccounts", {
          name: "ActiveAccounts",
          expression: "select TestAccount filter .active = true",
          targetType: "TestAccount"
        }]
      ]);

      const { manager, schema } = await applyTestSchema(pool, aliases);

      // Insert test data: 2 active, 1 inactive
      await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, email, active) VALUES
          (gen_random_uuid(), 'Ada', 'ada@test.com', true),
          (gen_random_uuid(), 'Billie', 'billie@test.com', false),
          (gen_random_uuid(), 'Cher', 'cher@test.com', true)`
      );

      // Compile and execute alias query with shape
      const sql = compileEdgeQL(
        "select ActiveAccounts { name, email }",
        schema
      );
      const result = await pool.query(sql);

      // Should return only the 2 active accounts
      assertEquals(
        result.rowCount,
        2,
        "Should return exactly 2 active accounts"
      );

      await cleanup(pool, manager);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Alias: alias with additional filter narrows results further",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const aliases = new Map<string, AliasDef>([
        ["ActiveAccounts", {
          name: "ActiveAccounts",
          expression: "select TestAccount filter .active = true",
          targetType: "TestAccount"
        }]
      ]);

      const { manager, schema } = await applyTestSchema(pool, aliases);

      // Insert test data
      await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, email, active) VALUES
          (gen_random_uuid(), 'Ada', 'ada@test.com', true),
          (gen_random_uuid(), 'Billie', 'billie@test.com', false),
          (gen_random_uuid(), 'Cher', 'cher@test.com', true)`
      );

      // Compile and execute alias query with additional filter
      const sql = compileEdgeQL(
        "select ActiveAccounts { name } filter .name = \"Ada\"",
        schema
      );
      const result = await pool.query(sql);

      // Should return only Ada (active AND name = "Ada")
      assertEquals(
        result.rowCount,
        1,
        "Should return exactly 1 account (Ada)"
      );

      // Verify it's Ada
      const row = result.rows[0];
      const rowData = row.jsonb_build_object ?? row;
      const name = rowData.name ??
        (typeof rowData === "object" ? Object.values(rowData)[0] : undefined);
      assertExists(name, "Row should contain name data");

      await cleanup(pool, manager);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Alias: simple type alias resolves to underlying table",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const aliases = new Map<string, AliasDef>([
        ["People", {
          name: "People",
          expression: "TestAccount",
          targetType: "TestAccount"
        }]
      ]);

      const { manager, schema } = await applyTestSchema(pool, aliases);

      // Insert test data
      await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, email, active) VALUES
          (gen_random_uuid(), 'Ada', 'ada@test.com', true),
          (gen_random_uuid(), 'Billie', 'billie@test.com', false)`
      );

      // Compile and execute type alias query
      const sql = compileEdgeQL(
        "select People { name }",
        schema
      );
      const result = await pool.query(sql);

      // Simple type alias should return ALL accounts
      assertEquals(
        result.rowCount,
        2,
        "Should return all 2 accounts via type alias"
      );

      await cleanup(pool, manager);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Alias: multiple aliases work independently",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const aliases = new Map<string, AliasDef>([
        ["ActiveAccounts", {
          name: "ActiveAccounts",
          expression: "select TestAccount filter .active = true",
          targetType: "TestAccount"
        }],
        ["People", {
          name: "People",
          expression: "TestAccount",
          targetType: "TestAccount"
        }]
      ]);

      const { manager, schema } = await applyTestSchema(pool, aliases);

      // Insert test data: 2 active, 1 inactive
      await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, email, active) VALUES
          (gen_random_uuid(), 'Ada', 'ada@test.com', true),
          (gen_random_uuid(), 'Billie', 'billie@test.com', false),
          (gen_random_uuid(), 'Cher', 'cher@test.com', true)`
      );

      // Test ActiveAccounts alias (should return 2)
      const activeSql = compileEdgeQL(
        "select ActiveAccounts { name }",
        schema
      );
      const activeResult = await pool.query(activeSql);
      assertEquals(
        activeResult.rowCount,
        2,
        "ActiveAccounts should return 2 active accounts"
      );

      // Test People alias (should return all 3)
      const peopleSql = compileEdgeQL(
        "select People { name }",
        schema
      );
      const peopleResult = await pool.query(peopleSql);
      assertEquals(
        peopleResult.rowCount,
        3,
        "People should return all 3 accounts"
      );

      await cleanup(pool, manager);
    } finally {
      await pool.close();
    }
  }
});

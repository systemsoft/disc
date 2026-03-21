/**
 * PostgreSQL End-to-End Tests -- Global Variable Queries
 *
 * Tests the full pipeline against real PostgreSQL for global variables:
 *   SDL -> migrate -> add globals to schema -> compile EdgeQL -> execute -> verify
 *
 * Globals are compile-time constructs backed by PostgreSQL session settings
 * via `current_setting()` and `set_config()`. No DDL is generated; global values
 * are injected into the session via `set_config(name, value, true)` within a
 * transaction scope on a single connection.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import type { GlobalDef, Schema } from "./context.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ConnectionPool configured for testing. */
function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

/**
 * SDL schema with a TestAccount type for globals testing.
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
 * compiler. Adds the provided globals to the returned schema.
 * Pre-cleans any existing tables to ensure test isolation.
 */
async function applyTestSchema(
  pool: ConnectionPool,
  globals?: Map<string, GlobalDef>,
): Promise<{ manager: SchemaManager; schema: Schema }> {
  // Pre-cleanup: drop tables from previous test runs
  await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");

  const manager = new SchemaManager({ pool });
  await manager.initialize();

  const result = await manager.applySchema(TEST_SDL);
  assertEquals(
    result.ok,
    true,
    `applySchema should succeed: ${result.ok ? "" : JSON.stringify(result)}`,
  );

  const baseSchema = manager.getSchema();
  assertExists(baseSchema, "Schema should exist after applySchema");

  // Add globals to the schema (globals are compile-time only, not stored in DB)
  const schema: Schema = {
    ...baseSchema!,
    globals: globals ?? new Map(),
  };

  return { manager, schema };
}

/**
 * Compile an EdgeQL query string to SQL using the full pipeline.
 */
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

/**
 * Clean up test tables and migration tracking.
 */
async function cleanup(pool: ConnectionPool, manager: SchemaManager) {
  await manager.close();
  await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/**
 * Standard globals map with current_user_id for testing.
 */
function makeTestGlobals(): Map<string, GlobalDef> {
  return new Map<string, GlobalDef>([
    ["default::current_user_id", {
      name: "current_user_id",
      module: "default",
      type: "uuid",
      pgType: "uuid",
      required: false,
      multi: false,
      readonly: false,
      pgSettingName: "disc.global_default__current_user_id",
    }],
  ]);
}

// =========================================================================
// Tests
// =========================================================================

Deno.test({
  name: "PG Globals: global in SELECT filter returns matching row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const globals = makeTestGlobals();
      const { manager, schema } = await applyTestSchema(pool, globals);

      // Insert test data
      const insertResult = await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, email, active) VALUES
          (gen_random_uuid(), 'Ada', 'ada@test.com', true),
          (gen_random_uuid(), 'Billie', 'billie@test.com', false)
        RETURNING id, name`,
      );

      // Get Ada's UUID
      const adaRow = insertResult.rows.find(
        (r: Record<string, unknown>) => r.name === "Ada",
      ) as Record<string, unknown>;
      assertExists(adaRow, "Ada should be inserted");
      const adaId = adaRow.id as string;

      // Compile the query: SELECT TestAccount { name } FILTER .id = global current_user_id
      const sql = compileEdgeQL(
        "select TestAccount { name } filter .id = global current_user_id",
        schema,
      );

      // Execute in a transaction to ensure set_config and query use the same connection
      const result = await pool.transaction(async (conn) => {
        await conn.query(
          `SELECT set_config('disc.global_default__current_user_id', '${adaId}', true)`,
        );
        return await conn.query(sql);
      });

      // Should return exactly 1 row (Ada)
      assertEquals(result.rowCount, 1, "Should return exactly 1 matching row");

      await cleanup(pool, manager);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Globals: unset global returns NULL via current_setting",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const globals = makeTestGlobals();
      const { manager, schema } = await applyTestSchema(pool, globals);

      // Compile: SELECT global current_user_id
      // This generates: SELECT current_setting('disc.global_default__current_user_id', true)::uuid
      const sql = compileEdgeQL(
        "select global current_user_id",
        schema,
      );

      // Execute without setting the global -- should return NULL
      const result = await pool.query(sql);
      assertEquals(result.rowCount, 1, "Should return 1 row");

      // The value should be NULL (unset setting with missing_ok=true returns NULL)
      const row = result.rows[0] as Record<string, unknown>;
      const values = Object.values(row);
      assertEquals(values[0], null, "Unset global should return NULL");

      await cleanup(pool, manager);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Globals: SET GLOBAL + query uses the set value",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const globals = makeTestGlobals();
      const { manager, schema } = await applyTestSchema(pool, globals);

      // Insert a test account
      const insertResult = await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, email, active) VALUES
          (gen_random_uuid(), 'Ada', 'ada@test.com', true)
        RETURNING id`,
      );
      const adaId = (insertResult.rows[0] as Record<string, unknown>)
        .id as string;

      // Compile SET GLOBAL
      const setGlobalSql = compileEdgeQL(
        `set global current_user_id := <uuid>'${adaId}'`,
        schema,
      );

      // Compile the filter query
      const filterSql = compileEdgeQL(
        "select TestAccount { name } filter .id = global current_user_id",
        schema,
      );

      // Execute both in a transaction to ensure same connection
      const result = await pool.transaction(async (conn) => {
        await conn.query(setGlobalSql);
        return await conn.query(filterSql);
      });

      assertEquals(
        result.rowCount,
        1,
        "Should return 1 row after SET GLOBAL",
      );

      await cleanup(pool, manager);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Globals: required global unset returns NULL from PG",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Create a required global (enforcement is at the application level,
      // not at the PG level)
      const globals = new Map<string, GlobalDef>([
        ["default::tenant_id", {
          name: "tenant_id",
          module: "default",
          type: "uuid",
          pgType: "uuid",
          required: true,
          multi: false,
          readonly: false,
          pgSettingName: "disc.global_default__tenant_id",
        }],
      ]);

      const { manager, schema } = await applyTestSchema(pool, globals);

      // Compile: SELECT global tenant_id
      const sql = compileEdgeQL(
        "select global tenant_id",
        schema,
      );

      // Execute without setting -- PG returns NULL (missing_ok=true)
      const result = await pool.query(sql);
      assertEquals(result.rowCount, 1, "Should return 1 row");

      const row = result.rows[0] as Record<string, unknown>;
      const values = Object.values(row);
      assertEquals(
        values[0],
        null,
        "Required global unset should still return NULL from PG",
      );

      await cleanup(pool, manager);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Globals: global in access-policy-style WHERE clause filters rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const globals = makeTestGlobals();
      const { manager, schema } = await applyTestSchema(pool, globals);

      // Insert test data
      const insertResult = await pool.query(
        `INSERT INTO ${TEST_TABLE} (id, name, email, active) VALUES
          (gen_random_uuid(), 'Ada', 'ada@test.com', true),
          (gen_random_uuid(), 'Billie', 'billie@test.com', true),
          (gen_random_uuid(), 'Cher', 'cher@test.com', true)
        RETURNING id, name`,
      );

      // Get Billie's UUID
      const billieRow = insertResult.rows.find(
        (r: Record<string, unknown>) => r.name === "Billie",
      ) as Record<string, unknown>;
      assertExists(billieRow, "Billie should be inserted");
      const billieId = billieRow.id as string;

      // This simulates an access policy filter: only return the row matching
      // the current user's ID. In real usage, the access policy evaluator
      // injects this WHERE clause automatically.
      const sql = compileEdgeQL(
        "select TestAccount { name, email } filter .id = global current_user_id",
        schema,
      );

      // Execute with global set to Billie's ID, using transaction for same connection
      const result = await pool.transaction(async (conn) => {
        await conn.query(
          `SELECT set_config('disc.global_default__current_user_id', '${billieId}', true)`,
        );
        return await conn.query(sql);
      });

      // Should return exactly 1 row (Billie)
      assertEquals(
        result.rowCount,
        1,
        "Access policy filter should return exactly 1 row",
      );

      // Verify it's Billie
      const row = result.rows[0] as Record<string, unknown>;
      const rowData = row.jsonb_build_object ?? row;
      const name = (rowData as Record<string, unknown>).name ??
        (typeof rowData === "object" ? Object.values(rowData)[0] : undefined);
      assertExists(name, "Row should contain name data");

      await cleanup(pool, manager);
    } finally {
      await pool.close();
    }
  },
});

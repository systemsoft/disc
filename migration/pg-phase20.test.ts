/**
 * PostgreSQL End-to-End Tests for Phase 20 Migration/DDL Features
 *
 * Tests that verify CHECK constraints, computed properties, and multiple
 * constraints are correctly applied to a real PostgreSQL instance via
 * the SchemaManager SDL pipeline.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "./schema-manager.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a DSN into connection config for the raw deno-postgres Client. */
function parseDsn(
  dsn: string,
): { hostname: string; port: number; user: string; database: string } {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test",
  };
}

/** Get column info for a table via a raw client. */
async function getColumns(
  dsn: string,
  tableName: string,
): Promise<{ column_name: string; data_type: string }[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<
      { column_name: string; data_type: string }
    >(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

/** Drop one or more tables by name (best-effort cleanup). */
async function dropTables(
  dsn: string,
  ...tableNames: string[]
): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    for (const name of tableNames) {
      await client.queryArray(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** Execute raw SQL via a fresh client connection. */
async function execRawSQL(
  dsn: string,
  sql: string,
  params?: unknown[],
): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    if (params) {
      await client.queryArray(sql, params);
    } else {
      await client.queryArray(sql);
    }
  } finally {
    await client.end();
  }
}

/** Create a ConnectionPool configured for testing. */
function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

// =========================================================================
// Test 1: CHECK constraint max_len_value enforced by PG
// =========================================================================

Deno.test({
  name: "PG Phase 20: CHECK constraint max_len_value enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_constrained";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestConstrained {
          required username: str {
            constraint max_len_value(20);
          };
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`,
      );

      // Insert a short string (5 chars) -- should succeed
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, username) VALUES (gen_random_uuid(), $1)`,
        ["ada"],
      );

      // Insert a long string (25 chars) -- should fail with CHECK violation
      let checkViolated = false;
      try {
        await execRawSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, username) VALUES (gen_random_uuid(), $1)`,
          ["a".repeat(25)],
        );
      } catch (error: unknown) {
        checkViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`,
        );
      }

      assertEquals(
        checkViolated,
        true,
        "Inserting a 25-char string should violate max_len_value(20) CHECK constraint",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 2: CHECK constraint min_value enforced by PG
// =========================================================================

Deno.test({
  name: "PG Phase 20: CHECK constraint min_value enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_bounded";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestBounded {
          required score: int64 {
            constraint min_value(0);
          };
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`,
      );

      // Insert score=10 -- should succeed
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, score) VALUES (gen_random_uuid(), $1)`,
        [10],
      );

      // Insert score=-5 -- should fail with CHECK violation
      let checkViolated = false;
      try {
        await execRawSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, score) VALUES (gen_random_uuid(), $1)`,
          [-5],
        );
      } catch (error: unknown) {
        checkViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`,
        );
      }

      assertEquals(
        checkViolated,
        true,
        "Inserting score=-5 should violate min_value(0) CHECK constraint",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 3: CHECK constraint max_value enforced by PG
// =========================================================================

Deno.test({
  name: "PG Phase 20: CHECK constraint max_value enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_capped";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestCapped {
          required rating: int64 {
            constraint max_value(100);
          };
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`,
      );

      // Insert rating=50 -- should succeed
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, rating) VALUES (gen_random_uuid(), $1)`,
        [50],
      );

      // Insert rating=150 -- should fail with CHECK violation
      let checkViolated = false;
      try {
        await execRawSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, rating) VALUES (gen_random_uuid(), $1)`,
          [150],
        );
      } catch (error: unknown) {
        checkViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`,
        );
      }

      assertEquals(
        checkViolated,
        true,
        "Inserting rating=150 should violate max_value(100) CHECK constraint",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 4: Computed property NOT stored as column
// =========================================================================

Deno.test({
  name: "PG Phase 20: Computed property is not stored as a column in PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_computed";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestComputed {
          required first_name: str;
          required last_name: str;
          full_name := .first_name ++ ' ' ++ .last_name;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`,
      );

      // Use getColumns() to verify the table schema
      const columns = await getColumns(dsn, expectedTable);
      const columnNames = columns.map((c) => c.column_name);

      // Should have id, first_name, last_name
      assertEquals(
        columnNames.includes("id"),
        true,
        "Should have id column",
      );
      assertEquals(
        columnNames.includes("first_name"),
        true,
        "Should have first_name column",
      );
      assertEquals(
        columnNames.includes("last_name"),
        true,
        "Should have last_name column",
      );

      // Should NOT have full_name (it is a computed virtual property)
      assertEquals(
        columnNames.includes("full_name"),
        false,
        "Should NOT have full_name column (computed properties are virtual)",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 5: Multiple CHECK constraints on same type
// =========================================================================

Deno.test({
  name: "PG Phase 20: Multiple CHECK constraints on same type enforced by PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_multi_check";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestMultiCheck {
          required username: str {
            constraint min_len_value(3);
            constraint max_len_value(20);
          };
          required age: int64 {
            constraint min_value(0);
            constraint max_value(150);
          };
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`,
      );

      // Insert valid data: username="ada" (5 chars), age=25 -- should succeed
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, username, age) VALUES (gen_random_uuid(), $1, $2)`,
        ["ada", 25],
      );

      // Insert invalid username: "ab" (2 chars, less than min 3) -- should fail
      let usernameCheckViolated = false;
      try {
        await execRawSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, username, age) VALUES (gen_random_uuid(), $1, $2)`,
          ["ab", 25],
        );
      } catch (error: unknown) {
        usernameCheckViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`,
        );
      }

      assertEquals(
        usernameCheckViolated,
        true,
        "Inserting username='ab' (2 chars) should violate min_len_value(3) CHECK constraint",
      );

      // Insert invalid age: 200 (more than max 150) -- should fail
      let ageCheckViolated = false;
      try {
        await execRawSQL(
          dsn,
          `INSERT INTO ${expectedTable} (id, username, age) VALUES (gen_random_uuid(), $1, $2)`,
          ["billie", 200],
        );
      } catch (error: unknown) {
        ageCheckViolated = true;
        const message = error instanceof Error ? error.message : String(error);
        assertEquals(
          message.toLowerCase().includes("check") ||
            message.toLowerCase().includes("constraint") ||
            message.toLowerCase().includes("violates"),
          true,
          `Error should mention CHECK/constraint/violates, got: ${message}`,
        );
      }

      assertEquals(
        ageCheckViolated,
        true,
        "Inserting age=200 should violate max_value(150) CHECK constraint",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

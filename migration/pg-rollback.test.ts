/**
 * PostgreSQL E2E Rollback Tests (Phase 24.6)
 *
 * End-to-end tests that verify rollback execution against a real PostgreSQL
 * instance. Requires a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { MigrationEngine } from "./engine.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDsn(
  dsn: string,
): { hostname: string; port: number; user: string; database: string; } {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test",
  };
}

async function tableExists(dsn: string, tableName: string): Promise<boolean> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<{ exists: boolean; }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [tableName],
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

async function dropTables(dsn: string, ...tableNames: string[]): Promise<void> {
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

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

function makeEngine(pool: ConnectionPool): MigrationEngine {
  const config: Types.MigrationConfig = {
    migrationsDir: "",
    schemaFile: "",
    databaseUrl: "",
    dryRun: false,
    autoApprove: true,
    backupBeforeMigration: false,
    rollbackOnError: true,
    connectionPool: pool,
  };
  return new MigrationEngine(config);
}

/**
 * Apply a migration that creates a table with the given name.
 * Returns the migration ID.
 */
async function applyCreateTableMigration(
  engine: MigrationEngine,
  tableName: string,
  migrationId?: string,
): Promise<string> {
  const id = migrationId || `test_${tableName}_${Date.now()}`;
  const createOp: Types.CreateTypeOperation = {
    kind: "CreateType",
    typeName: tableName,
    properties: [
      {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        constraints: [],
        annotations: {},
      },
    ],
    links: [],
  };

  const migration: Types.Migration = {
    id,
    name: `create_${tableName}`,
    description: `Create ${tableName} table`,
    createdAt: new Date(),
    schemaHash: `hash_${tableName}`,
    operations: [createOp],
  };

  const plan: Types.MigrationPlan = {
    migrations: [migration],
    targetSchemaHash: `hash_${tableName}`,
    operationsCount: 1,
  };

  const result = await engine.executeMigrationWithRollback(plan);
  assertEquals(
    result.ok,
    true,
    `Failed to apply migration for ${tableName}: ${result.ok ? "" : result.error.message}`,
  );

  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG Rollback: Apply migration then rollback - verify table is dropped",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const tableName = `test_rb_single_${Date.now()}`;

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // Apply migration that creates a table
      const migrationId = await applyCreateTableMigration(engine, tableName);

      // Verify table exists
      let exists = await tableExists(dsn, tableName);
      assertEquals(exists, true, "Table should exist after migration");

      // Execute rollback
      const rollbackResult = await engine.executeRollback(migrationId);
      assertEquals(
        rollbackResult.ok,
        true,
        `Rollback should succeed: ${rollbackResult.ok ? "" : rollbackResult.error.message}`,
      );

      // Verify table is dropped
      exists = await tableExists(dsn, tableName);
      assertEquals(exists, false, "Table should not exist after rollback");

      // Verify migration record is removed
      const appliedResult = await pool.query(
        `SELECT id FROM disc_migrations WHERE id = $1`,
        [migrationId],
      );
      assertEquals(
        appliedResult.rowCount,
        0,
        "Migration record should be removed after rollback",
      );

      await engine.close();
    } finally {
      await dropTables(
        dsn,
        tableName,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Rollback: Apply 3 migrations, rollback-to first - verify only first table remains",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const ts = Date.now();
    const table1 = `test_rbt_first_${ts}`;
    const table2 = `test_rbt_second_${ts}`;
    const table3 = `test_rbt_third_${ts}`;

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // Apply 3 migrations in sequence with small delays to ensure distinct applied_at
      const id1 = await applyCreateTableMigration(engine, table1);
      await new Promise((r) => setTimeout(r, 50));
      await applyCreateTableMigration(engine, table2);
      await new Promise((r) => setTimeout(r, 50));
      await applyCreateTableMigration(engine, table3);

      // Verify all tables exist
      assertEquals(
        await tableExists(dsn, table1),
        true,
        "Table 1 should exist",
      );
      assertEquals(
        await tableExists(dsn, table2),
        true,
        "Table 2 should exist",
      );
      assertEquals(
        await tableExists(dsn, table3),
        true,
        "Table 3 should exist",
      );

      // Rollback to first migration (should rollback 3rd and 2nd)
      const rollbackResult = await engine.executeRollbackTo(id1);
      assertEquals(
        rollbackResult.ok,
        true,
        `Rollback-to should succeed: ${rollbackResult.ok ? "" : rollbackResult.error.message}`,
      );

      // Verify: first table remains, second and third are dropped
      assertEquals(
        await tableExists(dsn, table1),
        true,
        "First table should still exist (target preserved)",
      );
      assertEquals(
        await tableExists(dsn, table2),
        false,
        "Second table should be dropped",
      );
      assertEquals(
        await tableExists(dsn, table3),
        false,
        "Third table should be dropped",
      );

      await engine.close();
    } finally {
      await dropTables(
        dsn,
        table1,
        table2,
        table3,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Rollback: getMigrationStatus shows correct count after migrations",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const ts = Date.now();
    const table1 = `test_status_a_${ts}`;
    const table2 = `test_status_b_${ts}`;

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // Apply 2 migrations
      await applyCreateTableMigration(engine, table1);
      await new Promise((r) => setTimeout(r, 50));
      await applyCreateTableMigration(engine, table2);

      // Check status
      const statusResult = await engine.getMigrationStatus();
      assertEquals(statusResult.ok, true);
      if (statusResult.ok) {
        assertEquals(
          statusResult.value.applied >= 2,
          true,
          `Should have at least 2 applied migrations, got ${statusResult.value.applied}`,
        );
        assertEquals(statusResult.value.latestMigration !== null, true);
        assertEquals(statusResult.value.currentSchemaHash !== null, true);
      }

      await engine.close();
    } finally {
      await dropTables(
        dsn,
        table1,
        table2,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Rollback: Rollback with no migrations applied - appropriate error",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // Try to rollback a non-existent migration
      const result = await engine.executeRollback("nonexistent_migration_id");
      assertEquals(result.ok, false, "Should fail for non-existent migration");
      if (!result.ok) {
        // Should get a "not found" error from the tracker
        assertEquals(
          result.error.message.includes("not found")
            || result.error.message.includes("not applied"),
          true,
          `Error should mention not found: ${result.error.message}`,
        );
      }

      await engine.close();
    } finally {
      await dropTables(
        dsn,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Rollback: Rollback preserves other tables not in rollback SQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const ts = Date.now();
    const preservedTable = `test_preserved_${ts}`;
    const rolledBackTable = `test_rolledback_${ts}`;

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // Apply two independent migrations
      await applyCreateTableMigration(engine, preservedTable);
      await new Promise((r) => setTimeout(r, 50));
      const rollbackId = await applyCreateTableMigration(
        engine,
        rolledBackTable,
      );

      // Both tables should exist
      assertEquals(
        await tableExists(dsn, preservedTable),
        true,
        "Preserved table should exist",
      );
      assertEquals(
        await tableExists(dsn, rolledBackTable),
        true,
        "Rolled-back table should exist",
      );

      // Rollback only the second migration
      const result = await engine.executeRollback(rollbackId);
      assertEquals(
        result.ok,
        true,
        `Rollback should succeed: ${result.ok ? "" : result.error.message}`,
      );

      // Preserved table should still exist
      assertEquals(
        await tableExists(dsn, preservedTable),
        true,
        "Preserved table should still exist after rollback",
      );

      // Rolled-back table should be gone
      assertEquals(
        await tableExists(dsn, rolledBackTable),
        false,
        "Rolled-back table should not exist after rollback",
      );

      await engine.close();
    } finally {
      await dropTables(
        dsn,
        preservedTable,
        rolledBackTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

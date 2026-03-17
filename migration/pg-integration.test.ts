/**
 * PostgreSQL-backed Migration Integration Tests
 *
 * End-to-end tests that verify the migration engine and schema manager
 * against a real PostgreSQL instance: DDL execution, migration tracking,
 * dry-run mode, transaction rollback, and schema evolution.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import {
  canRunPgTests,
  getTestDsn,
} from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { MigrationEngine } from "./engine.ts";
import { SchemaManager } from "./schema-manager.ts";
import * as Types from "./types.ts";

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

/** Check whether a table exists in the public schema via a raw client. */
async function tableExists(dsn: string, tableName: string): Promise<boolean> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<{ exists: boolean }>(
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

/** Create a ConnectionPool configured for testing. */
function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

/** Create a MigrationEngine configured for testing with a pool. */
function makeEngine(pool: ConnectionPool, dryRun = false): MigrationEngine {
  const config: Types.MigrationConfig = {
    migrations_dir: "",
    schema_file: "",
    database_url: "",
    dry_run: dryRun,
    auto_approve: true,
    backup_before_migration: false,
    rollback_on_error: true,
    connection_pool: pool,
  };
  return new MigrationEngine(config);
}

// =========================================================================
// A. MigrationEngine + Pool Tests
// =========================================================================

Deno.test({
  name: "PG Migration: executeStatements via pool creates table in PG",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const tableName = `test_migration_create_${Date.now()}`;

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // Build a CreateType operation that will produce a CREATE TABLE DDL
      const createOp: Types.CreateTypeOperation = {
        kind: "CreateType",
        type_name: tableName,
        properties: [
          {
            name: "name",
            type: "str",
            required: true,
            multi: false,
            constraints: [],
            annotations: {},
          },
          {
            name: "email",
            type: "str",
            required: true,
            multi: false,
            constraints: ["exclusive"],
            annotations: {},
          },
        ],
        links: [],
      };

      // Plan and execute the migration
      const migration: Types.Migration = {
        id: `test_${Date.now()}`,
        name: "create_test_table",
        description: "Test table creation",
        created_at: new Date(),
        schema_hash: "test_hash",
        operations: [createOp],
      };

      const plan: Types.MigrationPlan = {
        migrations: [migration],
        target_schema_hash: "test_hash",
        operations_count: 1,
      };

      const result = await engine.executeMigration(plan);
      assertEquals(result.ok, true);

      // Verify the table exists in PG
      const exists = await tableExists(dsn, tableName);
      assertEquals(exists, true, "Table should exist after migration");

      // Verify columns
      const columns = await getColumns(dsn, tableName);
      const columnNames = columns.map((c) => c.column_name);
      assertEquals(columnNames.includes("id"), true, "Should have id column");
      assertEquals(columnNames.includes("name"), true, "Should have name column");
      assertEquals(columnNames.includes("email"), true, "Should have email column");

      await engine.close();
    } finally {
      await dropTables(dsn, tableName);
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Migration: executeMigration records to disc_migrations tracker table",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const tableName = `test_migration_track_${Date.now()}`;

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // Build a simple migration
      const createOp: Types.CreateTypeOperation = {
        kind: "CreateType",
        type_name: tableName,
        properties: [
          {
            name: "value",
            type: "int32",
            required: false,
            multi: false,
            constraints: [],
            annotations: {},
          },
        ],
        links: [],
      };

      const migrationId = `track_test_${Date.now()}`;
      const migration: Types.Migration = {
        id: migrationId,
        name: "tracked_migration",
        description: "Migration with tracker recording",
        created_at: new Date(),
        schema_hash: "track_hash",
        operations: [createOp],
      };

      const plan: Types.MigrationPlan = {
        migrations: [migration],
        target_schema_hash: "track_hash",
        operations_count: 1,
      };

      const result = await engine.executeMigration(plan);
      assertEquals(result.ok, true);

      // Query disc_migrations table to verify the record was inserted
      const queryResult = await pool.query(
        `SELECT id, name, description FROM disc_migrations WHERE id = $1`,
        [migrationId],
      );
      assertEquals(queryResult.rowCount, 1, "Should have one migration record");
      assertEquals(queryResult.rows[0].id, migrationId);
      assertEquals(queryResult.rows[0].name, "tracked_migration");

      await engine.close();
    } finally {
      await dropTables(dsn, tableName, "disc_migrations", "disc_migration_checkpoints");
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Migration: dry_run mode does not touch database",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const tableName = `test_migration_dryrun_${Date.now()}`;

    try {
      const engine = makeEngine(pool, /* dryRun */ true);
      await engine.initialize();

      // Build a CreateType operation
      const createOp: Types.CreateTypeOperation = {
        kind: "CreateType",
        type_name: tableName,
        properties: [
          {
            name: "phantom",
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
        id: `dryrun_${Date.now()}`,
        name: "dry_run_migration",
        description: "Should not execute",
        created_at: new Date(),
        schema_hash: "dry_hash",
        operations: [createOp],
      };

      const plan: Types.MigrationPlan = {
        migrations: [migration],
        target_schema_hash: "dry_hash",
        operations_count: 1,
      };

      const result = await engine.executeMigration(plan);
      assertEquals(result.ok, true);

      // Verify the table does NOT exist in PG
      const exists = await tableExists(dsn, tableName);
      assertEquals(exists, false, "Table should NOT exist after dry-run migration");

      await engine.close();
    } finally {
      // Best-effort cleanup in case dry_run somehow failed and table was created
      await dropTables(dsn, tableName, "disc_migrations", "disc_migration_checkpoints");
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Migration: transaction rollback on DDL failure",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const tableName = `test_migration_rollback_${Date.now()}`;

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // First migration: create a valid table (this should succeed on its own)
      const validCreateOp: Types.CreateTypeOperation = {
        kind: "CreateType",
        type_name: tableName,
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

      // Create a migration whose second operation has invalid SQL
      // We use two operations in one migration: the first creates a table,
      // the second tries to alter a non-existent table. Since they run in
      // a single transaction, the first should be rolled back.
      const invalidAlterOp: Types.AlterTypeOperation = {
        kind: "AlterType",
        type_name: `nonexistent_table_${Date.now()}`,
        operations: [
          {
            kind: "AddProperty",
            property: {
              name: "impossible_col",
              type: "str",
              required: true,
              multi: false,
              constraints: [],
              annotations: {},
            },
          } as Types.AddPropertyOperation,
        ],
      };

      const migration: Types.Migration = {
        id: `rollback_${Date.now()}`,
        name: "should_rollback",
        description: "First op succeeds, second fails, all rolls back",
        created_at: new Date(),
        schema_hash: "rollback_hash",
        operations: [validCreateOp, invalidAlterOp],
      };

      const plan: Types.MigrationPlan = {
        migrations: [migration],
        target_schema_hash: "rollback_hash",
        operations_count: 2,
      };

      const result = await engine.executeMigration(plan);

      // The migration should have failed
      assertEquals(result.ok, false, "Migration with invalid SQL should fail");

      // Verify the table from the first operation was NOT created
      // (because PG transactions are atomic for DDL)
      const exists = await tableExists(dsn, tableName);
      assertEquals(
        exists,
        false,
        "Table should NOT exist after transactional rollback",
      );

      await engine.close();
    } finally {
      await dropTables(dsn, tableName, "disc_migrations", "disc_migration_checkpoints");
      await pool.close();
    }
  },
});

// =========================================================================
// B. SchemaManager + Pool Tests
// =========================================================================

Deno.test({
  name: "PG Migration: SchemaManager applySchema creates tables from SDL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    // The DDL generator converts PascalCase to snake_case via typeNameToTableName.
    // "TestSmUser" -> "test_sm_user"
    const expectedTable = "test_sm_user";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestSmUser {
          required name: str;
          required email: str;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(result.ok, true, `applySchema should succeed: ${result.ok ? "" : (result as any).error}`);

      // Verify the table was created
      const exists = await tableExists(dsn, expectedTable);
      assertEquals(exists, true, `Table '${expectedTable}' should exist after applySchema`);

      // Verify columns
      const columns = await getColumns(dsn, expectedTable);
      const columnNames = columns.map((c) => c.column_name);
      assertEquals(columnNames.includes("id"), true, "Should have id column");
      assertEquals(columnNames.includes("name"), true, "Should have name column");
      assertEquals(columnNames.includes("email"), true, "Should have email column");

      await manager.close();
    } finally {
      await dropTables(dsn, expectedTable, "disc_migrations", "disc_migration_checkpoints");
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Migration: SchemaManager applySchema handles schema evolution (ALTER TABLE)",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_evolve_user";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      // Step 1: Apply initial schema
      const sdlV1 = `
        type TestEvolveUser {
          required name: str;
        }
      `;

      const resultV1 = await manager.applySchema(sdlV1);
      assertEquals(resultV1.ok, true, "Initial applySchema should succeed");

      // Verify initial columns
      let columns = await getColumns(dsn, expectedTable);
      let columnNames = columns.map((c) => c.column_name);
      assertEquals(columnNames.includes("name"), true, "Should have name column");
      assertEquals(columnNames.includes("age"), false, "Should NOT have age column yet");

      // Step 2: Apply evolved schema (add age column)
      const sdlV2 = `
        type TestEvolveUser {
          required name: str;
          age: int32;
        }
      `;

      const resultV2 = await manager.applySchema(sdlV2);
      assertEquals(resultV2.ok, true, "Evolved applySchema should succeed");

      // Verify the new column was added
      columns = await getColumns(dsn, expectedTable);
      columnNames = columns.map((c) => c.column_name);
      assertEquals(columnNames.includes("name"), true, "Should still have name column");
      assertEquals(columnNames.includes("age"), true, "Should now have age column");

      await manager.close();
    } finally {
      await dropTables(dsn, expectedTable, "disc_migrations", "disc_migration_checkpoints");
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Migration: SchemaManager getSchema returns valid Schema after apply",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "test_schema_type";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type TestSchemaType {
          required title: str;
          active: bool;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(result.ok, true, "applySchema should succeed");

      // Retrieve the Schema object
      const schema = manager.getSchema();
      assertExists(schema, "getSchema() should return a Schema after applySchema");
      assertExists(schema!.types, "Schema should have types");

      const typeDef = schema!.types.get("TestSchemaType");
      assertExists(typeDef, "Schema should contain TestSchemaType");
      assertEquals(typeDef!.name, "TestSchemaType");
      assertEquals(typeDef!.kind, "object");

      // Check properties
      const titleProp = typeDef!.properties.get("title");
      assertExists(titleProp, "TypeDef should have title property");
      assertEquals(titleProp!.required, true);

      const activeProp = typeDef!.properties.get("active");
      assertExists(activeProp, "TypeDef should have active property");
      assertEquals(activeProp!.required, false);

      // Check implicit id property
      const idProp = typeDef!.properties.get("id");
      assertExists(idProp, "TypeDef should have implicit id property");
      assertEquals(idProp!.required, true);

      await manager.close();
    } finally {
      await dropTables(dsn, expectedTable, "disc_migrations", "disc_migration_checkpoints");
      await pool.close();
    }
  },
});

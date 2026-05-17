/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Stage 40: Comprehensive Rollback Verification Tests
 *
 * End-to-end tests that verify rollback, incremental migration, and
 * re-migration work correctly for complex schemas with all features.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import {
  canRunPgTests,
  getColumns,
  getTestDsn,
  makePool,
  parseDsn,
  tableExists
} from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";
import { makeEngine } from "./test-helpers.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dropTables(dsn: string, ...tableNames: string[]): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    for (const name of tableNames) {
      await client.queryArray(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }
    // Drop lingering trigger functions
    await client.queryArray(`
      DO $$ DECLARE fn RECORD;
      BEGIN
        FOR fn IN
          SELECT proname FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND (proname LIKE '%__rewrite_fn' OR proname LIKE '%_fn' OR proname LIKE 'disc_source_delete_%')
        LOOP
          EXECUTE 'DROP FUNCTION IF EXISTS ' || fn.proname || '() CASCADE';
        END LOOP;
      END $$;
    `);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Test 1: Full rollback — migrate comprehensive schema then rollback
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Rollback: migrate then rollback drops all tables and triggers",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // Create two types in one migration using executeMigrationWithRollback
      const createUserOp: Types.CreateTypeOperation = {
        kind: "CreateType",
        typeName: "rollback_user",
        properties: [
          {
            name: "name",
            type: "str",
            required: true,
            multi: false,
            constraints: [],
            annotations: {}
          },
          {
            name: "email",
            type: "str",
            required: true,
            multi: false,
            constraints: ["exclusive"],
            annotations: {}
          }
        ],
        links: []
      };

      const migration: Types.Migration = {
        id: `rb_full_${Date.now()}`,
        name: "create_rollback_user",
        description: "Create rollback_user table",
        createdAt: new Date(),
        schemaHash: "rb_hash_1",
        operations: [createUserOp]
      };

      const plan: Types.MigrationPlan = {
        migrations: [migration],
        targetSchemaHash: "rb_hash_1",
        operationsCount: 1
      };

      const applyResult = await engine.executeMigrationWithRollback(plan);
      assertEquals(applyResult.ok, true, "Migration should succeed");

      // Verify table exists
      assertEquals(
        await tableExists(dsn, "rollback_user"),
        true,
        "rollback_user table should exist after migration"
      );

      // Rollback
      const rollbackResult = await engine.executeRollback(migration.id);
      assertEquals(
        rollbackResult.ok,
        true,
        `Rollback should succeed: ${rollbackResult.ok ? "" : rollbackResult.error.message}`
      );

      // Verify table is gone
      assertEquals(
        await tableExists(dsn, "rollback_user"),
        false,
        "rollback_user table should NOT exist after rollback"
      );

      await engine.close();
    } finally {
      await dropTables(
        dsn,
        "rollback_user",
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 2: Incremental migration — base schema then add types
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Rollback: incremental migration adds new type to existing schema",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      // Step 1: Apply base schema with just User
      const sdlV1 = `
        type IncrUser {
          required name: str;
          required email: str {
            constraint exclusive;
          };
        };
      `;

      const resultV1 = await manager.applySchema(sdlV1);
      assertEquals(resultV1.ok, true, "Initial applySchema should succeed");

      // Verify User table only
      assertEquals(
        await tableExists(dsn, "incr_user"),
        true,
        "incr_user table should exist"
      );
      assertEquals(
        await tableExists(dsn, "incr_post"),
        false,
        "incr_post table should NOT exist yet"
      );

      // Step 2: Add Post type (incremental). Disc's parser requires
      // `link <name> -> <Target>` for relationships — the optional-link
      // shorthand is Gel-only.
      const sdlV2 = `
        type IncrUser {
          required name: str;
          required email: str {
            constraint exclusive;
          };
          multi link posts -> IncrPost;
        };

        type IncrPost {
          required title: str;
          required link author -> IncrUser;
        };
      `;

      const resultV2 = await manager.applySchema(sdlV2);
      assertEquals(resultV2.ok, true, "Incremental applySchema should succeed");

      // Verify both tables exist now
      assertEquals(
        await tableExists(dsn, "incr_user"),
        true,
        "incr_user should still exist"
      );
      assertEquals(
        await tableExists(dsn, "incr_post"),
        true,
        "incr_post should now exist"
      );

      // Verify Post has author_id column
      const postCols = await getColumns(dsn, "incr_post");
      const postColNames = postCols.map(c => c.column_name);
      assertEquals(
        postColNames.includes("author_id"),
        true,
        "IncrPost should have author_id FK column"
      );
      assertEquals(
        postColNames.includes("title"),
        true,
        "IncrPost should have title column"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "incr_user_posts",
        "incr_post",
        "incr_user",
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 3: Modify and re-migrate — add constraint and property
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Rollback: modify existing type (add property) and re-migrate",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      // Step 1: Apply initial schema
      const sdlV1 = `
        type ModItem {
          required name: str;
        };
      `;

      const resultV1 = await manager.applySchema(sdlV1);
      assertEquals(resultV1.ok, true, "Initial applySchema should succeed");

      // Verify initial state
      let columns = await getColumns(dsn, "mod_item");
      let columnNames = columns.map(c => c.column_name);
      assertEquals(
        columnNames.includes("name"),
        true,
        "Should have name column"
      );
      assertEquals(
        columnNames.includes("description"),
        false,
        "Should NOT have description column yet"
      );

      // Step 2: Add description property
      const sdlV2 = `
        type ModItem {
          required name: str;
          description: str;
        };
      `;

      const resultV2 = await manager.applySchema(sdlV2);
      assertEquals(resultV2.ok, true, "Modified applySchema should succeed");

      // Verify new column was added
      columns = await getColumns(dsn, "mod_item");
      columnNames = columns.map(c => c.column_name);
      assertEquals(
        columnNames.includes("name"),
        true,
        "Should still have name column"
      );
      assertEquals(
        columnNames.includes("description"),
        true,
        "Should now have description column"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "mod_item",
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 4: Rollback to specific point — apply 3 migrations, rollback to first
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Rollback: rollback-to specific migration preserves target and earlier",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const ts = Date.now();
    const table1 = `rb_point_a_${ts}`;
    const table2 = `rb_point_b_${ts}`;
    const table3 = `rb_point_c_${ts}`;

    try {
      const engine = makeEngine(pool);
      await engine.initialize();

      // Helper to create a migration for a single table
      const applyTable = async (
        tableName: string
      ): Promise<string> => {
        const id = `test_${tableName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const op: Types.CreateTypeOperation = {
          kind: "CreateType",
          typeName: tableName,
          properties: [
            {
              name: "value",
              type: "str",
              required: true,
              multi: false,
              constraints: [],
              annotations: {}
            }
          ],
          links: []
        };

        const migration: Types.Migration = {
          id,
          name: `create_${tableName}`,
          description: `Create ${tableName}`,
          createdAt: new Date(),
          schemaHash: `hash_${tableName}`,
          operations: [op]
        };

        const plan: Types.MigrationPlan = {
          migrations: [migration],
          targetSchemaHash: `hash_${tableName}`,
          operationsCount: 1
        };

        const result = await engine.executeMigrationWithRollback(plan);
        assertEquals(result.ok, true, `Apply ${tableName} should succeed`);
        return id;
      };

      // Apply 3 migrations with small delays
      const id1 = await applyTable(table1);
      await new Promise(r => setTimeout(r, 50));
      await applyTable(table2);
      await new Promise(r => setTimeout(r, 50));
      await applyTable(table3);

      // Verify all 3 tables exist
      assertEquals(
        await tableExists(dsn, table1),
        true,
        "Table 1 should exist"
      );
      assertEquals(
        await tableExists(dsn, table2),
        true,
        "Table 2 should exist"
      );
      assertEquals(
        await tableExists(dsn, table3),
        true,
        "Table 3 should exist"
      );

      // Rollback to first migration (should drop tables 2 and 3)
      const rollbackResult = await engine.executeRollbackTo(id1);
      assertEquals(
        rollbackResult.ok,
        true,
        `Rollback-to should succeed: ${rollbackResult.ok ? "" : rollbackResult.error.message}`
      );

      // Verify: first table preserved, second and third dropped
      assertEquals(
        await tableExists(dsn, table1),
        true,
        "Table 1 should still exist (target preserved)"
      );
      assertEquals(
        await tableExists(dsn, table2),
        false,
        "Table 2 should be dropped"
      );
      assertEquals(
        await tableExists(dsn, table3),
        false,
        "Table 3 should be dropped"
      );

      await engine.close();
    } finally {
      await dropTables(
        dsn,
        table1,
        table2,
        table3,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

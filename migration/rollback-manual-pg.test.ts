/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A rollback that needs manual steps is refused, not half-run.
 *
 * Some down-migrations can't be generated (a dropped index, trigger or link
 * has no stored definition), so the rollback SQL carries a
 * `-- MANUAL ROLLBACK REQUIRED` comment instead. Running what's left and
 * deleting the history row would leave the database out of step with the
 * recorded history — so the rollback must refuse and keep the record. A
 * `--dry-run` rollback shows those lines and changes nothing.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { cleanupTempDir, ConsoleCapture, createTempDir } from "../tests/test-utils.ts";
import { CLICommands } from "../cli/commands.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { makeEngine } from "./test-helpers.ts";
import { SchemaManager } from "./schema-manager.ts";

import type * as Types from "./types.ts";

const TABLE = "sprocket_manual_rb";

function migration(id: string, operation: Types.MigrationOperation): Types.Migration {
  return {
    createdAt: new Date(),
    description: id,
    id,
    name: id,
    operations: [operation],
    schemaHash: `hash_${id}`
  };
}

/*** Records two migrations through `executeMigrationWithRollback` (the path that stores each
     one's rollback SQL): a CREATE, then an index drop. The index drop's rollback can't recreate
     the index, so it is a manual step. ***/
async function applyDropIndexMigration(pool: ConnectionPool): Promise<void> {
  const engine = makeEngine(pool);
  await engine.initialize();

  const create: Types.CreateTypeOperation = {
    kind: "CreateType",
    links: [],
    properties: [{ annotations: {}, constraints: [], multi: false, name: "name", required: true, type: "str" }],
    typeName: TABLE
  };

  const dropIndex: Types.DropIndexOperation = { indexName: `${TABLE}_name_idx`, kind: "DropIndex" };
  const steps: [string, Types.MigrationOperation][] = [["m_create", create], ["m_drop_index", dropIndex]];

  for (const [id, operation] of steps) {
    const result = await engine.executeMigrationWithRollback({
      migrations: [migration(id, operation)],
      operationsCount: 1,
      targetSchemaHash: `hash_${id}`
    });

    assertEquals(result.ok, true, result.ok ? "" : result.error.message);
  }

  await engine.close();

  const latest = await pool.query(`SELECT rollback_sql FROM disc_migrations WHERE id = 'm_drop_index'`);
  const rollbackSql = (latest.rows[0].rollback_sql as string[]).join("\n");
  assertStringIncludes(rollbackSql, "MANUAL ROLLBACK REQUIRED", "precondition: the drop-index rollback is a manual step");
}

async function migrationCount(pool: ConnectionPool): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`);
  return result.rows[0].n as number;
}

Deno.test({
  name: "PG: rollback of a migration with manual steps is refused and keeps the record",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await applyDropIndexMigration(pool);
      assertEquals(await migrationCount(pool), 2);

      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const result = await manager.rollbackLastMigration();
      await manager.close();

      assertEquals(result.ok, false, "a rollback with manual steps must not report success");

      if (!result.ok) {
        assertStringIncludes(result.error.message, "manual");
        assertStringIncludes(result.error.message, "Recreate index");
      }

      assertEquals(await migrationCount(pool), 2, "the migration record stays when the rollback is refused");
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: rollback-to refuses before running anything when a migration in range needs manual steps",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await applyDropIndexMigration(pool);

      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const result = await manager.rollbackToMigration("m_create");
      await manager.close();

      assertEquals(result.ok, false);

      if (!result.ok)
        assertStringIncludes(result.error.message, "Recreate index");

      assertEquals(await migrationCount(pool), 2);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: disc migrate --rollback --dry-run shows the manual steps and changes nothing",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    /*** Run from an empty directory: no disc.toml above it, so the CLI can only reach `--backend-dsn`. ***/
    const tempDir = await createTempDir();

    try {
      await resetTestDatabase(pool);
      await applyDropIndexMigration(pool);

      Deno.chdir(tempDir);
      capture.start();
      await new CLICommands().migrate({ _: ["migrate"], "backend-dsn": dsn, "dry-run": true, rollback: true });
      capture.stop();

      const output = [...capture.getLogs(), ...capture.getErrors()].join("\n");
      assertStringIncludes(output, "MANUAL ROLLBACK REQUIRED: Recreate index");
      assert(!output.includes("Successfully rolled back"), `a dry run reported a rollback:\n${output}`);
      assertEquals(await migrationCount(pool), 2, "a dry run removes no migration record");
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

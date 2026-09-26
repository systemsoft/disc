/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc migrate --rollback` undoes a migration `disc migrate` applied.
 *
 * The normal apply path used to record migrations without rollback SQL, so
 * every CLI rollback failed with "No rollback SQL available". A rollback must
 * also leave the history consistent: the next `disc migrate` diffs against the
 * rolled-back-to snapshot and re-applies the change.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CLICommands } from "../cli/commands.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getColumns, getTestDsn, makePool, resetTestDatabase, tableExists } from "../tests/pg-test-harness.ts";
import { cleanupTempDir, ConsoleCapture, createTempDir } from "../tests/test-utils.ts";
import { SchemaManager } from "./schema-manager.ts";

const V1 = `module default {
  type Channel { required name: str; };
};`;

const V2 = `module default {
  type Channel {
    required name: str;
    slug: str { constraint exclusive; };
  };
  type Video { required title: str; };
};`;

async function columnNames(dsn: string, table: string): Promise<string[]> {
  return (await getColumns(dsn, table)).map(c => c.column_name);
}

async function indexExists(pool: ConnectionPool, name: string): Promise<boolean> {
  const result = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [name]);
  return result.rows.length > 0;
}

async function migrationCount(pool: ConnectionPool): Promise<number> {
  return (await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`)).rows[0].n as number;
}

/*** Runs `disc migrate` against `sdl`, the way the CLI does: a fresh process (manager) per run. ***/
async function cliMigrate(dsn: string, dir: string, sdl: string): Promise<void> {
  const schemaFile = `${dir}/default.disc`;
  await Deno.writeTextFile(schemaFile, sdl);
  await new CLICommands().migrate({ _: ["migrate"], "backend-dsn": dsn, quiet: true, schema: schemaFile });
}

async function cliRollback(dsn: string): Promise<void> {
  await new CLICommands().migrate({ _: ["migrate"], "backend-dsn": dsn, force: true, rollback: true });
}

Deno.test({
  name: "PG: disc migrate --rollback undoes a migration applied by disc migrate, and re-migrating re-applies it",
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
      Deno.chdir(tempDir);
      capture.start();

      await cliMigrate(dsn, tempDir, V1);
      await cliMigrate(dsn, tempDir, V2);
      assertEquals(await migrationCount(pool), 2);
      assert(await tableExists(dsn, "video"));
      assert((await columnNames(dsn, "channel")).includes("slug"));
      assert(await indexExists(pool, "uk_channel_slug"));

      await cliRollback(dsn);

      assertEquals(await migrationCount(pool), 1, "the rolled-back migration's record is removed");
      assertEquals(await tableExists(dsn, "video"), false, "the added type's table is dropped");
      assertEquals((await columnNames(dsn, "channel")).includes("slug"), false, "the added property's column is dropped");
      assertEquals(await indexExists(pool, "uk_channel_slug"), false);
      assert(await tableExists(dsn, "channel"), "the v1 table survives");

      /*** The next migrate diffs against the v1 snapshot, so it re-creates what was rolled back. ***/
      await cliMigrate(dsn, tempDir, V2);
      assertEquals(await migrationCount(pool), 2);
      assert(await tableExists(dsn, "video"));
      assert((await columnNames(dsn, "channel")).includes("slug"));
      assert(await indexExists(pool, "uk_channel_slug"));

      /*** And the snapshot it recorded is v2: one more migrate is a no-op. ***/
      await cliMigrate(dsn, tempDir, V2);
      assertEquals(await migrationCount(pool), 2);
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: SchemaManager diffs against the rolled-back-to snapshot after a rollback on the same instance",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    const manager = new SchemaManager({ pool });

    try {
      await resetTestDatabase(pool);
      await manager.initialize();

      for (const sdl of [V1, V2]) {
        const applied = await manager.applySchema(sdl);
        assertEquals(applied.ok, true, applied.ok ? "" : applied.error.message);
      }

      const rolledBack = await manager.rollbackLastMigration();
      assertEquals(rolledBack.ok, true, rolledBack.ok ? "" : rolledBack.error.message);
      assertEquals(await tableExists(dsn, "video"), false);

      const reapplied = await manager.applySchema(V2);
      assertEquals(reapplied.ok, true, reapplied.ok ? "" : reapplied.error.message);
      assertEquals(reapplied.ok && reapplied.value.length, 1, "re-applying v2 runs a migration, not a no-op");
      assert(await tableExists(dsn, "video"));
      assertEquals(await migrationCount(pool), 2);
    } finally {
      await manager.close();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: a migration recorded without rollback SQL still fails with a clear error",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await resetTestDatabase(pool);

      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema(V1);
      assertEquals(applied.ok, true, applied.ok ? "" : applied.error.message);

      /*** A row recorded before rollback SQL was stored. ***/
      await pool.query(`UPDATE disc_migrations SET rollback_sql = NULL`);

      const result = await manager.rollbackLastMigration();
      await manager.close();

      assertEquals(result.ok, false);

      if (!result.ok)
        assertStringIncludes(result.error.message, "No rollback SQL available");

      assertEquals(await migrationCount(pool), 1);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: rolling back a migration whose CREATE TABLE drift repair skipped keeps the pre-existing table and its rows",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    const tempDir = await createTempDir();

    try {
      await resetTestDatabase(pool);
      Deno.chdir(tempDir);
      capture.start();

      await cliMigrate(dsn, tempDir, V1);
      await pool.query(`INSERT INTO channel (name) VALUES ('kept')`);

      /*** History lost, table kept: the next migrate re-plans from scratch and drift repair
           skips the CREATE TABLE for `channel`, so this migration never created it. ***/
      await pool.query(`DELETE FROM disc_migrations`);
      await cliMigrate(
        dsn,
        tempDir,
        `module default {
        type Channel { required name: str; };
        type Video { required title: str; };
      };`
      );
      assert(await tableExists(dsn, "video"));

      await cliRollback(dsn);

      assertEquals(await tableExists(dsn, "video"), false, "the table this migration created is dropped");
      assert(await tableExists(dsn, "channel"), "the pre-existing table survives");
      assertEquals((await pool.query(`SELECT name FROM channel`)).rows.map(row => row.name), ["kept"]);
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

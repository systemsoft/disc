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

/*** Adds a type with a multi link (with a link property), delete-target links (single and multi,
     on the new type and added to the existing one) and an enum: objects beyond the type's table. ***/
const V2_LINKED = `module default {
  scalar type RbkStatus extending enum<Draft, Live>;
  type Channel {
    required name: str;
    multi featured: RbkVideo { on source delete delete target; };
    link pinned: RbkVideo { on source delete delete target; };
  };
  type RbkTag { required label: str; };
  type RbkVideo {
    required title: str;
    status: RbkStatus;
    multi tags: RbkTag { weight: int64; };
    multi clips: RbkTag { on source delete delete target; };
    link thumbnail: RbkTag { on source delete delete target; };
  };
};`;

/*** The functions, triggers and enum types in `public` (tables are checked with `tableExists`). ***/
async function nonTableObjects(pool: ConnectionPool): Promise<string[]> {
  const result = await pool.query(`
    SELECT 'function ' || p.proname AS name FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
    UNION ALL
    SELECT 'trigger ' || t.tgname FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'type ' || t.typname FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typtype = 'e'
    ORDER BY 1
  `);
  return result.rows.map(row => row.name as string);
}

/*** `resetTestDatabase` drops tables only; clear what V2_LINKED adds besides them. ***/
async function dropLinkedObjects(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);

  for (const name of await nonTableObjects(pool)) {
    const [kind, object] = name.split(" ");

    if (kind === "function" && object.includes("source_delete"))
      await pool.query(`DROP FUNCTION IF EXISTS "${object}"() CASCADE`);

    if (kind === "type" && object === "disc_enum_rbkstatus")
      await pool.query(`DROP TYPE IF EXISTS "${object}" CASCADE`);
  }
}

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

Deno.test({
  name: "PG: rolling back a migration removes the junction tables, trigger functions and enums it created, and nothing else",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    const tempDir = await createTempDir();
    const created = ["channel_featured", "rbk_tag", "rbk_video", "rbk_video_clips", "rbk_video_tags"];

    try {
      await dropLinkedObjects(pool);
      Deno.chdir(tempDir);
      capture.start();

      await cliMigrate(dsn, tempDir, V1);
      await pool.query(`INSERT INTO channel (name) VALUES ('kept')`);
      const before = await nonTableObjects(pool);

      await cliMigrate(dsn, tempDir, V2_LINKED);
      assertEquals(await migrationCount(pool), 2);

      for (const table of created)
        assert(await tableExists(dsn, table), `v2 creates ${table}`);

      assert((await nonTableObjects(pool)).includes("type disc_enum_rbkstatus"));
      assert((await nonTableObjects(pool)).includes("function disc_source_delete_channel_pinned"));

      await cliRollback(dsn);

      assertEquals(await migrationCount(pool), 1);

      for (const table of created)
        assertEquals(await tableExists(dsn, table), false, `rollback drops ${table}`);

      assertEquals(await nonTableObjects(pool), before, "every trigger, trigger function and enum v2 created is gone");
      assertEquals((await columnNames(dsn, "channel")).includes("pinned_id"), false);
      assertEquals((await pool.query(`SELECT name FROM channel`)).rows.map(row => row.name), ["kept"], "pre-existing rows remain");

      /*** No trigger is left behind on the surviving table to break a delete. ***/
      await pool.query(`DELETE FROM channel`);
      await pool.query(`INSERT INTO channel (name) VALUES ('kept')`);

      await cliMigrate(dsn, tempDir, V2_LINKED);
      assertEquals(await migrationCount(pool), 2, "re-migrating re-applies v2");

      for (const table of created)
        assert(await tableExists(dsn, table), `re-migrating re-creates ${table}`);

      await cliMigrate(dsn, tempDir, V2_LINKED);
      assertEquals(await migrationCount(pool), 2, "a further migrate is a no-op");
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await dropLinkedObjects(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: rolling back a migration whose junction CREATE drift repair skipped keeps the pre-existing junction and its rows",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    const tempDir = await createTempDir();
    const linked = `module default {
      type Channel { required name: str; multi tags: RbkTag; };
      type RbkTag { required label: str; };
    };`;

    try {
      await resetTestDatabase(pool);
      Deno.chdir(tempDir);
      capture.start();

      await cliMigrate(dsn, tempDir, linked);
      await pool.query(`
        WITH c AS (INSERT INTO channel (name) VALUES ('kept') RETURNING id),
             t AS (INSERT INTO rbk_tag (label) VALUES ('kept') RETURNING id)
        INSERT INTO channel_tags (source_id, target_id) SELECT c.id, t.id FROM c, t
      `);

      /*** History lost, tables kept: drift repair skips every existing CREATE, junction included. ***/
      await pool.query(`DELETE FROM disc_migrations`);
      await cliMigrate(
        dsn,
        tempDir,
        `module default {
          type Channel { required name: str; multi tags: RbkTag; };
          type RbkTag { required label: str; };
          type RbkVideo { required title: str; multi tags: RbkTag; };
        };`
      );
      assert(await tableExists(dsn, "rbk_video_tags"));

      await cliRollback(dsn);

      assertEquals(await tableExists(dsn, "rbk_video"), false);
      assertEquals(await tableExists(dsn, "rbk_video_tags"), false, "the junction this migration created is dropped");

      for (const table of ["channel", "channel_tags", "rbk_tag"])
        assert(await tableExists(dsn, table), `the pre-existing ${table} survives`);

      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM channel_tags`)).rows[0].n, 1);
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

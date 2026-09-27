/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `disc migrate --rollback` of a migration that dropped a type, a property
 * and links puts back the structure the migration started from.
 *
 * A drop's rollback used to be a manual step, so the rollback was refused.
 * The rollback SQL stored at apply time now recreates each dropped object
 * from the schema the migration was planned from, and the data the migration
 * deleted comes back empty (with a warning naming it).
 *
 * Unit coverage lives in `migration/rollback-restore.test.ts`.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { CLICommands } from "../cli/commands.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase, tableExists } from "../tests/pg-test-harness.ts";
import { cleanupTempDir, ConsoleCapture, createTempDir } from "../tests/test-utils.ts";

/*** RbrVideo has a multi link (with a link property), an enum property, an index, an exclusive
     constraint and a delete-target link; RbrChannel has a property and links v2 drops. ***/
const V1 = `module default {
  scalar type RbrStatus extending enum<Draft, Live>;
  type RbrChannel {
    required name: str;
    nickname: str { constraint exclusive; default := 'none'; };
    link pinned: RbrVideo;
    multi likes: RbrVideo;
  };
  type RbrTag { required label: str; };
  type RbrVideo {
    required title: str { constraint exclusive; };
    status: RbrStatus;
    views: int64 { constraint min_value(0); };
    multi tags: RbrTag { weight: int64; };
    link thumbnail: RbrTag { on source delete delete target; };
    index on (.views);
  };
};`;

const V2 = `module default {
  type RbrChannel { required name: str; };
  type RbrTag { required label: str; };
};`;

/*** Tables, columns, constraints, indexes, triggers, trigger functions and enums in `public`, Disc's own tables left out. ***/
async function structure(pool: ConnectionPool): Promise<string[]> {
  const result = await pool.query(`
    SELECT 'column ' || table_name || '.' || column_name || ' ' || udt_name || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS item
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name NOT LIKE 'disc\\_%'
    UNION ALL
    SELECT 'constraint ' || c.conrelid::regclass::text || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid)
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public' AND c.conrelid <> 0 AND c.conrelid::regclass::text NOT LIKE 'disc\\_%'
    UNION ALL
    SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename NOT LIKE 'disc\\_%'
    UNION ALL
    SELECT 'trigger ' || c.relname || ' ' || pg_get_triggerdef(t.oid)
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'function ' || p.proname || ' ' || p.prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype
    UNION ALL
    SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      GROUP BY t.typname
    ORDER BY 1
  `);
  return result.rows.map(row => row.item as string);
}

/*** `resetTestDatabase` drops tables only; also drop the trigger functions and enums these schemas create. ***/
async function resetAll(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);

  const functions = await pool.query(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prorettype = 'trigger'::regtype AND p.proname LIKE '%rbr\\_%'
  `);

  for (const row of functions.rows)
    await pool.query(`DROP FUNCTION IF EXISTS "${row.proname}"() CASCADE`);

  await pool.query(`DROP TYPE IF EXISTS disc_enum_rbrstatus CASCADE`);
}

async function migrationCount(pool: ConnectionPool): Promise<number> {
  return (await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`)).rows[0].n as number;
}

/*** Runs `disc migrate --unsafe` against `sdl`, the way the CLI does: a fresh process (manager) per run. ***/
async function cliMigrate(dsn: string, dir: string, sdl: string): Promise<void> {
  const schemaFile = `${dir}/default.disc`;
  await Deno.writeTextFile(schemaFile, sdl);
  await new CLICommands().migrate({ _: ["migrate"], "backend-dsn": dsn, quiet: true, schema: schemaFile, unsafe: true });
}

async function cliRollback(dsn: string): Promise<void> {
  await new CLICommands().migrate({ _: ["migrate"], "backend-dsn": dsn, force: true, rollback: true });
}

Deno.test({
  name: "PG: disc migrate --rollback of a migration that dropped a type, a property and links restores the v1 structure",
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
      await resetAll(pool);
      Deno.chdir(tempDir);
      capture.start();

      await cliMigrate(dsn, tempDir, V1);
      const v1 = await structure(pool);

      for (
        const item of ["column rbr_video_tags.weight", "enum disc_enum_rbrstatus Draft,Live", "index CREATE INDEX idx_rbr_video_views", "trigger rbr_video "]
      )
        assert(v1.some(entry => entry.startsWith(item)), `precondition: v1 has ${item}:\n${v1.join("\n")}`);
      await pool.query(`INSERT INTO rbr_channel (name) VALUES ('kept')`);
      await pool.query(`INSERT INTO rbr_video (title) VALUES ('gone')`);

      await cliMigrate(dsn, tempDir, V2);
      assertEquals(await migrationCount(pool), 2, "v2 applies");
      assertEquals(await tableExists(dsn, "rbr_video"), false);

      const logged = capture.getLogs().length + capture.getErrors().length;
      await cliRollback(dsn);
      const output = [...capture.getLogs(), ...capture.getErrors()].slice(logged).join("\n");

      assertEquals(await migrationCount(pool), 1, `the rollback runs and removes the v2 record:\n${output}`);
      assertEquals(await structure(pool), v1, "the rollback restores the structure a fresh v1 migrate created");
      assertEquals((await pool.query(`SELECT name, nickname FROM rbr_channel`)).rows, [{ name: "kept", nickname: "none" }]);
      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM rbr_video`)).rows[0].n, 0, "the dropped type's rows don't come back");

      for (const restored of ["table 'rbr_video'", "column 'rbr_channel.nickname'", "link 'rbr_channel.pinned'", "link 'rbr_video.tags'"])
        assertStringIncludes(output, restored, "the rollback warns about what comes back empty");

      /*** The recreated delete-target trigger works. ***/
      const tag = (await pool.query(`INSERT INTO rbr_tag (label) VALUES ('thumb') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO rbr_video (title, thumbnail_id, status) VALUES ('back', $1, 'Live')`, [tag]);
      await pool.query(`DELETE FROM rbr_video`);
      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM rbr_tag`)).rows[0].n, 0, "deleting the video deletes its thumbnail");

      await cliMigrate(dsn, tempDir, V1);
      assertEquals(await migrationCount(pool), 1, "migrating to v1 after the rollback is a no-op");

      await cliMigrate(dsn, tempDir, V2);
      assertEquals(await migrationCount(pool), 2, "re-migrating to v2 works");
      assertEquals(await tableExists(dsn, "rbr_video"), false);
      assert(await tableExists(dsn, "rbr_channel"));
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await resetAll(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: rolling back a dropped required property on a table with rows fails and keeps the record",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    const tempDir = await createTempDir();

    try {
      await resetAll(pool);
      Deno.chdir(tempDir);
      capture.start();

      await cliMigrate(dsn, tempDir, `module default { type RbrItem { required name: str; required code: str; }; };`);
      await cliMigrate(dsn, tempDir, `module default { type RbrItem { required name: str; }; };`);
      await pool.query(`INSERT INTO rbr_item (name) VALUES ('kept')`);

      await assertRejects(() => cliRollback(dsn), Error, `column "code" of relation "rbr_item" contains null values`);

      assertEquals(await migrationCount(pool), 2, "the column can't come back NOT NULL over existing rows: nothing is rolled back");
      assertEquals((await pool.query(`SELECT name FROM rbr_item`)).rows, [{ name: "kept" }]);
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await resetAll(pool);
      await pool.close();
    }
  }
});

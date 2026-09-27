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

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
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

/*** An abstract parent's `if orphan` link is inherited by every subtype, so each subtype's trigger reads every holder's link column (or junction). ***/
function inheritedIfOrphan(multi: boolean, subtypes: string[]): string {
  const link = multi ?
    "multi link tags: RbkTag { on source delete delete target if orphan; };" :
    "link tag: RbkTag { on source delete delete target if orphan; };";

  return `module default {
    type RbkTag { required name: str; };
    abstract type RbkItem { ${link} };
    ${subtypes.map(name => `type ${name} extending RbkItem;`).join("\n    ")}
  };`;
}

/*** Insert a `note` linked to `tag` through the single (`tag`) or the multi (`tags`) link. ***/
async function insertNote(pool: ConnectionPool, tag: string, multi: boolean): Promise<string> {
  if (!multi)
    return (await pool.query(`INSERT INTO note (tag_id) VALUES ($1) RETURNING id`, [tag])).rows[0].id as string;

  const id = (await pool.query(`INSERT INTO note DEFAULT VALUES RETURNING id`)).rows[0].id as string;
  await pool.query(`INSERT INTO note_tags (source_id, target_id) VALUES ($1, $2)`, [id, tag]);
  return id;
}

async function tagNames(pool: ConnectionPool): Promise<string[]> {
  return (await pool.query(`SELECT name FROM rbk_tag ORDER BY name`)).rows.map(row => row.name as string);
}

async function noteTriggerBody(pool: ConnectionPool): Promise<string> {
  return (await pool.query(`SELECT prosrc FROM pg_proc WHERE proname = 'disc_source_delete_note_tag'`)).rows[0].prosrc as string;
}

async function firstMigrationId(pool: ConnectionPool): Promise<string> {
  return (await pool.query(`SELECT id FROM disc_migrations ORDER BY applied_order LIMIT 1`)).rows[0].id as string;
}

Deno.test({
  name: "PG: rolling back the addition of a subtype holding an inherited if-orphan link repairs the other subtypes' triggers",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    const tempDir = await createTempDir();

    try {
      Deno.chdir(tempDir);
      capture.start();

      for (const { multi, rollbackTo } of [{ multi: false, rollbackTo: false }, { multi: true, rollbackTo: true }]) {
        const label = multi ? "multi link, --rollback-to" : "single link, --rollback";
        const v1 = inheritedIfOrphan(multi, ["Note"]);
        await dropLinkedObjects(pool);

        await cliMigrate(dsn, tempDir, v1);
        await cliMigrate(dsn, tempDir, inheritedIfOrphan(multi, ["Note", "Task"]));
        assert(await tableExists(dsn, "task"));

        if (rollbackTo) {
          await new CLICommands().migrate({ _: ["migrate"], "backend-dsn": dsn, force: true, "rollback-to": await firstMigrationId(pool) });
        } else {
          await cliRollback(dsn);
        }

        assertEquals(await migrationCount(pool), 1, label);
        assertEquals(await tableExists(dsn, "task"), false, `${label}: the added subtype's table is dropped`);

        /*** The note's trigger no longer reads the dropped `task` table, and still keeps a target another note links. ***/
        const shared = (await pool.query(`INSERT INTO rbk_tag (name) VALUES ('shared') RETURNING id`)).rows[0].id as string;
        const first = await insertNote(pool, shared, multi);
        const second = await insertNote(pool, shared, multi);

        await pool.query(`DELETE FROM note WHERE id = $1`, [first]);
        assertEquals(await tagNames(pool), ["shared"], `${label}: still linked by the second note`);

        await pool.query(`DELETE FROM note WHERE id = $1`, [second]);
        assertEquals(await tagNames(pool), [], `${label}: orphaned by the last note`);

        await cliMigrate(dsn, tempDir, v1);
        assertEquals(await migrationCount(pool), 1, `${label}: migrating to the rolled-back-to schema is a no-op`);
      }
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
  name: "PG: disc migrate --rollback --dry-run previews the repairs the rollback runs, and changes nothing",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    const tempDir = await createTempDir();

    try {
      await dropLinkedObjects(pool);
      Deno.chdir(tempDir);
      capture.start();

      await cliMigrate(dsn, tempDir, inheritedIfOrphan(false, ["Note"]));
      await cliMigrate(dsn, tempDir, inheritedIfOrphan(false, ["Note", "Task"]));
      const before = await nonTableObjects(pool);
      const bodyBefore = await noteTriggerBody(pool);
      const logged = capture.getLogs().length;
      const errored = capture.getErrors().length;

      await new CLICommands().migrate({ _: ["migrate"], "backend-dsn": dsn, "dry-run": true, rollback: true });
      const output = [...capture.getLogs().slice(logged), ...capture.getErrors().slice(errored)].join("\n");

      assertStringIncludes(output, "repairing the database for the rolled-back-to schema would execute:");
      assertStringIncludes(
        output,
        "CREATE OR REPLACE FUNCTION disc_source_delete_note_tag() RETURNS TRIGGER AS $$ BEGIN IF NOT EXISTS (SELECT 1 FROM note WHERE tag_id = OLD.tag_id) THEN",
        "the note's trigger is rebuilt without the task table"
      );
      assert(!output.includes("Successfully rolled back"), `a dry run reported a rollback:\n${output}`);
      assertEquals(await migrationCount(pool), 2, "a dry run removes no migration record");
      assert(await tableExists(dsn, "task"), "a dry run drops nothing");
      assertEquals(await nonTableObjects(pool), before, "a dry run drops no trigger");
      assertEquals(await noteTriggerBody(pool), bodyBefore, "a dry run replaces no trigger");
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
  name: "PG: rolling back a change of a link's delete rules restores the rolled-back-to schema's foreign key action and trigger",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const capture = new ConsoleCapture();
    const cwd = Deno.cwd();
    const tempDir = await createTempDir();
    const linked = (rules: string): string =>
      `module default {
        type RbkTag { required name: str; };
        type RbkPost { link tag: RbkTag { ${rules} }; };
      };`;

    try {
      await dropLinkedObjects(pool);
      Deno.chdir(tempDir);
      capture.start();

      await cliMigrate(dsn, tempDir, linked("on source delete delete target;"));
      await cliMigrate(dsn, tempDir, linked("on target delete allow;"));
      await cliRollback(dsn);
      assertEquals(await migrationCount(pool), 1);

      const tag = (await pool.query(`INSERT INTO rbk_tag (name) VALUES ('kept') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO rbk_post (tag_id) VALUES ($1)`, [tag]);

      await assertRejects(() => pool.query(`DELETE FROM rbk_tag`), Error, undefined, "the RESTRICT foreign key is back");

      await pool.query(`DELETE FROM rbk_post`);
      assertEquals(await tagNames(pool), [], "the delete-target trigger is back");

      await cliMigrate(dsn, tempDir, linked("on source delete delete target;"));
      assertEquals(await migrationCount(pool), 1, "migrating to the rolled-back-to schema is a no-op");
    } finally {
      capture.stop();
      Deno.chdir(cwd);
      await cleanupTempDir(tempDir);
      await dropLinkedObjects(pool);
      await pool.close();
    }
  }
});

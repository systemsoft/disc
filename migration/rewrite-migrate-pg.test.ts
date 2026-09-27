/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Migrating a type's `rewrite insert/update using (…)` rules after the type
 * exists.
 *
 * A rewrite is a trigger and its function. Only CREATE TYPE used to create
 * them: adding a property with a rewrite to an existing type created none,
 * dropping one left its trigger behind (so writes to the table ran a rule
 * against a missing column), and switching a rewrite between insert and
 * update created the new trigger before dropping the old one of the same
 * name. `migrate` now creates, replaces and drops them, the rollback of a
 * dropped property recreates its rewrite, and a database migrated before
 * the fix is repaired on the next `migrate`.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

function schema(views: string): string {
  return `module default {
    type RwPost {
      required title: str;
      views: int64;
      ${views}
    };
  };`;
}

const PLAIN = schema("");
const DOUBLED = schema("score: int64 { rewrite insert, update using (__subject__.views * 2); };");

async function withManager<T>(pool: ConnectionPool, fn: (manager: SchemaManager) => Promise<T>): Promise<T> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

/*** Applies `sdl` like `disc migrate --unsafe`; returns the number of migrations applied. ***/
async function migrate(pool: ConnectionPool, sdl: string): Promise<number> {
  const result = await withManager(pool, manager => manager.applySchema(sdl, { allowUnsafe: true }));

  if (!result.ok)
    throw result.error;

  return result.value.length;
}

async function rollback(pool: ConnectionPool): Promise<void> {
  const result = await withManager(pool, manager => manager.rollbackLastMigration());

  if (!result.ok)
    throw result.error;
}

/*** The rewrite triggers on `rw_post` with their events, and the rewrite functions, by name. ***/
async function rewrites(pool: ConnectionPool): Promise<string[]> {
  const result = await pool.query(`
    SELECT 'trigger ' || t.tgname || ' ' || pg_get_triggerdef(t.oid) AS item
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'rw_post' AND NOT t.tgisinternal
    UNION ALL
    SELECT 'function ' || p.proname FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'rw\\_post\\_\\_%'
    ORDER BY 1
  `);
  return result.rows.map(row => row.item as string);
}

async function scores(pool: ConnectionPool): Promise<unknown[]> {
  const result = await pool.query(`SELECT title, score FROM rw_post ORDER BY title`);
  return result.rows.map(row => [row.title, row.score === null ? null : Number(row.score)]);
}

async function resetAll(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);

  const functions = await pool.query(
    `SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'rw\\_post\\_\\_%'`
  );

  for (const row of functions.rows)
    await pool.query(`DROP FUNCTION IF EXISTS "${row.proname}"() CASCADE`);
}

async function run(fn: (pool: ConnectionPool) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();

  try {
    await resetAll(pool);
    await fn(pool);
  } finally {
    await resetAll(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG rewrite migrate: adding a property with a rewrite to an existing type creates its trigger",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, PLAIN), 1);
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('old', 1)`);

      assertEquals(await migrate(pool, DOUBLED), 1);
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('new', 5)`);
      await pool.query(`UPDATE rw_post SET views = 4 WHERE title = 'old'`);
      assertEquals(await scores(pool), [["new", 10], ["old", 8]], "inserts and updates apply the rewrite");

      assertEquals(await migrate(pool, DOUBLED), 0, "the next migrate is a no-op");
    })
});

Deno.test({
  name: "PG rewrite migrate: changing a rewrite's expression and events replaces its trigger",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, DOUBLED), 1);

      assertEquals(await migrate(pool, schema("score: int64 { rewrite insert, update using (__subject__.views * 3); };")), 1);
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('a', 2)`);
      assertEquals(await scores(pool), [["a", 6]], "the new expression applies");

      /*** From insert and update to update only: the insert no longer sets the score. ***/
      const updateOnly = schema("score: int64 { rewrite update using (__subject__.views * 3); };");
      assertEquals(await migrate(pool, updateOnly), 1);
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('b', 2)`);
      await pool.query(`UPDATE rw_post SET views = 1 WHERE title = 'a'`);
      assertEquals(await scores(pool), [["a", 3], ["b", null]]);

      /*** Separate insert and update rules on one property: each has its own trigger. ***/
      const split = schema("score: int64 { rewrite insert using (__subject__.views * 10); rewrite update using (__subject__.views * 3); };");
      assertEquals(await migrate(pool, split), 1);
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('c', 2)`);
      await pool.query(`UPDATE rw_post SET views = 2 WHERE title = 'b'`);
      assertEquals(await scores(pool), [["a", 3], ["b", 6], ["c", 20]]);
      assertEquals(await migrate(pool, split), 0, "the next migrate is a no-op");

      /*** And back to a single rule for both. ***/
      assertEquals(await migrate(pool, DOUBLED), 1);
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('d', 2)`);
      assertEquals((await scores(pool))[3], ["d", 4]);
      assertEquals((await rewrites(pool)).filter(item => item.startsWith("trigger")).length, 1, "one trigger is left");
    })
});

Deno.test({
  name: "PG rewrite migrate: dropping a property with a rewrite drops its trigger and function",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, PLAIN), 1);
      const before = await rewrites(pool);

      assertEquals(await migrate(pool, DOUBLED), 1);
      assertEquals(await migrate(pool, PLAIN), 1);

      assertEquals(await rewrites(pool), before, "no rewrite trigger or function is left");
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('a', 1)`);
      await pool.query(`UPDATE rw_post SET views = 2`);
    })
});

Deno.test({
  name: "PG rewrite migrate: a rewrite missing from a database migrated before the fix is repaired, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, DOUBLED), 1);
      const declared = await rewrites(pool);

      /*** What a migrate before the fix left behind: the property's rewrite never created, and a dropped property's trigger still there. ***/
      await pool.query(`DROP TRIGGER rw_post__score__rewrite ON rw_post`);
      await pool.query(`DROP FUNCTION rw_post__score__rewrite_fn()`);
      await pool.query(`ALTER TABLE rw_post ADD COLUMN gone bigint`);
      await pool.query(
        `CREATE FUNCTION rw_post__gone__rewrite_fn() RETURNS TRIGGER AS $$ BEGIN NEW.gone := 1; RETURN NEW; END; $$ LANGUAGE plpgsql`
      );
      await pool.query(`CREATE TRIGGER rw_post__gone__rewrite BEFORE INSERT ON rw_post FOR EACH ROW EXECUTE FUNCTION rw_post__gone__rewrite_fn()`);
      await pool.query(`ALTER TABLE rw_post DROP COLUMN gone`);
      await assertRejects(() => pool.query(`INSERT INTO rw_post (title, views) VALUES ('broken', 1)`));

      assertEquals(await migrate(pool, DOUBLED), 1, "the repair runs");
      assertEquals(await rewrites(pool), declared);
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('a', 2)`);
      assertEquals(await scores(pool), [["a", 4]]);

      /*** A rewrite whose expression drifted is replaced. ***/
      await pool.query(
        `CREATE OR REPLACE FUNCTION rw_post__score__rewrite_fn() RETURNS TRIGGER AS $$ BEGIN NEW.score := 0; RETURN NEW; END; $$ LANGUAGE plpgsql`
      );
      assertEquals(await migrate(pool, DOUBLED), 1, "the repair runs");
      assertEquals(await rewrites(pool), declared);
      await pool.query(`UPDATE rw_post SET views = 3`);
      assertEquals(await scores(pool), [["a", 6]]);

      assertEquals(await migrate(pool, DOUBLED), 0, "once repaired, the next migrate is a no-op");
    })
});

Deno.test({
  name: "PG rewrite migrate: rollbacks recreate a dropped property's rewrite and drop an added one",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, DOUBLED), 1);
      const declared = await rewrites(pool);

      assertEquals(await migrate(pool, PLAIN), 1);
      const plain = await rewrites(pool);
      await rollback(pool);

      assertEquals(await rewrites(pool), declared, "the dropped property's rewrite comes back");
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('a', 2)`);
      assertEquals(await scores(pool), [["a", 4]]);
      assertEquals(await migrate(pool, DOUBLED), 0, "migrating to the rolled-back-to schema is a no-op");

      assertEquals(await migrate(pool, schema("score: int64; bonus: int64 { rewrite insert using (__subject__.views + 1); };")), 1);
      await rollback(pool);
      assertEquals(await rewrites(pool), declared, "the added property's rewrite is gone");
      await pool.query(`INSERT INTO rw_post (title, views) VALUES ('b', 1)`);
      assertEquals(await scores(pool), [["a", 4], ["b", 2]]);

      assertEquals(await migrate(pool, PLAIN), 1);
      assertEquals(await rewrites(pool), plain);
    })
});

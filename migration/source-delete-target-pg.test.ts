/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `on source delete delete target` against a real database: deleting the
 * source deletes the targets it links to, whatever the link's `on target
 * delete` policy. The targets are deleted once the source row is gone, so a
 * single link's RESTRICT foreign key (the default) no longer blocks it, and a
 * multi link's targets are found although its junction rows cascade away.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

function schema(link: string): string {
  return `module default {
    type Program { required name: str; };
    type Bug { required title: str; ${link} };
  };`;
}

async function migrate(pool: ConnectionPool, sdl: string, allowUnsafe = false): Promise<void> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    const result = await manager.applySchema(sdl, { allowUnsafe });
    if (!result.ok)
      throw result.error;
  } finally {
    await manager.close();
  }
}

async function insertProgram(pool: ConnectionPool, name: string): Promise<string> {
  return (await pool.query(`INSERT INTO program (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;
}

async function insertBug(pool: ConnectionPool, title: string): Promise<string> {
  return (await pool.query(`INSERT INTO bug (title) VALUES ($1) RETURNING id`, [title])).rows[0].id as string;
}

async function programNames(pool: ConnectionPool): Promise<string[]> {
  return (await pool.query(`SELECT name FROM program ORDER BY name`)).rows.map(row => row.name as string);
}

async function run(fn: (pool: ConnectionPool) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();

  try {
    await resetTestDatabase(pool);
    await fn(pool);
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG on source delete delete target: a single link with the default RESTRICT target policy deletes its target",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      await migrate(pool, schema("link program: Program { on source delete delete target; };"));

      const program = await insertProgram(pool, "disc");
      await insertProgram(pool, "other");
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('crash', $1)`, [program]);
      await pool.query(`INSERT INTO bug (title) VALUES ('unlinked')`);

      await pool.query(`DELETE FROM bug`);
      assertEquals(await programNames(pool), ["other"]);
    })
});

Deno.test({
  name: "PG on source delete delete target: a multi link deletes every target, with a cascading or restricting junction",
  ignore: !canRunPgTests(),
  fn: async () => {
    for (const policy of ["", "on target delete restrict;"]) {
      await run(async pool => {
        await migrate(pool, schema(`multi link programs: Program { ${policy} on source delete delete target; };`));

        const bug = await insertBug(pool, "crash");
        for (const name of ["a", "b"]) {
          await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [bug, await insertProgram(pool, name)]);
        }
        await insertProgram(pool, "other");

        await pool.query(`DELETE FROM bug WHERE id = $1`, [bug]);
        assertEquals(await programNames(pool), ["other"], policy || "default policy");
        assertEquals((await pool.query(`SELECT count(*)::int AS n FROM bug_programs`)).rows[0].n, 0);
      });
    }
  }
});

Deno.test({
  name: "PG on source delete delete target: unlinking a multi link's target, or deleting the target, keeps the other side",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      await migrate(pool, schema("multi link programs: Program { on source delete delete target; };"));

      const bug = await insertBug(pool, "crash");
      const a = await insertProgram(pool, "a");
      const b = await insertProgram(pool, "b");
      await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2), ($1, $3)`, [bug, a, b]);

      await pool.query(`DELETE FROM bug_programs WHERE target_id = $1`, [a]);
      assertEquals(await programNames(pool), ["a", "b"], "unlinking leaves the target");

      await pool.query(`DELETE FROM program WHERE id = $1`, [b]);
      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM bug`)).rows[0].n, 1, "deleting the target leaves the source");
    })
});

Deno.test({
  name: "PG on source delete delete target: removing the link removes its trigger, so later deletes still work",
  ignore: !canRunPgTests(),
  fn: async () => {
    for (
      const [link, fn] of [
        ["link program: Program { on source delete delete target; };", "disc_source_delete_bug_program"],
        ["multi link programs: Program { on source delete delete target; };", "disc_source_delete_bug_programs"]
      ]
    ) {
      await run(async pool => {
        await migrate(pool, schema(link));
        await migrate(pool, schema(""), true);

        await insertBug(pool, "crash");
        await pool.query(`DELETE FROM bug`);

        const functions = await pool.query(`SELECT 1 FROM pg_proc WHERE proname = $1`, [fn]);
        assertEquals(functions.rows.length, 0, link);
      });
    }
  }
});

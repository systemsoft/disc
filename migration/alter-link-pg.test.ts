/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Altering an existing link against PostgreSQL.
 *
 * Changing `on target delete` used to emit only a comment: `migrate` recorded
 * the new schema while the foreign key kept its old ON DELETE action, so a
 * purge kept failing on RESTRICT after a "successful" migrate. A link change
 * the migrator cannot make must fail the migrate and record nothing.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

function schema(link: string): string {
  return `module default {
    type Program { required name: str; };
    type Team { required name: str; };
    type Bug { required title: str; ${link} };
  };`;
}

async function withManager<T>(pool: ConnectionPool, fn: (manager: SchemaManager) => Promise<T>): Promise<T> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

async function migrate(pool: ConnectionPool, sdl: string, allowUnsafe = false): Promise<number> {
  const result = await withManager(pool, manager => manager.applySchema(sdl, { allowUnsafe }));

  if (!result.ok)
    throw result.error;

  return result.value.length;
}

async function onDeleteAction(pool: ConnectionPool, constraint: string): Promise<string> {
  const result = await pool.query(`SELECT confdeltype FROM pg_constraint WHERE conname = $1`, [constraint]);
  return result.rows[0].confdeltype as string;
}

async function migrationCount(pool: ConnectionPool): Promise<number> {
  return (await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`)).rows[0].n as number;
}

Deno.test({
  name: "PG alter link: restrict → delete source makes deleting the target cascade",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      assertEquals(await migrate(pool, schema("required link program: Program;")), 1);
      assertEquals(await onDeleteAction(pool, "fk_bug_program_id"), "r");

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('crash', $1)`, [program]);
      await assertRejects(() => pool.query(`DELETE FROM program WHERE id = $1`, [program]));

      assertEquals(await migrate(pool, schema("required link program: Program { on target delete delete source; };")), 1);
      assertEquals(await onDeleteAction(pool, "fk_bug_program_id"), "c");

      await pool.query(`DELETE FROM program WHERE id = $1`, [program]);
      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM bug`)).rows[0].n, 0);

      assertEquals(await migrate(pool, schema("required link program: Program { on target delete delete source; };")), 0);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG alter link: a link change the migrator cannot make fails and records nothing",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await migrate(pool, schema("link owner: Program;"));
      const recorded = await migrationCount(pool);

      const error = await assertRejects(() => migrate(pool, schema("link owner: Team;"), true));
      assertStringIncludes((error as Error).message, "link 'owner' on 'bug'");
      assertEquals(await migrationCount(pool), recorded);

      /*** Not recorded as applied: the next migrate sees the same change and fails again rather than reporting up to date. ***/
      await assertRejects(() => migrate(pool, schema("link owner: Team;"), true));
      assertEquals(await migrationCount(pool), recorded);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

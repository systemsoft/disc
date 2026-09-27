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

/*** `confdeltype` and `condeferred` of a foreign key: `r` / `a` is RESTRICT / NO ACTION. ***/
async function foreignKeyRule(pool: ConnectionPool, constraint: string): Promise<[string, boolean]> {
  const result = await pool.query(`SELECT confdeltype, condeferred FROM pg_constraint WHERE conname = $1`, [constraint]);
  return [result.rows[0].confdeltype as string, result.rows[0].condeferred as boolean];
}

/*** Run `statements` in one transaction on one connection, then COMMIT; a failed statement or COMMIT rolls back and rethrows. ***/
async function inTransaction(pool: ConnectionPool, statements: [string, unknown[]][]): Promise<void> {
  const connection = await pool.acquire();

  try {
    await connection.query("BEGIN");
    try {
      for (const [sql, params] of statements)
        await connection.query(sql, params);
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    }
  } finally {
    pool.release(connection);
  }
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

Deno.test({
  name: "PG alter link: deferred restrict lets a transaction delete a target it unlinks before COMMIT; restrict fails at the delete",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();
    const insertProgram = async (name: string): Promise<string> =>
      (await pool.query(`INSERT INTO program (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;
    const programs = async (): Promise<number> => (await pool.query(`SELECT count(*)::int AS n FROM program`)).rows[0].n as number;

    try {
      await resetTestDatabase(pool);
      await migrate(pool, schema("required link program: Program;"));
      assertEquals(await foreignKeyRule(pool, "fk_bug_program_id"), ["r", false]);

      const disc = await insertProgram("disc");
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('crash', $1)`, [disc]);

      // restrict: the delete itself fails, even though the source goes away before COMMIT.
      await assertRejects(
        () => inTransaction(pool, [[`DELETE FROM program WHERE id = $1`, [disc]], [`DELETE FROM bug WHERE program_id = $1`, [disc]]]),
        Error,
        "fk_bug_program_id"
      );

      assertEquals(await migrate(pool, schema("required link program: Program { on target delete deferred restrict; };")), 1);
      assertEquals(await foreignKeyRule(pool, "fk_bug_program_id"), ["a", true]);

      // deferred restrict: nothing links to the target by COMMIT.
      await inTransaction(pool, [[`DELETE FROM program WHERE id = $1`, [disc]], [`DELETE FROM bug WHERE program_id = $1`, [disc]]]);
      assertEquals(await programs(), 0);

      // Relinking the source before COMMIT works too.
      const old = await insertProgram("old");
      const next = await insertProgram("new");
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('leak', $1)`, [old]);
      await inTransaction(pool, [[`DELETE FROM program WHERE id = $1`, [old]], [`UPDATE bug SET program_id = $1`, [next]]]);
      assertEquals(await programs(), 1);

      // Still linked at COMMIT: the COMMIT fails on the foreign key, and the delete is undone.
      await assertRejects(
        () => inTransaction(pool, [[`DELETE FROM program WHERE id = $1`, [next]]]),
        Error,
        `violates foreign key constraint "fk_bug_program_id"`
      );
      assertEquals(await programs(), 1);

      assertEquals(await migrate(pool, schema("required link program: Program { on target delete deferred restrict; };")), 0);

      assertEquals(await migrate(pool, schema("required link program: Program { on target delete restrict; };")), 1);
      assertEquals(await foreignKeyRule(pool, "fk_bug_program_id"), ["r", false]);
      assertEquals(await migrate(pool, schema("required link program: Program { on target delete restrict; };")), 0);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG alter link: a multi link's deferred restrict checks its junction rows at COMMIT",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      const sdl = schema("multi link programs: Program { on target delete deferred restrict; };");
      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await foreignKeyRule(pool, "fk_bug_programs_target_id"), ["a", true]);

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
      const bug = (await pool.query(`INSERT INTO bug (title) VALUES ('crash') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [bug, program]);

      await assertRejects(
        () => inTransaction(pool, [[`DELETE FROM program WHERE id = $1`, [program]]]),
        Error,
        `violates foreign key constraint "fk_bug_programs_target_id"`
      );

      // Deleting the source removes its junction rows before COMMIT.
      await inTransaction(pool, [[`DELETE FROM program WHERE id = $1`, [program]], [`DELETE FROM bug WHERE id = $1`, [bug]]]);
      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM bug_programs`)).rows[0].n, 0);

      assertEquals(await migrate(pool, sdl), 0);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

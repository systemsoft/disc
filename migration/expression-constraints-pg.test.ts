/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Type-level `constraint expression on (…)` against PostgreSQL: the CHECK is
 * created with the table and by later migrations, changed, dropped and rolled
 * back; a subtype's table enforces its abstract parent's constraint; a
 * violating write fails with Gel's text ("invalid <Type>", or the
 * errmessage) as SQLSTATE 23514 naming the constraint; an empty expression
 * passes, as in Gel; a migration adding a constraint that stored rows violate
 * fails whole; and a database migrated before Disc created these CHECKs gets
 * them on the next migrate.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { postgresErrorFields } from "../lib/errors.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

const BUG = "01234567-89ab-7cde-8f01-000000000001";
const PATCH = "01234567-89ab-7cde-8f01-000000000002";

function forge(constraint: string, extra = ""): string {
  return `module default {
    type XcBug { title: str; };
    type XcPatch { title: str; };
    type XcComment {
      body: str;
      bug: XcBug;
      patch: XcPatch;
      ${extra}
      ${constraint}
    };
  };`;
}

const PLAIN = forge("");
const EXACTLY_ONE = forge("constraint expression on ((exists .bug) != (exists .patch));");

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

/*** The `ck_` CHECKs on `table`, by name. ***/
async function checksOn(pool: ConnectionPool, table: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      WHERE c.contype = 'c' AND t.relname = $1 AND c.conname LIKE 'ck\\_%' ORDER BY 1`,
    [table]
  );
  return result.rows.map(row => row.conname as string);
}

/*** The PostgreSQL error fields and message `sql` fails with. ***/
async function violation(
  pool: ConnectionPool,
  sql: string
): Promise<{ constraint?: string; detail?: string; message: string; sqlState: string; table?: string; }> {
  try {
    await pool.query(sql);
  } catch (error) {
    const fields = postgresErrorFields(error);
    assert(fields, `not a PostgreSQL error: ${error}`);
    return { ...fields, message: (error as { fields?: { message?: string; }; }).fields?.message ?? String(error) };
  }
  throw new Error(`expected to fail: ${sql}`);
}

async function seed(pool: ConnectionPool): Promise<void> {
  await pool.query(`INSERT INTO xc_bug (id, title) VALUES ('${BUG}', 'b')`);
  await pool.query(`INSERT INTO xc_patch (id, title) VALUES ('${PATCH}', 'p')`);
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
  name: "PG expression constraint: exactly one of two links is enforced on insert and update, with Gel's error",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, EXACTLY_ONE), 1);
      await seed(pool);

      await pool.query(`INSERT INTO xc_comment (body, bug_id) VALUES ('on a bug', '${BUG}')`);
      await pool.query(`INSERT INTO xc_comment (body, patch_id) VALUES ('on a patch', '${PATCH}')`);

      const neither = await violation(pool, `INSERT INTO xc_comment (body) VALUES ('orphan')`);
      assertEquals(neither.sqlState, "23514");
      assertEquals(neither.message, "invalid XcComment");
      assertEquals(neither.detail, "violated constraint 'std::expression' on object type 'default::XcComment'");
      assertEquals(neither.table, "xc_comment");
      assertEquals([neither.constraint], await checksOn(pool, "xc_comment"));

      const both = await violation(pool, `UPDATE xc_comment SET patch_id = '${PATCH}' WHERE body = 'on a bug'`);
      assertEquals(both.message, "invalid XcComment");

      assertEquals(await migrate(pool, EXACTLY_ONE), 0, "the next migrate is a no-op");
    })
});

Deno.test({
  name: "PG expression constraint: an empty expression passes, as in Gel; errmessage is the message",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = `module default { type XcRange {
        lo: int64; hi: int64;
        constraint expression on (.lo < .hi) { errmessage := "lo must be below hi on {__subject__}"; };
      }; };`;
      assertEquals(await migrate(pool, sdl), 1);

      await pool.query(`INSERT INTO xc_range (hi) VALUES (1)`);
      await pool.query(`INSERT INTO xc_range DEFAULT VALUES`);
      await pool.query(`INSERT INTO xc_range (lo, hi) VALUES (1, 2)`);

      const failed = await violation(pool, `INSERT INTO xc_range (lo, hi) VALUES (5, 1)`);
      assertEquals(failed.message, "lo must be below hi on XcRange");
      assertEquals(failed.sqlState, "23514");
    })
});

Deno.test({
  name: "PG expression constraint: added, changed and dropped by migrations, and each undone by rollback",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, PLAIN), 1);
      await seed(pool);
      await pool.query(`INSERT INTO xc_comment (body, bug_id) VALUES ('ok', '${BUG}')`);
      assertEquals(await checksOn(pool, "xc_comment"), []);

      /*** Added to the existing table (this produced no DDL at all). ***/
      assertEquals(await migrate(pool, EXACTLY_ONE), 1);
      const [exactlyOne] = await checksOn(pool, "xc_comment");
      assert(exactlyOne, "the CHECK exists");
      await assertRejects(() => pool.query(`INSERT INTO xc_comment (body) VALUES ('orphan')`));

      /*** Changed: the old CHECK goes, the new one comes. ***/
      const atMostOne = forge("constraint expression on (not (exists .bug and exists .patch));");
      assertEquals(await migrate(pool, atMostOne), 1);
      const [changed] = await checksOn(pool, "xc_comment");
      assert(changed && changed !== exactlyOne, "a different CHECK replaces it");
      await pool.query(`INSERT INTO xc_comment (body) VALUES ('orphan')`);
      await assertRejects(() => pool.query(`INSERT INTO xc_comment (body, bug_id, patch_id) VALUES ('both', '${BUG}', '${PATCH}')`));

      /*** Rolling the change back restores the first CHECK (the orphan row is removed first — it violates it). ***/
      await pool.query(`DELETE FROM xc_comment WHERE body = 'orphan'`);
      await rollback(pool);
      assertEquals(await checksOn(pool, "xc_comment"), [exactlyOne]);

      /*** Dropped, then the drop rolled back. ***/
      assertEquals(await migrate(pool, PLAIN), 1);
      assertEquals(await checksOn(pool, "xc_comment"), []);
      await rollback(pool);
      assertEquals(await checksOn(pool, "xc_comment"), [exactlyOne]);

      /*** Rolling back the migration that added it removes it. ***/
      await rollback(pool);
      assertEquals(await checksOn(pool, "xc_comment"), []);
    })
});

Deno.test({
  name: "PG expression constraint: an abstract parent's constraint holds on its subtypes' tables and names the subtype",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = `module default {
        abstract type XcNamed { name: str; constraint expression on (len(.name) > 1); };
        type XcUser extending XcNamed {};
        type XcGroup extending XcNamed { size: int64; };
        type XcHolder { owner: XcNamed; };
      };`;
      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await checksOn(pool, "xc_named"), [], "the abstract table only mirrors its subtypes' rows");
      assertEquals((await checksOn(pool, "xc_user")).length, 1);
      assertEquals((await checksOn(pool, "xc_group")).length, 1);

      const failed = await violation(pool, `INSERT INTO xc_group (name) VALUES ('x')`);
      assertEquals(failed.message, "invalid XcGroup");
      assertEquals(failed.detail, "violated constraint 'std::expression' on object type 'default::XcGroup'");

      /*** A valid row still reaches the abstract table's mirror, so a link to the abstract type works. ***/
      const inserted = await pool.query(`INSERT INTO xc_user (name) VALUES ('ann') RETURNING id`);
      const id = inserted.rows[0].id as string;
      await pool.query(`INSERT INTO xc_holder (owner_id) VALUES ($1)`, [id]);
      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM xc_named WHERE id = $1`, [id])).rows[0].n, 1);
    })
});

Deno.test({
  name: "PG expression constraint: a migration adding one that stored rows violate fails whole, naming it",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, PLAIN), 1);
      await seed(pool);
      await pool.query(`INSERT INTO xc_comment (body) VALUES ('orphan')`);

      /*** The same migration also adds a property: it must not be applied either. ***/
      const error = await assertRejects(() => migrate(pool, forge("constraint expression on ((exists .bug) != (exists .patch));", "extra: str;")));
      assertStringIncludes(
        (error as Error).message,
        "Cannot add 'constraint expression on ((exists .bug) != (exists .patch))' to type 'default::XcComment': existing data violates it (invalid XcComment)"
      );
      assertStringIncludes((error as Error).message, "Nothing was applied.");

      assertEquals(await checksOn(pool, "xc_comment"), []);
      const columns = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'xc_comment' AND column_name = 'extra'`);
      assertEquals(columns.rows, [], "the rest of the migration was rolled back");

      await pool.query(`DELETE FROM xc_comment`);
      assertEquals(await migrate(pool, forge("constraint expression on ((exists .bug) != (exists .patch));", "extra: str;")), 1);
      assertEquals((await checksOn(pool, "xc_comment")).length, 1);
    })
});

/*** A property-level expression: a quoted literal and `len()`, which the DDL generator used to paste into SQL as text. ***/
function handles(constraint: string): string {
  return `module default { type XcHandle { name: str { ${constraint} }; }; };`;
}

const HANDLE = handles("constraint expression on (len(__subject__) > 2 and __subject__ != 'it\\'s');");

/*** Every CHECK on `table`, by name. ***/
async function allChecksOn(pool: ConnectionPool, table: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT c.conname FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE c.contype = 'c' AND t.relname = $1 ORDER BY 1`,
    [table]
  );
  return result.rows.map(row => row.conname as string);
}

Deno.test({
  name: "PG property expression constraint: len() and a quoted literal compile; created, migrated and enforced with Gel's error",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, handles("")), 1);
      await pool.query(`INSERT INTO xc_handle (name) VALUES ('ann')`);

      assertEquals(await migrate(pool, HANDLE), 1, "added to the existing table");
      await pool.query(`INSERT INTO xc_handle (name) VALUES ('bob')`);
      await pool.query(`INSERT INTO xc_handle (name) VALUES (NULL)`);

      const short = await violation(pool, `INSERT INTO xc_handle (name) VALUES ('ab')`);
      assertEquals(short.sqlState, "23514");
      assertEquals(short.message, "invalid name");
      assertEquals(short.detail, "violated constraint 'std::expression' on property 'name' of object type 'default::XcHandle'");

      const quoted = await violation(pool, `INSERT INTO xc_handle (name) VALUES ('it''s')`);
      assertEquals(quoted.message, "invalid name");

      assertEquals(await migrate(pool, HANDLE), 0, "the next migrate is a no-op");

      /*** On a new table too. ***/
      await resetTestDatabase(pool);
      assertEquals(await migrate(pool, HANDLE), 1);
      await assertRejects(() => pool.query(`INSERT INTO xc_handle (name) VALUES ('ab')`));
    })
});

Deno.test({
  name: "PG property expression constraint: a CHECK an earlier version pasted from the text is replaced on the next migrate",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = handles("constraint expression on (__subject__ != '');");
      assertEquals(await migrate(pool, sdl), 1);
      const [compiled] = await allChecksOn(pool, "xc_handle");

      /*** What the earlier DDL generator created: the expression's text with `__subject__` swapped for the column. ***/
      const legacy = "chk_xc_handle_name_expression_on___subject_________";
      await pool.query(`ALTER TABLE xc_handle DROP CONSTRAINT ${compiled}`);
      await pool.query(`ALTER TABLE xc_handle ADD CONSTRAINT ${legacy} CHECK (name != '')`);

      assertEquals(await migrate(pool, sdl), 1, "the repair runs");
      assertEquals(await allChecksOn(pool, "xc_handle"), [compiled]);
      assertEquals((await violation(pool, `INSERT INTO xc_handle (name) VALUES ('')`)).message, "invalid name");
      assertEquals(await migrate(pool, sdl), 0, "once repaired, the next migrate is a no-op");
    })
});

Deno.test({
  name: "PG expression constraint: a database migrated before Disc created the CHECK gets it on the next migrate, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, EXACTLY_ONE), 1);
      const declared = await checksOn(pool, "xc_comment");

      /*** What a migrate before the fix left behind: the schema declares the constraint, the table has no CHECK. ***/
      await pool.query(`ALTER TABLE xc_comment DROP CONSTRAINT ${declared[0]}`);
      await pool.query(`INSERT INTO xc_comment (body) VALUES ('orphan')`);

      /*** Stored rows that violate it fail the repair, which changes nothing. ***/
      const error = await assertRejects(() => migrate(pool, EXACTLY_ONE));
      assertStringIncludes((error as Error).message, "existing data violates it (invalid XcComment)");
      assertEquals(await checksOn(pool, "xc_comment"), []);

      await pool.query(`DELETE FROM xc_comment`);
      assertEquals(await migrate(pool, EXACTLY_ONE), 1, "the repair runs");
      assertEquals(await checksOn(pool, "xc_comment"), declared);
      assertEquals(await migrate(pool, EXACTLY_ONE), 0, "once repaired, the next migrate is a no-op");
    })
});

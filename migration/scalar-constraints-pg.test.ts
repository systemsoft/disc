/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A scalar type's constraints against PostgreSQL: every column of the scalar
 * — in subtype tables, multi properties element by element, link properties
 * in junction tables — refuses a violating value with Gel's error; migrations
 * add, change and drop the CHECKs as scalars and properties change, and
 * rollbacks undo them; a database migrated before Disc enforced them gets
 * them on the next migrate; stored values that violate a new constraint fail
 * the migration whole.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { postgresErrorFields } from "../lib/errors.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import { SchemaManager } from "./schema-manager.ts";

const EVM = String.raw`scalar type XsEVMAddress extending str { constraint regexp(r'^0x[0-9a-fA-F]{40}$'); };`;
const LIGHTNING = String.raw`scalar type XsLightningAddress extending str {
  constraint regexp(r'^([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}|lnurl1[a-z0-9]+)$');
};`;

function wallets(pos: string, props = "evm: XsEVMAddress; ln: XsLightningAddress; score: XsPos;"): string {
  return `module default {
    ${EVM}
    ${LIGHTNING}
    scalar type XsPos extending int64 ${pos};
    scalar type XsMood extending enum<Happy, Sad>;
    type XsTag {};
    abstract type XsOwned { ${props} };
    type XsWallet extending XsOwned {
      mood: XsMood;
      multi scores: XsPos;
      multi tags: XsTag { weight: XsPos; };
    };
  };`;
}

const POSITIVE = wallets("{ constraint min_value(0); }");

async function withManager<T>(pool: ConnectionPool, fn: (manager: SchemaManager) => Promise<T>): Promise<T> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

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

async function violation(pool: ConnectionPool, sql: string, params: unknown[] = []): Promise<{ detail?: string; message: string; sqlState: string; }> {
  try {
    await pool.query(sql, params);
  } catch (error) {
    const fields = postgresErrorFields(error);
    assert(fields, `not a PostgreSQL error: ${error}`);
    return { ...fields, message: (error as { fields?: { message?: string; }; }).fields?.message ?? String(error) };
  }
  throw new Error(`expected to fail: ${sql}`);
}

async function run(fn: (pool: ConnectionPool) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();

  const reset = async (): Promise<void> => {
    await resetTestDatabase(pool);
    await pool.query(`DROP TYPE IF EXISTS disc_enum_xsmood CASCADE`);
  };

  try {
    await reset();
    await fn(pool);
  } finally {
    await reset();
    await pool.close();
  }
}

const EVM_OK = `0x${"ab12".repeat(10)}`;

Deno.test({
  name: "PG scalar constraint: EVM and Lightning addresses, a subtype's columns, multi elements and link properties are checked",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, POSITIVE), 1);
      assertEquals(await checksOn(pool, "xs_owned"), [], "the abstract table only mirrors its subtypes' rows");

      for (const ln of ["alice@example.com", "a.b+c-d%e@sub-domain.example.io", "lnurl1abc"]) {
        await pool.query(`INSERT INTO xs_wallet (evm, ln, score) VALUES ($1, $2, 1)`, [EVM_OK, ln]);
      }
      await pool.query(`INSERT INTO xs_wallet (mood) VALUES ('Happy')`);

      for (const evm of [`0x${"a".repeat(39)}`, "ab".repeat(21), `0x${"a".repeat(39)}G`]) {
        const bad = await violation(pool, `INSERT INTO xs_wallet (evm) VALUES ($1)`, [evm]);
        assertEquals(bad.sqlState, "23514");
        assertEquals(bad.message, "invalid XsEVMAddress");
        assertEquals(bad.detail, "violated constraint 'std::regexp' on scalar type 'default::XsEVMAddress'");
      }
      for (const ln of ["bad", "alice@example", "alice@example.c", "LNURL1ABC"]) {
        assertEquals((await violation(pool, `INSERT INTO xs_wallet (ln) VALUES ($1)`, [ln])).message, "invalid XsLightningAddress");
      }

      const negative = await violation(pool, `INSERT INTO xs_wallet (score) VALUES (-1)`);
      assertEquals(negative.message, "Minimum allowed value for XsPos is 0.");
      assertEquals(negative.detail, "violated constraint 'std::min_value' on scalar type 'default::XsPos'");

      await pool.query(`INSERT INTO xs_wallet (scores) VALUES ('{1,2}'), ('{}')`);
      assertEquals((await violation(pool, `INSERT INTO xs_wallet (scores) VALUES ('{1,-1,2}')`)).message, "Minimum allowed value for XsPos is 0.");

      const wallet = (await pool.query(`SELECT id FROM xs_wallet LIMIT 1`)).rows[0].id as string;
      const tag = (await pool.query(`INSERT INTO xs_tag DEFAULT VALUES RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO xs_wallet_tags (source_id, target_id, weight) VALUES ($1, $2, 3)`, [wallet, tag]);
      const weight = await violation(pool, `UPDATE xs_wallet_tags SET weight = -1`);
      assertEquals(weight.message, "Minimum allowed value for XsPos is 0.");

      assertEquals(await migrate(pool, POSITIVE), 0, "the next migrate is a no-op");
    })
});

Deno.test({
  name: "PG scalar constraint: added, changed and dropped with the scalar or its properties, and rolled back",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const plain = wallets("");
      assertEquals(await migrate(pool, plain), 1);
      const unconstrained = await checksOn(pool, "xs_wallet");
      await pool.query(`INSERT INTO xs_wallet (score) VALUES (5)`);

      /*** A constraint added to the scalar reaches every column of it: score, scores, and the junction's weight. ***/
      assertEquals(await migrate(pool, POSITIVE), 1);
      await assertRejects(() => pool.query(`INSERT INTO xs_wallet (score) VALUES (-1)`));
      await assertRejects(() => pool.query(`INSERT INTO xs_wallet (scores) VALUES ('{-1}')`));
      assertEquals((await checksOn(pool, "xs_wallet_tags")).length, 1);

      /*** Changed: min_value(0) → min_value(1). ***/
      assertEquals(await migrate(pool, wallets("{ constraint min_value(1); }")), 1);
      assertEquals((await violation(pool, `INSERT INTO xs_wallet (score) VALUES (0)`)).message, "Minimum allowed value for XsPos is 1.");
      await rollback(pool);
      await pool.query(`INSERT INTO xs_wallet (score) VALUES (0)`);

      /*** A property of the scalar added, then removed and the removal rolled back. ***/
      const withExtra = wallets("{ constraint min_value(0); }", "evm: XsEVMAddress; ln: XsLightningAddress; score: XsPos; extra: XsPos;");
      assertEquals(await migrate(pool, withExtra), 1);
      await assertRejects(() => pool.query(`INSERT INTO xs_wallet (extra) VALUES (-1)`));
      assertEquals(await migrate(pool, POSITIVE), 1);
      await rollback(pool);
      await assertRejects(() => pool.query(`INSERT INTO xs_wallet (extra) VALUES (-1)`), Error, "Minimum allowed value for XsPos is 0.");

      /*** The constraint removed from the scalar drops its CHECKs. ***/
      assertEquals(await migrate(pool, plain), 1);
      assertEquals(await checksOn(pool, "xs_wallet"), unconstrained);
      await pool.query(`INSERT INTO xs_wallet (score) VALUES (-1)`);
    })
});

Deno.test({
  name: "PG scalar constraint: stored values violating a new constraint fail the migration whole, naming it",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, wallets("")), 1);
      await pool.query(`INSERT INTO xs_wallet (score) VALUES (-1)`);

      const error = await assertRejects(() => migrate(pool, POSITIVE));
      assertStringIncludes(
        (error as Error).message,
        "Cannot add 'constraint min_value(0)' to property 'default::XsWallet.score' (scalar type 'default::XsPos'): " +
          "existing data violates it (Minimum allowed value for XsPos is 0.)"
      );
      assertStringIncludes((error as Error).message, "Nothing was applied.");
      assertEquals((await checksOn(pool, "xs_wallet_tags")).length, 0, "no CHECK of the migration was kept");

      await pool.query(`DELETE FROM xs_wallet`);
      assertEquals(await migrate(pool, POSITIVE), 1);
    })
});

Deno.test({
  name: "PG scalar constraint: a database migrated before Disc enforced scalar constraints gets the CHECKs on the next migrate, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      assertEquals(await migrate(pool, POSITIVE), 1);
      const declared = await checksOn(pool, "xs_wallet");

      /*** What a migrate before the fix left behind: the scalar's constraints declared, no CHECK on any column. ***/
      for (const name of declared) {
        await pool.query(`ALTER TABLE xs_wallet DROP CONSTRAINT ${name}`);
      }
      for (const name of await checksOn(pool, "xs_wallet_tags")) {
        await pool.query(`ALTER TABLE xs_wallet_tags DROP CONSTRAINT ${name}`);
      }
      await pool.query(`INSERT INTO xs_wallet (score) VALUES (-1)`);

      await assertRejects(() => migrate(pool, POSITIVE), Error, "existing data violates it (Minimum allowed value for XsPos is 0.)");
      assertEquals(await checksOn(pool, "xs_wallet"), [], "the failed repair changed nothing");

      await pool.query(`DELETE FROM xs_wallet`);
      assertEquals(await migrate(pool, POSITIVE), 1, "the repair runs");
      assertEquals(await checksOn(pool, "xs_wallet"), declared);
      assertEquals((await checksOn(pool, "xs_wallet_tags")).length, 1);
      assertEquals(await migrate(pool, POSITIVE), 0, "once repaired, the next migrate is a no-op");
    })
});

const EVEN = `module default {
  scalar type XsPos extending int64 { constraint min_value(0); };
  scalar type XsShort extending str { constraint max_len_value(3); };
  scalar type XsEven extending int64 { constraint expression on (__subject__ % 2 = 0); };
  scalar type XsEven2 extending XsEven;
  type XsBag { label: str; multi evens: XsEven; list: array<XsEven>; };
};`;

// Gel 7.1 checks a cast to a constrained scalar (`<XsPos>-1`, element by
// element for `<array<XsPos>>`), and a scalar's `constraint expression` on each
// element of a multi or array property, with the scalar's error.
Deno.test({
  name: "PG scalar constraint: casts to a constrained scalar, and expression constraints on multi and array elements, are checked",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema(EVEN);
      assertEquals(applied.ok, true, JSON.stringify(applied));
      const handler = new EdgeQLProtocolHandler({ databaseUrl: await getTestDsn(), schema: manager.getSchema()! });
      await manager.close();

      const errorOf = async (query: string, variables?: Record<string, unknown>): Promise<string | null> => {
        const response = await handler.handleRequest({ query, variables }, {
          auth: { permissions: [], roles: [] },
          requestId: "scalar_cast",
          session: { createdAt: new Date(), database: "disc_test", lastActivity: new Date(), sessionId: "scalar_cast", variables: {} },
          startedAt: new Date()
        });
        return response.errors?.[0]?.message.replace(/^Database query failed: /, "") ?? null;
      };

      const cases: [string, string | null, Record<string, unknown>?][] = [
        [`select <XsPos>-1`, "Minimum allowed value for XsPos is 0."],
        [`select <XsPos>'-3'`, "Minimum allowed value for XsPos is 0."],
        [`select <XsPos>$p`, "Minimum allowed value for XsPos is 0.", { p: -2 }],
        [`select (<XsPos>-1) ?? 3`, "Minimum allowed value for XsPos is 0."],
        [`select <array<XsPos>>[1, -1]`, "Minimum allowed value for XsPos is 0."],
        [`select <XsShort>'abcd'`, "XsShort must be no longer than 3 characters."],
        [`select <XsEven>3`, "invalid XsEven"],
        [`select <XsEven2>3`, "invalid XsEven"],
        [`select <XsPos>5`, null],
        [`select <XsPos>{}`, null],
        [`select <array<XsPos>>[1, 2]`, null],
        [`select <XsEven2>4`, null],
        [`insert XsBag { evens := {2, 3} }`, "invalid XsEven"],
        [`insert XsBag { list := [2, 3] }`, "invalid XsEven"],
        [`insert XsBag { label := 'ok', evens := {2, 4}, list := [2, 4] }`, null],
        [`insert XsBag { evens := <array<XsEven>>[] }`, null],
        [`update XsBag filter .label = 'ok' set { evens += 5 }`, "invalid XsEven"]
      ];
      const answers: [string, string | null][] = [];
      for (const [query, , variables] of cases) {
        answers.push([query, await errorOf(query, variables)]);
      }
      assertEquals(answers, cases.map(([query, expected]) => [query, expected]));

      const stored = await violation(pool, `INSERT INTO xs_bag (evens) VALUES (ARRAY[1]::bigint[])`);
      assertEquals([stored.sqlState, stored.message, stored.detail], [
        "23514",
        "invalid XsEven",
        "violated constraint 'std::expression' on scalar type 'default::XsEven'"
      ]);
    })
});

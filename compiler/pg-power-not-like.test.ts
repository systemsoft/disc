/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `^` is Gel's power operator (not PostgreSQL's bitwise xor
 * `#`), and `not like` / `not ilike` negate a pattern match — in queries and
 * in schema computeds alike.
 *
 * `^` binds tighter than unary minus and to the right (`-2 ^ 2` is -4,
 * `2 ^ 3 ^ 2` is 512); ints raise to a float64 (`2 ^ 3` is 8.0), decimals and
 * bigints to a decimal. Zero to a negative power and a negative number to a
 * non-integer power are errors with Gel's (PostgreSQL's) messages.
 *
 * Expected values are Gel 7.1's.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals, assertRejects } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type PowItem {
    required label: str;
    required n: int64;
    price: decimal;
    squared := .n ^ 2;
    root := .n ^ 0.5;
    price_squared := .price ^ 2;
    not_a := .label not like 'a%';
    not_a_ci := .label not ilike 'A%';
  }
}`;

const TABLES = ["pow_item"];

async function withSchema(run: (pool: ConnectionPool, schema: Schema) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();
  try {
    await dropAll(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
    const schema = manager.getSchema();
    if (!schema) {
      throw new Error("no schema after applySchema");
    }
    await pool.query(
      `INSERT INTO pow_item (id, label, n, price) VALUES
        (gen_random_uuid(), 'abc', 4, 1.5),
        (gen_random_uuid(), 'xyz', 9, NULL)`
    );
    await run(pool, schema);
    await manager.close();
  } finally {
    await dropAll(pool);
    await pool.close();
  }
}

async function dropAll(pool: ConnectionPool): Promise<void> {
  for (const table of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/*** Each row's single column, with bigint and numeric strings read as numbers. ***/
async function values(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<unknown[]> {
  const result = await pool.query(compileEdgeQL(edgeql, schema));
  return result.rows.map(row => {
    const [column] = Object.values(row);
    return typeof column === "bigint" || typeof column === "string" ? Number(column) : column;
  });
}

async function value(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<unknown> {
  const rows = await values(pool, schema, edgeql);
  assertEquals(rows.length, 1, `expected one row for ${edgeql}`);
  return rows[0];
}

Deno.test({
  name: "PG power: ^ raises to a power, tighter than unary minus and to the right",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await value(pool, schema, "select 2 ^ 3"), 8);
      assertEquals(await value(pool, schema, "select 2 ^ -1"), 0.5);
      assertEquals(await value(pool, schema, "select -2 ^ 2"), -4);
      assertEquals(await value(pool, schema, "select 2 ^ 3 ^ 2"), 512);
      assertEquals(await value(pool, schema, "select 2 * 3 ^ 2"), 18);
      assertEquals(await value(pool, schema, "select 2 ^ 0.5"), Math.SQRT2);
      assertEquals(await value(pool, schema, "select 1.5 ^ 2"), 2.25);
      assertEquals(await value(pool, schema, "select <float32>2 ^ <float32>3"), 8);
      assertEquals(await value(pool, schema, "select 2 ^ 3 = 8"), true);
      assertEquals(await value(pool, schema, "select 2n ^ 3"), 8);
      assertEquals(await value(pool, schema, "select 2.5n ^ 2"), 6.25);
      assertEquals(await value(pool, schema, "select 2n ^ -1"), 0.5);
    })
});

Deno.test({
  name: "PG power: zero to a negative power and a negative base to a fractional one are errors",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await assertRejects(() => value(pool, schema, "select 0 ^ -1"), Error, "zero raised to a negative power is undefined");
      await assertRejects(() => value(pool, schema, "select 0n ^ -1"), Error, "zero raised to a negative power is undefined");
      await assertRejects(
        () => value(pool, schema, "select (-8) ^ 0.5"),
        Error,
        "a negative number raised to a non-integer power yields a complex result"
      );
    })
});

Deno.test({
  name: "PG power: ^ over properties and in schema computeds",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select PowItem { label, sq := .n ^ 2 } order by .label"), [
        { label: "abc", sq: 16 },
        { label: "xyz", sq: 81 }
      ]);
      assertEquals(await values(pool, schema, "select PowItem { label, squared, root, price_squared } order by .label"), [
        { label: "abc", price_squared: 2.25, root: 2, squared: 16 },
        { label: "xyz", price_squared: null, root: 3, squared: 81 }
      ]);
      assertEquals(await values(pool, schema, "select PowItem { label } filter .n ^ 2 > 20"), [{ label: "xyz" }]);
    })
});

Deno.test({
  name: "PG not like / not ilike: negated pattern matches in queries and schema computeds",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await value(pool, schema, "select 'abc' not like 'a%'"), false);
      assertEquals(await value(pool, schema, "select 'abc' not ilike 'A%'"), false);
      assertEquals(await value(pool, schema, "select 'a' not like 'b' and true"), true);
      assertEquals(await values(pool, schema, "select {'a', 'b'} not like 'a'"), [false, true]);
      assertEquals(await values(pool, schema, "select PowItem { label } filter .label not like 'a%'"), [{ label: "xyz" }]);
      assertEquals(await values(pool, schema, "select PowItem { label } filter .label not ilike 'X%'"), [{ label: "abc" }]);
      assertEquals(await values(pool, schema, "select PowItem { label, not_a, not_a_ci } order by .label"), [
        { label: "abc", not_a: false, not_a_ci: false },
        { label: "xyz", not_a: true, not_a_ci: true }
      ]);
    })
});

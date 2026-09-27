/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: bigint (`10n`) and decimal (`1.5n`) literals are numeric
 * values, a cast applies to a prefix-operator operand (`<int64>-7`), and a
 * float cast to an integer or bigint rounds half to even (`<bigint>2.5` is 2).
 *
 * `10n` was the int64 10, `1.5n` did not parse and `<int64>-7` was a syntax
 * error. PostgreSQL hands a numeric back as its text, so a numeric result is
 * a string here and an int a number or bigint — the value's type shows in it.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { bootstrapStdlib } from "../lib/stdlib-sql.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { createTestSchema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();
const schema = createTestSchema();

async function withPool(run: (pool: ConnectionPool) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();
  try {
    await run(pool);
  } finally {
    await pool.close();
  }
}

/*** The single column of the single row `edgeql` selects. ***/
async function value(pool: ConnectionPool, edgeql: string): Promise<unknown> {
  const result = await pool.query(compileEdgeQL(edgeql, schema));
  assertEquals(result.rows.length, 1, `expected one row for ${edgeql}`);
  const columns = Object.values(result.rows[0]);
  assertEquals(columns.length, 1, `expected one column for ${edgeql}`);
  return columns[0];
}

Deno.test({
  name: "PG numeric literals: bigint and decimal literals are exact numerics",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      assertEquals(await value(pool, "select 10n"), "10");
      assertEquals(await value(pool, "select 12345678901234567890n"), "12345678901234567890");
      assertEquals(await value(pool, "select -7n"), "-7");
      assertEquals(await value(pool, "select 1.5n"), "1.5");
      assertEquals(await value(pool, "select 1.50n"), "1.50");
      assertEquals(await value(pool, "select 1e3n"), "1000");
      assertEquals(await value(pool, "select 10"), 10);
    })
});

Deno.test({
  name: "PG numeric literals: bigint and decimal literals divide as decimals",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      assertEquals(Number(await value(pool, "select 10n / 4n")), 2.5);
      assertEquals(await value(pool, "select 10n // 4n"), "2");
      assertEquals(await value(pool, "select -7n // 2n"), "-4");
      assertEquals(await value(pool, "select -7n % 2n"), "1");
      assertEquals(Number(await value(pool, "select 7.5n / 2")), 3.75);
      assertEquals(await value(pool, "select 10n + 1"), "11");
    })
});

Deno.test({
  name: "PG casts apply to a prefix-operator operand",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      assertEquals(await value(pool, "select <int64>-7"), -7n);
      assertEquals(await value(pool, "select <int64>-7 + 1"), -6n);
      assertEquals(await value(pool, "select <decimal>-7"), "-7");
      assertEquals(await value(pool, "select <decimal>-7.5"), "-7.5");
      assertEquals(await value(pool, "select <str>-1"), "-1");
      assertEquals(Number(await value(pool, "select <float64>+2")), 2);
      assertEquals(await value(pool, "select <bool>not true"), false);
    })
});

Deno.test({
  name: "PG a float cast to an integer or bigint rounds half to even, a decimal half away from zero (Gel)",
  ignore: !RUN_PG,
  fn: () =>
    withPool(async pool => {
      // A cast to bigint of a value that is not a literal is checked by disc_finite_numeric.
      await bootstrapStdlib(pool);
      // Gel 7.1 answers each with the value asserted.
      assertEquals(await value(pool, "select <bigint>2.5"), "2");
      assertEquals(await value(pool, "select <bigint>3.5"), "4");
      assertEquals(await value(pool, "select <bigint>-2.5"), "-2");
      assertEquals(await value(pool, "select <bigint><float32>2.5"), "2");
      assertEquals(await value(pool, "select <int64>2.5"), 2n);
      assertEquals(await value(pool, "select <int64>3.5"), 4n);
      assertEquals(await value(pool, "select <int64>(2.5 + 1.0)"), 4n);
      assertEquals(await value(pool, "select <int32>2.5"), 2);
      assertEquals(await value(pool, "select <int16>-2.5"), -2);
      assertEquals(await value(pool, "select <bigint>2.5n"), "3");
      assertEquals(await value(pool, "select <bigint>-2.5n"), "-3");
      assertEquals(await value(pool, "select <int64>2.5n"), 3n);
      assertEquals(await value(pool, "select <int64>-2.5n"), -3n);
      assertEquals(await value(pool, "select <array<bigint>>[2.5, 3.5]"), ["2", "4"]);
      assertEquals(await value(pool, "select <array<int64>>[2.5, 3.5]"), [2n, 4n]);
    })
});

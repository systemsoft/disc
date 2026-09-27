/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: indexing and slicing compiled from EdgeQL, as Gel 7.1 answers.
 *
 * An array slice compiled to `SUBSTRING`, which PostgreSQL has no form of for
 * arrays; a string slice with a negative end asked `SUBSTRING` for a negative
 * length; an index past either end of an array answered nothing, where Gel
 * raises `InvalidValueError: array index 5 is out of bounds`; and a `str` or
 * `bytes` could not be indexed at all. Each case runs the compiled SQL and
 * reads back the rows PostgreSQL returns.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type IdxItem {
    arr: array<int64>;
    data: bytes;
    s: str;
    ts: array<tuple<x: int64, y: str>>;
  }
}`;

const TABLES = ["idx_item"];

async function withSchema(run: (pool: ConnectionPool, schema: Schema) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();
  try {
    await dropAll(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    if (!schema) {
      throw new Error("no schema after applySchema");
    }
    await pool.query(
      `INSERT INTO idx_item (id, arr, data, s, ts) VALUES
        (gen_random_uuid(), ARRAY[10, 20, 30], '\\x616263', 'hello', '[{"x": 1, "y": "p"}, {"x": 2, "y": "q"}]')`
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

/*** A value as a test compares it: an int64 as a number, bytes as their text, an array element by element. ***/
function plain(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  return Array.isArray(value) ? value.map(plain) : value;
}

/*** The single column of each row, in row order. ***/
async function values(pool: ConnectionPool, schema: Schema, edgeql: string, params: unknown[] = []): Promise<unknown[]> {
  const result = await pool.query(compileEdgeQL(edgeql, schema), params);
  return result.rows.map(row => {
    const columns = Object.values(row);
    assertEquals(columns.length, 1, `expected one column per row for ${edgeql}: ${Object.keys(row).join(", ")}`);
    return plain(columns[0]);
  });
}

/*** The error PostgreSQL raises running `edgeql`: its message, and its SQLSTATE (class 22 is Gel's InvalidValueError). ***/
async function failure(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<{ code?: string; message: string; }> {
  const sql = compileEdgeQL(edgeql, schema);
  const error = await assertRejects(() => pool.query(sql)) as Error & { fields?: { code?: string; }; };
  return { code: error.fields?.code, message: error.message };
}

Deno.test({
  name: "PG indexing-slicing: array slices take Gel's 0-based, end-exclusive, clamped bounds",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select [10, 20, 30][1:3]"), [[20, 30]]);
      assertEquals(await values(pool, schema, "select [10, 20, 30][:-1]"), [[10, 20]]);
      assertEquals(await values(pool, schema, "select [10, 20, 30][1:]"), [[20, 30]]);
      assertEquals(await values(pool, schema, "select [10, 20, 30][-1:]"), [[30]]);
      assertEquals(await values(pool, schema, "select [10, 20, 30][-5:10]"), [[10, 20, 30]]);
      assertEquals(await values(pool, schema, "select [10, 20, 30][2:1]"), [[]]);
      assertEquals(await values(pool, schema, "select [10, 20, 30][5:]"), [[]]);
      // An empty bound is an empty slice.
      assertEquals(await values(pool, schema, "select [10, 20, 30][<int64>{}:2]"), []);
    })
});

Deno.test({
  name: "PG indexing-slicing: slices of an array property and an array parameter",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select IdxItem { x := .arr[1:] }"), [{ x: [20, 30] }]);
      assertEquals(await values(pool, schema, "select IdxItem { x := .arr[:-1] }"), [{ x: [10, 20] }]);
      assertEquals(await values(pool, schema, "select IdxItem.arr[1:]"), [[20, 30]]);
      assertEquals(await values(pool, schema, "select (<array<int64>>$0)[1:2]", [[5, 6, 7]]), [[6]]);
    })
});

Deno.test({
  name: "PG indexing-slicing: str and bytes slices keep working, with negative and out-of-range bounds",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select 'hello'[1:3]"), ["el"]);
      assertEquals(await values(pool, schema, "select 'hello'[1:-1]"), ["ell"]);
      assertEquals(await values(pool, schema, "select 'hello'[-10:2]"), ["he"]);
      assertEquals(await values(pool, schema, "select 'hello'[3:1]"), [""]);
      assertEquals(await values(pool, schema, "select 'hello'[2:]"), ["llo"]);
      assertEquals(await values(pool, schema, "select IdxItem { x := .s[1:-1] }"), [{ x: "ell" }]);
      assertEquals(await values(pool, schema, "select b'hello'[1:3]"), ["el"]);
      assertEquals(await values(pool, schema, "select IdxItem.data[1:]"), ["bc"]);
    })
});

Deno.test({
  name: "PG indexing-slicing: array, str and bytes indexes count from 0, a negative one from the end",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select [10, 20, 30][0]"), [10]);
      assertEquals(await values(pool, schema, "select [10, 20, 30][-3]"), [10]);
      assertEquals(await values(pool, schema, "select [10, 20, 30][(select 1)]"), [20]);
      assertEquals(await values(pool, schema, "select IdxItem.arr[-1]"), [30]);
      assertEquals(await values(pool, schema, "select 'abc'[1]"), ["b"]);
      assertEquals(await values(pool, schema, "select 'abc'[-1]"), ["c"]);
      assertEquals(await values(pool, schema, "select IdxItem { x := .s[0] }"), [{ x: "h" }]);
      assertEquals(await values(pool, schema, "select b'abc'[1]"), ["b"]);
      assertEquals(await values(pool, schema, "select 'abc'[<int64>{}]"), []);
    })
});

Deno.test({
  name: "PG indexing-slicing: an index past either end raises InvalidValueError, as Gel does",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const cases: [string, string][] = [
        ["select [10, 20, 30][5]", "array index 5 is out of bounds"],
        ["select [10, 20, 30][-4]", "array index -4 is out of bounds"],
        ["select IdxItem { x := .arr[3] }", "array index 3 is out of bounds"],
        ["select [(a := 1), (a := 2)][5]", "array index 5 is out of bounds"],
        ["select 'abc'[5]", "string index 5 is out of bounds"],
        ["select 'abc'[-4]", "string index -4 is out of bounds"],
        ["select b'abc'[5]", "byte string index 5 is out of bounds"]
      ];
      for (const [edgeql, message] of cases) {
        const error = await failure(pool, schema, edgeql);
        assertStringIncludes(error.message, message, edgeql);
        assertEquals(error.code?.startsWith("22"), true, `${edgeql}: SQLSTATE ${error.code}`);
      }
      // `array_get` answers nothing instead.
      assertEquals(await values(pool, schema, "select array_get([10, 20, 30], 5)"), []);
    })
});

Deno.test({
  name: "PG indexing-slicing: an element of an array of tuples, then its field",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select [(n := 1)][0].n"), [1]);
      assertEquals(await values(pool, schema, "select [(n := 1, m := 'x')][-1].m"), ["x"]);
      assertEquals(await values(pool, schema, "select ([(a := (b := 5))][0]).a.b"), [5]);
      assertEquals(await values(pool, schema, "select (select [1, 2, 3])[0]"), [1]);
      assertEquals(await values(pool, schema, "select IdxItem { x := .ts[0].y, n := .ts[-1].x }"), [{ n: 2, x: "p" }]);
      assertEquals(await values(pool, schema, "select IdxItem.ts[1].y"), ["q"]);
    })
});

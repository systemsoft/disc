/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: tuple element access and the names of united tuples, as Gel
 * 7.1 answers.
 *
 * `(a := 1).a` read the element back out of the tuple's jsonb as text (`'1'`,
 * and `(a := 1).a + 1` failed); `select Rec.t.a` through a stored named tuple
 * was a compile error; and `[(a := 1)] ++ [(2,)]`, `{(a := 1), (2,)}` and
 * `[(a := 1), (b := 2)]` kept each tuple's own names, where Gel unites
 * differently named tuples as unnamed ones. Each case runs the compiled SQL
 * and reads back the rows PostgreSQL returns.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type TupleRec {
    t: tuple<a: int64, b: str>;
    u: tuple<int64, tuple<c: str>>;
  }
}`;

const TABLES = ["tuple_rec"];

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
      `INSERT INTO tuple_rec (id, t, u) VALUES
        (gen_random_uuid(), '{"a": 1, "b": "x"}', '[7, {"c": "k"}]'),
        (gen_random_uuid(), '{"a": 2, "b": "y"}', NULL)`
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

/*** The single column of each row, in row order; an int64 as a number. ***/
async function values(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<unknown[]> {
  const result = await pool.query(compileEdgeQL(edgeql, schema));
  return result.rows.map(row => {
    const columns = Object.values(row);
    assertEquals(columns.length, 1, `expected one column per row for ${edgeql}: ${Object.keys(row).join(", ")}`);
    const value = columns[0];
    return typeof value === "bigint" ? Number(value) : value;
  });
}

Deno.test({
  name: "PG tuple access: an element of a tuple literal is its own type",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select (a := 1).a"), [1]);
      assertEquals(await values(pool, schema, "select (a := 1).a + 1"), [2]);
      assertEquals(await values(pool, schema, "select (a := 1, b := 'x').b"), ["x"]);
      assertEquals(await values(pool, schema, "select (a := true).a"), [true]);
      assertEquals(await values(pool, schema, "select (1, 'x').0"), [1]);
      assertEquals(await values(pool, schema, "select (a := 1, b := 'x').1"), ["x"]);
      assertEquals(await values(pool, schema, "select ((1, 2), (3, 4)).0"), [[1, 2]]);
      assertEquals(await values(pool, schema, "select (a := (b := 5)).a.b"), [5]);
    })
});

Deno.test({
  name: "PG tuple access: select of a stored tuple's element through a path answers bare values",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(((await values(pool, schema, "select TupleRec.t.a")) as number[]).sort(), [1, 2]);
      assertEquals(((await values(pool, schema, "select TupleRec.t.b")) as string[]).sort(), ["x", "y"]);
      // An object without the tuple adds no element.
      assertEquals(await values(pool, schema, "select TupleRec.u.0"), [7]);
      assertEquals(await values(pool, schema, "select TupleRec.u.1.c"), ["k"]);
    })
});

Deno.test({
  name: "PG tuple access: united tuples of different names are unnamed, of the same names keep them",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select [(a := 1)] ++ [(2,)]"), [[[1], [2]]]);
      assertEquals(await values(pool, schema, "select [(2,)] ++ [(a := 1)]"), [[[2], [1]]]);
      assertEquals(await values(pool, schema, "select [(a := 1)] ++ [(a := 2)]"), [[{ a: 1 }, { a: 2 }]]);
      assertEquals(await values(pool, schema, "select [(a := 1, b := 2)] ++ [(a := 3, c := 4)]"), [[[1, 2], [3, 4]]]);
      assertEquals(await values(pool, schema, "select [(a := (b := 1))] ++ [(a := (2,))]"), [[{ a: [1] }, { a: [2] }]]);
      assertEquals(await values(pool, schema, "select [(a := 1), (2,)]"), [[[1], [2]]]);
      assertEquals(await values(pool, schema, "select [(a := 1), (b := 2)]"), [[[1], [2]]]);
      assertEquals(await values(pool, schema, "select [(a := 1), (b := 2)][0]"), [[1]]);
      assertEquals(await values(pool, schema, "select {(a := 1), (2,)}"), [[1], [2]]);
      assertEquals(await values(pool, schema, "select {(a := 1), (a := 2)}"), [{ a: 1 }, { a: 2 }]);
      assertEquals(await values(pool, schema, "select (a := 1) union (b := 2)"), [[1], [2]]);
      assertEquals(await values(pool, schema, "select (a := 1) union (a := 2)"), [{ a: 1 }, { a: 2 }]);
    })
});

Deno.test({
  name: "PG tuple access: '??' and 'if … else' over tuples of different names are unnamed, as union's are",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select (a := 1) ?? (b := 2)"), [[1]]);
      assertEquals(await values(pool, schema, "select <tuple<a: int64>>{} ?? (b := 2)"), [[2]]);
      assertEquals(await values(pool, schema, "select (a := 1) ?? (a := 2)"), [{ a: 1 }]);
      assertEquals(await values(pool, schema, "select (a := 1) if true else (b := 2)"), [[1]]);
      assertEquals(await values(pool, schema, "select (a := 1) if false else (b := 2)"), [[2]]);
      assertEquals(await values(pool, schema, "select (a := 1) if true else (a := 2)"), [{ a: 1 }]);
      assertEquals(await values(pool, schema, "select [(a := 1)] ?? [(b := 2)]"), [[[1]]]);
      assertEquals(await values(pool, schema, "select [(a := 1)] if false else [(b := 2)]"), [[[2]]]);
      assertEquals(await values(pool, schema, "select ((a := 1) ?? (b := 2)).0"), [1]);
    })
});

Deno.test({
  name: "PG tuple access: an element read inside an operator keeps its own precedence",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select 'y' ++ (a := 'x').a"), ["yx"]);
      assertEquals(await values(pool, schema, "select (a := 'x').a ++ 'y'"), ["xy"]);
      assertEquals(await values(pool, schema, "select 'y' ++ (a := 'x').a ++ 'z'"), ["yxz"]);
      assertEquals(await values(pool, schema, "select 1 + (a := 2).a"), [3]);
      assertEquals(await values(pool, schema, "select (a := 2).a * 3"), [6]);
      assertEquals(await values(pool, schema, "select 'x' = (a := 'x').a"), [true]);
      assertEquals(await values(pool, schema, "select 'abc' like (a := 'a%').a"), [true]);
      assertEquals(await values(pool, schema, "select (a := 'abc').a like 'a%'"), [true]);
      assertEquals(await values(pool, schema, "select (a := 'x').a in {'x', 'y'}"), [true]);
      assertEquals(await values(pool, schema, "select to_json('[1]') ++ (a := to_json('[2]')).a"), [[1, 2]]);
    })
});

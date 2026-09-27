/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `len()` by argument type, and set-returning function
 * arguments to aggregates, `exists`, `enumerate` and with-bound selects.
 *
 * Before: `len()` was `LENGTH()` for everything (no `length(interval[])` or
 * `length(text[])` in PostgreSQL), and `count(array_unpack(…))` was
 * `COUNT(UNNEST(…))` ("aggregate function calls cannot contain set-returning
 * function calls").
 *
 * Compile-level coverage: `compiler/std-function-gaps.test.ts`.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { unwrapExactNumbers } from "../lib/exact-json.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import type * as ServerTypes from "../server/types.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";

const SDL = `module default {
  type LenDoc {
    required title: str;
    data: bytes;
    tags: array<str>;
    durs: array<duration>;
  };
};`;

type Run = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
type Values = (query: string, variables?: Record<string, unknown>) => Promise<unknown[]>;

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `std_function_gaps_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

/*** Run `fn` against a migrated schema: `run` returns a query's data, `values` a scalar select's values. ***/
async function withHandler(fn: (run: Run, values: Values) => Promise<void>): Promise<void> {
  const dsn = await getTestDsn();
  const pool: ConnectionPool = makePool(dsn);
  await pool.initialize();

  try {
    await resetTestDatabase(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
    const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
    await manager.close();

    const run: Run = async (query, variables) => {
      const response = await handler.handleRequest({ query, variables }, makeContext());
      assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
      return response.data;
    };
    // A scalar select is one row per value, with one column; a numeric value may arrive as an exact JSON number.
    const values: Values = async (query, variables) =>
      ((await run(query, variables)) as Record<string, unknown>[]).map(row => unwrapExactNumbers(Object.values(row)[0]));

    await fn(run, values);
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG len(): arrays count elements (any element type), bytes count bytes, str counts characters",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (run, values) => {
      assertEquals(await values("select len(<array<str>>$x)", { x: ["a", "b", "c"] }), [3]);
      assertEquals(await values("select len(<array<duration>>$x)", { x: ["1 hour", "2 hours"] }), [2]);
      assertEquals(await values("select len([1, 2, 3, 4])"), [4]);
      assertEquals(await values("select len('héllo')"), [5]);

      await run(`insert LenDoc { title := "héllo", data := <bytes>$d, tags := ["a", "b"], durs := [<duration>"1 hour"] }`, { d: "aOls" });
      assertEquals(await run("select LenDoc { t := len(.tags), d := len(.durs), b := len(.data), s := len(.title) }"), [{ b: 3, d: 1, s: 5, t: 2 }]);
    });
  }
});

Deno.test({
  name: "PG set-returning argument: aggregates over array_unpack / json_array_unpack return the set's aggregate",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (_run, values) => {
      const x = { x: [3, 1, 2] };
      assertEquals(await values("select count(array_unpack(<array<int64>>$x))", x), [3]);
      assertEquals((await values("select sum(array_unpack(<array<int64>>$x))", x)).map(Number), [6]);
      assertEquals(await values("select min(array_unpack(<array<int64>>$x))", x), [1]);
      assertEquals(await values("select max(array_unpack(<array<int64>>$x))", x), [3]);
      assertEquals(await values("select array_agg(array_unpack(<array<str>>$x))", { x: ["a", "b"] }), [["a", "b"]]);
      assertEquals(await values("select count(array_unpack(<array<int64>>$x))", { x: [] }), [0]);
      assertEquals((await values("select sum(array_unpack(<array<int64>>$x))", { x: [] })).map(Number), [0]);
      assertEquals(await values("select count(json_array_unpack(<json>$j))", { j: [1, 2] }), [2]);
      assertEquals(await values("with a := array_unpack(<array<int64>>$x) select count(a)", x), [3]);
      assertEquals(await values("with a := {1, 2, 3} select count(a)"), [3]);
    });
  }
});

Deno.test({
  name: "PG set-returning argument: exists, filter/order over a with binding, enumerate",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (run, values) => {
      assertEquals(await values("select exists array_unpack(<array<int64>>$x)", { x: [1] }), [true]);
      assertEquals(await values("select exists array_unpack(<array<int64>>$x)", { x: [] }), [false]);
      assertEquals(await values("select std::exists(array_unpack(<array<int64>>$x))", { x: [] }), [false]);

      await run(`insert LenDoc { title := "a" }`);
      assertEquals(await run("select LenDoc { title } filter exists array_unpack(<array<int64>>$x)", { x: [] }), []);
      assertEquals(await run("select LenDoc { title } filter exists array_unpack(<array<int64>>$x)", { x: [5] }), [{ title: "a" }]);

      assertEquals(await values("with a := array_unpack(<array<int64>>$x) select a filter a > 1 order by a desc", { x: [3, 1, 2, 5] }), [5, 3, 2]);
      assertEquals(await values("with a := {3, 1, 2} select a filter a < 3 order by a"), [1, 2]);
      assertEquals(await values("select enumerate(array_unpack(<array<str>>$x))", { x: ["a", "b", "c"] }), [[0, "a"], [1, "b"], [2, "c"]]);
      assertEquals(await values("select count(enumerate(array_unpack(<array<str>>$x)))", { x: ["a", "b"] }), [2]);
    });
  }
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: whole-tuple comparisons and literal `array<tuple>` writes.
 *
 * Tuples are stored as jsonb, and the same value can be written as different
 * JSON: a literal's datetime is PostgreSQL's `to_jsonb` text
 * (`2024-01-01T00:00:00+00:00`), a parameter's is whatever the client sent
 * (`2024-01-01T00:00:00Z`, `…+02:00`), a decimal may arrive as a JSON string.
 * `=`, `!=`, `?=` and `in` on whole tuples must compare the values, not the
 * JSON text.
 *
 * A literal `array<tuple>` (`[(n := 1, s := "a")]`, `<array<tuple<…>>>[]`)
 * must be written as the same jsonb array the parameter form writes, not as a
 * PostgreSQL `jsonb[]`.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type TupRow {
    required name: str;
    t: tuple<n: int64, at: datetime>;
    u: tuple<int64, datetime>;
    d: tuple<x: decimal, b: bool, inner: tuple<s: str, at: datetime>>;
    ts: array<tuple<n: int64, s: str>>;
  };
};`;

function makeContext(): Types.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `tuple_cmp_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

type Run = (query: string, variables?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;

/*** Migrate SDL, hand `body` a query runner, then drop the tables. ***/
async function withSchema(body: (run: Run) => Promise<void>): Promise<void> {
  const dsn = await getTestDsn();
  const pool = makePool(dsn);
  await pool.initialize();
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  try {
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, JSON.stringify(applied));
    const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
    try {
      await body(async (query, variables) => {
        const res = await handler.handleRequest({ query, variables }, makeContext());
        assertEquals(res.errors, undefined, `${query}: ${JSON.stringify(res.errors)}`);
        const data = res.data;
        return (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
      });
    } finally {
      await handler.close();
    }
  } finally {
    await pool.query("DROP TABLE IF EXISTS tup_row CASCADE");
    await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
    await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
    await pool.close();
  }
}

async function names(run: Run, query: string, variables?: Record<string, unknown>): Promise<string[]> {
  return (await run(query, variables)).map(row => row.name as string).sort();
}

Deno.test({
  name: "PG tuple comparison: named tuple with datetime compares by value (literal vs param writes)",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async run => {
      await run(`insert TupRow { name := "a", t := (n := 1, at := <datetime>'2024-01-01T00:00:00Z') }`);
      await run(`insert TupRow { name := "b", t := <tuple<n: int64, at: datetime>>$t }`, {
        t: { at: "2024-01-01T00:00:00Z", n: 2 }
      });
      // The same instant as "a", written with another offset.
      await run(`insert TupRow { name := "c", t := <tuple<n: int64, at: datetime>>$t }`, {
        t: { at: "2024-01-01T02:00:00+02:00", n: 1 }
      });
      await run(`insert TupRow { name := "none" }`);

      assertEquals(await names(run, `select TupRow { name } filter .t = (n := 2, at := <datetime>'2024-01-01T00:00:00Z')`), ["b"]);
      assertEquals(await names(run, `select TupRow { name } filter .t = (n := 1, at := <datetime>'2024-01-01T00:00:00Z')`), ["a", "c"]);
      assertEquals(
        await names(run, `select TupRow { name } filter .t = <tuple<n: int64, at: datetime>>$t`, {
          t: { at: "2024-01-01T00:00:00Z", n: 1 }
        }),
        ["a", "c"]
      );
      assertEquals(await names(run, `select TupRow { name } filter .t != (n := 1, at := <datetime>'2024-01-01T00:00:00Z')`), ["b"]);
      assertEquals(await names(run, `select TupRow { name } filter .t ?= (n := 2, at := <datetime>'2024-01-01T00:00:00Z')`), ["b"]);
      assertEquals(await names(run, `select TupRow { name } filter .t ?= <tuple<n: int64, at: datetime>>{}`), ["none"]);
      assertEquals(
        await names(
          run,
          `select TupRow { name } filter .t in {(n := 2, at := <datetime>'2024-01-01T00:00:00Z'), (n := 9, at := <datetime>'2024-01-01T00:00:00Z')}`
        ),
        ["b"]
      );
    });
  }
});

Deno.test({
  name: "PG tuple comparison: unnamed tuple and nested tuple with decimal compare by value",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async run => {
      await run(
        `insert TupRow { name := "lit", u := (1, <datetime>'2024-01-01T00:00:00Z'), ` +
          `d := (x := 1.50n, b := true, inner := (s := "q", at := <datetime>'2024-01-01T00:00:00Z')) }`
      );
      await run(
        `insert TupRow { name := "param", u := <tuple<int64, datetime>>$u, ` +
          `d := <tuple<x: decimal, b: bool, inner: tuple<s: str, at: datetime>>>$d }`,
        {
          d: { b: true, inner: { at: "2024-01-01T00:00:00.000Z", s: "q" }, x: "1.5" },
          u: [1, "2024-01-01T00:00:00.000Z"]
        }
      );

      assertEquals(await names(run, `select TupRow { name } filter .u = (1, <datetime>'2024-01-01T00:00:00Z')`), ["lit", "param"]);
      assertEquals(
        await names(run, `select TupRow { name } filter .d = (x := 1.5n, b := true, inner := (s := "q", at := <datetime>'2024-01-01T00:00:00Z'))`),
        ["lit", "param"]
      );
      assertEquals(
        await names(run, `select TupRow { name } filter .d = (x := 1.5n, b := false, inner := (s := "q", at := <datetime>'2024-01-01T00:00:00Z'))`),
        []
      );
    });
  }
});

Deno.test({
  name: "PG array<tuple> literal: insert, empty cast and update write the parameter form's jsonb array",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async run => {
      await run(`insert TupRow { name := "lit", ts := [(n := 1, s := "a"), (n := 2, s := "b")] }`);
      await run(`insert TupRow { name := "param", ts := <array<tuple<n: int64, s: str>>>$ts }`, {
        ts: [{ n: 1, s: "a" }, { n: 2, s: "b" }]
      });
      await run(`insert TupRow { name := "empty", ts := <array<tuple<n: int64, s: str>>>[] }`);
      await run(`insert TupRow { name := "cast", ts := <array<tuple<n: int64, s: str>>>[(n := 5, s := "e")] }`);
      await run(`insert TupRow { name := "upd" }`);
      await run(`update TupRow filter .name = "upd" set { ts := [(n := 3, s := "c")] }`);

      const rows = await run(`select TupRow { name, ts } order by .name`);
      const byName = Object.fromEntries(rows.map(row => [row.name, row.ts]));
      const pair = [{ n: 1, s: "a" }, { n: 2, s: "b" }];
      assertEquals(byName.lit, pair);
      assertEquals(byName.param, pair);
      assertEquals(byName.empty, []);
      assertEquals(byName.cast, [{ n: 5, s: "e" }]);
      assertEquals(byName.upd, [{ n: 3, s: "c" }]);
    });
  }
});

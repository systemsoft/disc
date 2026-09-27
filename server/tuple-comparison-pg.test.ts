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
import { compileEdgeQL } from "../compiler/test-helpers.ts";
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
    o: tuple<at: datetime, n: int64>;
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

/*** Runs SQL on the pool: `edgeql` compiled, or `raw` as is. ***/
interface Sql {
  (edgeql: string): Promise<Record<string, unknown>[]>;
  raw: (sql: string) => Promise<Record<string, unknown>[]>;
}

/*** Migrate SDL, hand `body` a query runner (and one of SQL, for what the handler does not take), then drop the tables. ***/
async function withSchema(body: (run: Run, sql: Sql) => Promise<void>): Promise<void> {
  const dsn = await getTestDsn();
  const pool = makePool(dsn);
  await pool.initialize();
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  try {
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, JSON.stringify(applied));
    const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
    const raw = async (sql: string): Promise<Record<string, unknown>[]> => (await pool.query(sql)).rows as Record<string, unknown>[];
    const sql: Sql = Object.assign((edgeql: string) => raw(compileEdgeQL(edgeql, manager.getSchema()!)), { raw });
    try {
      await body(async (query, variables) => {
        const res = await handler.handleRequest({ query, variables }, makeContext());
        assertEquals(res.errors, undefined, `${query}: ${JSON.stringify(res.errors)}`);
        const data = res.data;
        return (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
      }, sql);
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

/*** Rows whose tuples hold values the stored JSON text would order wrongly. ***/
async function insertOrdered(run: Run): Promise<void> {
  // `o` is `tuple<at: datetime, n: int64>`: jsonb orders an object's keys
  // shortest first, so as stored `n` would be compared before `at`.
  await run(`insert TupRow { name := "a", o := (at := <datetime>'2024-01-01T00:00:00Z', n := 2), u := (10, <datetime>'2024-01-01T00:00:00Z') }`);
  await run(`insert TupRow { name := "b", o := <tuple<at: datetime, n: int64>>$o, u := <tuple<int64, datetime>>$u }`, {
    o: { at: "2024-01-02T00:00:00Z", n: 1 },
    u: [9, "2024-01-01T00:00:00Z"]
  });
  // 2023-12-31T23:00:00Z: first, though its text sorts after "a"'s.
  await run(`insert TupRow { name := "c", o := <tuple<at: datetime, n: int64>>$o, u := <tuple<int64, datetime>>$u }`, {
    o: { at: "2024-01-01T01:00:00+02:00", n: 5 },
    u: [9, "2023-12-31T23:30:00-01:00"]
  });
}

Deno.test({
  name: "PG tuple order: `order by` a whole tuple sorts its typed elements in declared order",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async (run, sql) => {
      await insertOrdered(run);
      await run(`insert TupRow { name := "none" }`);
      // Written before tuples were stored canonical: a read must still order it by value.
      await sql.raw(`UPDATE tup_row SET o = '{"n": 5, "at": "2024-01-01T01:00:00+02:00"}' WHERE name = 'c'`);
      const order = async (query: string): Promise<string[]> => (await run(query)).map(row => row.name as string);
      assertEquals(await order(`select TupRow { name } filter exists .o order by .o`), ["c", "a", "b"]);
      assertEquals(await order(`select TupRow { name } filter exists .o order by .o desc`), ["b", "a", "c"]);
      // 9 before 10, then the instants: "b" (00:00Z) before "c" (00:30Z).
      assertEquals(await order(`select TupRow { name } order by .u empty last`), ["b", "c", "a", "none"]);
      assertEquals(await order(`select TupRow { name } order by .u desc empty first`), ["none", "a", "c", "b"]);
    });
  }
});

Deno.test({
  name: "PG tuple distinct and group: equal tuples written as different JSON are one value",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async (run, sql) => {
      await run(`insert TupRow { name := "a", t := (n := 1, at := <datetime>'2024-01-01T00:00:00Z') }`);
      await run(`insert TupRow { name := "b", t := <tuple<n: int64, at: datetime>>$t }`, { t: { at: "2024-01-01T02:00:00+02:00", n: 1 } });
      await run(`insert TupRow { name := "c", t := <tuple<n: int64, at: datetime>>$t }`, { t: { at: "2024-01-01T00:00:00Z", n: 2 } });
      // Written before tuples were stored canonical.
      await sql.raw(`INSERT INTO tup_row (name, t) VALUES ('old', '{"n": 1, "at": "2024-01-01T00:00:00Z"}')`);

      const distinct = await run(`select distinct TupRow.t`);
      assertEquals(distinct.length, 2, JSON.stringify(distinct));

      const groups = await run(`group TupRow by .t`);
      const sizes = groups.map(row => (row.elements as unknown[]).length).sort();
      assertEquals(sizes, [1, 3], JSON.stringify(groups));
    });
  }
});

Deno.test({
  name: "PG tuple membership: `in array_unpack(<array<tuple<…>>>…)` compares whole tuples by value",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async run => {
      await run(`insert TupRow { name := "a", t := (n := 1, at := <datetime>'2024-01-01T00:00:00Z') }`);
      await run(`insert TupRow { name := "b", t := (n := 2, at := <datetime>'2024-01-01T00:00:00Z') }`);
      const param = { p: [{ at: "2024-01-01T02:00:00+02:00", n: 1 }, { at: "2024-01-01T00:00:00Z", n: 9 }] };
      assertEquals(await names(run, `select TupRow { name } filter .t in array_unpack(<array<tuple<n: int64, at: datetime>>>$p)`, param), ["a"]);
      assertEquals(await names(run, `select TupRow { name } filter .t not in array_unpack(<array<tuple<n: int64, at: datetime>>>$p)`, param), ["b"]);
      assertEquals(await names(run, `select TupRow { name } filter .t in array_unpack(<array<tuple<n: int64, at: datetime>>>[])`), []);

      const [row] = await run(
        `select ((2, 'b') in array_unpack([(1, 'a'), (2, 'b')]), (3, 'b') in array_unpack(<array<tuple<int64, str>>>[(1, 'a'), (2, 'b')]))`
      );
      assertEquals(Object.values(row)[0], [true, false]);
    });
  }
});

Deno.test({
  name: "PG tuple comparison: named and unnamed tuples compare by position (Gel 7.1)",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async run => {
      const [row] = await run(
        `select ((1, 'a') = (a := 1, b := 'a'), (a := 1, b := 'a') = (b := 1, a := 'a'), (1, 'a') != (a := 1, b := 'b'), ` +
          `(a := 1, b := 'a') ?= (1, 'a'), (1, 'a') in {(a := 1, b := 'a')}, (x := (1, 'a')) = (y := (a := 1, b := 'a')))`
      );
      assertEquals(Object.values(row)[0], [true, true, true, true, true, true]);

      await run(`insert TupRow { name := "u", u := (9, <datetime>'2024-01-01T00:00:00Z') }`);
      assertEquals(await names(run, `select TupRow { name } filter .u = (a := 9, b := <datetime>'2024-01-01T00:00:00Z')`), ["u"]);
    });
  }
});

Deno.test({
  name: "PG array<tuple> literal outside a write: output is Gel's JSON",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async run => {
      assertEquals(Object.values((await run(`select [(1, 'a'), (2, 'b')]`))[0]), [[[1, "a"], [2, "b"]]]);
      assertEquals(Object.values((await run(`select [(n := 1, s := 'a')]`))[0]), [[{ n: 1, s: "a" }]]);
      await run(`insert TupRow { name := "a" }`);
      const [shape] = await run(`select TupRow { name, x := [(n := 1, at := <datetime>'2024-01-01T00:00:00Z')] }`);
      assertEquals(shape.x, [{ at: "2024-01-01T00:00:00+00:00", n: 1 }]);
    });
  }
});

Deno.test({
  name: "PG tuple write: a parameter is stored as the JSON a literal of the same value writes",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async run => {
      await run(`insert TupRow { name := "lit", t := (n := 1, at := <datetime>'2024-01-01T00:00:00Z'), u := (1, <datetime>'2024-01-01T00:00:00Z') }`);
      await run(`insert TupRow { name := "param", t := <tuple<n: int64, at: datetime>>$t }`, { t: { at: "2024-01-01T02:00:00+02:00", n: "1" } });
      await run(`update TupRow filter .name = "param" set { u := <tuple<int64, datetime>>$u }`, { u: [1, "2024-01-01T00:00:00.000Z"] });
      const rows = await run(`select TupRow { name, t, u } order by .name`);
      assertEquals(rows[0].t, rows[1].t);
      assertEquals(rows[0].u, rows[1].u);
    });
  }
});

Deno.test({
  name: "PG array<tuple> write: a parameter is stored as the jsonb array a literal of the same value writes",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async (run, sql) => {
      await run(`insert TupRow { name := "lit", ts := [(n := 3, s := "c"), (n := 4, s := "d")] }`);
      await run(`insert TupRow { name := "param", ts := <array<tuple<n: int64, s: str>>>$ts }`, {
        ts: [{ n: "3", s: "c" }, { n: 4, s: "d" }]
      });
      await run(`insert TupRow { name := "upd" }`);
      await run(`update TupRow filter .name = "upd" set { ts := <array<tuple<n: int64, s: str>>>$ts }`, {
        ts: [{ n: "3", s: "c" }, { n: 4, s: "d" }]
      });
      const stored = await sql.raw(`SELECT name, ts::text AS ts FROM tup_row`);
      assertEquals(new Set(stored.map(row => row.ts)).size, 1, JSON.stringify(stored));

      // Written before array<tuple> parameters were stored canonical: still equal by value.
      await sql.raw(`INSERT INTO tup_row (name, ts) VALUES ('old', '[{"n": "3", "s": "c"}, {"n": "4", "s": "d"}]')`);
      const all = ["lit", "old", "param", "upd"];
      assertEquals(await names(run, `select TupRow { name } filter .ts = [(n := 3, s := "c"), (n := 4, s := "d")]`), all);
      assertEquals(
        await names(run, `select TupRow { name } filter .ts = <array<tuple<n: int64, s: str>>>$p`, { p: [{ n: 3, s: "c" }, { n: "4", s: "d" }] }),
        all
      );
      assertEquals((await run(`select distinct TupRow.ts`)).length, 1);
    });
  }
});

/*** The one value `query` selects. ***/
async function value(run: Run, query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const rows = await run(query, variables);
  assertEquals(rows.length, 1, `${query}: ${JSON.stringify(rows)}`);
  return Object.values(rows[0])[0];
}

/*** The values `query` selects, in order. ***/
async function values(run: Run, query: string, variables?: Record<string, unknown>): Promise<unknown[]> {
  return (await run(query, variables)).map(row => Object.values(row)[0]);
}

Deno.test({
  name: "PG array<tuple> expressions: literals, parameters and aggregates are one jsonb array form (Gel 7.1)",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async run => {
      const p = { p: [[2, "b"]] };
      assertEquals(await value(run, `select [(1, 'a')] ++ <array<tuple<int64, str>>>$p`, p), [[1, "a"], [2, "b"]]);
      assertEquals(await value(run, `select [(1, 'a')] ++ [(2, 'b')]`), [[1, "a"], [2, "b"]]);
      assertEquals(await value(run, `select array_agg({(1, 'a'), (2, 'b')})`), [[1, "a"], [2, "b"]]);
      assertEquals(await value(run, `select array_agg((2, 'b')) = <array<tuple<int64, str>>>$p`, p), true);
      assertEquals(await value(run, `select [(1, 'a')] = [(a := 1, b := 'a')]`), true);
      assertEquals(await value(run, `select [(2, 'b')] = <array<tuple<int64, str>>>$p`, p), true);
      assertEquals(await value(run, `select [(1, 'a')] != <array<tuple<int64, str>>>$p`, p), true);
      assertEquals(await value(run, `select [(1, 'a')] < [(1, 'b')]`), true);
      assertEquals(await value(run, `select [(1, 'a')] < [(0, 'b'), (0, 'c')]`), false);
      assertEquals(await value(run, `select [(1, 'a')] in {[(1, 'a')], [(2, 'b')]}`), true);
      assertEquals(await values(run, `select array_unpack([(1, 'a'), (2, 'b')])`), [[1, "a"], [2, "b"]]);
      assertEquals(await values(run, `select array_unpack(<array<tuple<int64, str>>>$p)`, p), [[2, "b"]]);
      assertEquals(await value(run, `select len([(1, 'a'), (2, 'b')])`), 2);
      assertEquals(await value(run, `select len(<array<tuple<int64, str>>>$p)`, p), 1);
      assertEquals(await value(run, `select [(1, 'a'), (2, 'b')][0]`), [1, "a"]);
      assertEquals(await value(run, `select [(1, 'a'), (2, 'b')][-1]`), [2, "b"]);
      assertEquals(await value(run, `select (<array<tuple<int64, str>>>$p)[0]`, p), [2, "b"]);
      assertEquals(await value(run, `select [(1, 'a'), (2, 'b')][1:]`), [[2, "b"]]);
      assertEquals(await value(run, `select [(1, 'a'), (2, 'b'), (3, 'c')][-2:]`), [[2, "b"], [3, "c"]]);
      assertEquals(await value(run, `select [(1, 'a'), (2, 'b')][:-1]`), [[1, "a"]]);
      assertEquals(await value(run, `select [(1, 'a'), (2, 'b')][5:]`), []);
      assertEquals(await value(run, `select (<array<tuple<int64, str>>>$p)[0:1]`, p), [[2, "b"]]);
    });
  }
});

Deno.test({
  name: "PG array<tuple> properties: len, index, slice, concat and order by (Gel 7.1)",
  ignore: !RUN_PG,
  fn: async () => {
    await withSchema(async (run, sql) => {
      await run(`insert TupRow { name := "a", ts := [(n := 1, s := "a"), (n := 2, s := "b")] }`);
      await run(`insert TupRow { name := "b", ts := <array<tuple<n: int64, s: str>>>$ts }`, { ts: [{ n: 3, s: "c" }] });
      await run(`insert TupRow { name := "c" }`);
      // Written before array<tuple> parameters were stored canonical: 10 sorts after 3.
      await sql.raw(`INSERT INTO tup_row (name, ts) VALUES ('d', '[{"n": "10", "s": "a"}]')`);

      const rows = await run(`select TupRow { name, n := len(.ts), f := .ts[0], sl := .ts[1:], x := .ts ++ [(n := 9, s := 'z')] } order by .name`);
      assertEquals(rows[0], {
        f: { n: 1, s: "a" },
        n: 2,
        name: "a",
        sl: [{ n: 2, s: "b" }],
        x: [{ n: 1, s: "a" }, { n: 2, s: "b" }, { n: 9, s: "z" }]
      });
      assertEquals(rows[1].x, [{ n: 3, s: "c" }, { n: 9, s: "z" }]);
      assertEquals((await run(`select TupRow { name } order by .ts`)).map(row => row.name), ["c", "a", "b", "d"]);
      assertEquals(await names(run, `select TupRow { name } filter .ts[0] = (n := 10, s := 'a')`), ["d"]);
    });
  }
});

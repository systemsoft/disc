/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `<json>` of every scalar type, and of arrays and tuples of
 * them, is the JSON value Gel makes — a `str` is a JSON string (not JSON text
 * to parse: that is `to_json`), numbers keep their digits, NaN and ±Infinity
 * are strings, dates and times are their ISO text, durations their ISO 8601
 * text, `bytes` base64, an enum its label, a named tuple an object.
 *
 * Each expected value is what a Gel 7.1 server answers for the same query
 * (JSON output). Where a number has more digits than a JS number holds, the
 * JSON text is compared (`to_str(<json>…)`).
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as ServerTypes from "./types.ts";

const SDL = `module default {
  scalar type Color extending enum<Red, Green>;
  type JsonCast {
    required label: str;
    s: str;
    at: datetime;
    ld: cal::local_date;
    dd: cal::date_duration;
    c: Color;
    n: bigint;
    b: bytes;
    f: float64;
    tags: array<str>;
  };
};`;

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `json_cast_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

type Run = (query: string, variables?: Record<string, unknown>) => Promise<unknown[]>;

async function handlerFor(pool: ConnectionPool, dsn: string): Promise<Run> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  const applied = await manager.applySchema(SDL);
  assertEquals(applied.ok, true, JSON.stringify(applied));
  const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
  await manager.close();

  return async (query, variables) => {
    const response = await handler.handleRequest({ query, variables }, makeContext());
    assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
    return response.data as unknown[];
  };
}

/*** Gel 7.1's answer to each query: its one value. ***/
const GEL_SCALARS: [string, unknown][] = [
  // str, bool, ints
  [`select <json>'hello'`, "hello"],
  [`select <json>'he"l\\\\lo'`, "he\"l\\lo"],
  [`select <json>'2024-01-02'`, "2024-01-02"],
  [`select <json>true`, true],
  [`select <json><int16>5`, 5],
  [`select <json><int32>5`, 5],
  [`select <json><int64>5`, 5],
  [`select <json>2.0`, 2],
  // bigint and decimal keep every digit
  [`select to_str(<json>123456789012345678901234567890n)`, "123456789012345678901234567890"],
  [`select to_str(<json><bigint>'-12345678901234567890123')`, "-12345678901234567890123"],
  [`select to_str(<json>12345678901234567890.123456789n)`, "12345678901234567890.123456789"],
  [`select to_str(<json>1.50n)`, "1.50"],
  [`select to_str(<json><decimal>'1e20')`, "100000000000000000000"],
  [`select to_str(<json>9007199254740993)`, "9007199254740993"],
  // floats; NaN and ±Infinity are strings
  [`select <json>1.5`, 1.5],
  [`select <json><float32>1.5`, 1.5],
  [`select to_str(<json><float32>0.1)`, "0.1"],
  [`select to_str(<json><float64>0.1)`, "0.1"],
  [`select to_str(<json><float64>1e20)`, "100000000000000000000"],
  [`select to_str(<json><float64>1e-7)`, "0.0000001"],
  [`select <json><float64>'NaN'`, "NaN"],
  [`select <json><float64>'inf'`, "Infinity"],
  [`select <json><float64>'-inf'`, "-Infinity"],
  [`select <json><float32>'NaN'`, "NaN"],
  // uuid, dates and times
  [`select <json><uuid>'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'`, "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"],
  [`select <json><datetime>'2024-01-02T03:04:05Z'`, "2024-01-02T03:04:05+00:00"],
  [`select <json><datetime>'2024-01-02T03:04:05.123456Z'`, "2024-01-02T03:04:05.123456+00:00"],
  [`select <json><datetime>'2024-01-02T03:04:05+02:00'`, "2024-01-02T01:04:05+00:00"],
  [`select <json><cal::local_date>'2024-01-02'`, "2024-01-02"],
  [`select <json><cal::local_time>'03:04:05'`, "03:04:05"],
  [`select <json><cal::local_time>'03:04:05.5'`, "03:04:05.5"],
  [`select <json><cal::local_datetime>'2024-01-02T03:04:05'`, "2024-01-02T03:04:05"],
  [`select <json><cal::local_datetime>'2024-01-02T03:04:05.25'`, "2024-01-02T03:04:05.25"],
  // durations
  [`select <json><duration>'1 hour'`, "PT1H"],
  [`select <json><cal::relative_duration>'1 month 2 days'`, "P1M2D"],
  [`select <json><cal::relative_duration>'0 seconds'`, "PT0S"],
  [`select <json><cal::date_duration>'3 days'`, "P3D"],
  [`select <json><cal::date_duration>'0 days'`, "P0D"],
  // json itself
  [`select <json><json>'[1,2]'`, "[1,2]"],
  [`select to_str(<json>'x')`, "\"x\""],
  // An empty set is no row.
  [`select <json>{}`, []],
  [`select <json><str>{}`, []],
  [`select <str>{}`, []],
  [`select to_str(<int64>{})`, []],
  [`select len(<str>{})`, []],
  [`select 1 + <int64>{}`, []],
  [`with x := <str>{} select x`, []],
  [`select <str>{} ?? 'x'`, "x"],
  // A tuple literal cast to a tuple type takes the type's names
  [`select <json><tuple<a: int64, b: str>>(1, 'x')`, { a: 1, b: "x" }],
  [`select (<tuple<a: int64, b: str>>(1, 'x')).a`, 1],
  [`select (<tuple<a: int64, b: str>>(1, 'x')).b`, "x"],
  [`select <tuple<int64, str>>(c := 1, d := 'x')`, [1, "x"]],
  [`select [<tuple<a: int64, b: str>>(1, 'x')]`, [{ a: 1, b: "x" }]],
  [`select <tuple<a: int64, b: str>>(1, 'x') = (a := 1, b := 'x')`, true],
  // json_get: a variadic path and a default
  [`select json_get(to_json('{"a": [{"b": 5}]}'), 'a', '0', 'b')`, 5],
  [`select json_get(to_json('[1, [2, 3]]'), '1', '-1')`, 3],
  [`select json_get(to_json('{"a": 1}'), 'x', default := <json>'d')`, "d"],
  [`select json_get(to_json('{"a": 1}'), 'a', default := <json>'d')`, 1],
  [`select json_get(to_json('{"a": 1}'), 'x', 'y', default := <json>0)`, 0],
  [`select json_get(to_json('{"a": [5]}'), 'a', 'x', default := <json>'d')`, "d"],
  [`select json_get(to_json('{"a": [1]}'), 'a', '5')`, []],
  [`select json_get(to_json('{"a": 1}'), 'a', 'b')`, []],
  [`select json_get(to_json('null'), 'x')`, []],
  [`select json_get(<json>{}, 'a', default := <json>1)`, []],
  [`select json_get(to_json('{"a": 1}'), <str>{}, default := <json>1)`, []],
  [`select json_get(to_json('{"a": null}'), 'a')`, null],
  [`select json_get(to_json('{"a": 1}'))`, { a: 1 }],
  // bytes literals
  [`select <json>b'\\x00ab'`, "AGFi"],
  [`select <json>[b'ab']`, ["YWI="]],
  [`select <json>(b'ab', 1)`, ["YWI=", 1]],
  [`select to_str(b'ab')`, "ab"],
  [`select len(b'\\x00\\xff')`, 2],
  [`select br'\\x00'`, "XHgwMA=="],
  // arrays and tuples
  [`select <json>[1, 2, 3]`, [1, 2, 3]],
  [`select <json>['a', 'b']`, ["a", "b"]],
  [`select <json><array<str>>[]`, []],
  [`select <json><array<int32>>[1, 2]`, [1, 2]],
  [`select <json>[1.5n, 2n]`, [1.5, 2]],
  [`select <json>[<float64>'NaN']`, ["NaN"]],
  [`select <json>[<datetime>'2024-01-02T03:04:05Z']`, ["2024-01-02T03:04:05+00:00"]],
  [`select <json>[<cal::local_date>'2024-01-02']`, ["2024-01-02"]],
  [`select <json>[<cal::date_duration>'0 days']`, ["P0D"]],
  [`select <json>[<json>1, <json>'a']`, [1, "a"]],
  [`select <json>(1, 'a', true)`, [1, "a", true]],
  [`select <json>(a := 1, b := 'x')`, { a: 1, b: "x" }],
  [`select <json>[(a := 1, b := 'x')]`, [{ a: 1, b: "x" }]],
  [`select <json>[(1, 'x')]`, [[1, "x"]]],
  [`select <json>(<datetime>'2024-01-02T03:04:05Z', <cal::local_date>'2024-01-02')`, ["2024-01-02T03:04:05+00:00", "2024-01-02"]],
  [`select <json>(x := [1n], y := (<uuid>'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',))`, { x: [1], y: ["a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"] }],
  [`select <json>(1, [<cal::date_duration>'0 days'], (<datetime>'2024-01-02T03:04:05Z',))`, [1, ["P0D"], ["2024-01-02T03:04:05+00:00"]]],
  // enums
  [`select <json>Color.Red`, "Red"],
  [`select <json>[Color.Red, Color.Green]`, ["Red", "Green"]],
  // to_json parses JSON text; <str> of a JSON string is its text
  [`select to_json('{"a": 1}')`, { a: 1 }],
  [`select to_json('5')`, 5],
  [`select <str><json>'hello'`, "hello"],
  [`select <str>to_json('"x"')`, "x"],
  [`select <cal::local_date><json>'2024-01-02'`, "2024-01-02"],
  [`select to_str(<decimal>to_json('3.5'))`, "3.5"],
  [`select json_get(<json>(a := 'x'), 'a')`, "x"],
  [`select <json><cal::local_date>'2024-01-02' = to_json('"2024-01-02"')`, true]
];

Deno.test({
  name: "PG <json> casts: every scalar type is the JSON value Gel makes",
  ignore: !canRunPgTests(),
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      const run = await handlerFor(pool, dsn);
      const one = async (query: string, variables?: Record<string, unknown>): Promise<unknown> => {
        const rows = await run(query, variables);
        return rows.length === 1 ? rows[0] : rows;
      };

      await t.step("scalars, arrays, tuples and to_json", async () => {
        const answers: [string, unknown][] = [];
        for (const [query] of GEL_SCALARS) {
          answers.push([query, await one(query).catch(error => `error: ${error.message}`)]);
        }
        assertEquals(answers, GEL_SCALARS);
      });

      // Gel: `<json>b'hello'` is "aGVsbG8=", `<json>b''` is "", `<json>[b'ab']` is ["YWI="].
      await t.step("bytes are base64", async () => {
        assertEquals(await one(`select <json><bytes>$b`, { b: "aGVsbG8=" }), "aGVsbG8=");
        assertEquals(await one(`select to_str(<json><bytes>$b)`, { b: "" }), "\"\"");
        assertEquals(await one(`select <json><array<bytes>>$bs`, { bs: ["YWI="] }), ["YWI="]);
      });

      await t.step("stored properties", async () => {
        await run(
          `insert JsonCast { label := 'a', s := 'hi', at := <datetime>'2024-01-02T03:04:05Z', ld := <cal::local_date>'2024-01-02', dd := <cal::date_duration>'0 days', c := Color.Green, n := 12345678901234567890n, b := <bytes>$b, f := <float64>'NaN', tags := ['x'] }`,
          { b: "YWI=" }
        );
        const checks: [string, unknown][] = [
          [`select <json>JsonCast.s`, "hi"],
          [`select <json>JsonCast.at`, "2024-01-02T03:04:05+00:00"],
          [`select <json>JsonCast.ld`, "2024-01-02"],
          [`select <json>JsonCast.dd`, "P0D"],
          [`select to_str(<json>JsonCast.n)`, "12345678901234567890"],
          [`select <json>JsonCast.b`, "YWI="],
          [`select <json>JsonCast.f`, "NaN"],
          [`select <json>JsonCast.c`, "Green"],
          [`select <json>JsonCast.tags`, ["x"]],
          [`select <json>(select JsonCast { label, ld, dd })`, { dd: "P0D", label: "a", ld: "2024-01-02" }]
        ];
        const answers: [string, unknown][] = [];
        for (const [query] of checks) {
          answers.push([query, await one(query)]);
        }
        assertEquals(answers, checks);

        assertEquals(await run(`select JsonCast { label, j := <json>.at, k := <json>.dd, m := <json>.s, e := <json>.b }`), [
          { e: "YWI=", j: "2024-01-02T03:04:05+00:00", k: "P0D", label: "a", m: "hi" }
        ]);
      });

      // A named tuple selected is its row (the response's object).
      await t.step("a tuple literal cast to a named tuple type", async () => {
        const checks: [string, unknown][] = [
          [`select <tuple<a: int64, b: str>>(1, 'x')`, { a: 1, b: "x" }],
          [`select <tuple<a: int64, b: str>>(c := 1, d := 'x')`, { a: 1, b: "x" }],
          [`select <tuple<a: str, b: int64>>('1', 2)`, { a: "1", b: 2 }],
          [`select <tuple<a: int64>>(b := '5')`, { a: 5 }],
          [`select <tuple<a: int64, b: tuple<c: str>>>(1, ('x',))`, { a: 1, b: { c: "x" } }]
        ];
        const answers: [string, unknown][] = [];
        for (const [query] of checks) {
          answers.push([query, (await run(query))[0]]);
        }
        assertEquals(answers, checks);
      });

      // Gel: `<json>T` is each object's `{ id }`, `<json>T { … }` (the shape is
      // the operand's) and `<json>(select T { … } …)` each object's shape.
      await t.step("<json> of objects", async () => {
        await run(`insert JsonCast { label := 'b', b := b'\\x00ab' }`);
        // A select of values (`<json>` is one) answers them bare, as Gel does.
        const values = async (query: string): Promise<unknown[]> => await run(query);
        assertEquals(await values(`select <json>(select JsonCast { label, b } order by .label)`), [{ b: "YWI=", label: "a" }, {
          b: "AGFi",
          label: "b"
        }]);
        assertEquals((await values(`select <json>JsonCast { label }`)).sort((x, y) => JSON.stringify(x) < JSON.stringify(y) ? -1 : 1), [
          { label: "a" },
          { label: "b" }
        ]);
        const ids = await values(`select <json>JsonCast`);
        assertEquals(ids.map(value => Object.keys(value as Record<string, unknown>)), [["id"], ["id"]]);
        assertEquals(await values(`select <json>(select JsonCast { label } filter .label = 'zz')`), []);
      });

      await t.step("a json variable is its JSON value", async () => {
        const [row] = await run(`select <json>$j`, { j: { a: [1] } });
        assertEquals(row, { a: [1] });
      });
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

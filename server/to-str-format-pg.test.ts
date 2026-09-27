/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: the format argument of `to_str` and of the parsers that take
 * one (`to_datetime`, `cal::to_local_datetime`, `cal::to_local_date`,
 * `cal::to_local_time`, `to_int64`/`32`/`16`, `to_float64`/`32`, `to_bigint`,
 * `to_decimal`). Gel passes the format to PostgreSQL's `to_char`,
 * `to_timestamp` and `to_number`, in UTC; JSON's one format is `pretty`.
 * Also the other forms of the date and time constructors: a value of the
 * other kind and a time zone, epoch seconds, and fields.
 *
 * Each expected value or error is what a Gel 7.1 server answers for the same
 * query (JSON output).
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
  type Fmt {
    required label: str;
    at: datetime;
    d: duration;
    n: int64;
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
      sessionId: `to_str_format_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

interface Answer {
  data?: unknown[];
  error?: string;
}

type Run = (query: string, variables?: Record<string, unknown>) => Promise<Answer>;

async function handlerFor(pool: ConnectionPool, dsn: string): Promise<Run> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  const applied = await manager.applySchema(SDL);
  assertEquals(applied.ok, true, JSON.stringify(applied));
  const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
  await manager.close();

  return async (query, variables) => {
    const response = await handler.handleRequest({ query, variables }, makeContext());
    const error = response.errors?.[0];
    // The server words a PostgreSQL error "Database query failed: <message>".
    return error ? { error: error.message.replace(/^Database query failed: /, "") } : { data: response.data as unknown[] };
  };
}

/*** Gel 7.1's answer to each query: its one value. ***/
const GEL_VALUES: [string, unknown][] = [
  // datetime: formatted in UTC
  [`select to_str(<datetime>'2024-01-02T03:04:05.123456Z', 'YYYY-MM-DD HH24:MI:SS')`, "2024-01-02 03:04:05"],
  [`select to_str(<datetime>'2024-01-02T03:04:05Z', 'Day, DD Mon YYYY TZ OF')`, "Tuesday  , 02 Jan 2024 UTC +00"],
  [`select to_str(<datetime>'2024-01-02T03:04:05+05:00', 'HH24:MI TZH:TZM')`, "22:04 +00:00"],
  [`select to_str(<datetime>'2024-01-02T03:04:05Z', '"literal" YYYY')`, "literal 2024"],
  [`select to_str(<datetime>'2024-01-02T03:04:05Z', 'xyz')`, "x4z"],
  [`select to_str(<datetime>'2024-01-02T03:04:05Z', 'FMDay FMMonth')`, "Tuesday January"],
  [`select to_str(<datetime>'2024-01-02T03:04:05Z', 'Q WW IW J')`, "1 01 01 2460312"],
  [`select to_str(<datetime>'2024-01-02T03:04:05Z', <str>{})`, "2024-01-02T03:04:05+00:00"],
  // cal::local_datetime, cal::local_date, cal::local_time
  [`select to_str(<cal::local_datetime>'2024-01-02T03:04:05', 'YYYY/MM/DD HH12 AM')`, "2024/01/02 03 AM"],
  [`select to_str(<cal::local_datetime>'2024-01-02T03:04:05', 'TZ')`, ""],
  [`select to_str(<cal::local_datetime>'2024-01-02T01:00', 'OF')`, "+00"],
  [`select to_str(<cal::local_date>'2024-01-02', 'Month DD, YYYY')`, "January   02, 2024"],
  [`select to_str(<cal::local_date>'2024-01-02', 'HH24:MI')`, "00:00"],
  [`select to_str(<cal::local_date>'2024-01-02', 'TZ')`, "UTC"],
  [`select to_str(<cal::local_date>'2024-01-02', <str>{})`, "2024-01-02"],
  [`select to_str(<cal::local_time>'13:04:05.5', 'HH12:MI:SS.MS AM')`, "01:04:05.500 PM"],
  [`select to_str(<cal::local_time>'01:02:03', 'TZ')`, ""],
  // A local time is formatted on today's date (UTC).
  [`select to_str(<cal::local_time>'13:04:05', 'YYYY') = to_str(cal::to_local_date(datetime_current(), 'UTC'), 'YYYY')`, true],
  // durations
  [`select to_str(<duration>'49 hours 3 minutes 4.5 seconds', 'HH24:MI:SS.MS')`, "49:03:04.500"],
  [`select to_str(<duration>'1 hour', 'DD HH')`, "00 01"],
  [`select to_str(<duration>'1 hour', <str>{})`, "PT1H"],
  [`select to_str(<cal::relative_duration>'1 year 2 months 3 days 4 hours', 'YYYY MM DD HH24')`, "0001 02 03 04"],
  [`select to_str(<cal::date_duration>'1 year 2 months 3 days', 'YYYY MM DD')`, "0001 02 03"],
  [`select to_str(<cal::date_duration>'0 days', 'DD')`, "00"],
  // numbers
  [`select to_str(123, '999')`, " 123"],
  [`select to_str(-123, '99999')`, "  -123"],
  [`select to_str(123, '0000')`, " 0123"],
  [`select to_str(1234567, '9,999,999')`, " 1,234,567"],
  [`select to_str(123, 'FM999')`, "123"],
  [`select to_str(<int16>12, '999')`, "  12"],
  [`select to_str(<int32>12, '999')`, "  12"],
  [`select to_str(1.5, '9.99')`, " 1.50"],
  [`select to_str(<float32>1.5, '9.99')`, " 1.50"],
  [`select to_str(<float32>0.1, '9.9999999999')`, "  .1000000015"],
  [`select to_str(0.1, '9.99999999999999999')`, "  .10000000000000"],
  [`select to_str(123.456n, '999.9')`, " 123.5"],
  [`select to_str(123n, '9999')`, "  123"],
  [`select to_str(12345678901234567890n, '99999999999999999999')`, " 12345678901234567890"],
  [`select to_str(12345, '99')`, " ##"],
  [`select to_str(123, 'xyz')`, "xyz"],
  [`select to_str(1.5, 'EEEE')`, " 2e+00"],
  [`select to_str(123, 'RN')`, "         CXXIII"],
  [`select to_str(-1.5, 'S9.9')`, "-1.5"],
  [`select to_str(<float64>'NaN', '999')`, " NaN"],
  [`select to_str(123, <str>{})`, "123"],
  [`select to_str(1.5, <str>{})`, "1.5"],
  // json
  [`select to_str(to_json('{"a": [1, 2], "b": null}'), 'pretty')`, "{\n    \"a\": [\n        1,\n        2\n    ],\n    \"b\": null\n}"],
  [`select to_str(to_json('[]'), 'pretty')`, "[\n]"],
  [`select to_str(to_json('"a"'), 'pretty')`, "\"a\""],
  [`select to_str(to_json('{"a":1}'))`, "{\"a\": 1}"],
  [`select to_str(<json>'x', <str>{})`, "\"x\""],
  // array<str> and a delimiter
  [`select to_str(['a', 'b'], ', ')`, "a, b"],
  // parsers
  [`select <str>to_datetime('2024-01-02 03:04:05 +02', 'YYYY-MM-DD HH24:MI:SS TZH')`, "2024-01-02T01:04:05+00:00"],
  [`select <str>to_datetime('2024-01-02 03:04:05 +02:30', 'YYYY-MM-DD HH24:MI:SS TZH:TZM')`, "2024-01-02T00:34:05+00:00"],
  [`select <str>to_datetime('2024-01-02 +02', 'YYYY-MM-DD TZH:TZM')`, "2024-01-01T22:00:00+00:00"],
  [`select <str>to_datetime('2024-01-02T03:04:05+00:00', <str>{})`, "2024-01-02T03:04:05+00:00"],
  [`select cal::to_local_datetime('2024-01-02 03:04:05', 'YYYY-MM-DD HH24:MI:SS')`, "2024-01-02T03:04:05"],
  [`select cal::to_local_datetime('2024-01-02 03:04:05 +02', 'YYYY-MM-DD HH24:MI:SS "x"')`, "2024-01-02T03:04:05"],
  [`select cal::to_local_date('02/01/2024', 'DD/MM/YYYY')`, "2024-01-02"],
  [`select cal::to_local_date('02/01/2024 13:00', 'DD/MM/YYYY HH24:MI')`, "2024-01-02"],
  [`select cal::to_local_time('2024 13:02', 'YYYY HH24:MI')`, "13:02:00"],
  [`select to_int64('1,234', '9,999')`, 1234],
  [`select to_int64('  -12', '999')`, -12],
  [`select to_int64('12.7', '99.9')`, 13],
  [`select to_int64('12', '9 9')`, 1],
  [`select to_int64(' 1 2', '9 9')`, 12],
  [`select to_int64('12', <str>{})`, 12],
  [`select to_int32('1,234', '9,999')`, 1234],
  [`select to_int16('1,234', '9,999')`, 1234],
  [`select to_float64('1,234.5', '9,999.9')`, 1234.5],
  [`select to_float32('1.25', '9.99')`, 1.25],
  [`select <str>to_decimal('1,234.5678', '9,999.9999')`, "1234.5678"],
  [`select <str>to_bigint('1,234', '9,999')`, "1234"],
  // a value of the other kind and a time zone
  [`select cal::to_local_date(<datetime>'2024-01-02T20:00:00Z', 'Asia/Tokyo')`, "2024-01-03"],
  [`select cal::to_local_time(<datetime>'2024-01-02T20:00:00Z', 'America/New_York')`, "15:00:00"],
  [`select cal::to_local_datetime(<datetime>'2024-01-02T20:00:00Z', 'Europe/Berlin')`, "2024-01-02T21:00:00"],
  [`select <str>to_datetime(<cal::local_datetime>'2024-01-02T03:00', 'Europe/Berlin')`, "2024-01-02T02:00:00+00:00"],
  // epoch seconds and fields
  [`select <str>to_datetime(1700000000)`, "2023-11-14T22:13:20+00:00"],
  [`select <str>to_datetime(1700000000.5)`, "2023-11-14T22:13:20.5+00:00"],
  [`select <str>to_datetime(1700000000.25n)`, "2023-11-14T22:13:20.25+00:00"],
  [`select <str>to_datetime(2024, 1, 2, 3, 4, 5.5, 'Europe/Berlin')`, "2024-01-02T02:04:05.5+00:00"],
  [`select cal::to_local_date(2024, 1, 2)`, "2024-01-02"],
  [`select cal::to_local_time(3, 4, 5.5)`, "03:04:05.5"],
  [`select cal::to_local_datetime(2024, 1, 2, 3, 4, 5.5)`, "2024-01-02T03:04:05.5"]
];

/*** Gel 7.1's error message for each query (all InvalidValueError). ***/
const GEL_ERRORS: [string, string][] = [
  [`select to_str(<datetime>'2024-01-02T03:04:05Z', '')`, `to_str(): "fmt" argument must be a non-empty string`],
  [`select to_str(123, '')`, `to_str(): "fmt" argument must be a non-empty string`],
  [`select to_str(to_json('{"a": 1}'), '')`, `to_str(): "fmt" argument must be a non-empty string`],
  [`select to_str(to_json('{"a": 1}'), 'ugly')`, `to_str(): format 'ugly' is invalid`],
  [`select to_str(<duration>'1 hour', 'Day')`, "invalid format specification for an std::duration value"],
  [`select to_str(<cal::relative_duration>'1 month', 'Mon')`, "invalid format specification for an std::duration value"],
  [`select to_str(<cal::date_duration>'1 day', 'Day')`, "invalid format specification for an std::duration value"],
  [`select to_datetime('2024-01-02 03:04:05', 'YYYY-MM-DD HH24:MI:SS')`, "missing required time zone in format: 'YYYY-MM-DD HH24:MI:SS'"],
  [`select to_datetime('2024-01-02 +02', 'YYYY-MM-DD TZM')`, "missing required time zone in format: 'YYYY-MM-DD TZM'"],
  [`select to_datetime('2024-01-02 03:04:05', 'YYYY-MM-DD HH24:MI:SS TZH')`, "missing required time zone in input '2024-01-02 03:04:05'"],
  [`select to_datetime('2024-01-02 03:04:05 +02', 'YYYY-MM-DD HH24:MI:SS "TZH" TZH')`, "missing required time zone in input '2024-01-02 03:04:05 +02'"],
  [`select to_datetime('2024-01-02', '')`, `to_datetime(): "fmt" argument must be a non-empty string`],
  [`select cal::to_local_datetime('2024-01-02 03:04:05 +02', 'YYYY-MM-DD HH24:MI:SS TZH')`, "unexpected time zone in format: 'YYYY-MM-DD HH24:MI:SS TZH'"],
  [`select cal::to_local_datetime('2024-01-02', '')`, `to_local_datetime(): "fmt" argument must be a non-empty string`],
  [`select cal::to_local_date('02/01/2024 +03', 'DD/MM/YYYY TZH')`, "unexpected time zone in format: 'DD/MM/YYYY TZH'"],
  [`select cal::to_local_date('2024-01-02', '')`, `to_local_date(): "fmt" argument must be a non-empty string`],
  [`select cal::to_local_time('13:02 +01', 'HH24:MI TZH')`, "unexpected time zone in format: 'HH24:MI TZH'"],
  [`select cal::to_local_time('13.02', '')`, `to_local_time(): "fmt" argument must be a non-empty string`],
  [`select to_int64('1', '')`, `to_int64(): "fmt" argument must be a non-empty string`],
  [`select to_int32('1', '')`, `to_int32(): "fmt" argument must be a non-empty string`],
  [`select to_int16('1', '')`, `to_int16(): "fmt" argument must be a non-empty string`],
  [`select to_float64('1', '')`, `to_float64(): "fmt" argument must be a non-empty string`],
  [`select to_float32('1', '')`, `to_float32(): "fmt" argument must be a non-empty string`],
  [`select to_bigint('1', '')`, `to_bigint(): "fmt" argument must be a non-empty string`],
  [`select to_decimal('1', '')`, `to_decimal(): "fmt" argument must be a non-empty string`],
  [`select to_str('abc', 'x')`, `function "to_str(arg0: std::str, arg1: std::str)" does not exist`],
  [`select to_str(true, 'x')`, `function "to_str(arg0: std::bool, arg1: std::str)" does not exist`]
];

Deno.test({
  name: "PG to_str and the parsers: a format argument",
  ignore: !canRunPgTests(),
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      const run = await handlerFor(pool, dsn);

      await t.step("values", async () => {
        const answers: [string, unknown][] = [];
        for (const [query] of GEL_VALUES) {
          const answer = await run(query);
          answers.push([query, answer.error !== undefined ? `error: ${answer.error}` : answer.data?.[0]]);
        }
        assertEquals(answers, GEL_VALUES);
      });

      await t.step("errors", async () => {
        const answers: [string, string][] = [];
        for (const [query] of GEL_ERRORS) {
          const answer = await run(query);
          answers.push([query, answer.error ?? `answered ${JSON.stringify(answer.data)}`]);
        }
        assertEquals(answers, GEL_ERRORS);
      });

      await t.step("an empty value is empty; a format from a parameter or a property path", async () => {
        assertEquals((await run(`select to_str(<datetime>{}, 'YYYY')`)).data, []);
        assertEquals((await run(`select to_datetime(<str>{}, 'YYYY TZH')`)).data, []);
        assertEquals((await run(`select to_str(<datetime>'2024-01-02T03:04:05Z', <str>$f)`, { f: "YYYY" })).data, ["2024"]);
        assertEquals((await run(`select to_int64(<str>$s, <str>$f)`, { f: "9,999", s: "1,234" })).data, [1234]);
        await run(`insert Fmt { label := 'a', at := <datetime>'2024-01-02T03:04:05Z', d := <duration>'1 hour', n := 7 }`);
        await run(`insert Fmt { label := 'b' }`);
        assertEquals((await run(`select Fmt { label, a := to_str(.at, 'YYYY'), s := to_str(.d, 'HH24'), m := to_str(.n, '99') } order by .label`)).data, [
          { a: "2024", label: "a", m: "  7", s: "01" },
          { a: null, label: "b", m: null, s: null }
        ]);
        assertEquals((await run(`select to_str(Fmt.d, 'HH24')`)).data, ["01"]);
        assertEquals((await run(`select Fmt { s := to_str(.at, .label) } filter .label = 'a'`)).data, [{ s: "a" }]);
      });
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

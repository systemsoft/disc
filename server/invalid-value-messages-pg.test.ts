/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: a value PostgreSQL can't take — a cast (`<int64>'x'`), a
 * parser (`to_int64('x')`), an argument, arithmetic that overflows — fails
 * with PostgreSQL's message, which names its own types (`bigint`, `double
 * precision`, `timestamp with time zone`). Gel reports the same message with
 * its types (`std::int64`, `std::float64`, `std::datetime`): its errormech
 * `translate_pgtype` renames each PostgreSQL type name before the message's
 * first colon. The SQLSTATE is PostgreSQL's (22P02, 22003, 22007, 22008);
 * Gel's error class follows from it (InvalidValueError, NumericOutOfRangeError).
 *
 * Each expected message is what a Gel 7.1 server answers for the same query.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as ServerTypes from "./types.ts";

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `invalid_value_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

/*** Gel 7.1's message for each query, and the SQLSTATE of PostgreSQL's error. ***/
const GEL_ERRORS: [string, string, string][] = [
  // casts
  [`select <int64>'x'`, `invalid input syntax for type std::int64: "x"`, "22P02"],
  [`select <int32>'x'`, `invalid input syntax for type std::int32: "x"`, "22P02"],
  [`select <int16>'x'`, `invalid input syntax for type std::int16: "x"`, "22P02"],
  [`select <float64>'x'`, `invalid input syntax for type std::float64: "x"`, "22P02"],
  [`select <float32>'x'`, `invalid input syntax for type std::float32: "x"`, "22P02"],
  [`select <decimal>'x'`, `invalid input syntax for type std::decimal: "x"`, "22P02"],
  [`select <bigint>'x'`, `invalid input syntax for type std::bigint: 'x'`, "22P02"],
  [`select <uuid>'x'`, `invalid input syntax for type std::uuid: "x"`, "22P02"],
  [`select <bool>'x'`, `invalid input syntax for type std::bool: 'x'`, "22P02"],
  [`select <bool>'t'`, `invalid input syntax for type std::bool: 't'`, "22P02"],
  [`select <bool>'yes'`, `invalid input syntax for type std::bool: 'yes'`, "22P02"],
  [`select <array<bool>>['true', 't']`, `invalid input syntax for type std::bool: 't'`, "22P02"],
  [`select <Color>'Purple'`, `invalid input value for enum 'default::Color': "Purple"`, "22P02"],
  [`select <array<Color>>['Red', 'Purple']`, `invalid input value for enum 'default::Color': "Purple"`, "22P02"],
  [`select <cal::relative_duration>'x'`, `invalid input syntax for type std::duration: "x"`, "22007"],
  [`select <cal::date_duration>'x'`, `invalid input syntax for type std::duration: "x"`, "22007"],
  [`select <cal::local_time>'24:00'`, `std::cal::local_time field value out of range: '24:00'`, "22007"],
  [`select <cal::local_datetime>'2024-01-01 10'`, `invalid input syntax for type std::cal::local_datetime: "2024-01-01 10"`, "22007"],
  [`select <duration>'x'`, `invalid input syntax for type std::duration: "x"`, "22007"],
  [`select <int64>'1.5'`, `invalid input syntax for type std::int64: "1.5"`, "22P02"],
  [`select <array<int64>>['1', 'x']`, `invalid input syntax for type std::int64: "x"`, "22P02"],
  [`select <cal::local_date>'2024-13-01'`, `std::cal::local_date/std::cal::local_time field value out of range: "2024-13-01"`, "22008"],
  [`select <datetime>'2024-13-01T00:00Z'`, `std::cal::local_date/std::cal::local_time field value out of range: "2024-13-01T00:00Z"`, "22008"],
  [`select <int16>'99999'`, `value "99999" is out of range for type std::int16`, "22003"],
  [`select <int32>'9999999999'`, `value "9999999999" is out of range for type std::int32`, "22003"],
  [`select <int64>'99999999999999999999'`, `value "99999999999999999999" is out of range for type std::int64`, "22003"],
  [`select <float32>'1e100'`, `"1e100" is out of range for type std::float32`, "22003"],
  // parsers
  [`select to_int64('x')`, `invalid input syntax for type std::int64: "x"`, "22P02"],
  [`select to_int16('99999')`, `value "99999" is out of range for type std::int16`, "22003"],
  [`select to_float64('x')`, `invalid input syntax for type std::float64: "x"`, "22P02"],
  [`select to_decimal('x')`, `invalid input syntax for type std::decimal: "x"`, "22P02"],
  [`select to_bigint('x')`, `invalid input syntax for type std::bigint: 'x'`, "22P02"],
  [`select to_decimal('x', '999')`, `invalid input syntax for type std::decimal: " "`, "22P02"],
  [`select to_json('x')`, "invalid input syntax for type std::pg::json", "22P02"],
  // arithmetic
  [`select 9223372036854775807 + 1`, "std::int64 out of range", "22003"],
  [`select <float64>1e308 * 10`, "value out of range: overflow", "22003"]
];

const DATETIME_HINT = `Please use ISO8601 format. Example: 2010-12-27T23:59:59-07:00. Alternatively "to_datetime" function provides custom formatting options.`;
const LOCAL_DATETIME_HINT =
  `Please use ISO8601 format. Example 2010-04-18T09:27:00 Alternatively "to_local_datetime" function provides custom formatting options.`;
const LOCAL_DATE_HINT = `Please use ISO8601 format. Example 2010-04-18 Alternatively "to_local_date" function provides custom formatting options.`;
const LOCAL_TIME_HINT = `Please use ISO8601 format. Examples: 18:43:27 or 18:43 Alternatively "to_local_time" function provides custom formatting options.`;
const DURATION_HINT = "Day, month and year units cannot be used for std::duration.";
const DATE_DURATION_HINT = "Units smaller than days cannot be used for std::cal::date_duration.";

/**
 * Gel 7.1's message and hint for a str that is no date, time or duration it
 * reads: Gel's `datetime_in`, `local_datetime_in`, `local_date_in`,
 * `local_time_in`, `duration_in` and `date_duration_in` (edb/pgsql/
 * metaschema.py) take only ISO 8601 text, and a duration only its units.
 * All are SQLSTATE 22007, an InvalidValueError.
 */
const GEL_HINTED_ERRORS: [string, string, string][] = [
  [`select <datetime>'x'`, `invalid input syntax for type std::datetime: 'x'`, DATETIME_HINT],
  [`select <datetime>'2024-01-01'`, `invalid input syntax for type std::datetime: '2024-01-01'`, DATETIME_HINT],
  [`select <datetime>'2024-01-01T00:00'`, `invalid input syntax for type std::datetime: '2024-01-01T00:00'`, DATETIME_HINT],
  [`select <array<datetime>>['2024-01-01T00:00Z', 'x']`, `invalid input syntax for type std::datetime: 'x'`, DATETIME_HINT],
  [`select <cal::local_datetime>'x'`, `invalid input syntax for type std::cal::local_datetime: 'x'`, LOCAL_DATETIME_HINT],
  [`select <cal::local_datetime>'2024-01-01T00:00Z'`, `invalid input syntax for type std::cal::local_datetime: '2024-01-01T00:00Z'`, LOCAL_DATETIME_HINT],
  [`select <cal::local_date>'x'`, `invalid input syntax for type std::cal::local_date: 'x'`, LOCAL_DATE_HINT],
  [`select <cal::local_date>''`, `invalid input syntax for type std::cal::local_date: ''`, LOCAL_DATE_HINT],
  [`select <cal::local_date>'2024-01-01T00:00'`, `invalid input syntax for type std::cal::local_date: '2024-01-01T00:00'`, LOCAL_DATE_HINT],
  [`select <cal::local_time>'x'`, `invalid input syntax for type std::cal::local_time: 'x'`, LOCAL_TIME_HINT],
  [`select <duration>'1 month'`, `invalid input syntax for type std::duration: '1 month'`, DURATION_HINT],
  [`select <duration>'1 day'`, `invalid input syntax for type std::duration: '1 day'`, DURATION_HINT],
  [`select <cal::date_duration>'1 hour'`, `invalid input syntax for type std::cal::date_duration: '1 hour'`, DATE_DURATION_HINT]
];

Deno.test({
  name: "PG an invalid value's error names Gel's types",
  ignore: !canRunPgTests(),
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema(`module default { scalar type Color extending enum<Red, Green>; type Item { n: int64; }; };`);
      assertEquals(applied.ok, true, JSON.stringify(applied));
      const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
      await manager.close();

      const run = async (query: string, variables?: Record<string, unknown>): Promise<[string, string, string]> => {
        const response = await handler.handleRequest({ query, variables }, makeContext());
        const error = response.errors?.[0];
        // The server words a PostgreSQL error "Database query failed: <message>".
        return error ?
          [query, error.message.replace(/^Database query failed: /, ""), String(error.extensions?.sqlState)] :
          [query, `answered ${JSON.stringify(response.data)}`, ""];
      };

      await t.step("casts, parsers and arithmetic", async () => {
        const answers: [string, string, string][] = [];
        for (const [query] of GEL_ERRORS) {
          answers.push(await run(query));
        }
        assertEquals(answers, GEL_ERRORS);
      });

      await t.step("a str that is no ISO 8601 date, time or duration gives Gel's hint", async () => {
        const answers: [string, string, string][] = [];
        for (const [query] of GEL_HINTED_ERRORS) {
          const response = await handler.handleRequest({ query }, makeContext());
          const error = response.errors?.[0];
          answers.push([
            query,
            error?.message.replace(/^Database query failed: /, "") ?? `answered ${JSON.stringify(response.data)}`,
            String(error?.extensions?.hint)
          ]);
          assertEquals(error?.extensions?.sqlState, "22007", query);
        }
        assertEquals(answers, GEL_HINTED_ERRORS);
        const response = await handler.handleRequest({ query: `select <datetime><str>$x`, variables: { x: "x" } }, makeContext());
        assertEquals(response.errors?.[0]?.extensions?.hint, DATETIME_HINT);
      });

      await t.step("ISO 8601 text Gel reads is read", async () => {
        const read: [string, unknown][] = [
          [`select <str><datetime>' 20240101T101112.5+0130 '`, "2024-01-01T08:41:12.5+00:00"],
          [`select <str><cal::local_datetime>'2024-01-01 10:11'`, "2024-01-01T10:11:00"],
          [`select <str><cal::local_date>'20240101'`, "2024-01-01"],
          [`select <str><cal::local_time>'101010.5'`, "10:10:10.5"],
          [`select <str><duration>'2 hours 3 seconds'`, "PT2H3S"],
          [`select <str><cal::date_duration>'1 year 2 days'`, "P1Y2D"],
          [`select <str><cal::relative_duration>'1 year 2 hours'`, "P1YT2H"],
          [`select [<bool>' TRUE ', <bool>'false']`, [true, false]]
        ];
        const answers: [string, unknown][] = [];
        for (const [query] of read) {
          const response = await handler.handleRequest({ query }, makeContext());
          answers.push([query, response.errors?.[0]?.message ?? response.data?.[0]]);
        }
        assertEquals(answers, read);
      });

      await t.step("a str is no bytes", async () => {
        const response = await handler.handleRequest({ query: `select <bytes>'x'` }, makeContext());
        assertEquals(response.errors?.[0]?.message, "cannot cast 'std::str' to 'std::bytes'");
      });

      await t.step("a parameter PostgreSQL can't take names the type it is cast to", async () => {
        assertEquals(await run(`select <int64>$x`, { x: "x" }), [`select <int64>$x`, `invalid input syntax for type std::int64: "x"`, "22P02"]);
        assertEquals(await run(`insert Item { n := <int64>$x }`, { x: "1.5" }), [
          `insert Item { n := <int64>$x }`,
          `invalid input syntax for type std::int64: "1.5"`,
          "22P02"
        ]);
      });
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

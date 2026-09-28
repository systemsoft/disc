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
      const applied = await manager.applySchema(`module default { type Item { n: int64; }; };`);
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

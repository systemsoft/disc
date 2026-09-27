/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `datetime_get`, `duration_get`, `cal::time_get` and
 * `cal::date_get` return each of Gel's units, and reject any other, for a
 * literal unit (checked by the compiler) and a parameter (checked by
 * `disc_date_part` when the query runs).
 *
 * Before: the unit was spliced unquoted into `EXTRACT(<unit> FROM …)`, and a
 * unit that wasn't a literal became `epoch`.
 *
 * Compile-level coverage: `compiler/builtin-functions-stdlib.test.ts`.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { unwrapExactNumbers } from "../lib/exact-json.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import type * as ServerTypes from "../server/types.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";

const SDL = `module default {
  type DatePartDoc {
    required title: str;
  };
};`;

const DT = "<datetime>'2024-03-15T10:30:45.5+00:00'";

type Value = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;
type Failure = (query: string, variables?: Record<string, unknown>) => Promise<string>;

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `date_part_get_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

/*** Run `fn` against a migrated schema: `value` returns a scalar select's one value, `failure` a failing query's error message. ***/
async function withHandler(fn: (value: Value, failure: Failure) => Promise<void>): Promise<void> {
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

    const value: Value = async (query, variables) => {
      const response = await handler.handleRequest({ query, variables }, makeContext());
      assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
      const rows = response.data as Record<string, unknown>[];
      assertEquals(rows.length, 1, query);
      return unwrapExactNumbers(Object.values(rows[0])[0]);
    };
    const failure: Failure = async (query, variables) => {
      const response = await handler.handleRequest({ query, variables }, makeContext());
      assertEquals(response.data === undefined || response.data === null, true, `${query} should fail`);
      return response.errors?.[0]?.message ?? "";
    };

    await fn(value, failure);
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG datetime_get: Gel's units, epochseconds as the Unix epoch",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async value => {
      assertEquals(await value(`select datetime_get(${DT}, 'year')`), 2024);
      assertEquals(await value(`select datetime_get(${DT}, 'quarter')`), 1);
      assertEquals(await value(`select datetime_get(${DT}, 'isodow')`), 5);
      assertEquals(await value(`select datetime_get(${DT}, 'seconds')`), 45.5);
      assertEquals(await value(`select datetime_get(${DT}, 'epochseconds')`), 1710498645.5);
      assertEquals(await value(`select datetime_get(<cal::local_datetime>'2024-03-15T10:30:45', 'hour')`), 10);
    });
  }
});

Deno.test({
  name: "PG duration_get, cal::time_get, cal::date_get: Gel's units",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async value => {
      assertEquals(await value(`select duration_get(<duration>'1 hour 30 minutes', 'totalseconds')`), 5400);
      assertEquals(await value(`select duration_get(<duration>'1 hour 30 minutes', 'minutes')`), 30);
      assertEquals(await value(`select duration_get(<cal::relative_duration>'1 year 2 months', 'month')`), 2);
      assertEquals(await value(`select duration_get(<cal::date_duration>'14 days', 'day')`), 14);
      assertEquals(await value(`select cal::time_get(<cal::local_time>'10:30:15', 'midnightseconds')`), 37815);
      assertEquals(await value(`select cal::time_get(<cal::local_time>'10:30:15', 'minutes')`), 30);
      assertEquals(await value(`select cal::date_get(<cal::local_date>'2024-03-15', 'doy')`), 75);
    });
  }
});

Deno.test({
  name: "PG *_get with a parameter unit: checked when the query runs, InvalidValueError for any other unit",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (value, failure) => {
      assertEquals(await value(`select datetime_get(${DT}, <str>$u)`, { u: "month" }), 3);
      assertEquals(await value(`select datetime_get(${DT}, <str>$u)`, { u: "epochseconds" }), 1710498645.5);
      assertEquals(await value(`select cal::date_get(<cal::local_date>'2024-03-15', <str>$u)`, { u: "day" }), 15);
      assertEquals(await value(`select duration_get(<duration>'2 hours', <str>$u)`, { u: "totalseconds" }), 7200);

      assertStringIncludes(await failure(`select datetime_get(${DT}, <str>$u)`, { u: "epoch" }), "invalid unit for std::datetime_get: 'epoch'");
      assertStringIncludes(
        await failure(`select datetime_get(${DT}, <str>$u)`, { u: "year FROM NOW()) --" }),
        "invalid unit for std::datetime_get: 'year FROM NOW()) --'"
      );
      assertStringIncludes(await failure(`select duration_get(<duration>'2 hours', <str>$u)`, { u: "day" }), "invalid unit for std::duration_get: 'day'");
    });
  }
});

Deno.test({
  name: "PG *_get with a literal unit that is not one of Gel's fails before running",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (_value, failure) => {
      assertStringIncludes(await failure(`select datetime_get(${DT}, 'fortnight')`), "invalid unit for std::datetime_get: 'fortnight'");
      assertStringIncludes(await failure(`select cal::date_get(<cal::local_date>'2024-03-15', 'hour')`), "invalid unit for std::date_get: 'hour'");
    });
  }
});

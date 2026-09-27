/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `duration`, `cal::relative_duration` and `cal::date_duration`
 * come back as Gel's ISO 8601 text (`PT1H2M`), not PostgreSQL's default
 * interval text (`01:02:00`) — as a scalar, a `<str>` cast, a shape property,
 * inside tuples, arrays and `<json>`.
 *
 * Each expected value is what a Gel 7.1 server answers for the same query
 * (JSON output). PostgreSQL's `intervalstyle = iso_8601` writes the same text,
 * but for two cases handled apart: a `duration` never holds days (a datetime
 * difference is `PT49H`, not `P2DT1H`), and a zero `cal::date_duration` is
 * `P0D`, not `PT0S`.
 *
 * Input keeps both spellings: `<duration>'PT1H2M'` and `<duration>'01:02:00'`.
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
  type DurIso {
    required label: str;
    d: duration;
    r: cal::relative_duration;
    dd: cal::date_duration;
    ds: array<duration>;
    dds: array<cal::date_duration>;
    at: datetime;
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
      sessionId: `duration_iso_${Date.now()}`,
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

/*** Gel 7.1's answer to each scalar query: its one value. ***/
const GEL_SCALARS: [string, unknown][] = [
  // std::duration
  [`select <duration>'0 seconds'`, "PT0S"],
  [`select <duration>'1.5 seconds'`, "PT1.5S"],
  [`select <duration>'1 microsecond'`, "PT0.000001S"],
  [`select <duration>'1 hour 2 minutes'`, "PT1H2M"],
  [`select <duration>'49 hours'`, "PT49H"],
  [`select <duration>'86400 seconds'`, "PT24H"],
  [`select <duration>'100 hours 0.5 seconds'`, "PT100H0.5S"],
  [`select <duration>'-1 hour'`, "PT-1H"],
  [`select <duration>'-1.5 seconds'`, "PT-1.5S"],
  [`select <duration>'-1 hour 30 minutes'`, "PT-30M"],
  [`select <duration>'-1 hour -2 minutes -3.25 seconds'`, "PT-1H-2M-3.25S"],
  [`select -<duration>'1 hour'`, "PT-1H"],
  // ISO 8601 and PostgreSQL input both still parse.
  [`select <duration>'PT1H2M'`, "PT1H2M"],
  [`select <duration>'01:02:00'`, "PT1H2M"],
  // A datetime difference holds no days.
  [`select <datetime>'2024-01-03T01:00:00Z' - <datetime>'2024-01-01T00:00:00Z'`, "PT49H"],
  [`select <datetime>'2024-01-01T00:00:00Z' - <datetime>'2024-01-03T01:00:00Z'`, "PT-49H"],
  [`select <datetime>'2024-01-01T00:00:00.5Z' - <datetime>'2024-01-01T00:00:00Z'`, "PT0.5S"],
  [`select <str>(<datetime>'2024-01-03T01:00:00Z' - <datetime>'2024-01-01T00:00:00Z')`, "PT49H"],
  // <str> casts
  [`select <str><duration>'1 hour 2 minutes'`, "PT1H2M"],
  [`select <str><duration>'-1.5 seconds'`, "PT-1.5S"],
  [`select <str><duration>'0 seconds'`, "PT0S"],
  [`select to_str(<duration>'1 hour')`, "PT1H"],
  // cal::relative_duration
  [`select <cal::relative_duration>'1 year 2 months 3 days 4 hours 5 minutes 6.5 seconds'`, "P1Y2M3DT4H5M6.5S"],
  [`select <cal::relative_duration>'P1Y2M3DT4H5M6.5S'`, "P1Y2M3DT4H5M6.5S"],
  [`select <cal::relative_duration>'-1 year -2 months -3 days -4 hours'`, "P-1Y-2M-3DT-4H"],
  [`select <cal::relative_duration>'-1 year 2 months'`, "P-10M"],
  [`select <cal::relative_duration>'0 seconds'`, "PT0S"],
  [`select <cal::relative_duration>'45 days 1 microsecond'`, "P45DT0.000001S"],
  [`select <cal::relative_duration>'1.5 days'`, "P1DT12H"],
  [`select <str><cal::relative_duration>'1 year 2 hours'`, "P1YT2H"],
  [`select <str><cal::relative_duration>'0 seconds'`, "PT0S"],
  [`select <cal::local_datetime>'2024-03-01T01:00' - <cal::local_datetime>'2024-01-01T00:00'`, "P60DT1H"],
  // cal::date_duration
  [`select <cal::date_duration>'1 year 2 months 3 days'`, "P1Y2M3D"],
  [`select <cal::date_duration>'-3 days'`, "P-3D"],
  [`select <cal::date_duration>'0 days'`, "P0D"],
  [`select <cal::date_duration>'1 month' + <cal::date_duration>'5 days'`, "P1M5D"],
  [`select <str><cal::date_duration>'1 month 2 days'`, "P1M2D"],
  [`select <str><cal::date_duration>'0 days'`, "P0D"],
  // Inside tuples, arrays and JSON
  [`select (<duration>'1 hour', <cal::relative_duration>'1 month', <cal::date_duration>'0 days')`, ["PT1H", "P1M", "P0D"]],
  [`select [<duration>'1 hour', <duration>'-2 minutes']`, ["PT1H", "PT-2M"]],
  [`select <array<str>>[<duration>'1 hour']`, ["PT1H"]],
  [`select <json><duration>'1 hour 2 minutes'`, "PT1H2M"],
  [`select <json><cal::date_duration>'0 days'`, "P0D"],
  [`select <json>(<duration>'1 hour', [<cal::date_duration>'2 days'])`, ["PT1H", ["P2D"]]],
  // Date and time arithmetic: the result type and its text
  [`select <cal::local_date>'2024-01-04' - <cal::local_date>'2024-01-01'`, "P3D"],
  [`select <cal::local_date>'2024-01-01' - <cal::local_date>'2024-01-04'`, "P-3D"],
  [`select <cal::local_date>'2024-01-01' - <cal::local_date>'2024-01-01'`, "P0D"],
  [`select <cal::local_date>'2024-03-01' - <cal::local_date>'2023-01-01'`, "P425D"],
  [`select <str>(<cal::local_date>'2024-01-04' - <cal::local_date>'2024-01-01')`, "P3D"],
  [`select <json>(<cal::local_date>'2024-01-04' - <cal::local_date>'2024-01-01')`, "P3D"],
  [`select [<cal::local_date>'2024-01-01' - <cal::local_date>'2024-01-01']`, ["P0D"]],
  [`select (<cal::local_date>'2024-01-01' - <cal::local_date>'2024-01-01', 1)`, ["P0D", 1]],
  [`select <cal::local_date>'2024-01-31' + <cal::date_duration>'1 month'`, "2024-02-29"],
  [`select <cal::date_duration>'1 month' + <cal::local_date>'2024-01-31'`, "2024-02-29"],
  [`select <cal::local_date>'2024-03-31' - <cal::date_duration>'1 month'`, "2024-02-29"],
  [`select <cal::local_date>'2024-01-01' + <cal::date_duration>'3 days'`, "2024-01-04"],
  [`select <cal::local_date>'2024-01-01' + <duration>'24 hours'`, "2024-01-02T00:00:00"],
  [`select <cal::local_date>'2024-01-01' + <cal::relative_duration>'1 day 2 hours'`, "2024-01-02T02:00:00"],
  [`select <cal::local_datetime>'2024-01-01T00:00' - <cal::local_datetime>'2024-01-01T00:00'`, "PT0S"],
  [`select <cal::local_datetime>'2024-01-01T00:00' - <cal::local_datetime>'2024-03-01T01:00:00.5'`, "P-60DT-1H-0.5S"],
  [`select <cal::local_datetime>'2024-01-01T00:00' + <cal::date_duration>'1 month'`, "2024-02-01T00:00:00"],
  [`select <cal::local_time>'10:00' - <cal::local_time>'08:30'`, "PT1H30M"],
  [`select <cal::local_time>'08:30' - <cal::local_time>'10:00'`, "PT-1H-30M"],
  [`select <cal::local_time>'08:30' - <cal::local_time>'08:30'`, "PT0S"],
  [`select <cal::local_time>'23:00' + <duration>'2 hours'`, "01:00:00"],
  [`select <cal::date_duration>'1 month' - <cal::date_duration>'5 days'`, "P1M-5D"],
  [`select <cal::date_duration>'5 days' - <cal::date_duration>'5 days'`, "P0D"],
  [`select <cal::date_duration>'1 day' + <duration>'1 hour'`, "P1DT1H"],
  // A zero date duration in an array literal
  [`select [<cal::date_duration>'0 days', <cal::date_duration>'1 day']`, ["P0D", "P1D"]]
];

Deno.test({
  name: "PG durations: output is Gel's ISO 8601 text",
  ignore: !canRunPgTests(),
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      const run = await handlerFor(pool, dsn);
      const one = async (query: string): Promise<unknown> => Object.values((await run(query))[0] as Record<string, unknown>)[0];

      await t.step("scalars, casts, tuples, arrays and JSON", async () => {
        const answers: [string, unknown][] = [];
        for (const [query] of GEL_SCALARS) {
          answers.push([query, await one(query)]);
        }
        assertEquals(answers, GEL_SCALARS);
      });

      await t.step("a difference from datetime_current() holds no days", async () => {
        const since = await one(`select datetime_current() - <datetime>'2024-01-01T00:00:00Z'`);
        assertEquals(/^PT\d+H(\d+M)?([\d.]+S)?$/.test(String(since)), true, String(since));
      });

      await t.step("a named tuple", async () => {
        assertEquals(await run(`select (a := <duration>'1.5 seconds')`), [{ a: "PT1.5S" }]);
      });

      await t.step("stored properties, in a shape and as the result of an insert", async () => {
        const inserted = await run(
          `insert DurIso { label := 'a', d := <duration>'1 hour 2 minutes', r := <cal::relative_duration>'1 month 3 hours', dd := <cal::date_duration>'2 days', ds := [<duration>'1 second', <duration>'-1.5 seconds'] }`
        );
        const row = (Array.isArray(inserted) ? inserted[0] : inserted) as Record<string, unknown>;
        assertEquals([row.d, row.r, row.dd, row.ds], ["PT1H2M", "P1MT3H", "P2D", ["PT1S", "PT-1.5S"]]);

        const zero = await run(
          `insert DurIso { label := 'zero', d := <duration>'0 seconds', dd := <cal::date_duration>'0 days', dds := [<cal::date_duration>'0 days', <cal::date_duration>'1 day'], at := <datetime>'2024-01-01T00:00:00Z' }`
        );
        const zeroRow = zero as unknown as Record<string, unknown>;
        assertEquals([zeroRow.d, zeroRow.dd, zeroRow.dds], ["PT0S", "P0D", ["P0D", "P1D"]]);
        const updated = await run(`update DurIso filter .label = 'zero' set { dd := <cal::date_duration>'0 days' }`) as unknown as Record<string, unknown>;
        assertEquals([updated.dd, updated.dds], ["P0D", ["P0D", "P1D"]]);
        assertEquals(await run(`select DurIso { label, d, r, dd, ds, dds } order by .label`), [
          { d: "PT1H2M", dd: "P2D", dds: null, ds: ["PT1S", "PT-1.5S"], label: "a", r: "P1MT3H" },
          { d: "PT0S", dd: "P0D", dds: ["P0D", "P1D"], ds: null, label: "zero", r: null }
        ]);
      });

      await t.step("computed shape elements and a bare property path", async () => {
        assertEquals(await run(`select DurIso { dd2 := .dd, t := (.d, .dd), s := <str>.dd } filter .label = 'zero'`), [
          { dd2: "P0D", s: "P0D", t: ["PT0S", "P0D"] }
        ]);
        assertEquals(
          await run(`select DurIso { since := <datetime>'2024-01-03T01:00:00Z' - .at } filter .label = 'zero'`),
          [{ since: "PT49H" }]
        );
        const values = async (query: string): Promise<unknown[]> => (await run(query)).map(row => Object.values(row as Record<string, unknown>)[0]).sort();
        assertEquals(await values(`select DurIso.d`), ["PT0S", "PT1H2M"]);
        assertEquals(await values(`select DurIso.dd`), ["P0D", "P2D"]);
      });

      await t.step("a variable binds either spelling", async () => {
        for (const x of ["PT1H2M", "01:02:00", "1 hour 2 minutes"]) {
          assertEquals(await run(`select DurIso { label } filter .d = <duration>$x`, { x }), [{ label: "a" }], x);
        }
      });
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

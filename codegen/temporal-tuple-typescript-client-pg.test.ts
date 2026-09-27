/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, through the generated TypeScript client over HTTP: every
 * value is of the TS type codegen declares for it, wherever the query
 * builders return one — `select`, `selectById`, `filter` (with a `select`
 * shape), the rows `insert` and `update` return, arrays and multi properties,
 * tuples, linked objects and link properties:
 *
 * - `datetime` is a `Date`, and a `Date` is accepted wherever one is written
 *   (insert and update data, filter values);
 * - the `cal::` types and `duration` are strings — a local datetime or date
 *   the same wall-clock text from an insert as from a select;
 * - an `int64` inside a tuple, a named tuple or an array of tuples is a
 *   `bigint`, and so is a user scalar extending `int64`, link properties too.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import { HttpServer } from "../server/http.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { emitTypeScript } from "./emit-typescript.ts";
import { schemaToIR } from "./schema-to-ir.ts";

const SDK_URL = new URL("../sdk/mod.ts", import.meta.url).href;

const SDL = `module default {
  scalar type Tally extending int64;
  type TtTag {
    required name: str;
    created: datetime;
  };
  type TtEvent {
    required label: str;
    at: datetime;
    ats: array<datetime>;
    multi marks: datetime;
    local: cal::local_datetime;
    day: cal::local_date;
    time: cal::local_time;
    span: duration;
    tally: Tally;
    pair: tuple<int64, str>;
    stamp: tuple<n: int64, at: datetime>;
    pairs: array<tuple<int64, str>>;
    tag: TtTag;
    multi tags: TtTag {
      since: datetime;
      weight: Tally;
    };
  };
};`;

/*** 2^53 + 1: the first integer a double cannot hold. ***/
const BIG = 9007199254740993n;

const AT = new Date("2026-01-15T10:20:30.123Z");
const LATER = new Date("2026-06-01T00:00:00Z");

type Row = Record<string, unknown> & { id: string; };

interface Builder {
  filter(filter: Record<string, unknown>): Promise<Row[]>;
  insert(data: Record<string, unknown>): Promise<Row>;
  select(shape?: string): Promise<Row[]>;
  selectById(id: string, shape?: string): Promise<Row | null>;
  update(id: string, data: Record<string, unknown>): Promise<Row>;
}

interface GeneratedClient {
  ttevent: Builder;
  tttag: Builder;
  query<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

/** Generate the typed client into a temp directory and import it, with its SDK import pointed at this repo's `sdk/`. */
async function withGeneratedClient(schema: Schema, baseUrl: string, fn: (client: GeneratedClient) => Promise<void>): Promise<void> {
  const outputDir = await Deno.makeTempDir({ prefix: "disc-temporal-client-" });

  try {
    const files = emitTypeScript(schemaToIR(schema), {
      formatOutput: false,
      includeClient: true,
      includeMutations: true,
      includeQueryBuilders: true,
      outputDir,
      schemaSource: "temporal-tuple-typescript-client-pg.test.ts",
      sdkImportBase: SDK_URL,
      target: "client"
    });

    for (const file of files)
      await Deno.writeTextFile(file.path, file.content);

    const generated = await import(new URL(`file://${outputDir}/client.ts`).href) as {
      DiscClient: new(config: { baseUrl: string; }) => GeneratedClient;
    };

    await fn(new generated.DiscClient({ baseUrl }));
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
}

/*** A multi property's elements in order (a set has none). ***/
function sortedDates(values: unknown): number[] {
  return (values as Date[])
    .map(date => {
      assert(date instanceof Date, `expected a Date, got ${JSON.stringify(date)}`);
      return date.getTime();
    })
    .sort((a, b) => a - b);
}

Deno.test({
  name: "PG temporal and tuple values via the generated TypeScript client: declared types in, declared types out",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 4, minConnections: 1 });
    await pool.initialize();
    await resetTestDatabase(pool);

    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);

    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 4, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, schema })
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (server as any).handleRequest(request, info)
    );

    try {
      await withGeneratedClient(schema, `http://127.0.0.1:${listener.addr.port}`, async client => {
        let eventId = "";
        let tagId = "";

        await t.step("insert takes Date values and returns the declared types", async () => {
          const tag = await client.tttag.insert({ created: AT, name: "t" });
          tagId = tag.id;
          assertEquals(tag.created, AT);

          const event = await client.ttevent.insert({
            at: AT,
            ats: [AT, LATER],
            day: "2026-01-15",
            label: "a",
            local: "2026-01-15T10:20:30",
            marks: [AT, LATER],
            pair: [BIG, "x"],
            span: "60 minutes",
            stamp: { at: AT, n: BIG },
            tag: tagId,
            tally: BIG,
            time: "10:20:30.5"
          });
          eventId = event.id;
          assertEquals(event.at, AT);
          assertEquals(event.ats, [AT, LATER]);
          assertEquals(sortedDates(event.marks), [AT.getTime(), LATER.getTime()]);
          // A local datetime or date has no zone: the text that was written, not an instant.
          assertEquals(event.local, "2026-01-15T10:20:30");
          assertEquals(event.day, "2026-01-15");
          assertEquals(event.time, "10:20:30.5");
          assertEquals(event.span, "PT1H");
          assertEquals(event.tally, BIG);
          assertEquals(event.pair, [BIG, "x"]);
          assertEquals(event.stamp, { at: AT, n: BIG });

          await client.ttevent.insert({ at: LATER, label: "b" });
        });

        await t.step("select and selectById return the declared types", async () => {
          const rows = await client.ttevent.select("{ label, at, ats, marks, local, day, tally, pair, stamp } order by .label");
          assertEquals(rows.map(row => [row.label, row.at, row.ats, row.local, row.day, row.tally, row.pair, row.stamp]), [
            ["a", AT, [AT, LATER], "2026-01-15T10:20:30", "2026-01-15", BIG, [BIG, "x"], { at: AT, n: BIG }],
            ["b", LATER, null, null, null, null, null, null]
          ]);
          assertEquals(sortedDates(rows[0].marks), [AT.getTime(), LATER.getTime()]);

          const byId = await client.ttevent.selectById(eventId);
          assertEquals(byId?.at, AT);
          assertEquals(byId?.local, "2026-01-15T10:20:30");
          assertEquals(byId?.span, "PT1H");
          assertEquals(byId?.stamp, { at: AT, n: BIG });
          assertEquals(sortedDates(byId?.marks), [AT.getTime(), LATER.getTime()]);
        });

        await t.step("arrays of tuples", async () => {
          const updated = await client.ttevent.update(eventId, { pairs: [[BIG, "x"], [2n, "y"]] });
          assertEquals(updated.pairs, [[BIG, "x"], [2n, "y"]]);
          const [row] = await client.ttevent.select(`{ pairs } filter .label = "a"`);
          assertEquals(row.pairs, [[BIG, "x"], [2n, "y"]]);
        });

        await t.step("linked objects and link properties", async () => {
          await client.query(`update TtEvent filter .id = <uuid>$id set { tags := (select TtTag) { @since := <datetime>$since, @weight := <Tally>$w } }`, {
            id: eventId,
            since: LATER,
            w: BIG
          });
          const [row] = await client.ttevent.select(`{ tag: { created }, tags: { created, @since, @weight } } filter .label = "a"`);
          assertEquals(row.tag, [{ created: AT }]);
          assertEquals(row.tags, [{ "@since": LATER, "@weight": BIG, created: AT }]);
        });

        await t.step("filter takes Date values and returns the declared types", async () => {
          const labels = async (filter: Record<string, unknown>): Promise<unknown[]> => (await client.ttevent.filter(filter)).map(row => row.label);
          assertEquals(await labels({ at: AT }), ["a"]);
          assertEquals(await labels({ at: { gt: AT } }), ["b"]);
          assertEquals(await labels({ at: { in: [AT, LATER] }, order_by: "label" }), ["a", "b"]);
          assertEquals(await labels({ marks: LATER }), ["a"]);
          assertEquals(await labels({ local: "2026-01-15T10:20:30" }), ["a"]);
          assertEquals(await labels({ day: { lte: "2026-01-15" } }), ["a"]);
          assertEquals(await labels({ tag: { created: AT } }), ["a"]);

          const [row] = await client.ttevent.filter({ at: AT, select: { at: true, label: true, stamp: true, tag: { created: true } } });
          assertEquals(row as Record<string, unknown>, { at: AT, label: "a", stamp: { at: AT, n: BIG }, tag: [{ created: AT }] });
        });

        await t.step("update takes Date values and returns the declared types", async () => {
          const updated = await client.ttevent.update(eventId, { at: LATER, day: "2027-02-03", local: "2027-02-03T04:05:06", marks: [AT] });
          assertEquals(updated.at, LATER);
          assertEquals(updated.day, "2027-02-03");
          assertEquals(updated.local, "2027-02-03T04:05:06");
          assertEquals(updated.marks, [AT]);
        });
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

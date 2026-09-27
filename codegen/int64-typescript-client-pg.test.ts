/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, through the generated TypeScript client over HTTP: an
 * `int64` is a `bigint`, as codegen declares it, wherever the query builders
 * return one — `select`, `selectById`, `filter` (with a `select` shape),
 * the rows `insert` and `update` return, arrays and multi properties, linked
 * objects and link properties — and a `bigint` is accepted wherever one is
 * written: insert and update data and filter values, past 2^53 too.
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
  type I64Tag {
    required name: str;
    required rank: int64;
  };
  type I64Item {
    required label: str;
    count: int64;
    counts: array<int64>;
    multi marks: int64;
    small: int32;
    tag: I64Tag;
    multi tags: I64Tag {
      weight: int64;
    };
  };
};`;

/*** 2^53 + 1: the first integer a double cannot hold. ***/
const BIG = 9007199254740993n;

type Row = Record<string, unknown> & { id: string; };

interface Builder {
  filter(filter: Record<string, unknown>): Promise<Row[]>;
  insert(data: Record<string, unknown>): Promise<Row>;
  select(shape?: string): Promise<Row[]>;
  selectById(id: string, shape?: string): Promise<Row | null>;
  update(id: string, data: Record<string, unknown>): Promise<Row>;
}

interface GeneratedClient {
  i64item: Builder;
  i64tag: Builder;
  query<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
}

/** Generate the typed client into a temp directory and import it, with its SDK import pointed at this repo's `sdk/`. */
async function withGeneratedClient(schema: Schema, baseUrl: string, fn: (client: GeneratedClient) => Promise<void>): Promise<void> {
  const outputDir = await Deno.makeTempDir({ prefix: "disc-int64-client-" });

  try {
    const files = emitTypeScript(schemaToIR(schema), {
      formatOutput: false,
      includeClient: true,
      includeMutations: true,
      includeQueryBuilders: true,
      outputDir,
      schemaSource: "int64-typescript-client-pg.test.ts",
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
function sorted(values: unknown): bigint[] {
  return [...(values as bigint[])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}

Deno.test({
  name: "PG int64 via the generated TypeScript client: bigint results and bigint values",
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
        let itemId = "";
        let tagId = "";

        await t.step("insert returns int64 fields as bigint", async () => {
          const tag = await client.i64tag.insert({ name: "t", rank: BIG });
          tagId = tag.id;
          assertEquals(tag.rank, BIG);

          const item = await client.i64item.insert({ count: BIG, counts: [1n, BIG], label: "a", marks: [2n, BIG], small: 7, tag: tagId });
          itemId = item.id;
          assertEquals(item.count, BIG);
          assertEquals(item.counts, [1n, BIG]);
          assertEquals(sorted(item.marks), [2n, BIG]);
          assertEquals(item.small, 7);

          await client.i64item.insert({ count: 3n, label: "b" });
        });

        await t.step("select and selectById return int64 fields as bigint", async () => {
          const rows = await client.i64item.select("{ label, count, counts, marks, small } order by .label");
          assertEquals(rows.map(row => [row.label, row.count, row.counts, row.small]), [["a", BIG, [1n, BIG], 7], ["b", 3n, null, null]]);
          assertEquals(sorted(rows[0].marks), [2n, BIG]);

          const byId = await client.i64item.selectById(itemId);
          assertEquals(byId?.count, BIG);
          assertEquals(sorted(byId?.marks), [2n, BIG]);
        });

        await t.step("linked objects and link properties", async () => {
          await client.query(`update I64Item filter .id = <uuid>$id set { tags := (select I64Tag) { @weight := <int64>$w } }`, {
            id: itemId,
            w: BIG
          });
          const [row] = await client.i64item.select(`{ tag: { rank }, tags: { rank, @weight } } filter .label = "a"`);
          assertEquals(row.tag, [{ rank: BIG }]);
          assertEquals(row.tags, [{ "@weight": BIG, rank: BIG }]);
        });

        await t.step("filter takes bigint values and returns bigint", async () => {
          const labels = async (filter: Record<string, unknown>): Promise<unknown[]> => (await client.i64item.filter(filter)).map(row => row.label);
          assertEquals(await labels({ count: BIG }), ["a"]);
          assertEquals(await labels({ count: { in: [3n, BIG] }, order_by: "label" }), ["a", "b"]);
          assertEquals(await labels({ count: { gt: 3n } }), ["a"]);
          assertEquals(await labels({ marks: BIG }), ["a"]);
          assertEquals(await labels({ tag: { rank: BIG } }), ["a"]);
          assertEquals(await labels({ tags: { rank: { gte: BIG } } }), ["a"]);

          const [row] = await client.i64item.filter({ count: BIG, select: { count: true, label: true, tag: { rank: true } } });
          assertEquals(row as Record<string, unknown>, { count: BIG, label: "a", tag: [{ rank: BIG }] });
        });

        await t.step("update takes bigint values and returns them as bigint", async () => {
          const updated = await client.i64item.update(itemId, { count: BIG + 1n, marks: [4n] });
          assertEquals(updated.count, BIG + 1n);
          assertEquals(updated.marks, [4n]);
        });
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

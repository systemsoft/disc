/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: a shape over a mutation answers the links the
 * statement wrote.
 *
 * `select (insert … { items := … }) { items: { name } }` answered `items: []`
 * and a single link to an object inserted by the same statement `null`: the
 * shape read the tables as they were before the statement. The compiler
 * cases are in compiler/pg-mutation-result-links.test.ts.
 *
 * Every case runs twice with the same query text, so the second run is a
 * compiled-query cache hit.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDL = `module default {
  type MrhItem {
    required name -> str;
  }
  type MrhOrder {
    required label -> str;
    item -> MrhItem;
    multi items -> MrhItem;
  }
}`;

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

/*** `value` with each array of `{ name }` objects sorted by name (a link's targets come back in no particular order). ***/
function byName(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(byName).sort((a, b) => String((a as { name?: string; }).name).localeCompare(String((b as { name?: string; }).name)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, byName(item)]));
  }
  return value;
}

Deno.test({
  name: "PG mutation result links over HTTP: a shape over an insert or update answers the links it wrote, on a cache miss and on a cache hit",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
    await pool.query("INSERT INTO mrh_item (name) VALUES ('a'), ('b')");

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

    async function answer(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
        body: JSON.stringify({ query, variables }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      const reply: Reply = { body: await response.json(), status: response.status };
      assertEquals(reply.status, 200, JSON.stringify(reply.body));
      return byName(reply.body.data);
    }

    try {
      for (const round of ["cache miss", "cache hit"]) {
        assertEquals(
          await answer(
            "select (insert MrhOrder { label := <str>$label, items := (select MrhItem filter .name in {'a', 'b'}), " +
              "item := (insert MrhItem { name := <str>$label ++ '-item' }) }) { label, items: { name }, item: { name } }",
            { label: round }
          ),
          [{ item: [{ name: `${round}-item` }], items: [{ name: "a" }, { name: "b" }], label: round }],
          round
        );
        assertEquals(
          await answer(
            "with o := (update MrhOrder filter .label = <str>$label set { items -= (select MrhItem filter .name = 'a') }) select o { label, items: { name } }",
            { label: round }
          ),
          [{ items: [{ name: "b" }], label: round }],
          round
        );
      }
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

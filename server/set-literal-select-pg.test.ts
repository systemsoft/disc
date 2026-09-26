/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: `select {…}` answers one element per row.
 *
 * A selected set literal compiled to one row holding a `(a, b, …)` record, so
 * `/query` answered a single value for `select {<uuid>$a, <uuid>$b}`. Scalar
 * elements come back as single-column rows like `select <expr>`; elements
 * that are shaped queries come back as their objects, unwrapped like any
 * shaped select.
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
  type SetLiteralNote {
    required label -> str;
  }
}`;

const UUID_A = "01234567-89ab-7cde-8f01-00000000000a";
const UUID_B = "01234567-89ab-7cde-8f01-00000000000b";

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG set literal over HTTP: select {…} answers one row per element, on a cache miss and on a cache hit",
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
    await pool.query("INSERT INTO set_literal_note (id, label) VALUES (gen_random_uuid(), 'a'), (gen_random_uuid(), 'b')");

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

    async function post(query: string, variables?: Record<string, unknown>): Promise<Reply> {
      const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
        body: JSON.stringify({ query, variables }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      return { body: await response.json(), status: response.status };
    }

    /*** Each answered row's one value (a shaped row is already the object). ***/
    async function answer(query: string, variables?: Record<string, unknown>): Promise<unknown[]> {
      const reply = await post(query, variables);
      assertEquals(reply.status, 200, JSON.stringify(reply.body));
      return (reply.body.data as Record<string, unknown>[]).map(row => {
        const columns = Object.values(row);
        return columns.length === 1 ? columns[0] : row;
      });
    }

    try {
      for (const round of ["cache miss", "cache hit"]) {
        assertEquals(await answer("select {1, 2, 3}"), [1, 2, 3], round);
        assertEquals(await answer("select {1, 1}"), [1, 1], round);
        assertEquals(await answer("select {}"), [], round);
        assertEquals(await answer("select {<uuid>$a, <uuid>$b}", { a: UUID_A, b: UUID_B }), [UUID_A, UUID_B], round);
        assertEquals(await answer("select {<str>$a, <str>$b}", { a: "x", b: "y" }), ["x", "y"], round);
        assertEquals(await answer("select count({1, 2, 3})"), [3], round);

        const reply = await post(
          "select {(select SetLiteralNote { label } filter .label = 'b'), (select SetLiteralNote { label } order by .label)}"
        );
        assertEquals(reply.status, 200, JSON.stringify(reply.body));
        assertEquals(reply.body.data, [{ label: "b" }, { label: "a" }, { label: "b" }], round);
      }
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

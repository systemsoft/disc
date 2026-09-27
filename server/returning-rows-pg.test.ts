/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: rows that carry an `int64` (D13).
 *
 * A bare `insert`/`update` returns `RETURNING *` rows, and `select count(…)`
 * an unshaped row; deno-postgres decodes their `int8` columns as `bigint`,
 * which `JSON.stringify` rejects. The statement ran, then the response failed
 * with HTTP 500 — a client that retries on 500 would write twice. The wire form
 * is a JSON number, exact past 2^53.
 *
 * Every case runs twice with the same query text, so the second run is a
 * compiled-query cache hit.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const FIXTURE_URL = new URL("../tests/fixtures/git-forge.disc", import.meta.url);
const PROGRAM_ID = "00000000-0000-0000-0000-0000000000d1";

const INSERT_OBJECT = `insert GitObject {
  program := <uuid>$p,
  object_id := <str>$oid,
  object_type := 'blob',
  size := <int64>$size
}`;

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; extensions?: { cacheHit?: boolean; }; };
  status: number;
  text: string;
}

Deno.test({
  name: "PG returning rows: int64 columns survive the HTTP response, on a cache miss and on a cache hit",
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
    const applied = await manager.applySchema(await Deno.readTextFile(FIXTURE_URL));
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);
    await pool.query("INSERT INTO program (id, name) VALUES ($1, 'returning-rows')", [PROGRAM_ID]);

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
      const text = await response.text();
      return { body: JSON.parse(text), status: response.status, text };
    }

    try {
      // Bare insert: RETURNING * carries `size` as a driver bigint.
      for (const [round, oid, size] of [["cache miss", "a".repeat(40), 3], ["cache hit", "b".repeat(40), 4]] as const) {
        const reply = await post(INSERT_OBJECT, { oid, p: PROGRAM_ID, size });
        assertEquals(reply.status, 200, `${round}: ${JSON.stringify(reply.body)}`);
        assertEquals(reply.body.extensions?.cacheHit, round === "cache hit", round);
        assertEquals((reply.body.data as Record<string, unknown>[])[0].size, size, round);
      }

      // Each insert ran exactly once.
      const stored = await pool.query("SELECT count(*)::int AS n FROM git_object WHERE program_id = $1", [PROGRAM_ID]);
      assertEquals((stored.rows[0] as { n: number; }).n, 2);

      // Beyond 2^53 the value is a JSON number exact to the last digit (as in Gel), never rounded.
      const large = await post(INSERT_OBJECT, { oid: "c".repeat(40), p: PROGRAM_ID, size: "9007199254740993" });
      assertEquals(large.status, 200, large.text);
      assertStringIncludes(large.text, `"size":9007199254740993`);

      // Bare update.
      for (const round of ["cache miss", "cache hit"]) {
        const reply = await post("update GitObject filter .object_id = <str>$oid set { size := <int64>$size }", { oid: "a".repeat(40), size: 5 });
        assertEquals(reply.status, 200, `${round}: ${JSON.stringify(reply.body)}`);
        assertEquals((reply.body.data as Record<string, unknown>[])[0].size, 5, round);
      }

      // An unshaped aggregate.
      for (const round of ["cache miss", "cache hit"]) {
        const reply = await post("select count(GitObject)");
        assertEquals(reply.status, 200, `${round}: ${JSON.stringify(reply.body)}`);
        assertEquals(reply.body.data, [3], round);
      }
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL-backed HTTP Transaction Route Tests
 *
 * The unit tests in `transaction-routes.test.ts` prove the wire contract with
 * a mock protocol handler. These prove the part that only a real database can
 * show: that a query sent with `X-Transaction-ID` actually runs inside that
 * PostgreSQL transaction — invisible to other sessions until commit, and gone
 * after rollback.
 *
 * Without this, the routes could return 200 for everything while silently
 * executing each statement on an unrelated pooled connection in autocommit.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, parseDsn } from "../tests/pg-test-harness.ts";
import { HttpServer } from "./http.ts";
import type {
  ProtocolHandler,
  QueryContext,
  QueryError,
  QueryRequest,
  QueryResponse,
  ServerConfig
} from "./types.ts";

const RUN_PG = canRunPgTests();

const TEST_TABLE = `txn_routes_test_${Date.now()}`;

async function setupTestTable(dsn: string): Promise<void> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    await client.queryArray(
      `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`
    );
  } finally {
    await client.end();
  }
}

async function teardownTestTable(dsn: string): Promise<void> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    await client.queryArray(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
  } finally {
    await client.end();
  }
}

/** Count rows through a separate client — i.e. a different PG session. */
async function countRows(dsn: string): Promise<number> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    const result = await client.queryObject<{ cnt: number; }>(
      `SELECT COUNT(*)::int AS cnt FROM ${TEST_TABLE}`
    );
    return result.rows[0]?.cnt ?? 0;
  } finally {
    await client.end();
  }
}

/**
 * Protocol handler that treats the incoming "query" as raw SQL and runs it
 * exactly where `executeSQL` would: the transaction's connection when the
 * context carries one, the pool otherwise. This is the behavior under test,
 * isolated from EdgeQL compilation.
 */
function createSqlPassthroughHandler(pool: ConnectionPool): ProtocolHandler {
  return {
    async handleRequest(
      request: QueryRequest,
      context: QueryContext
    ): Promise<QueryResponse> {
      const connection = context.transactionConnection;
      const result = connection ?
        await connection.query(request.query) :
        await pool.query(request.query);
      return { data: result.rows };
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    }
  };
}

function createTestConfig(dsn: string): ServerConfig {
  return {
    databaseUrl: dsn,
    enableCors: false,
    enableWebsockets: false,
    host: "localhost",
    maxConnections: 10,
    port: 0,
    requestTimeout: 5000
  };
}

interface Harness {
  cleanup: () => Promise<void>;
  port: number;
}

async function withServer(dsn: string): Promise<Harness> {
  const pool = new ConnectionPool({
    cleanupInterval: 0,
    connectionString: dsn,
    maxConnections: 5,
    minConnections: 1
  });
  await pool.initialize();

  const server = new HttpServer({
    config: createTestConfig(dsn),
    protocolHandler: createSqlPassthroughHandler(pool),
    transactionPool: pool
  });

  const testServer = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request: Request, info: Deno.ServeHandlerInfo) =>
      // deno-lint-ignore no-explicit-any
      (server as any).handleRequest(request, info)
  );

  return {
    cleanup: async () => {
      await testServer.shutdown();
      await pool.close();
    },
    port: testServer.addr.port
  };
}

async function beginTransaction(port: number): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/transaction/begin`, {
    method: "POST"
  });
  const body = await response.json() as { transactionId: string; };
  return body.transactionId;
}

async function queryInTransaction(
  port: number,
  transactionId: string,
  sql: string
): Promise<Response> {
  const response = await fetch(`http://127.0.0.1:${port}/query`, {
    body: JSON.stringify({ query: sql }),
    headers: { "X-Transaction-ID": transactionId },
    method: "POST"
  });
  await response.body?.cancel();
  return response;
}

Deno.test({
  name: "PG: a rolled-back transaction leaves no rows behind",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);
    const { cleanup, port } = await withServer(dsn);

    try {
      const transactionId = await beginTransaction(port);

      const inserted = await queryInTransaction(
        port,
        transactionId,
        `INSERT INTO ${TEST_TABLE} (name) VALUES ('rolled-back')`
      );
      assertEquals(inserted.status, 200);

      // A different PG session must not see the uncommitted row. If the
      // query had run on a pooled connection in autocommit, this would be 1.
      assertEquals(await countRows(dsn), 0);

      const rolledBack = await fetch(
        `http://127.0.0.1:${port}/transaction/rollback`,
        { headers: { "X-Transaction-ID": transactionId }, method: "POST" }
      );
      assertEquals(rolledBack.status, 200);
      await rolledBack.body?.cancel();

      assertEquals(await countRows(dsn), 0);
    } finally {
      await cleanup();
      await teardownTestTable(dsn);
    }
  }
});

Deno.test({
  name: "PG: a committed transaction persists its rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);
    const { cleanup, port } = await withServer(dsn);

    try {
      const transactionId = await beginTransaction(port);

      await queryInTransaction(
        port,
        transactionId,
        `INSERT INTO ${TEST_TABLE} (name) VALUES ('committed')`
      );
      assertEquals(await countRows(dsn), 0);

      const committed = await fetch(
        `http://127.0.0.1:${port}/transaction/commit`,
        { headers: { "X-Transaction-ID": transactionId }, method: "POST" }
      );
      assertEquals(committed.status, 200);
      await committed.body?.cancel();

      assertEquals(await countRows(dsn), 1);
    } finally {
      await cleanup();
      await teardownTestTable(dsn);
    }
  }
});

Deno.test({
  name: "PG: statements in one transaction share a session",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);
    const { cleanup, port } = await withServer(dsn);

    try {
      const transactionId = await beginTransaction(port);

      await queryInTransaction(
        port,
        transactionId,
        `INSERT INTO ${TEST_TABLE} (name) VALUES ('first')`
      );

      // The second statement reads its own transaction's uncommitted write,
      // which only holds if both ran on the same held connection.
      const read = await fetch(`http://127.0.0.1:${port}/query`, {
        body: JSON.stringify({
          query: `SELECT name FROM ${TEST_TABLE} WHERE name = 'first'`
        }),
        headers: { "X-Transaction-ID": transactionId },
        method: "POST"
      });
      const body = await read.json() as { data: Array<{ name: string; }>; };
      assertEquals(body.data.length, 1);
      assertEquals(body.data[0].name, "first");

      const rolledBack = await fetch(
        `http://127.0.0.1:${port}/transaction/rollback`,
        { headers: { "X-Transaction-ID": transactionId }, method: "POST" }
      );
      await rolledBack.body?.cancel();
      assertEquals(await countRows(dsn), 0);
    } finally {
      await cleanup();
      await teardownTestTable(dsn);
    }
  }
});

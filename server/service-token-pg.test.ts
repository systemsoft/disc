/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL-backed service credential + transaction test.
 *
 * `service-token.test.ts` proves the ownership rules with a mock handler.
 * This proves them against a held PostgreSQL connection: the service can
 * begin, write inside and commit its own transaction (the row persists),
 * and a user's attempt to drive that transaction changes nothing — and vice
 * versa.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, parseDsn } from "../tests/pg-test-harness.ts";
import { HttpServer } from "./http.ts";
import type { ProtocolHandler, QueryContext, QueryError, QueryRequest, QueryResponse, ServerConfig } from "./types.ts";

const RUN_PG = canRunPgTests();
const SERVICE_TOKEN = "service-token-pg-test-0123456789abcdef-ghij";
const TEST_TABLE = `service_txn_test_${Date.now()}`;

async function withClient<T>(dsn: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Rows visible from a separate PostgreSQL session. */
function committedNames(dsn: string): Promise<string[]> {
  return withClient(dsn, async client => {
    const result = await client.queryObject<{ name: string; }>(`SELECT name FROM ${TEST_TABLE} ORDER BY name`);
    return result.rows.map(row => row.name);
  });
}

/** Runs the "query" as raw SQL on the transaction's connection, as `executeSQL` would. */
function createSqlPassthroughHandler(pool: ConnectionPool): ProtocolHandler {
  return {
    async handleRequest(request: QueryRequest, context: QueryContext): Promise<QueryResponse> {
      const connection = context.transactionConnection;
      const result = connection ? await connection.query(request.query) : await pool.query(request.query);
      return { data: result.rows };
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    }
  };
}

function createFakeAuthMiddleware(tokenToUser: Record<string, string>): { authenticate(request: Request): Promise<{ userId: string; } | null>; } {
  return {
    authenticate(request: Request) {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const userId = tokenToUser[token];
      return Promise.resolve(userId ? { userId } : null);
    }
  };
}

interface Harness {
  begin(token: string): Promise<string>;
  cleanup(): Promise<void>;
  finish(action: "commit" | "rollback", transactionId: string, token: string): Promise<number>;
  query(sql: string, transactionId: string, token: string): Promise<number>;
}

async function withServer(dsn: string): Promise<Harness> {
  const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 5, minConnections: 1 });
  await pool.initialize();

  const config: ServerConfig = {
    databaseUrl: dsn,
    enableCors: false,
    enableWebsockets: false,
    host: "localhost",
    maxConnections: 10,
    port: 0,
    requestTimeout: 5000,
    serviceToken: SERVICE_TOKEN
  };
  const server = new HttpServer({
    // deno-lint-ignore no-explicit-any
    authMiddleware: createFakeAuthMiddleware({ "user-token": "user_1" }) as any,
    config,
    protocolHandler: createSqlPassthroughHandler(pool),
    transactionPool: pool
  });

  const listener = Deno.serve(
    { hostname: "127.0.0.1", onListen() {}, port: 0 },
    (request: Request, info: Deno.ServeHandlerInfo) =>
      // deno-lint-ignore no-explicit-any
      (server as any).handleRequest(request, info)
  );
  const base = `http://127.0.0.1:${listener.addr.port}`;
  const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  return {
    begin: async token => {
      const response = await fetch(`${base}/transaction/begin`, { headers: bearer(token), method: "POST" });
      return (await response.json() as { transactionId: string; }).transactionId;
    },
    cleanup: async () => {
      await listener.shutdown();
      await pool.close();
    },
    finish: async (action, transactionId, token) => {
      const response = await fetch(`${base}/transaction/${action}`, {
        headers: { ...bearer(token), "X-Transaction-ID": transactionId },
        method: "POST"
      });
      await response.body?.cancel();
      return response.status;
    },
    query: async (sql, transactionId, token) => {
      const response = await fetch(`${base}/query`, {
        body: JSON.stringify({ query: sql }),
        headers: { ...bearer(token), "X-Transaction-ID": transactionId },
        method: "POST"
      });
      await response.body?.cancel();
      return response.status;
    }
  };
}

Deno.test({
  name: "PG: the service begins, writes inside and commits its own transaction; users cannot drive it, nor it theirs",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await withClient(dsn, client => client.queryArray(`CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id SERIAL PRIMARY KEY, name TEXT NOT NULL)`));
    const h = await withServer(dsn);

    try {
      // Service transaction: the write is invisible until the service commits.
      const serviceTx = await h.begin(SERVICE_TOKEN);
      assertEquals(await h.query(`INSERT INTO ${TEST_TABLE} (name) VALUES ('by-service')`, serviceTx, SERVICE_TOKEN), 200);
      assertEquals(await committedNames(dsn), []);

      // A user holding the id cannot write into, commit or roll back the service's transaction.
      assertEquals(await h.query(`INSERT INTO ${TEST_TABLE} (name) VALUES ('by-user-into-service-tx')`, serviceTx, "user-token"), 403);
      assertEquals(await h.finish("rollback", serviceTx, "user-token"), 403);
      assertEquals(await h.finish("commit", serviceTx, "user-token"), 403);

      assertEquals(await h.finish("commit", serviceTx, SERVICE_TOKEN), 200);
      assertEquals(await committedNames(dsn), ["by-service"]);

      // User transaction: the service cannot drive it either.
      const userTx = await h.begin("user-token");
      assertEquals(await h.query(`INSERT INTO ${TEST_TABLE} (name) VALUES ('by-user')`, userTx, "user-token"), 200);
      assertEquals(await h.query(`INSERT INTO ${TEST_TABLE} (name) VALUES ('by-service-into-user-tx')`, userTx, SERVICE_TOKEN), 403);
      assertEquals(await h.finish("commit", userTx, SERVICE_TOKEN), 403);
      assertEquals(await h.finish("rollback", userTx, "user-token"), 200);
      assertEquals(await committedNames(dsn), ["by-service"]);
    } finally {
      await h.cleanup();
      await withClient(dsn, client => client.queryArray(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`));
    }
  }
});

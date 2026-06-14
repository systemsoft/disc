/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Request Timeout Enforcement Tests
 *
 * Tests:
 * 1. queryWithTimeout throws QueryTimeoutError when query exceeds timeout
 * 2. EdgeQLProtocolHandler returns TIMEOUT error when pool query times out
 * 3. HTTP request exceeding timeout returns 408 status
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { QueryTimeoutError } from "../lib/errors.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";
import type {
  ProtocolHandler,
  QueryContext,
  QueryError,
  QueryRequest,
  QueryResponse,
  ServerConfig
} from "./types.ts";

// --- Helpers ---

function makeContext(): QueryContext {
  return {
    session: {
      sessionId: "test_timeout",
      database: "test_db",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "test_request",
    startedAt: new Date()
  };
}

/**
 * Creates a mock ConnectionPool whose `query()` delays for `delayMs`
 * before resolving. Returns a handle with a `cleanup()` method to
 * cancel lingering timers so Deno's test sanitizer stays happy.
 */
function makeSlowPool(delayMs: number): {
  pool: ConnectionPool;
  cleanup: () => void;
} {
  const timerIds: ReturnType<typeof setTimeout>[] = [];

  const pool = {
    query: () =>
      new Promise(resolve => {
        const id = setTimeout(
          () => resolve({ rows: [{ id: 1 }], rowCount: 1 }),
          delayMs
        );
        timerIds.push(id);
      }),
    queryWithTimeout: ConnectionPool.prototype.queryWithTimeout,
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve()
  } as unknown as ConnectionPool;

  return {
    pool,
    cleanup: () => {
      for (const id of timerIds) {
        clearTimeout(id);
      }
      timerIds.length = 0;
    }
  };
}

/**
 * Creates a mock ConnectionPool whose `query()` resolves immediately.
 */
function makeFastPool(): ConnectionPool {
  return {
    query: () => Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 }),
    queryWithTimeout: ConnectionPool.prototype.queryWithTimeout,
    initialize: () => Promise.resolve(),
    close: () => Promise.resolve()
  } as unknown as ConnectionPool;
}

// --- ConnectionPool.queryWithTimeout tests ---

Deno.test(
  "queryWithTimeout - throws QueryTimeoutError when query exceeds timeout",
  async () => {
    const { pool, cleanup } = makeSlowPool(500);

    let caught: Error | undefined;
    try {
      await pool.queryWithTimeout("SELECT pg_sleep(10)", [], 50);
    } catch (error) {
      caught = error as Error;
    } finally {
      cleanup();
    }

    assert(caught !== undefined, "Expected an error to be thrown");
    assert(
      caught instanceof QueryTimeoutError,
      `Expected QueryTimeoutError, got ${caught?.constructor.name}`
    );
    assertEquals(caught.timeoutMs, 50);
    assertStringIncludes(caught.sql, "SELECT pg_sleep(10)");
    assertStringIncludes(caught.message, "timed out after 50ms");
  }
);

Deno.test(
  "queryWithTimeout - returns result when query completes before timeout",
  async () => {
    const pool = makeFastPool();

    const result = await pool.queryWithTimeout(
      "SELECT 1",
      [],
      5000
    );

    assertEquals(result.rowCount, 1);
    assertEquals(result.rows[0].id, 1);
  }
);

Deno.test(
  "queryWithTimeout - delegates to regular query when timeout <= 0",
  async () => {
    const pool = makeFastPool();

    const result = await pool.queryWithTimeout("SELECT 1", [], 0);
    assertEquals(result.rowCount, 1);

    const result2 = await pool.queryWithTimeout("SELECT 1", [], -1);
    assertEquals(result2.rowCount, 1);
  }
);

// --- EdgeQLProtocolHandler timeout integration ---

Deno.test(
  "EdgeQLProtocolHandler - returns TIMEOUT error when query times out",
  async () => {
    const { pool: slowPool, cleanup } = makeSlowPool(500);

    const handler = new EdgeQLProtocolHandler({
      connectionPool: slowPool,
      requestTimeout: 50
    });

    const request = {
      query: "select User { name, email }",
      variables: {}
    };

    try {
      const response = await handler.handleRequest(
        request,
        makeContext()
      );

      // Must have errors
      assert(
        response.errors !== undefined,
        "Expected errors in response"
      );
      assert(
        response.errors!.length > 0,
        "Expected at least one error"
      );
      assertEquals(response.errors![0].extensions?.code, "TIMEOUT");
      assertStringIncludes(response.errors![0].message, "timed out");

      // Must NOT have data
      assert(
        response.data === undefined,
        "Expected no data when query times out"
      );
    } finally {
      cleanup();
    }
  }
);

Deno.test(
  "EdgeQLProtocolHandler - succeeds when query completes within timeout",
  async () => {
    const fastPool = makeFastPool();

    const handler = new EdgeQLProtocolHandler({
      connectionPool: fastPool,
      requestTimeout: 5000
    });

    const request = {
      query: "select User { name, email }",
      variables: {}
    };

    const response = await handler.handleRequest(
      request,
      makeContext()
    );

    // Should succeed
    assert(
      response.errors === undefined ||
        response.errors.every(
          e => e.extensions?.code === "WARNING"
        ),
      "Expected no real errors"
    );
    assert(response.data !== undefined, "Expected data in response");
  }
);

// --- HTTP-level timeout tests ---

/**
 * Creates a slow protocol handler with cancellable timer.
 */
function createSlowProtocolHandler(delayMs: number): {
  handler: ProtocolHandler;
  cleanup: () => void;
} {
  const timerIds: ReturnType<typeof setTimeout>[] = [];

  const handler: ProtocolHandler = {
    async handleRequest(
      _request: QueryRequest,
      _context: QueryContext
    ): Promise<QueryResponse> {
      await new Promise<void>(resolve => {
        const id = setTimeout(resolve, delayMs);
        timerIds.push(id);
      });
      return { data: { ok: true } };
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    }
  };

  return {
    handler,
    cleanup: () => {
      for (const id of timerIds) {
        clearTimeout(id);
      }
      timerIds.length = 0;
    }
  };
}

function createFastProtocolHandler(): ProtocolHandler {
  return {
    handleRequest(
      _request: QueryRequest,
      _context: QueryContext
    ): Promise<QueryResponse> {
      return Promise.resolve({ data: { ok: true } });
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    }
  };
}

function createTestConfig(
  overrides: Partial<ServerConfig> = {}
): ServerConfig {
  return {
    host: "localhost",
    port: 0,
    databaseUrl: "postgresql://localhost:5432/test",
    maxConnections: 10,
    requestTimeout: 5000,
    enableCors: false,
    enableWebsockets: false,
    ...overrides
  };
}

Deno.test(
  "HTTP timeout - returns 408 when request exceeds timeout",
  async () => {
    const { handler, cleanup: handlerCleanup } = createSlowProtocolHandler(500);
    const config = createTestConfig({ requestTimeout: 50 });
    const server = new HttpServer({
      config,
      protocolHandler: handler
    });

    const testServer = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        onListen() {}
      },
      (request: Request, info: Deno.ServeHandlerInfo) => {
        return (server as any).handleRequest(request, info);
      }
    );

    const port = testServer.addr.port;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "select User { name }"
          })
        }
      );

      assertEquals(response.status, 408);

      const body = await response.json();
      assert(body.errors !== undefined, "Expected errors in body");
      assertEquals(body.errors[0].extensions.code, "TIMEOUT");
      assertStringIncludes(body.errors[0].message, "timed out");
    } finally {
      handlerCleanup();
      // Graceful teardown — shutdown() instead of abortController.abort(),
      // which can throw an uncaught BadResource from Deno.serve's internal
      // abort listener on Linux CI. See production-ws-e2e.test.ts.
      await testServer.shutdown();
      await server.stop();
    }
  }
);

Deno.test(
  "HTTP timeout - returns 200 when request completes within timeout",
  async () => {
    const handler = createFastProtocolHandler();
    const config = createTestConfig({ requestTimeout: 5000 });
    const server = new HttpServer({
      config,
      protocolHandler: handler
    });

    const testServer = Deno.serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        onListen() {}
      },
      (request: Request, info: Deno.ServeHandlerInfo) => {
        return (server as any).handleRequest(request, info);
      }
    );

    const port = testServer.addr.port;

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/query`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "select User { name }"
          })
        }
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assert(body.data !== undefined, "Expected data in body");
      assertEquals(body.data.ok, true);
    } finally {
      // Graceful teardown — shutdown() instead of abortController.abort(),
      // which can throw an uncaught BadResource from Deno.serve's internal
      // abort listener on Linux CI. See production-ws-e2e.test.ts.
      await testServer.shutdown();
      await server.stop();
    }
  }
);

// --- QueryTimeoutError unit tests ---

Deno.test(
  "QueryTimeoutError - stores sql and timeout values",
  () => {
    const error = new QueryTimeoutError(
      "SELECT * FROM big_table",
      3000
    );

    assertEquals(error.name, "QueryTimeoutError");
    assertEquals(error.sql, "SELECT * FROM big_table");
    assertEquals(error.timeoutMs, 3000);
    assertStringIncludes(error.message, "3000ms");

    const formatted = error.formatError();
    assertStringIncludes(formatted, "QueryTimeoutError");
    assertStringIncludes(formatted, "SELECT * FROM big_table");
    assertStringIncludes(formatted, "Timeout: 3000ms");
  }
);

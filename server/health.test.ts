/**
 * Health Endpoint Enhancement Tests
 *
 * Tests:
 * 1. /health/live always returns alive with 200
 * 2. /health/ready returns 200 when DB is reachable
 * 3. /health/ready returns 503 when DB is unreachable
 * 4. /health returns full status with pool stats
 * 5. /health returns degraded when pool has waiters
 * 6. No pool configured returns healthy status (dev mode)
 */

import { assertEquals, assertExists } from "@std/assert";
import { HttpServer } from "./http.ts";
import type { HealthStatus, ProtocolHandler, QueryContext, QueryError, QueryRequest, QueryResponse, ServerConfig } from "./types.ts";

// --- Helpers ---

function createTestConfig(
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  return {
    host: "localhost",
    port: 0,
    databaseUrl: "postgresql://localhost:5432/test",
    maxConnections: 10,
    requestTimeout: 5000,
    enableCors: false,
    enableWebsockets: false,
    ...overrides,
  };
}

/**
 * Creates a protocol handler with a configurable health status response.
 */
function createHealthyProtocolHandler(
  healthResponse: HealthStatus,
): ProtocolHandler {
  return {
    handleRequest(
      _request: QueryRequest,
      _context: QueryContext,
    ): Promise<QueryResponse> {
      return Promise.resolve({ data: { ok: true } });
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    },
    checkHealth(): Promise<HealthStatus> {
      return Promise.resolve(healthResponse);
    },
    getPoolStats(): {
      total: number;
      idle: number;
      active: number;
      waiters: number;
    } | null {
      return healthResponse.pool ?? null;
    },
  };
}

/**
 * Creates a protocol handler with no health methods (simulates a
 * handler that does not implement checkHealth/getPoolStats).
 */
function createBasicProtocolHandler(): ProtocolHandler {
  return {
    handleRequest(
      _request: QueryRequest,
      _context: QueryContext,
    ): Promise<QueryResponse> {
      return Promise.resolve({ data: { ok: true } });
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    },
  };
}

/**
 * Spins up a temporary HTTP server wrapping an HttpServer instance and
 * returns a helper to make requests and a cleanup function.
 */
function withTestServer(
  handler: ProtocolHandler,
  configOverrides: Partial<ServerConfig> = {},
): {
  port: number;
  cleanup: () => Promise<void>;
  server: HttpServer;
  testServer: Deno.HttpServer<Deno.NetAddr>;
  abortController: AbortController;
} {
  const config = createTestConfig(configOverrides);
  const server = new HttpServer({
    config,
    protocolHandler: handler,
  });

  const abortController = new AbortController();
  const testServer = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      onListen() {},
    },
    (request: Request, info: Deno.ServeHandlerInfo) => {
      return (server as any).handleRequest(request, info);
    },
  );

  const port = testServer.addr.port;

  const cleanup = async () => {
    abortController.abort();
    await testServer.finished;
    await server.stop();
  };

  return { port, cleanup, server, testServer, abortController };
}

// --- Tests ---

Deno.test(
  "/health/live always returns alive with 200",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health/live`,
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "alive");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "/health/live returns 200 even when DB is unreachable",
  async () => {
    // Use a handler that reports unhealthy — liveness should still
    // return 200 because liveness is independent of DB health.
    const handler = createHealthyProtocolHandler({
      status: "unhealthy",
      database: { connected: false },
      pool: { total: 0, idle: 0, active: 0, waiters: 0 },
    });
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health/live`,
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "alive");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "/health/ready returns 200 when DB is reachable",
  async () => {
    const handler = createHealthyProtocolHandler({
      status: "healthy",
      database: { connected: true, latencyMs: 1 },
      pool: { total: 5, idle: 3, active: 2, waiters: 0 },
    });
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health/ready`,
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "healthy");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "/health/ready returns 503 when DB is unreachable",
  async () => {
    const handler = createHealthyProtocolHandler({
      status: "unhealthy",
      database: { connected: false },
      pool: { total: 0, idle: 0, active: 0, waiters: 0 },
    });
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health/ready`,
      );

      assertEquals(response.status, 503);

      const body = await response.json();
      assertEquals(body.status, "unhealthy");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "/health/ready returns 200 when status is degraded",
  async () => {
    const handler = createHealthyProtocolHandler({
      status: "degraded",
      database: { connected: true, latencyMs: 50 },
      pool: { total: 10, idle: 0, active: 10, waiters: 3 },
    });
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health/ready`,
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "degraded");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "/health returns full status with pool stats",
  async () => {
    const handler = createHealthyProtocolHandler({
      status: "healthy",
      database: { connected: true, latencyMs: 2 },
      pool: { total: 5, idle: 3, active: 2, waiters: 0 },
    });
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health`,
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "healthy");
      assertExists(body.database);
      assertEquals(body.database.connected, true);
      assertEquals(typeof body.database.latencyMs, "number");
      assertExists(body.pool);
      assertEquals(body.pool.total, 5);
      assertEquals(body.pool.idle, 3);
      assertEquals(body.pool.active, 2);
      assertEquals(body.pool.waiters, 0);
      assertExists(body.timestamp);
      assertEquals(typeof body.uptimeMs, "number");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "/health returns degraded when pool has waiters",
  async () => {
    const handler = createHealthyProtocolHandler({
      status: "degraded",
      database: { connected: true, latencyMs: 100 },
      pool: { total: 10, idle: 0, active: 10, waiters: 5 },
    });
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health`,
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "degraded");
      assertEquals(body.pool.waiters, 5);
      assertEquals(body.pool.idle, 0);
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "/health returns 503 when unhealthy",
  async () => {
    const handler = createHealthyProtocolHandler({
      status: "unhealthy",
      database: { connected: false },
      pool: { total: 0, idle: 0, active: 0, waiters: 0 },
    });
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health`,
      );

      assertEquals(response.status, 503);

      const body = await response.json();
      assertEquals(body.status, "unhealthy");
      assertEquals(body.database.connected, false);
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "No pool configured returns healthy status (dev mode)",
  async () => {
    // Handler with checkHealth that returns healthy with no DB info
    // (simulates no pool / dry-run mode)
    const handler = createHealthyProtocolHandler({
      status: "healthy",
    });
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health`,
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "healthy");
      assertEquals(body.database, undefined);
      assertEquals(body.pool, undefined);
      assertExists(body.timestamp);
      assertEquals(typeof body.uptimeMs, "number");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "/health fallback when handler lacks checkHealth",
  async () => {
    // Handler without checkHealth — should fall back to basic healthy
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health`,
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "healthy");
      assertExists(body.timestamp);
      assertEquals(typeof body.uptimeMs, "number");
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "/health/ready fallback when handler lacks checkHealth",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health/ready`,
      );

      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "healthy");
    } finally {
      await cleanup();
    }
  },
);

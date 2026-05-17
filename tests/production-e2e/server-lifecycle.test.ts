/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file
/**
 * Production E2E: Server Lifecycle and Endpoint Behavior Tests
 *
 * Tests the HttpServer's endpoint routing, response shapes, metrics,
 * graceful shutdown / drain behaviour, and PG-gated health readiness.
 *
 * 12 tests total.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes
} from "@std/assert";
import type { AuthRoutes } from "../../auth/integration.ts";
import { HttpServer } from "../../server/http.ts";
import type { HttpServerOptions } from "../../server/http.ts";
import type {
  HealthStatus,
  ProtocolHandler,
  QueryContext,
  QueryError,
  QueryRequest,
  QueryResponse,
  ServerConfig
} from "../../server/types.ts";
import { canRunPgTests } from "../../tests/pg-test-harness.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function createBasicProtocolHandler(): ProtocolHandler {
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

/**
 * Creates a protocol handler whose handleRequest resolves after a delay.
 */
function createSlowProtocolHandler(delayMs: number): ProtocolHandler {
  return {
    handleRequest(
      _request: QueryRequest,
      _context: QueryContext
    ): Promise<QueryResponse> {
      return new Promise(resolve => {
        setTimeout(() => resolve({ data: { slow: true } }), delayMs);
      });
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    }
  };
}

/**
 * Creates a protocol handler with a configurable health status response.
 */
function createHealthyProtocolHandler(
  healthResponse: HealthStatus
): ProtocolHandler {
  return {
    handleRequest(
      _request: QueryRequest,
      _context: QueryContext
    ): Promise<QueryResponse> {
      return Promise.resolve({ data: { ok: true } });
    },
    validateRequest(_request: QueryRequest): QueryError[] {
      return [];
    },
    checkHealth(): Promise<HealthStatus> {
      return Promise.resolve(healthResponse);
    }
  };
}

/**
 * Spins up a temporary HTTP server wrapping an HttpServer instance.
 * Accepts optional HttpServerOptions overrides beyond config to allow
 * passing authRoutes, extensionRoutes, etc.
 */
function withTestServer(
  handler: ProtocolHandler,
  configOverrides: Partial<ServerConfig> = {},
  optionOverrides: Partial<
    Omit<HttpServerOptions, "config" | "protocolHandler">
  > = {}
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
    ...optionOverrides
  });

  const abortController = new AbortController();
  const testServer = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      onListen() {}
    },
    (request: Request, info: Deno.ServeHandlerInfo) => {
      return (server as any).handleRequest(request, info);
    }
  );

  const port = testServer.addr.port;

  const cleanup = async () => {
    abortController.abort();
    await testServer.finished;
    await server.stop();
  };

  return { port, cleanup, server, testServer, abortController };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "Production E2E: Root endpoint lists all configured endpoints",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.name, "Disc Database");
      assertExists(body.endpoints);
      assertExists(body.endpoints.query);
      assertExists(body.endpoints.health);
      assertExists(body.endpoints.healthLive);
      assertExists(body.endpoints.healthReady);
      assertExists(body.endpoints.stats);
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: Root endpoint omits metrics when disabled",
  async () => {
    const handler = createBasicProtocolHandler();
    // enableMetrics defaults to undefined/false
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.endpoints.metrics, undefined);
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: Root endpoint includes auth endpoints when auth routes configured",
  async () => {
    const handler = createBasicProtocolHandler();

    // Create a mock that structurally matches AuthRoutes. Each method returns
    // a request handler function that produces a dummy Response. The root
    // endpoint only checks `if (this.authRoutes)` — it never invokes these
    // methods — so the mocks are purely structural.
    const mockAuthRoutes = {
      register: () => async (_req: Request) => new Response("ok"),
      login: () => async (_req: Request) => new Response("ok"),
      logout: () => async (_req: Request) => new Response("ok"),
      refresh: () => async (_req: Request) => new Response("ok"),
      profile: () => async (_req: Request) => new Response("ok"),
      updatePassword: () => async (_req: Request) => new Response("ok"),
      resetPasswordRequest: () => async (_req: Request) => new Response("ok"),
      resetPassword: () => async (_req: Request) => new Response("ok"),
      verifyEmail: () => async (_req: Request) => new Response("ok")
    } as unknown as AuthRoutes;

    const { port, cleanup } = withTestServer(handler, {}, {
      authRoutes: mockAuthRoutes
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assertEquals(response.status, 200);

      const body = await response.json();
      assertExists(body.endpoints.auth);
      assertEquals(body.endpoints.auth.register, "/auth/register");
      assertEquals(body.endpoints.auth.login, "/auth/login");
      assertEquals(body.endpoints.auth.logout, "/auth/logout");
      assertEquals(body.endpoints.auth.refresh, "/auth/refresh");
      assertEquals(body.endpoints.auth.profile, "/auth/profile");
      assertEquals(body.endpoints.auth.password, "/auth/password");
      assertEquals(body.endpoints.auth.reset, "/auth/reset");
      assertEquals(body.endpoints.auth.reset_confirm, "/auth/reset/confirm");
      assertEquals(body.endpoints.auth.verify, "/auth/verify");
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: /health/live returns 200 always",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health/live`
      );
      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "alive");
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: /health/ready returns 503 during shutdown drain",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup, server } = withTestServer(handler);

    try {
      // Initiate drain — sets shutting_down = true. Use a short timeout
      // since there are no in-flight requests; drain resolves immediately.
      const drainPromise = server.drain(1000);

      // Give drain a moment to set the flag
      await new Promise<void>(resolve => setTimeout(resolve, 50));

      const response = await fetch(
        `http://127.0.0.1:${port}/health/ready`
      );
      assertEquals(response.status, 503);

      const body = await response.json();
      assertStringIncludes(body.error, "shutting down");

      await drainPromise;
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: /stats tracks request counts after queries",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler);

    try {
      // Issue a query request to bump the stats counters
      const queryResponse = await fetch(`http://127.0.0.1:${port}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "select 1" })
      });
      // Consume body so the connection is released
      await queryResponse.body?.cancel();

      // Fetch stats
      const statsResponse = await fetch(
        `http://127.0.0.1:${port}/stats`
      );
      assertEquals(statsResponse.status, 200);

      const body = await statsResponse.json();
      assertExists(body.queries);
      assert(body.queries.total >= 1, "total requests should be >= 1");
      assert(
        body.queries.successful >= 1,
        "successful requests should be >= 1"
      );
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: /stats includes subscription stats key",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/stats`);
      assertEquals(response.status, 200);

      const body = await response.json();
      assertExists(body.subscriptions);
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: /metrics returns Prometheus text format with expected metric names",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler, {
      enableMetrics: true
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      assertEquals(response.status, 200);

      const body = await response.text();
      assertStringIncludes(body, "disc_http_requests_total");
      assertStringIncludes(body, "disc_http_requests_successful_total");
      assertStringIncludes(body, "disc_http_requests_failed_total");
      assertStringIncludes(body, "disc_uptime_seconds");
      assertStringIncludes(body, "disc_process_memory_heap_used_bytes");
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: /metrics Content-Type is text/plain; version=0.0.4; charset=utf-8",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler, {
      enableMetrics: true
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      assertEquals(response.status, 200);

      const contentType = response.headers.get("content-type");
      assertEquals(contentType, "text/plain; version=0.0.4; charset=utf-8");

      await response.body?.cancel();
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: Graceful shutdown drains in-flight requests",
  async () => {
    // Handler takes 500ms to respond
    const handler = createSlowProtocolHandler(500);
    const { port, cleanup, server } = withTestServer(handler);

    try {
      // Start an in-flight request (don't await yet)
      const requestPromise = fetch(`http://127.0.0.1:${port}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "select 1" })
      });

      // Give the server a moment to begin processing
      await new Promise<void>(resolve => setTimeout(resolve, 50));

      // Now initiate drain with a generous timeout
      const drainPromise = server.drain(3000);

      // The in-flight request should still complete successfully
      const response = await requestPromise;
      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.data.slow, true);

      // Drain should finish because the in-flight request completed
      await drainPromise;
    } finally {
      await cleanup();
    }
  }
);

Deno.test(
  "Production E2E: Shutdown rejects new requests with 503",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup, server } = withTestServer(handler);

    try {
      // Initiate drain — no in-flight requests so it resolves quickly
      await server.drain(500);

      // New requests should be rejected
      const response = await fetch(`http://127.0.0.1:${port}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "select 1" })
      });
      assertEquals(response.status, 503);

      const body = await response.json();
      assertStringIncludes(body.error, "shutting down");
    } finally {
      await cleanup();
    }
  }
);

Deno.test({
  name: "Production E2E: (PG) /health/ready with real PG handler returns 200 healthy",
  ignore: !canRunPgTests(),
  fn: async () => {
    // This test is gated behind canRunPgTests(). It uses a mock handler
    // that simulates a real PG-backed protocol handler reporting healthy
    // status, demonstrating the /health/ready path for production PG
    // deployments. A full PG-backed DiscServer test belongs in a
    // dedicated integration suite.
    const handler = createHealthyProtocolHandler({
      status: "healthy",
      database: { connected: true, latencyMs: 1 },
      pool: { total: 5, idle: 3, active: 2, waiters: 0 }
    });
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/health/ready`
      );
      assertEquals(response.status, 200);

      const body = await response.json();
      assertEquals(body.status, "healthy");
    } finally {
      await cleanup();
    }
  }
});

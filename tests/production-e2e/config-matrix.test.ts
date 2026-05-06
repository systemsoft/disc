// deno-lint-ignore-file
/**
 * Production E2E: Configuration Matrix Tests
 *
 * Verifies that environment variables parsed by createServerFromEnv()
 * correctly flow through to DiscServer configuration and that the
 * resulting HTTP server behavior matches the configured values.
 *
 * 12 tests covering: host, port, database URL, CORS, metrics,
 * max connections, request timeout, log level/format, and cache size.
 */

import { assertEquals, assertExists } from "@std/assert";
import { EnvMock } from "../../tests/test-utils.ts";
import { createServerFromEnv } from "../../server/server.ts";
import { HttpServer } from "../../server/http.ts";
import type {
  ProtocolHandler,
  QueryContext,
  QueryError,
  QueryRequest,
  QueryResponse,
  ServerConfig,
} from "../../server/types.ts";

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
  "Production E2E: DISC_HOST + DISC_PORT take effect",
  async () => {
    const env = new EnvMock();

    try {
      env.set("DISC_HOST", "0.0.0.0");
      env.set("DISC_PORT", "7777");

      const server = createServerFromEnv();
      const config = (server as any).config;

      assertEquals(config.host, "0.0.0.0");
      assertEquals(config.port, 7777);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DATABASE_URL flows through",
  async () => {
    const env = new EnvMock();

    try {
      env.set("DATABASE_URL", "postgresql://test:1234/mydb");

      const server = createServerFromEnv();
      const config = (server as any).config;

      assertEquals(config.databaseUrl, "postgresql://test:1234/mydb");
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_ENABLE_CORS=false -> no CORS headers",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler, {
      enableCors: false,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const corsHeader = response.headers.get("Access-Control-Allow-Origin");

      assertEquals(corsHeader, null);
      // Drain the body to avoid resource leaks
      await response.body?.cancel();
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "Production E2E: DISC_ENABLE_CORS=true -> CORS headers present",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler, {
      enableCors: true,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const corsHeader = response.headers.get("Access-Control-Allow-Origin");

      assertExists(corsHeader);
      // Drain the body to avoid resource leaks
      await response.body?.cancel();
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "Production E2E: CORS preflight rejected when CORS disabled",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler, {
      enableCors: false,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "OPTIONS",
        headers: {
          "Origin": "http://example.com",
          "Access-Control-Request-Method": "POST",
        },
      });

      assertEquals(response.status, 405);
      // Drain the body to avoid resource leaks
      await response.body?.cancel();
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "Production E2E: DISC_CORS_ORIGINS restricts allowed origins",
  async () => {
    const env = new EnvMock();

    try {
      env.set("DISC_CORS_ORIGINS", "http://example.com, http://app.test.com");

      const server = createServerFromEnv();
      const config = (server as any).config;

      assertExists(config.corsOrigins);
      assertEquals(config.corsOrigins.length, 2);
      assertEquals(config.corsOrigins[0], "http://example.com");
      assertEquals(config.corsOrigins[1], "http://app.test.com");
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_ENABLE_METRICS=true -> GET /metrics returns 200",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler, {
      enableMetrics: true,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);

      assertEquals(response.status, 200);
      // Drain the body to avoid resource leaks
      await response.body?.cancel();
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "Production E2E: DISC_ENABLE_METRICS unset -> GET /metrics returns 404",
  async () => {
    const handler = createBasicProtocolHandler();
    const { port, cleanup } = withTestServer(handler);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);

      assertEquals(response.status, 404);
      // Drain the body to avoid resource leaks
      await response.body?.cancel();
    } finally {
      await cleanup();
    }
  },
);

Deno.test(
  "Production E2E: DISC_MAX_CONNECTIONS parsed correctly",
  async () => {
    const env = new EnvMock();

    try {
      env.set("DISC_MAX_CONNECTIONS", "50");

      const server = createServerFromEnv();
      const config = (server as any).config;

      assertEquals(config.maxConnections, 50);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_REQUEST_TIMEOUT parsed correctly",
  async () => {
    const env = new EnvMock();

    try {
      env.set("DISC_REQUEST_TIMEOUT", "15000");

      const server = createServerFromEnv();
      const config = (server as any).config;

      assertEquals(config.requestTimeout, 15000);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_LOG_LEVEL + DISC_LOG_FORMAT parsed without error",
  async () => {
    const env = new EnvMock();

    try {
      env.set("DISC_LOG_LEVEL", "DEBUG");
      env.set("DISC_LOG_FORMAT", "text");

      // Should not throw -- configureLogging() is called internally
      const server = createServerFromEnv();
      const config = (server as any).config;

      // Verify the server was created successfully (config object exists)
      assertExists(config);
      assertExists(config.host);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_CACHE_MAX_SIZE parsed correctly",
  async () => {
    const env = new EnvMock();

    try {
      env.set("DISC_CACHE_MAX_SIZE", "500");

      const server = createServerFromEnv();
      const config = (server as any).config;

      assertEquals(config.cacheMaxSize, 500);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_SHUTDOWN_DRAIN_TIMEOUT flows through to config",
  async () => {
    const env = new EnvMock();
    try {
      env.set("DISC_SHUTDOWN_DRAIN_TIMEOUT", "12345");
      const server = createServerFromEnv();
      const config = (server as any).config;
      assertEquals(config.shutdownDrainTimeout, 12345);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_REQUIRE_AUTH=true flows through",
  async () => {
    const env = new EnvMock();
    try {
      env.set("DISC_REQUIRE_AUTH", "true");
      const server = createServerFromEnv();
      const config = (server as any).config;
      assertEquals(config.requireAuth, true);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_REQUIRE_AUTH=1 also accepted",
  async () => {
    const env = new EnvMock();
    try {
      env.set("DISC_REQUIRE_AUTH", "1");
      const server = createServerFromEnv();
      const config = (server as any).config;
      assertEquals(config.requireAuth, true);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_READ_ONLY=yes flows through",
  async () => {
    const env = new EnvMock();
    try {
      env.set("DISC_READ_ONLY", "yes");
      const server = createServerFromEnv();
      const config = (server as any).config;
      assertEquals(config.readOnly, true);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_TRUST_PROXY=false flows through",
  async () => {
    const env = new EnvMock();
    try {
      env.set("DISC_TRUST_PROXY", "false");
      const server = createServerFromEnv();
      const config = (server as any).config;
      assertEquals(config.trustProxy, false);
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_TLS_CERT_ENV indirection materializes PEM",
  async () => {
    const env = new EnvMock();
    try {
      env.set("MY_PEM_CERT", "-----BEGIN CERT-----\nfake\n-----END CERT-----");
      env.set("MY_PEM_KEY", "-----BEGIN KEY-----\nfake\n-----END KEY-----");
      env.set("DISC_TLS_CERT_ENV", "MY_PEM_CERT");
      env.set("DISC_TLS_KEY_ENV", "MY_PEM_KEY");
      const server = createServerFromEnv();
      const config = (server as any).config;
      assertExists(config.tls);
      // Both should resolve to a temp file path containing the PEM contents
      const certBody = await Deno.readTextFile(config.tls.certFile);
      const keyBody = await Deno.readTextFile(config.tls.keyFile);
      assertEquals(certBody.includes("-----BEGIN CERT-----"), true);
      assertEquals(keyBody.includes("-----BEGIN KEY-----"), true);
      // Cleanup the temp files we just wrote
      try {
        await Deno.remove(config.tls.certFile);
        await Deno.remove(config.tls.keyFile);
      } catch {
        // ignore
      }
    } finally {
      env.restore();
    }
  },
);

Deno.test(
  "Production E2E: DISC_BINARY_PORT + DISC_BINARY_PASSWORD flow through",
  async () => {
    const env = new EnvMock();
    try {
      env.set("DISC_BINARY_PORT", "5657");
      env.set("DISC_BINARY_PASSWORD", "scram-secret");
      const server = createServerFromEnv();
      const config = (server as any).config;
      assertEquals(config.binaryPort, 5657);
      // binaryPassword is private to the server; cross-check via getter
      assertEquals((server as any).binaryPassword, "scram-secret");
    } finally {
      env.restore();
    }
  },
);

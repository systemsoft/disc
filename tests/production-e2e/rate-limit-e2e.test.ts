import { assertEquals } from "@std/assert";
import { HttpServer } from "../../server/http.ts";
import type {
  ProtocolHandler,
  QueryContext,
  QueryError,
  QueryRequest,
  QueryResponse,
  ServerConfig,
} from "../../server/types.ts";

function createTestConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
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
) {
  const config = createTestConfig(configOverrides);
  const server = new HttpServer({ config, protocolHandler: handler });
  const abortController = new AbortController();
  const testServer = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abortController.signal,
      onListen() {},
    },
    (request, info) => (server as any).handleRequest(request, info),
  );
  const port = testServer.addr.port;
  const cleanup = async () => {
    abortController.abort();
    await testServer.finished;
    await server.stop();
  };
  return { port, cleanup, server, testServer, abortController };
}

Deno.test("Production E2E: Requests within burst all return 200", async () => {
  const handler = createBasicProtocolHandler();
  const { port, cleanup } = withTestServer(handler, {
    rateLimitRpm: 60,
    rateLimitBurst: 5,
  });

  try {
    for (let i = 0; i < 5; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assertEquals(response.status, 200);
      await response.body?.cancel();
    }
  } finally {
    await cleanup();
  }
});

Deno.test("Production E2E: Requests over burst return 429", async () => {
  const handler = createBasicProtocolHandler();
  const { port, cleanup } = withTestServer(handler, {
    rateLimitRpm: 60,
    rateLimitBurst: 3,
  });

  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assertEquals(response.status, 200);
      await response.body?.cancel();
    }

    const response = await fetch(`http://127.0.0.1:${port}/`);
    assertEquals(response.status, 429);
    await response.body?.cancel();
  } finally {
    await cleanup();
  }
});

Deno.test("Production E2E: 429 includes Retry-After header", async () => {
  const handler = createBasicProtocolHandler();
  const { port, cleanup } = withTestServer(handler, {
    rateLimitRpm: 60,
    rateLimitBurst: 3,
  });

  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.body?.cancel();
    }

    const response = await fetch(`http://127.0.0.1:${port}/`);
    assertEquals(response.status, 429);
    assertEquals(response.headers.get("Retry-After"), "60");
    await response.body?.cancel();
  } finally {
    await cleanup();
  }
});

Deno.test("Production E2E: 429 body has error message", async () => {
  const handler = createBasicProtocolHandler();
  const { port, cleanup } = withTestServer(handler, {
    rateLimitRpm: 60,
    rateLimitBurst: 3,
  });

  try {
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      await response.body?.cancel();
    }

    const response = await fetch(`http://127.0.0.1:${port}/`);
    assertEquals(response.status, 429);
    const body = await response.json();
    assertEquals(body.error, "Rate limit exceeded");
  } finally {
    await cleanup();
  }
});

Deno.test("Production E2E: Rate limit stats reflected in /stats", async () => {
  const handler = createBasicProtocolHandler();
  const { port, cleanup } = withTestServer(handler, {
    rateLimitRpm: 60,
    rateLimitBurst: 2,
  });

  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assertEquals(response.status, 200);
      await response.body?.cancel();
    }

    const rejected = await fetch(`http://127.0.0.1:${port}/`);
    assertEquals(rejected.status, 429);
    await rejected.body?.cancel();

    // Wait for token refill (RPM 60 = 1 token/sec)
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const statsResponse = await fetch(`http://127.0.0.1:${port}/stats`);
    assertEquals(statsResponse.status, 200);
    const body = await statsResponse.json();
    assertEquals(body.rateLimit.rejectedCount >= 1, true);
  } finally {
    await cleanup();
  }
});

Deno.test({
  name: "Production E2E: No rate limiter when rateLimitRpm is 0",
  sanitizeResources: false,
  fn: async () => {
  const handler = createBasicProtocolHandler();
  const { port, cleanup } = withTestServer(handler, {
    rateLimitRpm: 0,
  });

  try {
    for (let i = 0; i < 20; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      assertEquals(response.status, 200);
      await response.body?.cancel();
    }
  } finally {
    await cleanup();
  }
  },
});

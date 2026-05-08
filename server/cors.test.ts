/**
 * Tests for CORS origin restriction (P0-07).
 *
 * Before the fix, `get_default_headers()` hardcoded `Access-Control-Allow-Origin: *`
 * regardless of `corsOrigins` config. These tests lock in that (a) unlisted
 * origins don't receive CORS headers when an allowlist is set, (b) listed
 * origins are echoed, and (c) preflight requests from unlisted origins are
 * rejected with 403 instead of being falsely allowed.
 */

import { assertEquals } from "@std/assert";
import { HttpServer } from "./http.ts";
import type { HealthStatus, ProtocolHandler, QueryContext, QueryError, QueryRequest, QueryResponse, ServerConfig } from "./types.ts";

function basicHandler(): ProtocolHandler {
  return {
    handleRequest(
      _req: QueryRequest,
      _ctx: QueryContext
    ): Promise<QueryResponse> {
      return Promise.resolve({ data: { ok: true } });
    },
    validateRequest(_req: QueryRequest): QueryError[] {
      return [];
    },
    checkHealth(): Promise<HealthStatus> {
      return Promise.resolve({
        status: "healthy",
        timestamp: new Date().toISOString()
      });
    },
    getPoolStats() {
      return null;
    }
  };
}

function withCorsServer(overrides: Partial<ServerConfig> = {}): {
  port: number;
  cleanup: () => Promise<void>;
} {
  const config: ServerConfig = {
    host: "localhost",
    port: 0,
    databaseUrl: "postgresql://localhost:5432/test",
    maxConnections: 10,
    requestTimeout: 5000,
    enableCors: true,
    enableWebsockets: false,
    ...overrides
  };
  const server = new HttpServer({ config, protocolHandler: basicHandler() });
  const abort = new AbortController();
  const testServer = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: abort.signal,
      onListen() {}
    },
    (request: Request, info: Deno.ServeHandlerInfo) =>
      // deno-lint-ignore no-explicit-any
      (server as any).handleRequest(request, info)
  );
  return {
    port: testServer.addr.port,
    cleanup: async () => {
      abort.abort();
      await testServer.finished;
      await server.stop();
    }
  };
}

Deno.test("CORS — allowlisted origin is echoed back", async () => {
  const { port, cleanup } = withCorsServer({
    corsOrigins: ["https://app.example.com"]
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://app.example.com" }
    });
    await res.body?.cancel();
    assertEquals(
      res.headers.get("Access-Control-Allow-Origin"),
      "https://app.example.com"
    );
  } finally {
    await cleanup();
  }
});

Deno.test("CORS — unlisted origin receives NO Access-Control-Allow-Origin header", async () => {
  const { port, cleanup } = withCorsServer({
    corsOrigins: ["https://app.example.com"]
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://evil.example.com" }
    });
    await res.body?.cancel();
    // The critical assertion: previously the server emitted "*" here,
    // effectively bypassing the allowlist. Now it must emit no CORS header.
    assertEquals(
      res.headers.get("Access-Control-Allow-Origin"),
      null,
      "Unlisted origin must NOT receive a CORS header"
    );
  } finally {
    await cleanup();
  }
});

Deno.test("CORS — preflight from unlisted origin is rejected (403)", async () => {
  const { port, cleanup } = withCorsServer({
    corsOrigins: ["https://app.example.com"]
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/query`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "POST"
      }
    });
    await res.body?.cancel();
    assertEquals(res.status, 403);
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), null);
  } finally {
    await cleanup();
  }
});

Deno.test("CORS — permissive mode (no corsOrigins set) keeps '*' for dev backward-compat", async () => {
  const { port, cleanup } = withCorsServer({}); // no corsOrigins
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://any.example.com" }
    });
    await res.body?.cancel();
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  } finally {
    await cleanup();
  }
});

// =========================================================================
// Wildcard subdomain matching (#6655)
// =========================================================================

Deno.test("CORS — wildcard `*.example.com` accepts one-label subdomain", async () => {
  const { port, cleanup } = withCorsServer({
    corsOrigins: ["https://*.example.com"]
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://tenant1.example.com" }
    });
    await res.body?.cancel();
    assertEquals(
      res.headers.get("Access-Control-Allow-Origin"),
      "https://tenant1.example.com"
    );
  } finally {
    await cleanup();
  }
});

Deno.test("CORS — wildcard `*.example.com` rejects two-label subdomain", async () => {
  const { port, cleanup } = withCorsServer({
    corsOrigins: ["https://*.example.com"]
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://a.b.example.com" }
    });
    await res.body?.cancel();
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), null);
  } finally {
    await cleanup();
  }
});

// =========================================================================
// Configurable methods/headers/credentials/expose/max-age (#6655)
// =========================================================================

Deno.test("CORS — preflight uses configured methods + headers + max-age", async () => {
  const { port, cleanup } = withCorsServer({
    corsOrigins: ["https://app.example.com"],
    corsAllowedMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    corsAllowedHeaders: ["Content-Type", "Authorization", "X-Tenant-Id"],
    corsMaxAge: 600
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/query`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "PATCH"
      }
    });
    await res.body?.cancel();
    assertEquals(res.status, 204);
    assertEquals(
      res.headers.get("Access-Control-Allow-Methods"),
      "GET, POST, PATCH, DELETE, OPTIONS"
    );
    assertEquals(
      res.headers.get("Access-Control-Allow-Headers"),
      "Content-Type, Authorization, X-Tenant-Id"
    );
    assertEquals(res.headers.get("Access-Control-Max-Age"), "600");
  } finally {
    await cleanup();
  }
});

Deno.test("CORS — `corsAllowCredentials: true` emits credentials header for allowlisted origin", async () => {
  const { port, cleanup } = withCorsServer({
    corsOrigins: ["https://app.example.com"],
    corsAllowCredentials: true
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://app.example.com" }
    });
    await res.body?.cancel();
    assertEquals(
      res.headers.get("Access-Control-Allow-Credentials"),
      "true"
    );
  } finally {
    await cleanup();
  }
});

Deno.test("CORS — credentials header NOT emitted with permissive `*` origin", async () => {
  // Spec forbids `Access-Control-Allow-Credentials: true` together with
  // `Access-Control-Allow-Origin: *`. The server must drop credentials.
  const { port, cleanup } = withCorsServer({
    corsAllowCredentials: true
    // no corsOrigins — permissive mode
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://any.example.com" }
    });
    await res.body?.cancel();
    assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
    assertEquals(res.headers.get("Access-Control-Allow-Credentials"), null);
  } finally {
    await cleanup();
  }
});

Deno.test("CORS — `corsExposeHeaders` emits expose-headers list", async () => {
  const { port, cleanup } = withCorsServer({
    corsOrigins: ["https://app.example.com"],
    corsExposeHeaders: ["X-Request-Id", "X-Trace-Id"]
  });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: "https://app.example.com" }
    });
    await res.body?.cancel();
    assertEquals(
      res.headers.get("Access-Control-Expose-Headers"),
      "X-Request-Id, X-Trace-Id"
    );
  } finally {
    await cleanup();
  }
});

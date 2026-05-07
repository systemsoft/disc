/**
 * Tests for `config.requireAuth` — global auth gate on the HTTP server.
 * Ports geldata/gel#6352 (gh/geldata#6345).
 *
 * Uses TestDatabase (no PostgreSQL required).
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AuthRoutes } from "../auth/integration.ts";
import { AuthMiddleware } from "../auth/middleware.ts";
import { AuthProvider } from "../auth/provider.ts";
import { TestDatabase } from "../auth/test-database.ts";
import { HttpServer } from "./http.ts";

const TEST_HOST = "127.0.0.1";
const TEST_JWT_SECRET = "require-auth-test-secret-32bytes-min";

let nextPort = 18500;
function pickPort(): number {
  return nextPort++;
}

async function buildServer(opts: {
  port: number;
  requireAuth: boolean;
  withMiddleware?: boolean;
}): Promise<{
  server: HttpServer;
  provider: AuthProvider;
  middleware: AuthMiddleware;
  db: TestDatabase;
}> {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider({ jwtSecret: TEST_JWT_SECRET }, db);
  await provider.initialize();
  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware);

  const server = new HttpServer({
    config: {
      host: TEST_HOST,
      port: opts.port,
      databaseUrl: "postgresql://localhost:5432/test",
      maxConnections: 10,
      requestTimeout: 5000,
      enableCors: true,
      enableWebsockets: false,
      jwtSecret: TEST_JWT_SECRET,
      enableAuth: true,
      requireAuth: opts.requireAuth,
    },
    protocolHandler: {
      handleRequest: () => Promise.resolve({ data: { result: "ok" } }),
      validateRequest: () => [],
    },
    authProvider: provider,
    ...(opts.withMiddleware === false ? {} : {
      authMiddleware: middleware,
      authRoutes: routes,
    }),
  });

  return { server, provider, middleware, db };
}

async function startAndWait(server: HttpServer): Promise<void> {
  // Fire start without awaiting (it never returns until stop).
  void server.start();
  await new Promise((r) => setTimeout(r, 150));
}

// ── requireAuth=false (default) — backwards compat ─────────────────────

Deno.test("requireAuth=false — /query reachable without token (backwards compat)", async () => {
  const port = pickPort();
  const { server, db } = await buildServer({ port, requireAuth: false });
  await startAndWait(server);

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SELECT 1" }),
    });
    // Status doesn't matter — just that auth didn't reject it (not 401/503).
    assertEquals(res.status === 401 || res.status === 503, false);
    await res.body?.cancel();
  } finally {
    await server.stop();
    await db.close();
  }
});

// ── requireAuth=true — protected routes ────────────────────────────────

Deno.test("requireAuth=true — /query rejects unauthenticated request with 401", async () => {
  const port = pickPort();
  const { server, db } = await buildServer({ port, requireAuth: true });
  await startAndWait(server);

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SELECT 1" }),
    });

    assertEquals(res.status, 401);
    const wwwAuth = res.headers.get("WWW-Authenticate");
    assertEquals(wwwAuth, "Bearer realm=\"disc\"");
    const body = await res.json();
    assertEquals(body.error, "Authentication required");
  } finally {
    await server.stop();
    await db.close();
  }
});

Deno.test("requireAuth=true — /query accepts a valid Bearer token", async () => {
  const port = pickPort();
  const { server, provider, db } = await buildServer({
    port,
    requireAuth: true,
  });
  await startAndWait(server);

  try {
    const auth = await provider.register({
      email: "alice@test.com",
      password: "password123",
    });

    const res = await fetch(`http://${TEST_HOST}:${port}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${auth.token}`,
      },
      body: JSON.stringify({ query: "SELECT 1" }),
    });

    // Pass = anything that isn't the auth-gate's rejection.
    assertEquals(res.status === 401, false);
    assertEquals(res.status === 503, false);
    await res.body?.cancel();
  } finally {
    await server.stop();
    await db.close();
  }
});

Deno.test("requireAuth=true — /query rejects an invalid Bearer token with 401", async () => {
  const port = pickPort();
  const { server, db } = await buildServer({ port, requireAuth: true });
  await startAndWait(server);

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer not-a-real-jwt",
      },
      body: JSON.stringify({ query: "SELECT 1" }),
    });

    assertEquals(res.status, 401);
    await res.body?.cancel();
  } finally {
    await server.stop();
    await db.close();
  }
});

// ── requireAuth=true — public routes stay public ───────────────────────

Deno.test("requireAuth=true — /health/live still reachable without token", async () => {
  const port = pickPort();
  const { server, db } = await buildServer({ port, requireAuth: true });
  await startAndWait(server);

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/health/live`);
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    await server.stop();
    await db.close();
  }
});

Deno.test("requireAuth=true — /auth/login still reachable without token", async () => {
  const port = pickPort();
  const { server, db } = await buildServer({ port, requireAuth: true });
  await startAndWait(server);

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@x.com", password: "wrong" }),
    });
    // 401 from the auth route itself is fine — what matters is the auth
    // gate didn't intercept (no WWW-Authenticate Bearer challenge).
    assertEquals(res.headers.get("WWW-Authenticate"), null);
    assertExists(await res.text());
  } finally {
    await server.stop();
    await db.close();
  }
});

Deno.test("requireAuth=true — root endpoint still reachable without token", async () => {
  const port = pickPort();
  const { server, db } = await buildServer({ port, requireAuth: true });
  await startAndWait(server);

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/`);
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    await server.stop();
    await db.close();
  }
});

// ── requireAuth=true with no middleware — fail loud ────────────────────

Deno.test("requireAuth=true with no authMiddleware — returns 503 on protected route", async () => {
  const port = pickPort();
  const db = new TestDatabase();
  await db.connect();

  const server = new HttpServer({
    config: {
      host: TEST_HOST,
      port,
      databaseUrl: "postgresql://localhost:5432/test",
      maxConnections: 10,
      requestTimeout: 5000,
      enableCors: true,
      enableWebsockets: false,
      requireAuth: true,
    },
    protocolHandler: {
      handleRequest: () => Promise.resolve({ data: { result: "ok" } }),
      validateRequest: () => [],
    },
  });

  await startAndWait(server);

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SELECT 1" }),
    });

    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(
      body.error,
      "Authentication required but auth provider not configured",
    );
  } finally {
    await server.stop();
    await db.close();
  }
});

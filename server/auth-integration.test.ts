/**
 * Server Auth Integration Tests
 *
 * Tests that auth routes work when configured and return 404 when not configured.
 * Uses TestDatabase for unit testing without PostgreSQL.
 */

import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AuthProvider } from "../auth/provider.ts";
import { AuthMiddleware } from "../auth/middleware.ts";
import { AuthRoutes } from "../auth/integration.ts";
import { TestDatabase } from "../auth/test-database.ts";
import { HttpServer } from "./http.ts";

const TEST_PORT = 19876; // High port unlikely to conflict
const TEST_HOST = "127.0.0.1";
const TEST_JWT_SECRET = "test-secret-key-for-integration-tests";

/** Create a minimal HttpServer with auth configured */
async function createAuthServer(): Promise<{
  server: HttpServer;
  provider: AuthProvider;
  db: TestDatabase;
  port: number;
}> {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider(
    { jwt_secret: TEST_JWT_SECRET },
    db,
  );
  await provider.initialize();

  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware);

  // Find an available port
  const port = TEST_PORT + Math.floor(Math.random() * 1000);

  const server = new HttpServer({
    config: {
      host: TEST_HOST,
      port,
      database_url: "postgresql://localhost:5432/test",
      max_connections: 10,
      request_timeout: 5000,
      enable_cors: true,
      enable_websockets: false,
      jwt_secret: TEST_JWT_SECRET,
      enable_auth: true,
    },
    protocol_handler: {
      handle_request: async () => ({ data: { result: "ok" } }),
      validate_request: () => [],
    },
    auth_provider: provider,
    auth_middleware: middleware,
    auth_routes: routes,
  });

  return { server, provider, db, port };
}

/** Create a minimal HttpServer WITHOUT auth configured */
function createNoAuthServer(port: number): HttpServer {
  return new HttpServer({
    config: {
      host: TEST_HOST,
      port,
      database_url: "postgresql://localhost:5432/test",
      max_connections: 10,
      request_timeout: 5000,
      enable_cors: true,
      enable_websockets: false,
    },
    protocol_handler: {
      handle_request: async () => ({ data: { result: "ok" } }),
      validate_request: () => [],
    },
  });
}

// --- Auth disabled tests ---

Deno.test("auth routes return 404 when auth not configured", async () => {
  const port = TEST_PORT + Math.floor(Math.random() * 1000) + 1000;
  const server = createNoAuthServer(port);

  // Start server in background
  const serverPromise = server.start();

  // Wait for server to start
  await new Promise((r) => setTimeout(r, 200));

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@test.com",
        password: "password123",
      }),
    });

    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Authentication not configured");
  } finally {
    await server.stop();
  }
});

Deno.test("root endpoint excludes auth when not configured", async () => {
  const port = TEST_PORT + Math.floor(Math.random() * 1000) + 2000;
  const server = createNoAuthServer(port);

  const serverPromise = server.start();
  await new Promise((r) => setTimeout(r, 200));

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.endpoints.auth, undefined);
  } finally {
    await server.stop();
  }
});

// --- Auth enabled tests ---

Deno.test("root endpoint includes auth endpoints when configured", async () => {
  const { server, db, port } = await createAuthServer();

  const serverPromise = server.start();
  await new Promise((r) => setTimeout(r, 200));

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.endpoints.auth);
    assertEquals(body.endpoints.auth.register, "/auth/register");
    assertEquals(body.endpoints.auth.login, "/auth/login");
    assertEquals(body.endpoints.auth.logout, "/auth/logout");
    assertEquals(body.endpoints.auth.profile, "/auth/profile");
  } finally {
    await server.stop();
    await db.close();
  }
});

Deno.test("register and login flow via HTTP", async () => {
  const { server, db, port } = await createAuthServer();

  const serverPromise = server.start();
  await new Promise((r) => setTimeout(r, 200));

  try {
    // Register
    const registerRes = await fetch(`http://${TEST_HOST}:${port}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "newuser@test.com",
        password: "password123",
      }),
    });

    assertEquals(registerRes.status, 201);
    const registerBody = await registerRes.json();
    assertExists(registerBody.token);
    assertExists(registerBody.user);
    assertEquals(registerBody.user.email, "newuser@test.com");

    // Login
    const loginRes = await fetch(`http://${TEST_HOST}:${port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "newuser@test.com",
        password: "password123",
      }),
    });

    assertEquals(loginRes.status, 200);
    const loginBody = await loginRes.json();
    assertExists(loginBody.token);
    assertEquals(loginBody.user.email, "newuser@test.com");
  } finally {
    await server.stop();
    await db.close();
  }
});

Deno.test({
  name: "profile requires authentication",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { server, db, port } = await createAuthServer();

    const serverPromise = server.start();
    await new Promise((r) => setTimeout(r, 200));

    try {
      // Profile without token should fail
      const noAuthRes = await fetch(`http://${TEST_HOST}:${port}/auth/profile`);
      assertEquals(noAuthRes.status, 401);
      await noAuthRes.text(); // consume body

      // Register to get a token
      const registerRes = await fetch(`http://${TEST_HOST}:${port}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "authuser@test.com",
          password: "password123",
        }),
      });

      const registerBody = await registerRes.json();
      const token = registerBody.token;
      assertExists(token);

      // Profile with token should work
      const profileRes = await fetch(`http://${TEST_HOST}:${port}/auth/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      assertEquals(profileRes.status, 200);
      const profile = await profileRes.json();
      assertEquals(profile.email, "authuser@test.com");
    } finally {
      await server.stop();
      await db.close();
    }
  },
});

Deno.test({
  name: "query endpoint populates AuthContext with valid token",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let capturedContext: any = null;

    const db = new TestDatabase();
    await db.connect();

    const provider = new AuthProvider(
      { jwt_secret: TEST_JWT_SECRET },
      db,
    );
    await provider.initialize();

    const middleware = new AuthMiddleware(provider);
    const routes = new AuthRoutes(provider, middleware);

    const port = TEST_PORT + Math.floor(Math.random() * 1000) + 5000;

    const server = new HttpServer({
      config: {
        host: TEST_HOST,
        port,
        database_url: "postgresql://localhost:5432/test",
        max_connections: 10,
        request_timeout: 5000,
        enable_cors: true,
        enable_websockets: false,
        jwt_secret: TEST_JWT_SECRET,
        enable_auth: true,
      },
      protocol_handler: {
        handle_request: async (_req: any, ctx: any) => {
          capturedContext = ctx;
          return { data: { result: "ok" } };
        },
        validate_request: () => [],
      },
      auth_provider: provider,
      auth_middleware: middleware,
      auth_routes: routes,
    });

    const serverPromise = server.start();
    await new Promise((r) => setTimeout(r, 200));

    try {
      // Register to get a token
      const registerRes = await fetch(`http://${TEST_HOST}:${port}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "queryuser@test.com",
          password: "password123",
        }),
      });

      const registerBody = await registerRes.json();
      const token = registerBody.token;

      // Query with token
      const queryRes = await fetch(`http://${TEST_HOST}:${port}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: "SELECT User { name }" }),
      });

      assertEquals(queryRes.status, 200);
      await queryRes.json();

      // Verify AuthContext was populated
      assertExists(capturedContext);
      assertExists(capturedContext.auth.user_id);
      assertExists(capturedContext.auth.jwt_claims);
      assertEquals(capturedContext.auth.jwt_claims.email, "queryuser@test.com");
    } finally {
      await server.stop();
      await db.close();
    }
  },
});

Deno.test("query endpoint works without token (optional auth)", async () => {
  const { server, db, port } = await createAuthServer();

  const serverPromise = server.start();
  await new Promise((r) => setTimeout(r, 200));

  try {
    const queryRes = await fetch(`http://${TEST_HOST}:${port}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SELECT User { name }" }),
    });

    assertEquals(queryRes.status, 200);
    const body = await queryRes.json();
    assertEquals(body.data.result, "ok");
  } finally {
    await server.stop();
    await db.close();
  }
});

Deno.test("unknown auth endpoint returns 404", async () => {
  const { server, db, port } = await createAuthServer();

  const serverPromise = server.start();
  await new Promise((r) => setTimeout(r, 200));

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/auth/nonexistent`, {
      method: "POST",
    });

    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Unknown auth endpoint");
  } finally {
    await server.stop();
    await db.close();
  }
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Server Auth Integration Tests
 *
 * Tests that auth routes work when configured and return 404 when not configured.
 * Uses TestDatabase for unit testing without PostgreSQL.
 */

import {
  assertEquals,
  assertExists
} from "@std/assert";
import { AuthRoutes } from "../auth/integration.ts";
import { AuthMiddleware } from "../auth/middleware.ts";
import { AuthProvider } from "../auth/provider.ts";
import { TestDatabase } from "../auth/test-database.ts";
import { HttpServer } from "./http.ts";

const TEST_HOST = "127.0.0.1";
const TEST_JWT_SECRET = "test-secret-key-for-integration-tests";

/** Create a minimal HttpServer with auth configured */
async function createAuthServer(): Promise<{
  server: HttpServer;
  provider: AuthProvider;
  db: TestDatabase;
}> {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider(
    { jwtSecret: TEST_JWT_SECRET },
    db
  );
  await provider.initialize();

  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware);

  const server = new HttpServer({
    config: {
      host: TEST_HOST,
      // OS-assigned free port; read `server.boundPort` after start() to
      // learn it. Avoids AddrInUse flakes from random fixed ports.
      port: 0,
      databaseUrl: "postgresql://localhost:5432/test",
      maxConnections: 10,
      requestTimeout: 5000,
      enableCors: true,
      enableWebsockets: false,
      jwtSecret: TEST_JWT_SECRET,
      enableAuth: true
    },
    protocolHandler: {
      handleRequest: () => Promise.resolve({ data: { result: "ok" } }),
      validateRequest: () => []
    },
    authProvider: provider,
    authMiddleware: middleware,
    authRoutes: routes
  });

  return { server, provider, db };
}

/** Create a minimal HttpServer WITHOUT auth configured */
function createNoAuthServer(): HttpServer {
  return new HttpServer({
    config: {
      host: TEST_HOST,
      port: 0,
      databaseUrl: "postgresql://localhost:5432/test",
      maxConnections: 10,
      requestTimeout: 5000,
      enableCors: true,
      enableWebsockets: false
    },
    protocolHandler: {
      handleRequest: () => Promise.resolve({ data: { result: "ok" } }),
      validateRequest: () => []
    }
  });
}

// --- Auth disabled tests ---

Deno.test("auth routes return 404 when auth not configured", async () => {
  const server = createNoAuthServer();

  // Start server in background
  void server.start();

  // Wait for server to start
  await new Promise(r => setTimeout(r, 200));
  const port = server.boundPort;

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "test@test.com",
        password: "password123"
      })
    });

    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Authentication not configured");
  } finally {
    await server.stop();
  }
});

Deno.test("root endpoint excludes auth when not configured", async () => {
  const server = createNoAuthServer();

  void server.start();
  await new Promise(r => setTimeout(r, 200));
  const port = server.boundPort;

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
  const { server, db } = await createAuthServer();

  void server.start();
  await new Promise(r => setTimeout(r, 200));
  const port = server.boundPort;

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
  const { server, db } = await createAuthServer();

  void server.start();
  await new Promise(r => setTimeout(r, 200));
  const port = server.boundPort;

  try {
    // Register
    const registerRes = await fetch(
      `http://${TEST_HOST}:${port}/auth/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "newuser@test.com",
          password: "password123"
        })
      }
    );

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
        password: "password123"
      })
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
    const { server, db } = await createAuthServer();

    void server.start();
    await new Promise(r => setTimeout(r, 200));
    const port = server.boundPort;

    try {
      // Profile without token should fail
      const noAuthRes = await fetch(`http://${TEST_HOST}:${port}/auth/profile`);
      assertEquals(noAuthRes.status, 401);
      await noAuthRes.text(); // consume body

      // Register to get a token
      const registerRes = await fetch(
        `http://${TEST_HOST}:${port}/auth/register`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "authuser@test.com",
            password: "password123"
          })
        }
      );

      const registerBody = await registerRes.json();
      const token = registerBody.token;
      assertExists(token);

      // Profile with token should work
      const profileRes = await fetch(
        `http://${TEST_HOST}:${port}/auth/profile`,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );

      assertEquals(profileRes.status, 200);
      const profile = await profileRes.json();
      assertEquals(profile.email, "authuser@test.com");
    } finally {
      await server.stop();
      await db.close();
    }
  }
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
      { jwtSecret: TEST_JWT_SECRET },
      db
    );
    await provider.initialize();

    const middleware = new AuthMiddleware(provider);
    const routes = new AuthRoutes(provider, middleware);

    const server = new HttpServer({
      config: {
        host: TEST_HOST,
        port: 0,
        databaseUrl: "postgresql://localhost:5432/test",
        maxConnections: 10,
        requestTimeout: 5000,
        enableCors: true,
        enableWebsockets: false,
        jwtSecret: TEST_JWT_SECRET,
        enableAuth: true
      },
      protocolHandler: {
        handleRequest: (_req: any, ctx: any) => {
          capturedContext = ctx;
          return Promise.resolve({ data: { result: "ok" } });
        },
        validateRequest: () => []
      },
      authProvider: provider,
      authMiddleware: middleware,
      authRoutes: routes
    });

    void server.start();
    await new Promise(r => setTimeout(r, 200));
    const port = server.boundPort;

    try {
      // Register to get a token
      const registerRes = await fetch(
        `http://${TEST_HOST}:${port}/auth/register`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "queryuser@test.com",
            password: "password123"
          })
        }
      );

      const registerBody = await registerRes.json();
      const token = registerBody.token;

      // Query with token
      const queryRes = await fetch(`http://${TEST_HOST}:${port}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ query: "SELECT User { name }" })
      });

      assertEquals(queryRes.status, 200);
      await queryRes.json();

      // Verify AuthContext was populated
      assertExists(capturedContext);
      assertExists(capturedContext.auth.userId);
      assertExists(capturedContext.auth.jwtClaims);
      assertEquals(capturedContext.auth.jwtClaims.email, "queryuser@test.com");
    } finally {
      await server.stop();
      await db.close();
    }
  }
});

Deno.test("query endpoint works without token (optional auth)", async () => {
  const { server, db } = await createAuthServer();

  void server.start();
  await new Promise(r => setTimeout(r, 200));
  const port = server.boundPort;

  try {
    const queryRes = await fetch(`http://${TEST_HOST}:${port}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SELECT User { name }" })
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
  const { server, db } = await createAuthServer();

  void server.start();
  await new Promise(r => setTimeout(r, 200));
  const port = server.boundPort;

  try {
    const res = await fetch(`http://${TEST_HOST}:${port}/auth/nonexistent`, {
      method: "POST"
    });

    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Unknown auth endpoint");
  } finally {
    await server.stop();
    await db.close();
  }
});

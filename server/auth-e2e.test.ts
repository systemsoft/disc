/**
 * Server Auth End-to-End Tests
 *
 * Full HTTP flow: register -> login -> profile -> query with token -> logout
 * Uses TestDatabase (no PG required) to test the complete server auth pipeline.
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

const TEST_HOST = "127.0.0.1";
// 32+ bytes required by AuthProvider (P3-04 hardening).
const TEST_JWT_SECRET = "e2e-test-secret-key-with-enough-entropy-32b";

function getRandomPort(): number {
  return 30000 + Math.floor(Math.random() * 5000);
}

async function createE2EServer(port: number): Promise<{
  server: HttpServer;
  db: TestDatabase;
  capturedContexts: any[];
}> {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider(
    { jwtSecret: TEST_JWT_SECRET },
    db,
  );
  await provider.initialize();

  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware);

  const capturedContexts: any[] = [];

  const server = new HttpServer({
    config: {
      host: TEST_HOST,
      port,
      databaseUrl: "postgresql://localhost:5432/test",
      maxConnections: 10,
      requestTimeout: 5000,
      enableCors: true,
      enableWebsockets: false,
      jwtSecret: TEST_JWT_SECRET,
      enableAuth: true,
    },
    protocolHandler: {
      handleRequest: (_req: any, ctx: any) => {
        capturedContexts.push(ctx);
        return Promise.resolve({ data: { result: "ok" } });
      },
      validateRequest: () => [],
    },
    authProvider: provider,
    authMiddleware: middleware,
    authRoutes: routes,
  });

  return { server, db, capturedContexts };
}

Deno.test({
  name:
    "E2E: full auth lifecycle - register -> login -> profile -> query -> logout",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = getRandomPort();
    const { server, db, capturedContexts } = await createE2EServer(port);
    const base = `http://${TEST_HOST}:${port}`;

    void server.start();
    await new Promise((r) => setTimeout(r, 200));

    try {
      // 1. Register
      const registerRes = await fetch(`${base}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "e2e@test.com",
          password: "testpassword123",
          username: "e2euser",
        }),
      });
      assertEquals(registerRes.status, 201);
      const registerBody = await registerRes.json();
      assertExists(registerBody.token);
      assertExists(registerBody.refreshToken);
      assertEquals(registerBody.user.email, "e2e@test.com");
      assertEquals(registerBody.user.username, "e2euser");

      const refreshToken = registerBody.refreshToken;

      // 2. Login (separate flow)
      const loginRes = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "e2e@test.com",
          password: "testpassword123",
        }),
      });
      assertEquals(loginRes.status, 200);
      const loginBody = await loginRes.json();
      assertExists(loginBody.token);
      assertEquals(loginBody.user.email, "e2e@test.com");

      const loginToken = loginBody.token;

      // 3. Profile with token
      const profileRes = await fetch(`${base}/auth/profile`, {
        headers: { Authorization: `Bearer ${loginToken}` },
      });
      assertEquals(profileRes.status, 200);
      const profileBody = await profileRes.json();
      assertEquals(profileBody.email, "e2e@test.com");
      assertEquals(profileBody.username, "e2euser");

      // 4. Query with token (verifies AuthContext population)
      const queryRes = await fetch(`${base}/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${loginToken}`,
        },
        body: JSON.stringify({ query: "SELECT User { name }" }),
      });
      assertEquals(queryRes.status, 200);
      await queryRes.json();

      // Verify captured AuthContext
      assertEquals(capturedContexts.length, 1);
      assertExists(capturedContexts[0].auth.userId);
      assertExists(capturedContexts[0].auth.jwtClaims);
      assertEquals(capturedContexts[0].auth.jwtClaims.email, "e2e@test.com");

      // 5. Refresh token
      const refreshRes = await fetch(`${base}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: refreshToken }),
      });
      assertEquals(refreshRes.status, 200);
      const refreshBody = await refreshRes.json();
      assertExists(refreshBody.token);
      assertExists(refreshBody.refreshToken);

      // 6. Logout
      const logoutRes = await fetch(
        `${base}/auth/logout?sessionId=${loginBody.session.id}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${loginToken}` },
        },
      );
      assertEquals(logoutRes.status, 200);
      const logoutBody = await logoutRes.json();
      assertEquals(logoutBody.success, true);
    } finally {
      await server.stop();
      await db.close();
    }
  },
});

Deno.test({
  name: "E2E: query without auth populates empty AuthContext",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = getRandomPort();
    const { server, db, capturedContexts } = await createE2EServer(port);
    const base = `http://${TEST_HOST}:${port}`;

    void server.start();
    await new Promise((r) => setTimeout(r, 200));

    try {
      const queryRes = await fetch(`${base}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "SELECT User { name }" }),
      });
      assertEquals(queryRes.status, 200);
      await queryRes.json();

      // AuthContext should have no userId
      assertEquals(capturedContexts.length, 1);
      assertEquals(capturedContexts[0].auth.userId, undefined);
      assertEquals(capturedContexts[0].auth.jwtClaims, undefined);
    } finally {
      await server.stop();
      await db.close();
    }
  },
});

Deno.test({
  name: "E2E: invalid credentials return proper error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const port = getRandomPort();
    const { server, db } = await createE2EServer(port);
    const base = `http://${TEST_HOST}:${port}`;

    void server.start();
    await new Promise((r) => setTimeout(r, 200));

    try {
      const loginRes = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "nonexistent@test.com",
          password: "wrong",
        }),
      });
      // P1-35: nonexistent email returns the same generic 401/INVALID_CREDENTIALS
      // as a wrong-password case to prevent email enumeration.
      assertEquals(loginRes.status, 401);
      const body = await loginRes.json();
      assertEquals(body.code, "INVALID_CREDENTIALS");
    } finally {
      await server.stop();
      await db.close();
    }
  },
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `POST /auth/admin/users/delete` — service-token-only endpoint that
 * deletes an auth user and everything keyed to them.
 *
 * Drives the real dispatcher (`handleRequest`) over the in-memory
 * TestDatabase: the service credential is the only accepted caller (a
 * user JWT, a wrong token, or a server with no service token configured
 * all get 401), an unknown user is a 404, and a successful delete kills
 * the user’s sessions.
 */

import { assertEquals } from "@std/assert";
import { AuthRoutes } from "../auth/integration.ts";
import { AuthMiddleware } from "../auth/middleware.ts";
import { AuthProvider } from "../auth/provider.ts";
import { TestDatabase } from "../auth/test-database.ts";
import { HttpServer } from "./http.ts";
import type { ServerConfig } from "./types.ts";

const JWT_SECRET = "auth-delete-user-tests-jwt-secret-32-bytes!";
const SERVICE_TOKEN = "auth-delete-user-service-token-0123456789abcdef";

interface Harness {
  close(): Promise<void>;
  db: TestDatabase;
  request(path: string, options?: { body?: unknown; token?: string; }): Promise<{ body: Record<string, unknown>; status: number; }>;
  userId: string;
  userToken: string;
}

async function createHarness(config: Partial<ServerConfig> = { serviceToken: SERVICE_TOKEN }): Promise<Harness> {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider({ bcryptRounds: 4, jwtSecret: JWT_SECRET }, db);
  await provider.initialize();
  const registered = await provider.register({ email: "doomed@example.com", password: "TestPass123!" });

  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware, { rateLimiter: null });

  const server = new HttpServer({
    authMiddleware: middleware,
    authProvider: provider,
    authRoutes: routes,
    config: {
      databaseUrl: "postgresql://localhost:5432/test",
      enableAuth: true,
      enableCors: false,
      enableWebsockets: false,
      host: "127.0.0.1",
      jwtSecret: JWT_SECRET,
      maxConnections: 10,
      port: 0,
      requestTimeout: 5000,
      ...config
    },
    protocolHandler: {
      handleRequest: () => Promise.resolve({ data: [] }),
      validateRequest: () => []
    }
  });

  return {
    close: async () => {
      routes.dispose();
      await db.close();
    },
    db,
    request: async (path, options = {}) => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      if (options.token)
        headers.Authorization = `Bearer ${options.token}`;

      const request = new Request(`http://127.0.0.1${path}`, {
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        headers,
        method: options.body === undefined ? "GET" : "POST"
      });
      const info = {
        completed: Promise.resolve(),
        remoteAddr: { hostname: "127.0.0.1", port: 40000, transport: "tcp" }
      } as unknown as Deno.ServeHandlerInfo;
      // deno-lint-ignore no-explicit-any
      const response: Response = await (server as any).handleRequest(request, info);
      const text = await response.text();

      return { body: text ? JSON.parse(text) : {}, status: response.status };
    },
    userId: registered.user.id,
    userToken: registered.token
  };
}

async function userExists(db: TestDatabase, userId: string): Promise<boolean> {
  return (await db.query("SELECT id FROM users WHERE id = ?", [userId])).rows.length > 0;
}

const DELETE_PATH = "/auth/admin/users/delete";

Deno.test("auth delete user: the service token deletes the user and their sessions", async () => {
  const harness = await createHarness();

  try {
    assertEquals((await harness.request("/auth/profile", { token: harness.userToken })).status, 200);

    const { body, status } = await harness.request(DELETE_PATH, { body: { userId: harness.userId }, token: SERVICE_TOKEN });
    assertEquals(status, 200);
    assertEquals(body, { success: true });

    assertEquals(await userExists(harness.db, harness.userId), false);
    assertEquals((await harness.db.query("SELECT id FROM sessions WHERE user_id = ?", [harness.userId])).rows.length, 0);
    assertEquals((await harness.request("/auth/profile", { token: harness.userToken })).status, 401);
  } finally {
    await harness.close();
  }
});

Deno.test("auth delete user: works when requireAuth is on", async () => {
  const harness = await createHarness({ requireAuth: true, serviceToken: SERVICE_TOKEN });

  try {
    const { status } = await harness.request(DELETE_PATH, { body: { userId: harness.userId }, token: SERVICE_TOKEN });
    assertEquals(status, 200);
    assertEquals(await userExists(harness.db, harness.userId), false);
  } finally {
    await harness.close();
  }
});

Deno.test("auth delete user: an unknown user is a 404, not a 500", async () => {
  const harness = await createHarness();

  try {
    const { body, status } = await harness.request(DELETE_PATH, { body: { userId: "no-such-user" }, token: SERVICE_TOKEN });
    assertEquals(status, 404);
    assertEquals(body.code, "USER_NOT_FOUND");
  } finally {
    await harness.close();
  }
});

Deno.test("auth delete user: a missing userId is a 400", async () => {
  const harness = await createHarness();

  try {
    const { body, status } = await harness.request(DELETE_PATH, { body: {}, token: SERVICE_TOKEN });
    assertEquals(status, 400);
    assertEquals(body.code, "MISSING_USER_ID");
  } finally {
    await harness.close();
  }
});

Deno.test("auth delete user: requires the service token", async () => {
  const harness = await createHarness();

  try {
    for (
      const [label, token] of [
        ["no credential", undefined],
        ["a user JWT", harness.userToken],
        ["a wrong token", "not-the-service-token"]
      ] as const
    ) {
      const { status } = await harness.request(DELETE_PATH, { body: { userId: harness.userId }, token });
      assertEquals(status, 401, `${label} must be rejected`);
    }

    assertEquals(await userExists(harness.db, harness.userId), true);
  } finally {
    await harness.close();
  }
});

Deno.test("auth delete user: refused when no service token is configured", async () => {
  const harness = await createHarness({});

  try {
    const { status } = await harness.request(DELETE_PATH, { body: { userId: harness.userId }, token: harness.userToken });
    assertEquals(status, 401);
    assertEquals(await userExists(harness.db, harness.userId), true);
  } finally {
    await harness.close();
  }
});

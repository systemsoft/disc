/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The login/register rate limiter must be keyed by the caller's address.
 *
 * Regression: `HttpServer.handle_auth_route` dropped the `Deno.ServeHandlerInfo`
 * it was handed, so `AuthRoutes` never saw the TCP peer and every caller that
 * wasn't behind a trusted proxy shared one "anonymous" bucket. One busy client
 * locked everyone else out of signing in.
 *
 * These tests drive the real dispatch path (`handleRequest`) with a
 * synthetic `ServeHandlerInfo` per caller, so the peer address flows exactly
 * as it would from `Deno.serve`.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { AuthRoutes } from "../auth/integration.ts";
import { AuthMiddleware } from "../auth/middleware.ts";
import { AuthProvider } from "../auth/provider.ts";
import { TestDatabase } from "../auth/test-database.ts";
import { RateLimiter } from "./rate-limiter.ts";
import { HttpServer } from "./http.ts";

const JWT_SECRET = "auth-rate-limit-ip-tests-jwt-secret-32-bytes";

interface Harness {
  close(): Promise<void>;
  login(peer: string, headers?: Record<string, string>): Promise<number>;
}

async function createHarness(options: { burstSize: number; trustProxy?: boolean; }): Promise<Harness> {
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider({ bcryptRounds: 4, jwtSecret: JWT_SECRET }, db);
  await provider.initialize();

  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware, {
    rateLimiter: new RateLimiter({ burstSize: options.burstSize, requestsPerMinute: 1 }),
    trustProxy: options.trustProxy ?? false
  });

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
      trustProxy: options.trustProxy ?? false
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
    login: async (peer: string, headers: Record<string, string> = {}) => {
      const request = new Request("http://127.0.0.1/auth/login", {
        body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
        headers: { "Content-Type": "application/json", ...headers },
        method: "POST"
      });
      const info = {
        completed: Promise.resolve(),
        remoteAddr: { hostname: peer, port: 40000, transport: "tcp" }
      } as unknown as Deno.ServeHandlerInfo;
      // deno-lint-ignore no-explicit-any
      const response: Response = await (server as any).handleRequest(request, info);
      await response.body?.cancel();
      return response.status;
    }
  };
}

Deno.test("auth rate limit: two different peer addresses get separate buckets", async () => {
  const harness = await createHarness({ burstSize: 2 });

  try {
    assertNotEquals(await harness.login("198.51.100.1"), 429);
    assertNotEquals(await harness.login("198.51.100.1"), 429);
    assertEquals(await harness.login("198.51.100.1"), 429);

    assertNotEquals(await harness.login("198.51.100.2"), 429, "a second client must not inherit the first client's bucket");
  } finally {
    await harness.close();
  }
});

Deno.test("auth rate limit: requests from the same peer address share a bucket", async () => {
  const harness = await createHarness({ burstSize: 2 });

  try {
    assertNotEquals(await harness.login("198.51.100.7"), 429);
    assertNotEquals(await harness.login("198.51.100.7"), 429);
    assertEquals(await harness.login("198.51.100.7"), 429);
  } finally {
    await harness.close();
  }
});

Deno.test("auth rate limit: X-Forwarded-For is ignored unless trustProxy is on", async () => {
  const harness = await createHarness({ burstSize: 2 });

  try {
    assertNotEquals(await harness.login("198.51.100.9", { "X-Forwarded-For": "203.0.113.1" }), 429);
    assertNotEquals(await harness.login("198.51.100.9", { "X-Forwarded-For": "203.0.113.2" }), 429);
    assertEquals(
      await harness.login("198.51.100.9", { "X-Forwarded-For": "203.0.113.3" }),
      429,
      "a direct client must not escape its bucket by rotating X-Forwarded-For"
    );
  } finally {
    await harness.close();
  }
});

Deno.test("auth rate limit: with trustProxy, clients behind one proxy get separate buckets", async () => {
  const harness = await createHarness({ burstSize: 2, trustProxy: true });

  try {
    const proxy = "10.0.0.1";

    assertNotEquals(await harness.login(proxy, { "X-Forwarded-For": "203.0.113.1" }), 429);
    assertNotEquals(await harness.login(proxy, { "X-Forwarded-For": "203.0.113.1" }), 429);
    assertEquals(await harness.login(proxy, { "X-Forwarded-For": "203.0.113.1" }), 429);

    assertNotEquals(await harness.login(proxy, { "X-Forwarded-For": "203.0.113.2" }), 429);
  } finally {
    await harness.close();
  }
});

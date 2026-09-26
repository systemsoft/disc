/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The server-wide rate limiter (`rateLimitRpm`) must key on the same client
 * address the auth limiter uses.
 *
 * Regression: `HttpServer.handleRequest` always keyed on the TCP peer, even
 * with `trustProxy` on. Behind a trusted reverse proxy every client has the
 * proxy's address, so they all shared one bucket.
 *
 * These tests drive the real dispatch path (`handleRequest`) with a
 * synthetic `ServeHandlerInfo` per caller, so the peer address flows exactly
 * as it would from `Deno.serve`.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { HttpServer } from "./http.ts";

interface Harness {
  close(): void;
  get(peer: string, headers?: Record<string, string>): Promise<number>;
}

function createHarness(options: { trustProxy?: boolean; }): Harness {
  const server = new HttpServer({
    config: {
      databaseUrl: "postgresql://localhost:5432/test",
      enableCors: false,
      enableWebsockets: false,
      host: "127.0.0.1",
      maxConnections: 10,
      port: 0,
      rateLimitBurst: 2,
      rateLimitRpm: 1,
      requestTimeout: 5000,
      trustProxy: options.trustProxy ?? false
    },
    protocolHandler: {
      handleRequest: () => Promise.resolve({ data: [] }),
      validateRequest: () => []
    }
  });

  return {
    // deno-lint-ignore no-explicit-any
    close: () => (server as any).rate_limiter?.dispose(),
    get: async (peer: string, headers: Record<string, string> = {}) => {
      const request = new Request("http://127.0.0.1/health/live", { headers });
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

Deno.test("server rate limit: two different peer addresses get separate buckets", async () => {
  const harness = createHarness({});

  try {
    assertNotEquals(await harness.get("198.51.100.1"), 429);
    assertNotEquals(await harness.get("198.51.100.1"), 429);
    assertEquals(await harness.get("198.51.100.1"), 429);

    assertNotEquals(await harness.get("198.51.100.2"), 429);
  } finally {
    harness.close();
  }
});

Deno.test("server rate limit: X-Forwarded-For is ignored unless trustProxy is on", async () => {
  const harness = createHarness({});

  try {
    assertNotEquals(await harness.get("198.51.100.9", { "X-Forwarded-For": "203.0.113.1" }), 429);
    assertNotEquals(await harness.get("198.51.100.9", { "X-Forwarded-For": "203.0.113.2" }), 429);
    assertEquals(
      await harness.get("198.51.100.9", { "X-Forwarded-For": "203.0.113.3" }),
      429,
      "a direct client must not escape its bucket by rotating X-Forwarded-For"
    );
  } finally {
    harness.close();
  }
});

Deno.test("server rate limit: with trustProxy, clients behind one proxy get separate buckets", async () => {
  const harness = createHarness({ trustProxy: true });

  try {
    const proxy = "10.0.0.1";

    assertNotEquals(await harness.get(proxy, { "X-Forwarded-For": "203.0.113.1" }), 429);
    assertNotEquals(await harness.get(proxy, { "X-Forwarded-For": "203.0.113.1" }), 429);
    assertEquals(await harness.get(proxy, { "X-Forwarded-For": "203.0.113.1" }), 429);

    assertNotEquals(
      await harness.get(proxy, { "X-Forwarded-For": "203.0.113.2" }),
      429,
      "a second client behind the proxy must not inherit the first client's bucket"
    );
  } finally {
    harness.close();
  }
});

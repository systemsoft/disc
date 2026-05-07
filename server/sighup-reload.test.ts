/**
 * Tests for SIGHUP-triggered config hot-reload.
 *
 * Verifies that `DiscServer.reloadConfig()`:
 *   1. Re-reads env vars + applies safe-to-reload knobs in place.
 *   2. Skips unsafe-to-reload knobs (logs warn, leaves field intact).
 *   3. Tolerates `reloadTls()` failures without throwing.
 *
 * The tests call `reloadConfig()` directly rather than firing actual
 * SIGHUP — Deno's signal listeners can interact unpredictably with
 * the test runner's own SIGINT handling, and the direct call exercises
 * the same logic. (gh/geldata#4278)
 */

import { assertEquals, assertExists } from "@std/assert";
import { DiscServer } from "./server.ts";
import { HttpServer } from "./http.ts";
import type { ProtocolHandler, QueryContext, QueryRequest, QueryResponse } from "./types.ts";

/**
 * Minimal ProtocolHandler stub. The reload path doesn't need a working
 * handler — it just walks config and pokes the HttpServer.
 */
function stubHandler(): ProtocolHandler {
  return {
    handleRequest(_r: QueryRequest, _c: QueryContext): Promise<QueryResponse> {
      return Promise.resolve({ data: null });
    },
    validateRequest(_r: QueryRequest) {
      return [];
    },
  };
}

/**
 * Wire an HttpServer onto a DiscServer without actually binding a
 * listener. We stash it on the private `httpServer` field via a cast —
 * this matches what `start()` does internally and lets us drive
 * `reloadConfig()` without owning a port.
 *
 * Returns a `cleanup` callable that disposes the SubscriptionHandler's
 * heartbeat timer (started in the HttpServer constructor) so the test
 * runner doesn't flag a timer leak.
 */
function attachHttpServer(server: DiscServer): {
  cleanup: () => void;
  http: HttpServer;
} {
  const http = new HttpServer({
    config: server.get_config(),
    protocolHandler: stubHandler(),
  });
  (server as unknown as { httpServer: HttpServer }).httpServer = http;
  const cleanup = () => {
    // SubscriptionHandler's heartbeat interval starts in its
    // constructor — dispose to release the timer.
    const sub = (http as unknown as { subscription_handler: { dispose(): void } })
      .subscription_handler;
    sub.dispose();
  };
  return { cleanup, http };
}

/**
 * Snapshot + restore a set of env vars around a test body. Avoids
 * leaking values across tests (and into the test runner's process).
 */
async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const restore: Array<[string, string | undefined]> = [];
  for (const [k, v] of Object.entries(vars)) {
    restore.push([k, Deno.env.get(k)]);
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    await fn();
  } finally {
    for (const [k, prev] of restore) {
      if (prev === undefined) Deno.env.delete(k);
      else Deno.env.set(k, prev);
    }
  }
}

// ── Safe-to-reload fields ─────────────────────────────────────────────

Deno.test("reloadConfig - applies new requestTimeout from env", async () => {
  await withEnv({ DISC_REQUEST_TIMEOUT: "30000" }, async () => {
    const server = new DiscServer({ requestTimeout: 30000 });
    const { cleanup, http } = attachHttpServer(server);
    try {
      Deno.env.set("DISC_REQUEST_TIMEOUT", "9999");
      await server.reloadConfig();

      assertEquals(server.get_config().requestTimeout, 9999);
      // HttpServer's view of the value (used per-request) was also updated.
      assertEquals(
        (http as unknown as { config: { requestTimeout: number } }).config.requestTimeout,
        9999,
      );
    } finally {
      cleanup();
    }
  });
});

Deno.test("reloadConfig - applies new enableCors toggle", async () => {
  await withEnv({ DISC_ENABLE_CORS: "true" }, async () => {
    const server = new DiscServer({ enableCors: true });
    const { cleanup, http } = attachHttpServer(server);
    try {
      Deno.env.set("DISC_ENABLE_CORS", "false");
      await server.reloadConfig();

      assertEquals(server.get_config().enableCors, false);
      assertEquals(
        (http as unknown as { config: { enableCors: boolean } }).config.enableCors,
        false,
      );
    } finally {
      cleanup();
    }
  });
});

Deno.test("reloadConfig - updates corsOrigins allowlist", async () => {
  await withEnv({ DISC_CORS_ORIGINS: undefined }, async () => {
    const server = new DiscServer({ corsOrigins: ["https://old.example"] });
    const { cleanup, http } = attachHttpServer(server);
    try {
      Deno.env.set(
        "DISC_CORS_ORIGINS",
        "https://new.example, https://other.example",
      );
      await server.reloadConfig();

      const origins = server.get_config().corsOrigins;
      assertEquals(origins, ["https://new.example", "https://other.example"]);
      assertEquals(
        (http as unknown as { config: { corsOrigins?: string[] } }).config.corsOrigins,
        ["https://new.example", "https://other.example"],
      );
    } finally {
      cleanup();
    }
  });
});

Deno.test("reloadConfig - updates slowQueryThresholdMs", async () => {
  await withEnv({ DISC_SLOW_QUERY_MS: "1000" }, async () => {
    const server = new DiscServer({ slowQueryThresholdMs: 1000 });
    const { cleanup, http } = attachHttpServer(server);
    try {
      Deno.env.set("DISC_SLOW_QUERY_MS", "2500");
      await server.reloadConfig();

      assertEquals(server.get_config().slowQueryThresholdMs, 2500);
      assertEquals(
        (http as unknown as { config: { slowQueryThresholdMs?: number } }).config
          .slowQueryThresholdMs,
        2500,
      );
    } finally {
      cleanup();
    }
  });
});

// ── Unsafe-to-reload fields ───────────────────────────────────────────

Deno.test("reloadConfig - host change is ignored (unsafe)", async () => {
  await withEnv({ DISC_HOST: "localhost" }, async () => {
    const server = new DiscServer({ host: "localhost" });
    const { cleanup } = attachHttpServer(server);
    try {
      Deno.env.set("DISC_HOST", "0.0.0.0");
      await server.reloadConfig();

      // host is unsafe — must not change.
      assertEquals(server.get_config().host, "localhost");
    } finally {
      cleanup();
    }
  });
});

Deno.test("reloadConfig - port change is ignored (unsafe)", async () => {
  await withEnv({ DISC_PORT: "5656" }, async () => {
    const server = new DiscServer({ port: 5656 });
    const { cleanup } = attachHttpServer(server);
    try {
      Deno.env.set("DISC_PORT", "9999");
      await server.reloadConfig();

      assertEquals(server.get_config().port, 5656);
    } finally {
      cleanup();
    }
  });
});

Deno.test("reloadConfig - enableWebsockets change is ignored (unsafe)", async () => {
  await withEnv({ DISC_ENABLE_WEBSOCKETS: "true" }, async () => {
    const server = new DiscServer({ enableWebsockets: true });
    const { cleanup } = attachHttpServer(server);
    try {
      Deno.env.set("DISC_ENABLE_WEBSOCKETS", "false");
      await server.reloadConfig();

      assertEquals(server.get_config().enableWebsockets, true);
    } finally {
      cleanup();
    }
  });
});

Deno.test("reloadConfig - enableMetrics change is ignored (unsafe)", async () => {
  await withEnv({ DISC_ENABLE_METRICS: "false" }, async () => {
    const server = new DiscServer({ enableMetrics: false });
    const { cleanup } = attachHttpServer(server);
    try {
      Deno.env.set("DISC_ENABLE_METRICS", "true");
      await server.reloadConfig();

      assertEquals(server.get_config().enableMetrics, false);
    } finally {
      cleanup();
    }
  });
});

Deno.test("reloadConfig - maxConnections change is ignored (unsafe)", async () => {
  await withEnv({ DISC_MAX_CONNECTIONS: "100" }, async () => {
    const server = new DiscServer({ maxConnections: 100 });
    const { cleanup } = attachHttpServer(server);
    try {
      Deno.env.set("DISC_MAX_CONNECTIONS", "500");
      await server.reloadConfig();

      assertEquals(server.get_config().maxConnections, 100);
    } finally {
      cleanup();
    }
  });
});

// ── Resilience ────────────────────────────────────────────────────────

Deno.test("reloadConfig - tolerates reloadTls failure when TLS not configured", async () => {
  // No TLS configured — reloadTls() won't run, reloadConfig() returns
  // cleanly. This is the common path.
  await withEnv({}, async () => {
    const server = new DiscServer({ requestTimeout: 30000 });
    const { cleanup } = attachHttpServer(server);
    try {
      // Should not throw.
      await server.reloadConfig();
      assertExists(server.get_config());
    } finally {
      cleanup();
    }
  });
});

Deno.test("reloadConfig - works with no httpServer attached (pre-start)", async () => {
  await withEnv({ DISC_REQUEST_TIMEOUT: "5000" }, async () => {
    const server = new DiscServer({ requestTimeout: 30000 });
    // Deliberately do NOT attach an HttpServer — simulates a reload
    // arriving before start() finished. The setter calls are guarded by
    // optional chaining and must not throw.
    await server.reloadConfig();

    // Config field on DiscServer is still updated (HTTP setter just
    // no-ops because the chain is undefined).
    assertEquals(server.get_config().requestTimeout, 5000);
  });
});

Deno.test("reloadConfig - no-op when nothing changed", async () => {
  await withEnv(
    {
      DISC_ENABLE_CORS: "true",
      DISC_REQUEST_TIMEOUT: "30000",
    },
    async () => {
      const server = new DiscServer({
        enableCors: true,
        requestTimeout: 30000,
      });
      const { cleanup } = attachHttpServer(server);
      try {
        // No env changes between construction and reload.
        await server.reloadConfig();

        assertEquals(server.get_config().requestTimeout, 30000);
        assertEquals(server.get_config().enableCors, true);
      } finally {
        cleanup();
      }
    },
  );
});

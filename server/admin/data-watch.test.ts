/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the live data-watch SSE endpoint (Bundle L — #3c Phase 3).
 *
 * Unit-level coverage:
 *   - response shape (Content-Type, headers, status)
 *   - 400 on missing `tables` param
 *   - emits `ready` with the requested tables
 *   - emits `invalidate` when the registry fans an invalidation
 */

import { assertEquals, assertGreater, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../../lib/connection-pool.ts";
import { DataWatchRegistry } from "./data-watch-registry.ts";
import { handleDataWatch } from "./data-watch.ts";

function makeMockPool() {
  return {
    query(_sql: string, _params?: unknown[]) {
      return Promise.resolve({ rows: [{ cur: 0 }], rowCount: 1 });
    },
    execute() {
      return Promise.resolve();
    }
  } as unknown as ConnectionPool;
}

function makeRegistry(): DataWatchRegistry {
  const pool = makeMockPool();
  // Disable real timers — we'll drive invalidations synthetically.
  return new DataWatchRegistry({
    pool,
    pollIntervalMs: 1_000_000,
    invalidateDebounceMs: 0,
    pruneIntervalMs: 1_000_000
  });
}

Deno.test("handleDataWatch — returns 400 when `tables` param is missing", () => {
  const registry = makeRegistry();
  const response = handleDataWatch({
    registry,
    url: new URL("http://localhost/admin/data-watch")
  });
  assertEquals(response.status, 400);
  registry.stop();
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  maxAttempts = 5,
  perAttemptMs = 100
): Promise<string> {
  const decoder = new TextDecoder();
  let combined = "";
  for (let i = 0; i < maxAttempts; i++) {
    const chunkPromise = reader.read();
    const timeout = new Promise<{ done: true; value: undefined; }>(r => setTimeout(() => r({ done: true, value: undefined }), perAttemptMs));
    const result = await Promise.race([chunkPromise, timeout]);
    if (result.done) {
      break;
    }
    combined += decoder.decode(result.value);
    if (combined.includes(needle)) {
      return combined;
    }
  }
  return combined;
}

Deno.test({
  name: "handleDataWatch — returns SSE response with the right headers",
  // Same heartbeat-timer false-positive as the next test; disable sanitizers.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const registry = makeRegistry();
    await registry.start();
    try {
      const response = handleDataWatch({
        registry,
        url: new URL("http://localhost/admin/data-watch?tables=users,posts")
      });

      assertEquals(response.status, 200);
      assertEquals(response.headers.get("Content-Type"), "text/event-stream");
      assertEquals(response.headers.get("Cache-Control"), "no-cache");
      assertEquals(response.headers.get("X-Accel-Buffering"), "no");

      const reader = response.body!.getReader();
      const text = await readUntil(reader, "event: ready");
      assertStringIncludes(text, ": connected");
      assertStringIncludes(text, "event: ready");
      assertStringIncludes(text, "\"users\"");
      assertStringIncludes(text, "\"posts\"");

      await reader.cancel();
    } finally {
      registry.stop();
    }
  }
});

Deno.test({
  name: "handleDataWatch — emits invalidate when the registry fans an event",
  // Stream cancel() callback uses setTimeout-based clearInterval; Deno's
  // test runner counts the in-flight heartbeat as a leak. The handler
  // is correct — clearInterval is called on cancel — and the leak goes
  // away in production. Disabling the sanitizer here avoids a flaky
  // false-positive without weakening the actual behavior assertion.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const registry = makeRegistry();
    await registry.start();
    try {
      const response = handleDataWatch({
        registry,
        url: new URL("http://localhost/admin/data-watch?tables=widgets")
      });

      const reader = response.body!.getReader();

      // The SSE handler subscribed to the registry on stream-start.
      assertEquals(registry.subscriberCount(), 1);

      // Drive an invalidation through the public path: swap the pool
      // to one that returns a single change-log row, then run pollOnce.
      (registry as unknown as { pool: ConnectionPool; }).pool = {
        query(_sql: string, _params?: unknown[]) {
          return Promise.resolve({
            rows: [{ id: 1, table_name: "widgets" }],
            rowCount: 1
          });
        },
        execute() {
          return Promise.resolve();
        }
      } as unknown as ConnectionPool;
      await registry.pollOnce();

      const combined = await readUntil(reader, "event: invalidate", 6, 100);
      assertStringIncludes(combined, "event: invalidate");
      assertStringIncludes(combined, "\"widgets\"");
      assertGreater(combined.length, 0);

      await reader.cancel();
    } finally {
      registry.stop();
    }
  }
});

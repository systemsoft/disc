/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the token bucket rate limiter.
 */

import { assertEquals } from "@std/assert";
import { RateLimiter } from "./rate-limiter.ts";

Deno.test("allows requests under limit", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requestsPerMinute: 60,
    burstSize: 5,
    nowFn: () => now
  });

  // Should allow up to burstSize requests immediately
  for (let i = 0; i < 5; i++) {
    assertEquals(limiter.allow("1.2.3.4"), true);
  }

  limiter.dispose();
});

Deno.test("rejects requests over limit", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requestsPerMinute: 60,
    burstSize: 3,
    nowFn: () => now
  });

  // Exhaust the burst
  limiter.allow("1.2.3.4");
  limiter.allow("1.2.3.4");
  limiter.allow("1.2.3.4");

  // Next request should be rejected
  assertEquals(limiter.allow("1.2.3.4"), false);

  limiter.dispose();
});

Deno.test("token refill over time", () => {
  let now = 0;
  const limiter = new RateLimiter({
    // 60 rpm = 1 token/second = 1 token per 1000ms
    requestsPerMinute: 60,
    burstSize: 3,
    nowFn: () => now
  });

  // Exhaust burst
  limiter.allow("1.2.3.4");
  limiter.allow("1.2.3.4");
  limiter.allow("1.2.3.4");
  assertEquals(limiter.allow("1.2.3.4"), false);

  // Advance 1 second — should get 1 token back
  now = 1000;
  assertEquals(limiter.allow("1.2.3.4"), true);
  assertEquals(limiter.allow("1.2.3.4"), false);

  limiter.dispose();
});

Deno.test("burst handling - start with full burst then exhaust it", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requestsPerMinute: 6,
    burstSize: 4,
    nowFn: () => now
  });

  const results: boolean[] = [];
  for (let i = 0; i < 6; i++) {
    results.push(limiter.allow("10.0.0.1"));
  }

  // First 4 allowed (burstSize), remaining rejected
  assertEquals(results.slice(0, 4).every(r => r === true), true);
  assertEquals(results.slice(4).every(r => r === false), true);

  limiter.dispose();
});

Deno.test("independent IP buckets", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requestsPerMinute: 60,
    burstSize: 2,
    nowFn: () => now
  });

  // Exhaust IP A
  limiter.allow("192.168.0.1");
  limiter.allow("192.168.0.1");
  assertEquals(limiter.allow("192.168.0.1"), false);

  // IP B is unaffected
  assertEquals(limiter.allow("192.168.0.2"), true);
  assertEquals(limiter.allow("192.168.0.2"), true);
  assertEquals(limiter.allow("192.168.0.2"), false);

  limiter.dispose();
});

Deno.test("stats tracking - rejectedCount and activeClients", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requestsPerMinute: 60,
    burstSize: 1,
    nowFn: () => now
  });

  limiter.allow("10.0.0.1"); // allowed
  limiter.allow("10.0.0.1"); // rejected
  limiter.allow("10.0.0.2"); // allowed (new IP)
  limiter.allow("10.0.0.2"); // rejected

  const s = limiter.stats();
  assertEquals(s.rejectedCount, 2);
  assertEquals(s.activeClients, 2);

  limiter.dispose();
});

Deno.test("cleanup removes stale entries after idle TTL", () => {
  let now = 0;
  const limiter = new RateLimiter({
    requestsPerMinute: 60,
    burstSize: 5,
    nowFn: () => now
  });

  limiter.allow("172.16.0.1");
  assertEquals(limiter.stats().activeClients, 1);

  // Advance past the 2-minute idle TTL
  now = 2 * 60 * 1000 + 1;

  // The cleanup runs on the 60s interval; we invoke it directly by
  // casting to access the private method.
  (limiter as unknown as { cleanup_stale(): void; }).cleanup_stale();

  assertEquals(limiter.stats().activeClients, 0);

  limiter.dispose();
});

Deno.test("dispose stops cleanup interval", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requestsPerMinute: 60,
    burstSize: 5,
    nowFn: () => now
  });

  // dispose() should not throw
  limiter.dispose();

  // Calling dispose() again should also not throw (clearInterval is idempotent)
  limiter.dispose();
});

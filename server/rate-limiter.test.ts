/**
 * Tests for the token bucket rate limiter.
 */

import { assertEquals } from "@std/assert";
import { RateLimiter } from "./rate-limiter.ts";

Deno.test("allows requests under limit", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requests_per_minute: 60,
    burst_size: 5,
    now_fn: () => now,
  });

  // Should allow up to burst_size requests immediately
  for (let i = 0; i < 5; i++) {
    assertEquals(limiter.allow("1.2.3.4"), true);
  }

  limiter.dispose();
});

Deno.test("rejects requests over limit", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requests_per_minute: 60,
    burst_size: 3,
    now_fn: () => now,
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
    requests_per_minute: 60,
    burst_size: 3,
    now_fn: () => now,
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
    requests_per_minute: 6,
    burst_size: 4,
    now_fn: () => now,
  });

  const results: boolean[] = [];
  for (let i = 0; i < 6; i++) {
    results.push(limiter.allow("10.0.0.1"));
  }

  // First 4 allowed (burst_size), remaining rejected
  assertEquals(results.slice(0, 4).every((r) => r === true), true);
  assertEquals(results.slice(4).every((r) => r === false), true);

  limiter.dispose();
});

Deno.test("independent IP buckets", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requests_per_minute: 60,
    burst_size: 2,
    now_fn: () => now,
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

Deno.test("stats tracking - rejected_count and active_clients", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requests_per_minute: 60,
    burst_size: 1,
    now_fn: () => now,
  });

  limiter.allow("10.0.0.1"); // allowed
  limiter.allow("10.0.0.1"); // rejected
  limiter.allow("10.0.0.2"); // allowed (new IP)
  limiter.allow("10.0.0.2"); // rejected

  const s = limiter.stats();
  assertEquals(s.rejected_count, 2);
  assertEquals(s.active_clients, 2);

  limiter.dispose();
});

Deno.test("cleanup removes stale entries after idle TTL", () => {
  let now = 0;
  const limiter = new RateLimiter({
    requests_per_minute: 60,
    burst_size: 5,
    now_fn: () => now,
  });

  limiter.allow("172.16.0.1");
  assertEquals(limiter.stats().active_clients, 1);

  // Advance past the 2-minute idle TTL
  now = 2 * 60 * 1000 + 1;

  // The cleanup runs on the 60s interval; we invoke it directly by
  // casting to access the private method.
  (limiter as unknown as { cleanup_stale(): void }).cleanup_stale();

  assertEquals(limiter.stats().active_clients, 0);

  limiter.dispose();
});

Deno.test("dispose stops cleanup interval", () => {
  const now = 0;
  const limiter = new RateLimiter({
    requests_per_minute: 60,
    burst_size: 5,
    now_fn: () => now,
  });

  // dispose() should not throw
  limiter.dispose();

  // Calling dispose() again should also not throw (clearInterval is idempotent)
  limiter.dispose();
});

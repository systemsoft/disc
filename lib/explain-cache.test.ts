/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for ExplainCache — TTL-based EXPLAIN plan cache
 */

import { assertEquals } from "@std/assert";
import { ExplainCache } from "./explain-cache.ts";

// ── Cache miss / hit ─────────────────────────────────────────────────

Deno.test("ExplainCache - cache miss returns undefined", () => {
  const cache = new ExplainCache();
  assertEquals(cache.get("nonexistent"), undefined);
});

Deno.test("ExplainCache - cache hit returns stored plan after set", () => {
  const cache = new ExplainCache();
  const plan = {
    Plan: { "Node Type": "Seq Scan", "Relation Name": "users" }
  };

  cache.set("hash1", plan);
  assertEquals(cache.get("hash1"), plan);
});

// ── TTL expiration ───────────────────────────────────────────────────

Deno.test("ExplainCache - TTL expiration: get returns undefined after TTL elapses", () => {
  let now = 1_000;
  const cache = new ExplainCache({
    ttl_ms: 500,
    nowFn: () => now
  });

  cache.set("hash1", { plan: "data" });

  // Advance past TTL
  now = 1_600;
  assertEquals(cache.get("hash1"), undefined);
});

Deno.test("ExplainCache - TTL not yet elapsed: get returns cached plan", () => {
  let now = 1_000;
  const cache = new ExplainCache({
    ttl_ms: 500,
    nowFn: () => now
  });

  cache.set("hash1", { plan: "data" });

  // Advance but still within TTL
  now = 1_400;
  assertEquals(cache.get("hash1"), { plan: "data" });
});

// ── Capacity eviction ────────────────────────────────────────────────

Deno.test("ExplainCache - capacity eviction: oldest entry is evicted when max_size reached", () => {
  let now = 1_000;
  const cache = new ExplainCache({
    max_size: 3,
    ttl_ms: 60_000,
    nowFn: () => now
  });

  cache.set("a", "plan-a");
  now = 1_001;
  cache.set("b", "plan-b");
  now = 1_002;
  cache.set("c", "plan-c");
  // At capacity — inserting "d" must evict "a" (oldest inserted_at)
  now = 1_003;
  cache.set("d", "plan-d");

  assertEquals(cache.get("a"), undefined); // evicted
  assertEquals(cache.get("b"), "plan-b");
  assertEquals(cache.get("c"), "plan-c");
  assertEquals(cache.get("d"), "plan-d");
  assertEquals(cache.stats().evictions, 1);
});

// ── Stats tracking ───────────────────────────────────────────────────

Deno.test("ExplainCache - stats: hits, misses, and evictions increment correctly", () => {
  let now = 1_000;
  const cache = new ExplainCache({
    max_size: 2,
    ttl_ms: 60_000,
    nowFn: () => now
  });

  cache.set("a", "plan-a");
  now = 1_001;
  cache.set("b", "plan-b");

  cache.get("a"); // hit
  cache.get("z"); // miss

  // Fill past capacity to trigger eviction
  now = 1_002;
  cache.set("c", "plan-c"); // evicts "a"

  const s = cache.stats();
  assertEquals(s.hits, 1);
  assertEquals(s.misses, 1);
  assertEquals(s.evictions, 1);
});

// ── Clear ────────────────────────────────────────────────────────────

Deno.test("ExplainCache - clear empties cache", () => {
  const cache = new ExplainCache();
  cache.set("a", "plan-a");
  cache.set("b", "plan-b");

  cache.clear();

  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.stats().size, 0);
});

// ── Expired entries evicted on set ───────────────────────────────────

Deno.test("ExplainCache - expired entries are evicted during set, freeing capacity", () => {
  let now = 1_000;
  const cache = new ExplainCache({
    max_size: 2,
    ttl_ms: 500,
    nowFn: () => now
  });

  cache.set("a", "plan-a");
  now = 1_001;
  cache.set("b", "plan-b");
  // Both entries are now at max_size; advance past TTL so they expire
  now = 1_600;
  // set should evict both expired entries before inserting "c"
  cache.set("c", "plan-c");

  assertEquals(cache.get("a"), undefined);
  assertEquals(cache.get("b"), undefined);
  assertEquals(cache.get("c"), "plan-c");
  // Evictions count reflects the two expired entries removed during set
  assertEquals(cache.stats().evictions, 2);
});

// ── Size reflects current entries ────────────────────────────────────

Deno.test("ExplainCache - stats size reflects current number of live entries", () => {
  let now = 1_000;
  const cache = new ExplainCache({
    ttl_ms: 500,
    nowFn: () => now
  });

  cache.set("a", "plan-a");
  cache.set("b", "plan-b");
  assertEquals(cache.stats().size, 2);

  // Expire one entry and trigger eviction via a new set
  now = 1_600;
  cache.set("c", "plan-c");
  // "a" and "b" expired; only "c" should remain
  assertEquals(cache.stats().size, 1);
});

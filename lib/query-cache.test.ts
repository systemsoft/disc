/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for QueryCache, hash utilities, and cache key composition
 */

import {
  assertEquals,
  assertNotEquals
} from "@std/assert";
import {
  hashAccessContext,
  hashString,
  makeCompilationCacheKey,
  QueryCache
} from "./query-cache.ts";

// ── QueryCache basic operations ──────────────────────────────────────

Deno.test("QueryCache - get returns null on miss", () => {
  const cache = new QueryCache<string>();
  assertEquals(cache.get("nonexistent"), null);
});

Deno.test("QueryCache - set and get round-trip", () => {
  const cache = new QueryCache<string>();
  cache.set("key1", "value1");
  assertEquals(cache.get("key1"), "value1");
});

Deno.test("QueryCache - stats track hits and misses", () => {
  const cache = new QueryCache<string>();
  cache.set("a", "1");

  cache.get("a"); // hit
  cache.get("b"); // miss

  const stats = cache.stats();
  assertEquals(stats.hits, 1);
  assertEquals(stats.misses, 1);
  assertEquals(stats.size, 1);
});

Deno.test("QueryCache - LRU eviction when at capacity", () => {
  const cache = new QueryCache<string>(3);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");
  // At capacity — next set should evict "a" (oldest)
  cache.set("d", "4");

  assertEquals(cache.get("a"), null); // evicted
  assertEquals(cache.get("b"), "2");
  assertEquals(cache.get("d"), "4");
  assertEquals(cache.stats().evictions, 1);
});

Deno.test("QueryCache - get promotes entry to most-recently-used", () => {
  const cache = new QueryCache<string>(3);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");

  // Access "a" — promotes it so "b" becomes oldest
  cache.get("a");
  cache.set("d", "4"); // evicts "b"

  assertEquals(cache.get("b"), null); // evicted
  assertEquals(cache.get("a"), "1"); // still present
});

Deno.test("QueryCache - overwrite existing key updates value and position", () => {
  const cache = new QueryCache<string>(3);
  cache.set("a", "1");
  cache.set("b", "2");
  cache.set("c", "3");

  // Re-set "a" with new value — promotes it
  cache.set("a", "updated");
  cache.set("d", "4"); // evicts "b" (now oldest)

  assertEquals(cache.get("a"), "updated");
  assertEquals(cache.get("b"), null); // evicted
  assertEquals(cache.stats().evictions, 1);
});

Deno.test("QueryCache - clear resets entries and stats", () => {
  const cache = new QueryCache<string>();
  cache.set("a", "1");
  cache.get("a");
  cache.get("b");

  cache.clear();

  assertEquals(cache.get("a"), null);
  const stats = cache.stats();
  assertEquals(stats.size, 0);
  assertEquals(stats.hits, 0);
  assertEquals(stats.misses, 1); // the get("a") after clear
  assertEquals(stats.evictions, 0);
});

Deno.test("QueryCache - minimum maxSize is 1", () => {
  const cache = new QueryCache<string>(0);
  cache.set("a", "1");
  assertEquals(cache.get("a"), "1");
  assertEquals(cache.stats().maxSize, 1);
});

// ── Hash utilities ───────────────────────────────────────────────────

Deno.test("hashString - deterministic output", () => {
  const a = hashString("select User { name }");
  const b = hashString("select User { name }");
  assertEquals(a, b);
});

Deno.test("hashString - different inputs produce different hashes", () => {
  const a = hashString("select User { name }");
  const b = hashString("select Post { title }");
  assertNotEquals(a, b);
});

Deno.test("hashString - empty string produces a hash", () => {
  const h = hashString("");
  assertEquals(typeof h, "string");
  assertEquals(h, "0");
});

// ── Cache key composition ────────────────────────────────────────────

Deno.test("makeCompilationCacheKey - without access context", () => {
  const key = makeCompilationCacheKey("abc123");
  assertEquals(key, "abc123");
});

Deno.test("makeCompilationCacheKey - with access context", () => {
  const key = makeCompilationCacheKey("abc123", "ctx456");
  assertEquals(key, "abc123:ctx456");
});

Deno.test("hashAccessContext - deterministic", () => {
  const a = hashAccessContext("user1", "admin");
  const b = hashAccessContext("user1", "admin");
  assertEquals(a, b);
});

Deno.test("hashAccessContext - same role produces same hash regardless of user (P1-13)", () => {
  // P1-13: userId must NOT contribute to the cache key — every user with
  // the same role shares one compiled plan. Otherwise cardinality
  // explodes under multi-tenant load.
  const a = hashAccessContext("user1", "admin");
  const b = hashAccessContext("user2", "admin");
  assertEquals(a, b);
});

Deno.test("hashAccessContext - different roles produce different hashes (P1-13)", () => {
  const a = hashAccessContext("user1", "admin");
  const b = hashAccessContext("user1", "viewer");
  assertNotEquals(a, b);
});

Deno.test("hashAccessContext - handles undefined values", () => {
  const a = hashAccessContext(undefined, undefined);
  const b = hashAccessContext(undefined, undefined);
  assertEquals(a, b);
  assertEquals(typeof a, "string");
});

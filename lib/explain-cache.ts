/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * TTL-based cache for EXPLAIN plan results.
 *
 * Unlike the LRU QueryCache, plans are evicted by time rather than access
 * recency, because query plans depend on table statistics that change as
 * data grows or is vacuumed. A stale plan is worse than a cold miss, so
 * TTL-based expiry is the appropriate strategy here.
 */

// deno-lint-ignore-file camelcase

export interface ExplainCacheConfig {
  /** Time to live in milliseconds. Default: 300_000 (5 minutes). */
  ttl_ms: number;
  /** Maximum number of entries. Default: 500. */
  max_size: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  nowFn?: () => number;
}

export interface ExplainCacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

interface CacheEntry {
  plan: unknown;
  expiresAt: number;
  inserted_at: number;
}

/**
 * Defaults applied to every `ExplainCacheConfig` field. Typed as
 * `Required<ExplainCacheConfig>` so adding a new field to the interface
 * is a compile error until it's defaulted here. Mirrors the same pattern
 * used in `auth/provider.ts` to avoid silent missing-field bugs.
 */
const EXPLAIN_CACHE_DEFAULTS: Required<ExplainCacheConfig> = {
  ttl_ms: 300_000, // 5 minutes
  max_size: 500,
  nowFn: Date.now
};

export class ExplainCache {
  private entries = new Map<string, CacheEntry>();
  private config: Required<ExplainCacheConfig>;
  private stats_data: ExplainCacheStats = {
    hits: 0,
    misses: 0,
    size: 0,
    evictions: 0
  };

  constructor(config: Partial<ExplainCacheConfig> = {}) {
    const overrides: Partial<ExplainCacheConfig> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) {
        (overrides as Record<string, unknown>)[key] = value;
      }
    }
    this.config = {
      ...EXPLAIN_CACHE_DEFAULTS,
      ...overrides
    };
  }

  get(hash: string): unknown | undefined {
    const entry = this.entries.get(hash);

    if (!entry) {
      this.stats_data.misses++;
      return undefined;
    }

    // Check if expired
    if (this.config.nowFn() > entry.expiresAt) {
      this.entries.delete(hash);
      this.stats_data.size = this.entries.size;
      this.stats_data.misses++;
      return undefined;
    }

    // LRU reordering: delete and re-insert to move to end of Map
    // This ensures the oldest (least recently used) entry is always first
    this.entries.delete(hash);
    this.entries.set(hash, entry);

    this.stats_data.hits++;
    return entry.plan;
  }

  set(hash: string, plan: unknown): void {
    const now = this.config.nowFn();

    // Only scan for expired entries when at capacity to avoid unnecessary O(n) scans.
    // get() already performs lazy per-entry TTL checks, so expired entries are
    // invisible to callers even without eager scanning.
    if (this.entries.size >= this.config.max_size) {
      this.evictExpired(now);
    }

    // Capacity eviction: remove oldest (first) entry via Map insertion order — O(1)
    while (this.entries.size >= this.config.max_size) {
      this.evictOldest();
    }

    this.entries.set(hash, {
      plan,
      expiresAt: now + this.config.ttl_ms,
      inserted_at: now
    });
    this.stats_data.size = this.entries.size;
  }

  stats(): ExplainCacheStats {
    // Count only non-expired entries so size reflects entries visible via get().
    // This is not on the hot path (diagnostics only), so the scan is acceptable.
    const now = this.config.nowFn();
    let liveCount = 0;
    for (const entry of this.entries.values()) {
      if (now <= entry.expiresAt) {
        liveCount++;
      }
    }
    return { ...this.stats_data, size: liveCount };
  }

  clear(): void {
    this.entries.clear();
    this.stats_data.size = 0;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
        this.stats_data.evictions++;
      }
    }
  }

  private evictOldest(): void {
    // Map preserves insertion order; the first key is the oldest (least recently used)
    // because get() reorders accessed entries to the end via delete + re-set.
    const oldest = this.entries.keys().next();
    if (!oldest.done) {
      this.entries.delete(oldest.value);
      this.stats_data.evictions++;
    }
  }
}

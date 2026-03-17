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
  now_fn?: () => number;
}

export interface ExplainCacheStats {
  hits: number;
  misses: number;
  size: number;
  evictions: number;
}

interface CacheEntry {
  plan: unknown;
  expires_at: number;
  inserted_at: number;
}

export class ExplainCache {
  private entries = new Map<string, CacheEntry>();
  private config: Required<ExplainCacheConfig>;
  private stats_data: ExplainCacheStats = {
    hits: 0,
    misses: 0,
    size: 0,
    evictions: 0,
  };

  constructor(config: Partial<ExplainCacheConfig> = {}) {
    this.config = {
      ttl_ms: config.ttl_ms ?? 300_000,
      max_size: config.max_size ?? 500,
      now_fn: config.now_fn ?? Date.now,
    };
  }

  get(hash: string): unknown | undefined {
    const entry = this.entries.get(hash);

    if (!entry) {
      this.stats_data.misses++;
      return undefined;
    }

    // Check if expired
    if (this.config.now_fn() > entry.expires_at) {
      this.entries.delete(hash);
      this.stats_data.size = this.entries.size;
      this.stats_data.misses++;
      return undefined;
    }

    this.stats_data.hits++;
    return entry.plan;
  }

  set(hash: string, plan: unknown): void {
    const now = this.config.now_fn();

    // Evict expired entries first to free space before capacity check
    this.evictExpired(now);

    // Capacity eviction: remove oldest inserted entry if at max
    while (this.entries.size >= this.config.max_size) {
      this.evictOldest();
    }

    this.entries.set(hash, {
      plan,
      expires_at: now + this.config.ttl_ms,
      inserted_at: now,
    });
    this.stats_data.size = this.entries.size;
  }

  stats(): ExplainCacheStats {
    return { ...this.stats_data, size: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
    this.stats_data.size = 0;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now > entry.expires_at) {
        this.entries.delete(key);
        this.stats_data.evictions++;
      }
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [key, entry] of this.entries) {
      if (entry.inserted_at < oldestTime) {
        oldestTime = entry.inserted_at;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
      this.stats_data.evictions++;
    }
  }
}

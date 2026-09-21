/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Generic LRU Query Cache
 *
 * Two-layer caching for parsed ASTs and compiled SQL.
 * Uses Map delete-then-re-set pattern for LRU ordering.
 */

/**
 * Cache statistics for observability
 */
export interface CacheStats {
  evictions: number;
  hits: number;
  maxSize: number;
  misses: number;
  size: number;
}

/**
 * Generic LRU cache with hit/miss/eviction tracking
 */
export class QueryCache<T> {
  private cache: Map<string, T> = new Map();
  private evictions = 0;
  private hits = 0;
  private maxSize: number;
  private misses = 0;

  constructor(maxSize = 1000) {
    this.maxSize = Math.max(1, maxSize);
  }

  /**
   * Get a cached value by key. Returns null on miss.
   * Promotes the entry to most-recently-used on hit.
   */
  get(key: string): T | null {
    const value = this.cache.get(key);

    if (value === undefined) {
      this.misses++;
      return null;
    }

    // Promote to most-recently-used (delete + re-set)
    this.cache.delete(key);
    this.cache.set(key, value);
    this.hits++;
    return value;
  }

  /**
   * Store a value in the cache. Evicts least-recently-used if at capacity.
   */
  set(key: string, value: T): void {
    // If key already exists, delete first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least-recently-used (first entry in Map iteration order)
      const firstKey = this.cache.keys().next().value;

      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
        this.evictions++;
      }
    }

    this.cache.set(key, value);
  }

  /**
   * Clear all entries and reset stats.
   */
  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /**
   * Return current cache statistics.
   */
  stats(): CacheStats {
    return {
      evictions: this.evictions,
      hits: this.hits,
      maxSize: this.maxSize,
      misses: this.misses,
      size: this.cache.size
    };
  }
}

/**
 * Hash a string into a hex string.
 * Extracted from edgeql-protocol.ts hash_query() for reuse.
 */
export function hashString(input: string): string {
  let hash = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  return Math.abs(hash).toString(16);
}

/**
 * Compose a compilation cache key from a query hash and optional access context hash.
 */
export function makeCompilationCacheKey(
  queryHash: string,
  accessContextHash?: string
): string {
  if (accessContextHash) {
    return `${queryHash}:${accessContextHash}`;
  }

  return queryHash;
}

/**
 * Key an access context for the compilation cache.
 *
 * S1: both `userId` and `userRole` are part of the key. The policy evaluator
 * inlines the caller's id into the compiled SQL as a literal
 * (`owner_id = E'<userId>'`, see access/evaluator.ts), so a compiled plan
 * belongs to exactly one user; keying by role alone (the old P1-13 behavior)
 * served one user's row filter to every other user with that role.
 *
 * The values are embedded verbatim, not run through `hashString`: that is a
 * 32-bit hash, and two user ids that collide would share a plan again.
 *
 * The cost is one cache entry per (query, user). The long-term fix is to emit
 * the policy's user id as a bind parameter, which makes the SQL user-neutral
 * and lets the key go back to role only.
 */
export function hashAccessContext(
  userId?: string,
  userRole?: string
): string {
  return JSON.stringify([userId ?? null, userRole ?? null]);
}

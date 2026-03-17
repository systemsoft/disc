/**
 * Token bucket rate limiter keyed by client IP.
 */

export interface RateLimitConfig {
  requests_per_minute: number;
  burst_size: number;
  now_fn?: () => number;
}

export interface RateLimitStats {
  rejected_count: number;
  active_clients: number;
}

interface Bucket {
  tokens: number;
  last_refill_ms: number;
  last_seen_ms: number;
}

const CLEANUP_INTERVAL_MS = 60_000;
const IDLE_TTL_MS = 2 * 60_000;

export class RateLimiter {
  private readonly refill_rate: number; // tokens per millisecond
  private readonly burst_size: number;
  private readonly now_fn: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private rejected_count = 0;
  private readonly cleanup_timer: number;

  constructor(config: RateLimitConfig) {
    this.refill_rate = config.requests_per_minute / 60 / 1000;
    this.burst_size = config.burst_size;
    this.now_fn = config.now_fn ?? (() => Date.now());

    this.cleanup_timer = setInterval(() => {
      this.cleanup_stale();
    }, CLEANUP_INTERVAL_MS);
  }

  allow(client_ip: string): boolean {
    const now = this.now_fn();
    let bucket = this.buckets.get(client_ip);

    if (!bucket) {
      bucket = {
        tokens: this.burst_size,
        last_refill_ms: now,
        last_seen_ms: now,
      };
      this.buckets.set(client_ip, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed_ms = now - bucket.last_refill_ms;
    const refill = elapsed_ms * this.refill_rate;

    bucket.tokens = Math.min(this.burst_size, bucket.tokens + refill);
    bucket.last_refill_ms = now;
    bucket.last_seen_ms = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    this.rejected_count++;
    return false;
  }

  stats(): RateLimitStats {
    return {
      rejected_count: this.rejected_count,
      active_clients: this.buckets.size,
    };
  }

  dispose(): void {
    clearInterval(this.cleanup_timer);
  }

  private cleanup_stale(): void {
    const now = this.now_fn();
    for (const [ip, bucket] of this.buckets) {
      if (now - bucket.last_seen_ms > IDLE_TTL_MS) {
        this.buckets.delete(ip);
      }
    }
  }
}

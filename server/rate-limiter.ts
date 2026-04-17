/**
 * Token bucket rate limiter keyed by client IP.
 */

export interface RateLimitConfig {
  requestsPerMinute: number;
  burstSize: number;
  nowFn?: () => number;
}

export interface RateLimitStats {
  rejectedCount: number;
  activeClients: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
  lastSeenMs: number;
}

const CLEANUP_INTERVAL_MS = 60_000;
const IDLE_TTL_MS = 2 * 60_000;

export class RateLimiter {
  private readonly refill_rate: number; // tokens per millisecond
  private readonly burstSize: number;
  private readonly nowFn: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private rejectedCount = 0;
  private readonly cleanup_timer: number;

  constructor(config: RateLimitConfig) {
    this.refill_rate = config.requestsPerMinute / 60 / 1000;
    this.burstSize = config.burstSize;
    this.nowFn = config.nowFn ?? (() => Date.now());

    this.cleanup_timer = setInterval(() => {
      this.cleanup_stale();
    }, CLEANUP_INTERVAL_MS);
    // Unref the timer so it doesn't keep Deno's event loop alive. Without
    // this the process (and test runners) would hang waiting for the
    // interval to fire even after the limiter is otherwise idle.
    Deno.unrefTimer(this.cleanup_timer);
  }

  allow(clientIp: string): boolean {
    const now = this.nowFn();
    let bucket = this.buckets.get(clientIp);

    if (!bucket) {
      bucket = {
        tokens: this.burstSize,
        lastRefillMs: now,
        lastSeenMs: now,
      };
      this.buckets.set(clientIp, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsedMs = now - bucket.lastRefillMs;
    const refill = elapsedMs * this.refill_rate;

    bucket.tokens = Math.min(this.burstSize, bucket.tokens + refill);
    bucket.lastRefillMs = now;
    bucket.lastSeenMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    this.rejectedCount++;
    return false;
  }

  stats(): RateLimitStats {
    return {
      rejectedCount: this.rejectedCount,
      activeClients: this.buckets.size,
    };
  }

  dispose(): void {
    clearInterval(this.cleanup_timer);
  }

  private cleanup_stale(): void {
    const now = this.nowFn();
    for (const [ip, bucket] of this.buckets) {
      if (now - bucket.lastSeenMs > IDLE_TTL_MS) {
        this.buckets.delete(ip);
      }
    }
  }
}

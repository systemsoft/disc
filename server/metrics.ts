/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file camelcase

/**
 * Prometheus metrics export for Disc database server.
 */

export interface MetricsSource {
  /** HTTP-level request stats */
  http: {
    total_requests: number;
    successful_requests: number;
    failed_requests: number;
    total_duration_ms: number;
  };
  /** Query cache stats (optional, from protocol handler) */
  cache?: {
    compilation: {
      hits: number;
      misses: number;
      evictions: number;
      size: number;
    };
    parse: { hits: number; misses: number; evictions: number; size: number; };
  };
  /** Query metrics (optional) */
  queryMetrics?: {
    totalQueries: number;
    avgParseMs: number;
    avgCompileMs: number;
    avgExecuteMs: number;
    cacheHitRate: number;
  };
  /** Connection pool stats (optional) */
  pool?: {
    total: number;
    idle: number;
    active: number;
    waiters: number;
  } | null;
  /** Rate limiter stats (optional) */
  rateLimit?: {
    rejectedCount: number;
    activeClients: number;
  };
  /** Server uptime in ms */
  uptimeMs: number;
  /** Memory usage */
  memory: {
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  /**
   * TLS certificate metadata (optional). When TLS is enabled, the server
   * reports the leaf certificate's `notAfter` as a unix-epoch-seconds
   * timestamp plus a derived `seconds_until_expiry` measurement so ops
   * can alert before renewal fails. Ports geldata/gel#6205.
   */
  tls?: {
    /** Unix epoch seconds at which the leaf cert stops being valid. */
    notAfterUnix: number;
    /** Seconds remaining until expiry, computed at scrape time. */
    secondsUntilExpiry: number;
  };
}

export interface MetricsConfig {
  prefix?: string; // default "disc"
}

export function renderMetrics(
  source: MetricsSource,
  config: MetricsConfig = {}
): string {
  const prefix = config.prefix || "disc";
  const lines: string[] = [];

  function gauge(name: string, help: string, value: number): void {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }

  function counter(name: string, help: string, value: number): void {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }

  // HTTP request metrics
  counter(
    `${prefix}_http_requests_total`,
    "Total HTTP requests",
    source.http.total_requests
  );
  counter(
    `${prefix}_http_requests_successful_total`,
    "Successful HTTP requests",
    source.http.successful_requests
  );
  counter(
    `${prefix}_http_requests_failed_total`,
    "Failed HTTP requests",
    source.http.failed_requests
  );

  // Cache metrics
  if (source.cache) {
    counter(
      `${prefix}_query_cache_hits_total`,
      "Query compilation cache hits",
      source.cache.compilation.hits
    );
    counter(
      `${prefix}_query_cache_misses_total`,
      "Query compilation cache misses",
      source.cache.compilation.misses
    );
    counter(
      `${prefix}_query_cache_evictions_total`,
      "Query compilation cache evictions",
      source.cache.compilation.evictions
    );
    gauge(
      `${prefix}_query_cache_size`,
      "Current query compilation cache size",
      source.cache.compilation.size
    );

    counter(
      `${prefix}_parse_cache_hits_total`,
      "Parse cache hits",
      source.cache.parse.hits
    );
    counter(
      `${prefix}_parse_cache_misses_total`,
      "Parse cache misses",
      source.cache.parse.misses
    );
    gauge(
      `${prefix}_parse_cache_size`,
      "Current parse cache size",
      source.cache.parse.size
    );
  }

  // Pool metrics
  if (source.pool) {
    gauge(
      `${prefix}_pool_connections_total`,
      "Total pool connections",
      source.pool.total
    );
    gauge(
      `${prefix}_pool_connections_idle`,
      "Idle pool connections",
      source.pool.idle
    );
    gauge(
      `${prefix}_pool_connections_active`,
      "Active pool connections",
      source.pool.active
    );
    gauge(
      `${prefix}_pool_waiters`,
      "Pool connection waiters",
      source.pool.waiters
    );
  }

  // Rate limit metrics
  if (source.rateLimit) {
    counter(
      `${prefix}_rate_limit_rejected_total`,
      "Rate-limited requests rejected",
      source.rateLimit.rejectedCount
    );
    gauge(
      `${prefix}_rate_limit_active_clients`,
      "Active rate limit client buckets",
      source.rateLimit.activeClients
    );
  }

  // TLS certificate metrics
  // Ports geldata/gel#6205. Two related gauges: the absolute notAfter
  // unix timestamp (matches Gel's `edgedb_tls_certificate_expiration_time`)
  // and a derived seconds-until-expiry measurement that's friendlier for
  // alerting rules (`disc_tls_certificate_seconds_until_expiry < 7d`).
  if (source.tls) {
    gauge(
      `${prefix}_tls_certificate_expiration_time`,
      "TLS leaf certificate notAfter as unix epoch seconds",
      source.tls.notAfterUnix
    );
    gauge(
      `${prefix}_tls_certificate_seconds_until_expiry`,
      "Seconds until TLS leaf certificate expires (negative if expired)",
      source.tls.secondsUntilExpiry
    );
  }

  // Process metrics
  gauge(
    `${prefix}_process_memory_heap_used_bytes`,
    "Process heap memory used",
    source.memory.heapUsed
  );
  gauge(
    `${prefix}_process_memory_heap_total_bytes`,
    "Process heap memory total",
    source.memory.heapTotal
  );
  gauge(
    `${prefix}_process_memory_external_bytes`,
    "Process external memory",
    source.memory.external
  );
  gauge(
    `${prefix}_uptime_seconds`,
    "Server uptime in seconds",
    source.uptimeMs / 1000
  );

  return lines.join("\n") + "\n";
}

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
    parse: { hits: number; misses: number; evictions: number; size: number };
  };
  /** Query metrics (optional) */
  query_metrics?: {
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
  rate_limit?: {
    rejected_count: number;
    active_clients: number;
  };
  /** Server uptime in ms */
  uptime_ms: number;
  /** Memory usage */
  memory: {
    heap_used: number;
    heap_total: number;
    external: number;
  };
}

export interface MetricsConfig {
  prefix?: string; // default "disc"
}

export function renderMetrics(
  source: MetricsSource,
  config: MetricsConfig = {},
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
    source.http.total_requests,
  );
  counter(
    `${prefix}_http_requests_successful_total`,
    "Successful HTTP requests",
    source.http.successful_requests,
  );
  counter(
    `${prefix}_http_requests_failed_total`,
    "Failed HTTP requests",
    source.http.failed_requests,
  );

  // Cache metrics
  if (source.cache) {
    counter(
      `${prefix}_query_cache_hits_total`,
      "Query compilation cache hits",
      source.cache.compilation.hits,
    );
    counter(
      `${prefix}_query_cache_misses_total`,
      "Query compilation cache misses",
      source.cache.compilation.misses,
    );
    counter(
      `${prefix}_query_cache_evictions_total`,
      "Query compilation cache evictions",
      source.cache.compilation.evictions,
    );
    gauge(
      `${prefix}_query_cache_size`,
      "Current query compilation cache size",
      source.cache.compilation.size,
    );

    counter(
      `${prefix}_parse_cache_hits_total`,
      "Parse cache hits",
      source.cache.parse.hits,
    );
    counter(
      `${prefix}_parse_cache_misses_total`,
      "Parse cache misses",
      source.cache.parse.misses,
    );
    gauge(
      `${prefix}_parse_cache_size`,
      "Current parse cache size",
      source.cache.parse.size,
    );
  }

  // Pool metrics
  if (source.pool) {
    gauge(
      `${prefix}_pool_connections_total`,
      "Total pool connections",
      source.pool.total,
    );
    gauge(
      `${prefix}_pool_connections_idle`,
      "Idle pool connections",
      source.pool.idle,
    );
    gauge(
      `${prefix}_pool_connections_active`,
      "Active pool connections",
      source.pool.active,
    );
    gauge(
      `${prefix}_pool_waiters`,
      "Pool connection waiters",
      source.pool.waiters,
    );
  }

  // Rate limit metrics
  if (source.rate_limit) {
    counter(
      `${prefix}_rate_limit_rejected_total`,
      "Rate-limited requests rejected",
      source.rate_limit.rejected_count,
    );
    gauge(
      `${prefix}_rate_limit_active_clients`,
      "Active rate limit client buckets",
      source.rate_limit.active_clients,
    );
  }

  // Process metrics
  gauge(
    `${prefix}_process_memory_heap_used_bytes`,
    "Process heap memory used",
    source.memory.heap_used,
  );
  gauge(
    `${prefix}_process_memory_heap_total_bytes`,
    "Process heap memory total",
    source.memory.heap_total,
  );
  gauge(
    `${prefix}_process_memory_external_bytes`,
    "Process external memory",
    source.memory.external,
  );
  gauge(
    `${prefix}_uptime_seconds`,
    "Server uptime in seconds",
    source.uptime_ms / 1000,
  );

  return lines.join("\n") + "\n";
}

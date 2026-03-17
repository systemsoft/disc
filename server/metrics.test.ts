/**
 * Tests for Prometheus metrics rendering.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderMetrics } from "./metrics.ts";
import type { MetricsSource } from "./metrics.ts";

function makeSource(
  overrides: Partial<MetricsSource> = {},
): MetricsSource {
  return {
    http: {
      total_requests: 100,
      successful_requests: 95,
      failed_requests: 5,
      total_duration_ms: 50000,
    },
    uptime_ms: 120000,
    memory: {
      heap_used: 1024 * 1024 * 10,
      heap_total: 1024 * 1024 * 50,
      external: 1024 * 512,
    },
    ...overrides,
  };
}

Deno.test("renderMetrics includes HELP and TYPE comments for HTTP counters", () => {
  const output = renderMetrics(makeSource());

  assertStringIncludes(output, "# HELP disc_http_requests_total");
  assertStringIncludes(output, "# TYPE disc_http_requests_total counter");
  assertStringIncludes(
    output,
    "# HELP disc_http_requests_successful_total",
  );
  assertStringIncludes(
    output,
    "# TYPE disc_http_requests_successful_total counter",
  );
  assertStringIncludes(output, "# HELP disc_http_requests_failed_total");
  assertStringIncludes(
    output,
    "# TYPE disc_http_requests_failed_total counter",
  );
});

Deno.test("renderMetrics outputs correct HTTP request counter values", () => {
  const source = makeSource({
    http: {
      total_requests: 42,
      successful_requests: 40,
      failed_requests: 2,
      total_duration_ms: 9000,
    },
  });
  const output = renderMetrics(source);

  assertStringIncludes(output, "disc_http_requests_total 42");
  assertStringIncludes(output, "disc_http_requests_successful_total 40");
  assertStringIncludes(output, "disc_http_requests_failed_total 2");
});

Deno.test("renderMetrics includes cache stats when cache is provided", () => {
  const source = makeSource({
    cache: {
      compilation: { hits: 50, misses: 10, evictions: 2, size: 48 },
      parse: { hits: 30, misses: 5, evictions: 1, size: 29 },
    },
  });
  const output = renderMetrics(source);

  assertStringIncludes(output, "disc_query_cache_hits_total 50");
  assertStringIncludes(output, "disc_query_cache_misses_total 10");
  assertStringIncludes(output, "disc_query_cache_evictions_total 2");
  assertStringIncludes(output, "disc_query_cache_size 48");
  assertStringIncludes(output, "disc_parse_cache_hits_total 30");
  assertStringIncludes(output, "disc_parse_cache_misses_total 5");
  assertStringIncludes(output, "disc_parse_cache_size 29");
});

Deno.test("renderMetrics omits cache stats when cache is undefined", () => {
  const source = makeSource({ cache: undefined });
  const output = renderMetrics(source);

  assertEquals(output.includes("cache_hits"), false);
  assertEquals(output.includes("cache_misses"), false);
  assertEquals(output.includes("parse_cache"), false);
});

Deno.test("renderMetrics includes pool stats when pool is provided", () => {
  const source = makeSource({
    pool: { total: 10, idle: 7, active: 3, waiters: 1 },
  });
  const output = renderMetrics(source);

  assertStringIncludes(output, "disc_pool_connections_total 10");
  assertStringIncludes(output, "disc_pool_connections_idle 7");
  assertStringIncludes(output, "disc_pool_connections_active 3");
  assertStringIncludes(output, "disc_pool_waiters 1");
});

Deno.test("renderMetrics omits pool stats when pool is null", () => {
  const source = makeSource({ pool: null });
  const output = renderMetrics(source);

  assertEquals(output.includes("pool_connections"), false);
  assertEquals(output.includes("pool_waiters"), false);
});

Deno.test("renderMetrics includes rate limit stats when rate_limit is provided", () => {
  const source = makeSource({
    rate_limit: { rejected_count: 15, active_clients: 8 },
  });
  const output = renderMetrics(source);

  assertStringIncludes(output, "disc_rate_limit_rejected_total 15");
  assertStringIncludes(output, "disc_rate_limit_active_clients 8");
});

Deno.test("renderMetrics always includes memory and uptime metrics", () => {
  const source = makeSource({
    uptime_ms: 60000,
    memory: {
      heap_used: 1000,
      heap_total: 2000,
      external: 500,
    },
  });
  const output = renderMetrics(source);

  assertStringIncludes(
    output,
    "disc_process_memory_heap_used_bytes 1000",
  );
  assertStringIncludes(
    output,
    "disc_process_memory_heap_total_bytes 2000",
  );
  assertStringIncludes(output, "disc_process_memory_external_bytes 500");
  // 60000ms / 1000 = 60 seconds
  assertStringIncludes(output, "disc_uptime_seconds 60");
});

Deno.test("renderMetrics uses custom prefix when provided", () => {
  const source = makeSource();
  const output = renderMetrics(source, { prefix: "myapp" });

  assertStringIncludes(output, "myapp_http_requests_total");
  assertStringIncludes(output, "myapp_uptime_seconds");
  assertEquals(output.includes("disc_http"), false);
  assertEquals(output.includes("disc_uptime"), false);
});

Deno.test("renderMetrics output ends with newline", () => {
  const output = renderMetrics(makeSource());
  assertEquals(output[output.length - 1], "\n");
});

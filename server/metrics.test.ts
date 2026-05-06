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
    uptimeMs: 120000,
    memory: {
      heapUsed: 1024 * 1024 * 10,
      heapTotal: 1024 * 1024 * 50,
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

Deno.test("renderMetrics includes rate limit stats when rateLimit is provided", () => {
  const source = makeSource({
    rateLimit: { rejectedCount: 15, activeClients: 8 },
  });
  const output = renderMetrics(source);

  assertStringIncludes(output, "disc_rate_limit_rejected_total 15");
  assertStringIncludes(output, "disc_rate_limit_active_clients 8");
});

Deno.test("renderMetrics always includes memory and uptime metrics", () => {
  const source = makeSource({
    uptimeMs: 60000,
    memory: {
      heapUsed: 1000,
      heapTotal: 2000,
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

// ── TLS expiry gauge (ports geldata/gel#6205) ──────────────────────────

Deno.test("renderMetrics emits TLS expiry gauges when tls is provided", () => {
  // notAfter pinned at a fixed unix timestamp; secondsUntilExpiry is
  // pre-computed by the caller (handle_metrics) so this test doesn't
  // need to know the wall clock.
  const source = makeSource({
    tls: {
      notAfterUnix: 1893456000, // 2030-01-01T00:00:00Z
      secondsUntilExpiry: 60 * 60 * 24 * 30, // 30 days
    },
  });
  const output = renderMetrics(source);

  assertStringIncludes(
    output,
    "# TYPE disc_tls_certificate_expiration_time gauge",
  );
  assertStringIncludes(
    output,
    "disc_tls_certificate_expiration_time 1893456000",
  );
  assertStringIncludes(
    output,
    "# TYPE disc_tls_certificate_seconds_until_expiry gauge",
  );
  assertStringIncludes(
    output,
    "disc_tls_certificate_seconds_until_expiry 2592000",
  );
});

Deno.test("renderMetrics omits TLS gauges when tls is undefined", () => {
  const output = renderMetrics(makeSource({ tls: undefined }));
  assertEquals(output.includes("disc_tls_certificate"), false);
});

// ── Gauge-value sanity audit (ports geldata/gel#5405) ──────────────────
//
// Gel #5405: certain `_created` gauges were inadvertently reporting the
// wall-clock unix timestamp (~1.7e9) instead of the actual measurement.
// Disc never adopted prom_client's `_created` convention so the bug
// can't apply structurally — but a regression pin is still cheap. Any
// gauge whose value falls in the unix-epoch-seconds danger band
// (Jan 2020–Jan 2050) is suspicious for a count/size/seconds metric.
//
// Real expiry timestamps (`disc_tls_certificate_expiration_time`) are
// allowed to look like unix epochs by design — the gauge name explicitly
// says "expiration_time" — so we whitelist that line by name.

Deno.test("no gauge other than tls_certificate_expiration_time reports a unix-epoch-shaped value", () => {
  const source = makeSource({
    cache: {
      compilation: { hits: 1, misses: 1, evictions: 0, size: 1 },
      parse: { hits: 1, misses: 1, evictions: 0, size: 1 },
    },
    pool: { total: 5, idle: 4, active: 1, waiters: 0 },
    rateLimit: { rejectedCount: 0, activeClients: 0 },
    tls: {
      notAfterUnix: 1893456000,
      secondsUntilExpiry: 100,
    },
  });
  const output = renderMetrics(source);

  // Lower bound ≈ 2020-01-01, upper bound ≈ 2050-01-01.
  const UNIX_LOW = 1_577_836_800;
  const UNIX_HIGH = 2_524_608_000;
  const ALLOWED_TIMESTAMP_GAUGES = new Set([
    "disc_tls_certificate_expiration_time",
  ]);

  let currentType: "gauge" | "counter" | undefined;
  let currentName: string | undefined;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("# TYPE ")) {
      const [, , name, kind] = line.split(/\s+/);
      currentName = name;
      currentType = kind === "gauge" ? "gauge" : "counter";
      continue;
    }
    if (line.startsWith("#")) continue;
    if (currentType !== "gauge") continue;
    if (!currentName) continue;
    if (ALLOWED_TIMESTAMP_GAUGES.has(currentName)) continue;

    // Sample line: "disc_query_cache_size 48"
    const match = line.match(/^(\S+)\s+(\S+)$/);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    const looksLikeEpoch = value >= UNIX_LOW && value <= UNIX_HIGH;
    assertEquals(
      looksLikeEpoch,
      false,
      `gauge ${currentName}=${value} looks like a unix epoch — see geldata/gel#5405`,
    );
  }
});

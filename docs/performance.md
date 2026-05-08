# Performance Guide

This guide covers the practical levers Disc exposes for query performance: indexing strategies, EXPLAIN-based diagnosis, the parse/compile/EXPLAIN caches, the connection pool, and the Prometheus gauges that reveal pressure on each of those subsystems.

Related documentation: [Schema](schema.md) | [Server Configuration](server.md) | [Production Deployment](production-deployment.md) | [Bundled PostgreSQL](bundled-postgres.md)

---

## Indexing

Disc translates SDL `index on (...)` clauses into PostgreSQL indexes during migration. The differ supports `btree` (default), `hash`, `gist`, `gin`, and `brin` methods (`migration/types.ts` `IndexDefinition.method`). Pick the method based on the access pattern:

| Method  | Best for                                                                                            |
| ------- | --------------------------------------------------------------------------------------------------- |
| `btree` | Equality and range queries on scalars (`=`, `<`, `>`, `between`, `order by`). The default.          |
| `hash`  | Equality lookups on a single column where range scans are never used.                               |
| `gin`   | Multi-valued types: arrays, JSON keys, full-text search vectors, trigram fuzzy match.               |
| `gist`  | Geometric/range types and nearest-neighbor queries (PostGIS, `tstzrange`, `daterange`).             |
| `brin`  | Very large tables where rows are physically clustered by an indexed column (e.g. append-only logs). |

Single-property index on `User.name`:

```
type User {
  required name: str;
  index on (.name);
};
```

Expression index on `lower(email)`:

```
type User {
  required email: str;
  index on (str_lower(.email));
};
```

Composite index on `(last_name, first_name)`:

```
type Person {
  required first_name: str;
  required last_name: str;
  index on ((.last_name, .first_name));
};
```

See [Schema → Indexes](schema.md#indexes) for the full SDL grammar (named indexes, annotated indexes, multi-property composites).

### Choosing what to index

Index the columns that appear in `filter`, `order by`, and `group by` clauses on hot queries. Foreign-key columns generated for `link` properties are not indexed automatically — add an explicit `index on (.author)` if you query `Post filter .author = <uuid>$id`. Don't over-index: every additional index slows down writes and consumes disk.

### Verifying an index is used

Use [EXPLAIN](#explain) (below) to confirm PostgreSQL actually picks the index for the planned query. A `Seq Scan` on a column you indexed usually means the predicate isn't sargable (e.g. `lower(email) = $1` against an index on `email` — switch to an expression index).

---

## EXPLAIN

EdgeQL's `analyze` keyword produces the underlying PostgreSQL `EXPLAIN ANALYZE` for a query, surfaced through Disc's compiler. Use it to diagnose slow queries.

### From the shell

```
disc> analyze select User { email, name } filter .email = "ada@example.com";

Seq Scan on user u  (cost=0.00..18.50 rows=1 width=64)
  Filter: (email = 'ada@example.com'::text)
```

### From the SDK

```typescript
const plan = await client.explain(
  `
  select User { email, name } filter .email = <str>$email
`,
  { email: "ada@example.com" }
);
console.log(plan);
```

### EXPLAIN cache

Disc caches `EXPLAIN` plan results in `lib/explain-cache.ts` to keep the admin UI's query analyzer responsive. The TTL is configurable via `DISC_EXPLAIN_CACHE_TTL` (default 300 000 ms / 5 minutes). The cache is keyed by the compiled SQL plus parameter signature — semantically identical EdgeQL with different literal arguments shares one entry.

For ad-hoc diagnosis on a stale query plan, restart the server or wait for the TTL to expire. EXPLAIN cache hits are not currently exposed as a metric; the cache is best-effort.

### Reading the plan

Look for these signals in the plan output:

| Signal                          | Meaning                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `Seq Scan` on a large table     | Missing or unused index. Add an index, or rewrite the predicate to be sargable.             |
| `Hash Join` with high `Buckets` | Joining on an unindexed FK. Add an index on the link's column.                              |
| `actual rows >> rows`           | PostgreSQL's row estimate is wrong; run `ANALYZE` on the table or check pg_stats freshness. |
| Repeated `Index Scan` in a loop | N+1 from nested shapes. Hoist the inner query into a `WITH` block or denormalize.           |

For complex EdgeQL with nested shapes, the generated SQL uses lateral subqueries; `EXPLAIN ANALYZE` reflects those as nested loops. That's expected — the goal is not avoiding loops but ensuring each iteration uses an index.

---

## Parse and Compilation Caches

Disc caches both EdgeQL parse trees and compiled SQL output. A repeated query with the same shape reuses both stages.

### Cache size

```bash
DISC_CACHE_MAX_SIZE=1000   # Default: 1000 entries each for parse + compile
```

Each entry holds a parsed AST or a compiled SQL string. Increase for large schemas with many distinct queries; reduce on memory-constrained hosts.

### Cache key cardinality

The compiled-SQL cache is keyed by EdgeQL source plus role-derived access context (`lib/query-cache.ts` `hashAccessContext`). The key intentionally hashes only the role, not `userId` — different users with the same role share one compiled-SQL entry, since user identity is bound at parameter time (`$user_id`), not compile time. This dramatically reduces cache pressure for multi-tenant deployments where every user runs the same `select Post filter .author = $self`.

### Hit-rate metrics

Both caches expose Prometheus counters via `/metrics`:

- `disc_parse_cache_hits_total`, `disc_parse_cache_misses_total`, `disc_parse_cache_size`
- `disc_query_cache_hits_total`, `disc_query_cache_misses_total`, `disc_query_cache_evictions_total`, `disc_query_cache_size`

Aim for a `disc_query_cache_hits_total / (hits + misses)` ratio above 0.7. Lower than that suggests churn — either `cacheMaxSize` is too small, or the schema is being reloaded faster than entries can warm up.

### Cache invalidation

Caches are flushed on schema reload (SIGHUP, `disc migrate`, or admin-UI schema edit). Plan accordingly: a quiet redeploy followed by a migration causes a brief cold-cache window where the first request for each query pays the parse + compile cost.

---

## Connection Pool

The PostgreSQL connection pool (`lib/connection-pool.ts`) sizes itself between `minConnections` (default 2) and `maxConnections` (default 10 inside the library, 100 on the server). The server's pool is configured via `DISC_MAX_CONNECTIONS`.

### Sizing

Total Disc connections across all instances must stay below PostgreSQL's `max_connections`:

```
DISC_MAX_CONNECTIONS * disc_instance_count <= pg_max_connections - 5
```

See [Production Deployment → Connection Pool Tuning](production-deployment.md#connection-pool-tuning) for a deployment-size matrix.

### Pool tunables

When constructing a pool programmatically (`new ConnectionPool(...)`), these knobs control behavior:

| Field                | Default     | Meaning                                                              |
| -------------------- | ----------- | -------------------------------------------------------------------- |
| `minConnections`     | `2`         | Minimum idle connections kept warm.                                  |
| `maxConnections`     | `10`        | Hard cap on simultaneously active connections.                       |
| `connectionTimeout`  | `30000` ms  | Max wait for a free connection before throwing `QueryTimeoutError`.  |
| `idleTimeout`        | `600000` ms | Idle connections older than this are closed during cleanup.          |
| `validateOnAcquire`  | `true`      | Run `SELECT 1` on each acquired connection to evict stale ones.      |
| `maxWaitQueueSize`   | `50`        | Reject new acquisitions when the wait queue is full (back-pressure). |
| `cleanupInterval`    | `60000` ms  | How often the pool reaps idle/stale connections.                     |
| `leakWarningTimeout` | `30000` ms  | Log a warning when a connection has been held for longer than this.  |

### Pool health metrics

Surface via `/metrics`:

- `disc_pool_connections_total` — total connections (active + idle).
- `disc_pool_connections_active` — currently acquired.
- `disc_pool_connections_idle` — pooled but not in use.
- `disc_pool_waiters` — requests blocked waiting for a connection.

Sustained `disc_pool_waiters > 0` is the canonical pool-pressure signal. When you see it:

1. Raise `DISC_MAX_CONNECTIONS` if the database has headroom.
2. Look for slow queries holding connections (slow-query log, EXPLAIN).
3. Add another Disc instance horizontally.
4. Insert PgBouncer in transaction mode for very high concurrency.

The full troubleshooting recipe lives in [Production Deployment → Connection Pool Exhaustion](production-deployment.md#connection-pool-exhaustion).

---

## Slow Query Logging

Set `DISC_SLOW_QUERY_MS` to log queries that exceed a threshold:

```bash
DISC_SLOW_QUERY_MS=200   # Log queries slower than 200ms
```

Each slow query emits a log line with the query hash, duration, parse/compile/execute split, and (when log level is DEBUG) the full EdgeQL text. Pair with the structured-JSON log format in production so an aggregator can index by `query_hash` and surface trends.

`DISC_SLOW_QUERY_MS=0` disables the threshold.

---

## Prometheus Gauges to Watch

A complete production dashboard should track these gauges over time:

| Metric                                | Type    | What to watch for                                               |
| ------------------------------------- | ------- | --------------------------------------------------------------- |
| `disc_http_requests_total`            | counter | Sudden drop = upstream outage. Steady growth = healthy traffic. |
| `disc_http_requests_failed_total`     | counter | Rising error rate vs. successful_total > 1% sustained.          |
| `disc_pool_connections_active`        | gauge   | Approaches `DISC_MAX_CONNECTIONS` → scale out.                  |
| `disc_pool_waiters`                   | gauge   | Sustained > 0 = pool pressure.                                  |
| `disc_query_cache_hits_total`         | counter | Combined with misses, derive cache hit rate (target ≥ 0.7).     |
| `disc_query_cache_evictions_total`    | counter | Rising evictions = `cacheMaxSize` too small for query churn.    |
| `disc_rate_limit_rejected_total`      | counter | Spikes = abuse, runaway client, or `RPM` set too low.           |
| `disc_process_memory_heap_used_bytes` | gauge   | Sustained growth = leak. Compare against heap_total.            |
| `disc_uptime_seconds`                 | gauge   | Resets on every restart — pair with restart-count alerts.       |

The `disc_tls_certificate_seconds_until_expiry` gauge from [Production Deployment → TLS](production-deployment.md#tls-certificate-hot-reload) is the alerting hook for cert renewal.

---

## When in Doubt

1. Run `analyze <query>` from `disc shell`.
2. Check `/stats` for cache hit rate and pool waiters.
3. Compare `disc_query_avg_compile_ms` over time — a rising trend means schema growth or cache churn.
4. Profile the slowest queries from the slow-query log against PostgreSQL `EXPLAIN ANALYZE` directly.

Most performance work in Disc is one of: missing index, undersized pool, or cache thrash. Identify which one with the metrics above before reaching for code changes.

---

## See Also

- [Schema → Indexes](schema.md#indexes) — full SDL syntax for indexes
- [Server Configuration](server.md) — cache / pool / metrics environment variables
- [Production Deployment](production-deployment.md) — sizing, health checks, troubleshooting
- [EdgeQL → EXPLAIN](edgeql.md#explain) — `analyze` semantics
- [Bundled PostgreSQL](bundled-postgres.md) — PG configuration knobs that feed the pool

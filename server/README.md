# Server

HTTP/JSON server for the Disc database. Handles EdgeQL query execution, WebSocket subscriptions, authentication, extension routing, health checks, metrics, and graceful lifecycle management.

## Starting the Server

### Programmatic

```typescript
import { createServerFromEnv, DiscServer } from "disc/server/server.ts";

// From environment variables
const server = createServerFromEnv();
await server.start();

// With explicit config
const server = new DiscServer({
  host: "localhost",
  port: 5656,
  databaseUrl: "postgresql://localhost:5432/disc",
  protocol: "full", // "simple" (default) or "full" (real EdgeQL compiler)
  enableAuth: true,
  jwtSecret: "my-secret",
});
await server.start();
await server.stop();
```

### Via CLI

```bash
disc start     # Start server + bundled PostgreSQL
disc serve     # Start server only
disc stop      # Graceful shutdown
```

## HTTP API Endpoints

### `GET /`

Returns server info and available endpoints.

```json
{
  "name": "Disc Database",
  "version": "0.1.0",
  "protocol": "HTTP/JSON",
  "endpoints": {
    "query": "/query",
    "health": "/health",
    "healthLive": "/health/live",
    "healthReady": "/health/ready",
    "stats": "/stats",
    "websocket": "ws://upgrade"
  }
}
```

### `POST /query`

Execute an EdgeQL query. Accepts JSON with `query`, optional `variables`, and optional `operationName`.

**Request:**

```json
{
  "query": "select User { name, email } filter .email = <str>$email",
  "variables": { "email": "ada@example.com" }
}
```

**Response (200):**

```json
{
  "data": [{ "name": "Ada", "email": "ada@example.com" }],
  "extensions": {
    "durationMs": 12,
    "parseMs": 1,
    "compileMs": 3,
    "executeMs": 8,
    "cacheHit": false,
    "queryHash": "abc123"
  }
}
```

**Error Response (400):**

```json
{
  "errors": [{
    "message": "Unknown type 'Userr'",
    "extensions": { "code": "COMPILATION_ERROR", "phase": "compilation" }
  }]
}
```

### `GET /health`

Full health status including database connectivity, connection pool stats, uptime, and extension health.

### `GET /health/live`

Liveness probe. Returns `200` with `{ "status": "alive" }` if the server process is running.

### `GET /health/ready`

Readiness probe. Returns `200` when the database is connected and the server can accept queries. Returns `503` when unhealthy.

### `GET /stats`

Server statistics: connections (active, total, HTTP, WebSocket), query metrics (total, successful, failed, avgDurationMs), transaction counts, memory usage, uptime, cache stats, and rate limit info.

### `GET /metrics`

Prometheus-compatible metrics endpoint. Only available when `enableMetrics` is true. Returns `text/plain; version=0.0.4` format.

### Auth Routes (`/auth/*`)

Available when `jwtSecret` is configured and `enableAuth` is not `false`.

| Method | Path                  | Description               |
| ------ | --------------------- | ------------------------- |
| POST   | `/auth/register`      | Register a new user       |
| POST   | `/auth/login`         | Login with email/username |
| POST   | `/auth/logout`        | Logout and revoke session |
| POST   | `/auth/refresh`       | Refresh access token      |
| GET    | `/auth/profile`       | Get current user profile  |
| POST   | `/auth/password`      | Update password           |
| POST   | `/auth/reset`         | Request password reset    |
| POST   | `/auth/reset/confirm` | Confirm password reset    |
| GET    | `/auth/verify`        | Verify email address      |

### Extension Routes (`/ext/*`)

Extensions register routes under `/ext/<extension-name>/<path>`. See the extensions module for details.

## WebSocket Protocol

Connect via WebSocket upgrade on the server URL. Messages are JSON objects with a `type` field.

### Client-to-Server Messages

**Query:**

```json
{ "type": "query", "payload": { "query": "select User { name }" } }
```

**Subscribe:**

```json
{
  "type": "subscribe",
  "payload": { "id": "sub_1", "query": "select User { name }" }
}
```

**Unsubscribe:**

```json
{ "type": "unsubscribe", "payload": { "subscriptionId": "sub_1" } }
```

### Server-to-Client Messages

```json
{ "type": "query_result", "payload": { "data": [...] } }
{ "type": "data", "id": "sub_1", "payload": [...] }
{ "type": "error", "payload": { "message": "..." } }
{ "type": "subscription_stopped", "payload": { "subscriptionId": "sub_1" } }
```

## Configuration

### ServerConfig

| Field                  | Type       | Default              | Description                             |
| ---------------------- | ---------- | -------------------- | --------------------------------------- |
| `host`                 | `string`   | `"localhost"`        | Bind address                            |
| `port`                 | `number`   | `5656`               | Listen port                             |
| `databaseUrl`          | `string`   | `"postgresql://..."` | PostgreSQL connection string            |
| `maxConnections`       | `number`   | `100`                | Max concurrent connections              |
| `requestTimeout`       | `number`   | `30000`              | Request timeout in ms                   |
| `enableCors`           | `boolean`  | `true`               | Enable CORS headers                     |
| `corsOrigins`          | `string[]` | `undefined`          | Allowed CORS origins                    |
| `enableWebsockets`     | `boolean`  | `true`               | Enable WebSocket upgrade                |
| `jwtSecret`            | `string`   | `undefined`          | JWT signing secret (enables auth)       |
| `enableAuth`           | `boolean`  | `undefined`          | Explicit auth toggle                    |
| `enableAccessPolicies` | `boolean`  | `undefined`          | Enable SDL access policy enforcement    |
| `cacheMaxSize`         | `number`   | `1000`               | Max entries in parse/compilation caches |
| `shutdownDrainTimeout` | `number`   | `30000`              | Drain timeout on shutdown in ms         |
| `slowQueryThresholdMs` | `number`   | `1000`               | Slow query log threshold                |
| `enableMetrics`        | `boolean`  | `false`              | Enable `/metrics` endpoint              |
| `rateLimitRpm`         | `number`   | `undefined`          | Requests per minute per IP              |
| `rateLimitBurst`       | `number`   | `undefined`          | Burst size for rate limiter             |
| `tls`                  | `object`   | `undefined`          | TLS certificate and key paths           |

### Environment Variables

| Variable                      | Maps To                               |
| ----------------------------- | ------------------------------------- |
| `DISC_HOST`                   | `host`                                |
| `DISC_PORT`                   | `port`                                |
| `DATABASE_URL`                | `databaseUrl`                         |
| `DISC_MAX_CONNECTIONS`        | `maxConnections`                      |
| `DISC_REQUEST_TIMEOUT`        | `requestTimeout`                      |
| `DISC_ENABLE_CORS`            | `enableCors`                          |
| `DISC_CORS_ORIGINS`           | `corsOrigins` (comma-separated)       |
| `DISC_ENABLE_WEBSOCKETS`      | `enableWebsockets`                    |
| `DISC_JWT_SECRET`             | `jwtSecret`                           |
| `DISC_ENABLE_AUTH`            | `enableAuth`                          |
| `DISC_ENABLE_ACCESS_POLICIES` | `enableAccessPolicies`                |
| `DISC_CACHE_MAX_SIZE`         | `cacheMaxSize`                        |
| `DISC_SLOW_QUERY_MS`          | `slowQueryThresholdMs`                |
| `DISC_ENABLE_METRICS`         | `enableMetrics`                       |
| `DISC_RATE_LIMIT_RPM`         | `rateLimitRpm`                        |
| `DISC_RATE_LIMIT_BURST`       | `rateLimitBurst`                      |
| `DISC_PROTOCOL`               | `protocol` ("simple"/"full")          |
| `DISC_LOG_LEVEL`              | Logging level (DEBUG/INFO/WARN/ERROR) |
| `DISC_LOG_FORMAT`             | Logging format ("json"/"text")        |
| `DISC_TLS_CERT`               | TLS certificate file path             |
| `DISC_TLS_KEY`                | TLS key file path                     |
| `DISC_TLS_REDIRECT`           | Enable HTTP-to-HTTPS redirect         |
| `DISC_TLS_REDIRECT_PORT`      | HTTP redirect listen port             |
| `DISC_EXPLAIN_CACHE_TTL`      | EXPLAIN plan cache TTL in ms          |

## Server Lifecycle

1. **Start**: Initialize protocol handler (connection pool), auth system, extensions, then start HTTP server.
2. **Running**: Handle requests, manage connections/sessions/transactions, periodic cleanup of idle connections (5 min), expired sessions (10 min), and abandoned transactions (2 min).
3. **Shutdown**: Set shutting-down flag (reject new requests with 503), drain in-flight requests up to `shutdownDrainTimeout`, shut down extensions, close protocol handler pool, close auth DB connection.

Signal handlers for `SIGINT` and `SIGTERM` trigger graceful shutdown.

## Protocol Handlers

The server supports two protocol handler implementations:

- **`SimpleEdgeQLProtocolHandler`** (default): Simulated compilation for development and testing.
- **`EdgeQLProtocolHandler`**: Full EdgeQL parser, compiler, and SQL generation with real PostgreSQL execution. Includes parse and compilation caches, EXPLAIN plan caching, slow query logging, and query timeout enforcement.

## Rate Limiting

When `rateLimitRpm` is set, a token-bucket rate limiter enforces per-IP request limits. Excess requests receive `429 Too Many Requests` with a `Retry-After: 60` header.

## Query & Compilation Caches

The protocol handler keeps two LRU caches:

- **Parse cache** — keyed by `(query text)`. Stable across users and sessions.
- **Compilation cache** — keyed by `(query text, role hash)`. Compiled SQL is
  parameterized on `$user_id` / `$current_user`, so the plan shape depends on
  which policies apply (a function of role), not on the concrete user running
  it. **All users with the same role share one cache entry per query.** (P1-13:
  prior implementation included `userId` in the key, which caused cardinality
  to scale with active-user count rather than role count.)

Sizing guidance:

| Scenario | Suggested `cacheMaxSize` |
|---------|--------------------------|
| Public site, no auth policies | 500–2 000 (query count only) |
| Multi-role app (≤10 roles), policies on | (query count) × (role count) |
| Per-user dynamic policies | not currently distinguished from role; revisit if added |

`DISC_CACHE_MAX_SIZE` sets the bound. `/stats` exposes live hit/miss/eviction rates.

## TLS

Configure TLS by providing certificate and key file paths:

```typescript
const server = new DiscServer({
  tls: {
    certFile: "/path/to/cert.pem",
    keyFile: "/path/to/key.pem",
    redirect: true, // optional: redirect HTTP to HTTPS
    redirectPort: 80, // optional: HTTP redirect listen port
  },
});
```

## Key Exports

From `server/server.ts`:

- `DiscServer` -- main server class
- `DiscServerOptions` -- constructor options interface
- `createDefaultConfig()` -- default ServerConfig
- `createServerFromEnv()` -- create server from environment variables
- `HttpServer` -- low-level HTTP server
- `EdgeQLProtocolHandler` -- full protocol handler
- `SimpleEdgeQLProtocolHandler` -- simple protocol handler
- `ConnectionManager`, `SessionManager`, `TransactionManager` -- connection management

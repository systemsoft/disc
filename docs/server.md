# Server Configuration

The Disc server provides an HTTP/JSON API for executing EdgeQL queries, WebSocket subscriptions, authentication, schema introspection, extension routing, health checks, and Prometheus metrics. It runs on Deno and connects to PostgreSQL (bundled or external) as its storage backend.

---

## Starting the Server

### Via CLI

```bash
disc serve    # Start the server
disc start    # Start server + bundled PostgreSQL
disc stop     # Graceful shutdown
disc status   # Show instance status
```

#### CLI Flags

| Flag                       | Description                                 |
| -------------------------- | ------------------------------------------- |
| `--enable-access-policies` | Enable object-level access policies         |
| `--enable-auth`            | Enable the auth subsystem                   |
| `--host <host>`            | Bind address (default: localhost)           |
| `--jwt-secret <key>`       | Enable authentication with this signing key |
| `--port <port>`            | HTTP port (default: 5656)                   |
| `--tls-cert <path>`        | Path to TLS certificate for HTTPS           |
| `--tls-key <path>`         | Path to TLS private key                     |

### Programmatic

```typescript
import { createServerFromEnv, DiscServer } from "disc/server/server.ts";

// Create from environment variables
const server = createServerFromEnv();
await server.start();

// Or with explicit configuration
const server = new DiscServer({
  databaseUrl: "postgresql://localhost:5432/disc",
  enableAuth: true,
  enableMetrics: true,
  host: "0.0.0.0",
  jwtSecret: "my-secret-key",
  port: 5656,
  protocol: "full",
  rateLimitRpm: 600
});

await server.start();
```

The `createServerFromEnv()` function reads all configuration from environment variables and optionally accepts a `PostgresInstance` (for bundled mode), a parsed `Schema`, and a list of extensions:

```typescript
import { PostgresInstance } from "disc/postgres/instance.ts";
import { createServerFromEnv } from "disc/server/server.ts";

const pg = new PostgresInstance({ dataDir: "~/.disc/instances/myapp/data" });
await pg.start();

const server = createServerFromEnv(pg);
await server.start();
```

---

## Configuration

### Environment Variables

All server configuration can be set via environment variables. The `createServerFromEnv()` function reads these at startup.

#### Core

| Variable               | Default                            | Description                          |
| ---------------------- | ---------------------------------- | ------------------------------------ |
| `DATABASE_URL`         | `postgresql://localhost:5432/disc` | PostgreSQL connection string         |
| `DISC_HOST`            | `localhost`                        | Bind address                         |
| `DISC_MAX_CONNECTIONS` | `100`                              | Max concurrent connections           |
| `DISC_PORT`            | `5656`                             | HTTP listen port                     |
| `DISC_PROTOCOL`        | `simple`                           | Protocol handler: `simple` or `full` |
| `DISC_REQUEST_TIMEOUT` | `30000`                            | Request timeout in milliseconds      |

#### Authentication

| Variable                      | Default | Description                                                     |
| ----------------------------- | ------- | --------------------------------------------------------------- |
| `DISC_ENABLE_ACCESS_POLICIES` | (none)  | Enable SDL access policy enforcement                            |
| `DISC_ENABLE_AUTH`            | (auto)  | Explicit auth toggle (`true`/`false`)                           |
| `DISC_JWT_SECRET`             | (none)  | JWT signing secret. Enables auth when set.                      |
| `DISC_REQUIRE_AUTH`           | `false` | Gate `/query`, `/schema*`, `/migrations`, `/stats`, `/metrics`. |
| `DISC_READ_ONLY`              | `false` | Reject INSERT/UPDATE/DELETE/CONFIGURE at AST level.             |

#### CORS

| Variable                 | Default | Description                                        |
| ------------------------ | ------- | -------------------------------------------------- |
| `DISC_CORS_ORIGINS`      | (none)  | Comma-separated allowed origins                    |
| `DISC_ENABLE_CORS`       | `true`  | Enable CORS headers on all responses               |
| `DISC_ENABLE_WEBSOCKETS` | `true`  | Enable WebSocket upgrade                           |
| `DISC_TRUST_PROXY`       | `false` | Honor `X-Forwarded-{For,Proto}` from a known proxy |

#### TLS

| Variable                 | Default | Description                                                                       |
| ------------------------ | ------- | --------------------------------------------------------------------------------- |
| `DISC_TLS_CERT`          | (none)  | Path to TLS certificate file                                                      |
| `DISC_TLS_CERT_ENV`      | (none)  | Name of an env var holding the PEM cert (used in lieu of a path; gh/geldata#4547) |
| `DISC_TLS_KEY`           | (none)  | Path to TLS private key file                                                      |
| `DISC_TLS_KEY_ENV`       | (none)  | Name of an env var holding the PEM key                                            |
| `DISC_TLS_REDIRECT`      | `false` | Redirect HTTP to HTTPS                                                            |
| `DISC_TLS_REDIRECT_PORT` | `80`    | Port for the HTTP redirect listener                                               |

#### Rate Limiting

| Variable                | Default | Description                                |
| ----------------------- | ------- | ------------------------------------------ |
| `DISC_RATE_LIMIT_BURST` | (none)  | Burst size for the token bucket            |
| `DISC_RATE_LIMIT_RPM`   | (none)  | Requests per minute per IP (disabled if 0) |

#### Caching and Performance

| Variable                 | Default  | Description                                 |
| ------------------------ | -------- | ------------------------------------------- |
| `DISC_CACHE_MAX_SIZE`    | `1000`   | Max entries in parse and compilation caches |
| `DISC_EXPLAIN_CACHE_TTL` | `300000` | EXPLAIN plan cache TTL in milliseconds      |
| `DISC_SLOW_QUERY_MS`     | `1000`   | Log queries slower than this threshold (ms) |

#### Logging

| Variable          | Default | Description                                 |
| ----------------- | ------- | ------------------------------------------- |
| `DISC_LOG_FORMAT` | `json`  | Log format: `json` or `text`                |
| `DISC_LOG_LEVEL`  | `INFO`  | Log level: `DEBUG`, `INFO`, `WARN`, `ERROR` |

#### Observability

| Variable              | Default | Description                               |
| --------------------- | ------- | ----------------------------------------- |
| `DISC_ENABLE_METRICS` | `false` | Enable the `/metrics` Prometheus endpoint |

#### Multi-Database

| Variable                     | Default | Description                   |
| ---------------------------- | ------- | ----------------------------- |
| `DISC_ENABLE_MULTI_DATABASE` | `false` | Enable multi-database routing |

#### Admin Features

| Variable                 | Default | Description                                                                                                                                        |
| ------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISC_ENABLE_DATA_WATCH` | `true`  | Enable the live-data subscription endpoint at `/admin/data-watch` (Bundle L). Set `false` to skip both the trigger bootstrap and the SSE endpoint. |
| `DISC_ENABLE_REST`       | `true`  | Enable the schema-derived REST surface at `/api/<Type>` (Bundle J). Set `false` to disable.                                                        |

#### Shutdown

| Variable                      | Default | Description                                                     |
| ----------------------------- | ------- | --------------------------------------------------------------- |
| `DISC_SHUTDOWN_DRAIN_TIMEOUT` | `30000` | Max ms to wait for in-flight requests during graceful shutdown. |

#### Binary Protocol

| Variable                   | Default | Description                                                                |
| -------------------------- | ------- | -------------------------------------------------------------------------- |
| `DISC_BINARY_PORT`         | (none)  | Port for the Gel-compatible binary protocol                                |
| `DISC_BINARY_PASSWORD`     | (none)  | Password for SCRAM-SHA-256 auth on the binary listener                     |
| `DISC_BINARY_TLS_CERT`     | (none)  | TLS certificate for the binary listener (required by upstream Gel clients) |
| `DISC_BINARY_TLS_CERT_ENV` | (none)  | Name of an env var holding the PEM cert (gh/geldata#4547)                  |
| `DISC_BINARY_TLS_KEY`      | (none)  | TLS private key for the binary listener                                    |
| `DISC_BINARY_TLS_KEY_ENV`  | (none)  | Name of an env var holding the PEM key                                     |

> The `[server]` knobs `corsAllowCredentials`, `corsAllowedHeaders`,
> `corsAllowedMethods`, `corsExposeHeaders`, `corsMaxAge`, and
> `maxRequestBodyBytes` remain `disc.toml`-only — they're project-level
> defaults rather than per-deployment knobs. See [Project Context Resolution](cli.md#project-context-resolution) for the full table.
> Secrets (JWT, bcrypt rounds) stay env/CLI-only and never live in
> `disc.toml`.

### ServerConfig Reference

When constructing a `DiscServer` programmatically, you pass a `DiscServerOptions` object. All fields are optional.

```typescript
interface DiscServerOptions {
  binaryPassword?: string;
  binaryPort?: number;
  cacheMaxSize?: number; // default: 1000
  corsAllowedHeaders?: string[]; // preflight Access-Control-Allow-Headers
  corsAllowedMethods?: string[]; // preflight Access-Control-Allow-Methods
  corsAllowCredentials?: boolean; // emit Access-Control-Allow-Credentials
  corsExposeHeaders?: string[]; // Access-Control-Expose-Headers
  corsMaxAge?: number; // default: 86400 (24 h)
  corsOrigins?: string[];
  databases?: Record<string, string>;
  databaseUrl?: string; // default: "postgresql://localhost:5432/disc"
  dryRun?: boolean; // skip write side-effects (test mode)
  enableAccessPolicies?: boolean;
  enableAuth?: boolean;
  enableCors?: boolean; // default: true
  enableExplain?: boolean; // EXPLAIN plan caching (full protocol only)
  enableMetrics?: boolean; // default: false
  enableMultiDatabase?: boolean;
  enableWebsockets?: boolean; // default: true
  extensions?: Extension[];
  host?: string; // default: "localhost"
  jwtSecret?: string;
  maxConnections?: number; // default: 100
  maxRequestBodyBytes?: number; // default: 4 MiB
  port?: number; // default: 5656
  postgresInstance?: PostgresInstance;
  protocol?: "simple" | "full"; // default: "full" (env override "simple")
  rateLimitBurst?: number;
  rateLimitRpm?: number;
  readOnly?: boolean; // reject INSERT/UPDATE/DELETE/CONFIGURE
  requestTimeout?: number; // default: 30000
  requireAuth?: boolean; // gate data-plane on Authorization header
  schema?: Schema;
  shutdownDrainTimeout?: number; // default: 30000
  slowQueryThresholdMs?: number; // default: 1000
  tls?: {
    certFile: string;
    keyFile: string;
    redirect?: boolean;
    redirectPort?: number;
    reload?: boolean; // hot-reload on file change
    reloadDebounceMs?: number; // debounce window, default 500
  };
  trustProxy?: boolean; // honor X-Forwarded-* headers
}
```

---

---

## Connection Resolution

Every Disc server (and CLI command that needs a database connection) resolves the PostgreSQL DSN in this order, taking the first one that yields a value:

1. **`--backend-dsn` CLI flag.** Explicit external PostgreSQL. Always wins.
2. **`DATABASE_URL` environment variable.** Standard 12-factor.
3. **`disc.toml` project context.** Walks up from `cwd` looking for `disc.toml` (like `git`); when found and `[database].managed = true`, builds a Unix-socket DSN against the managed instance. When `[database].backend_dsn = "..."` is set, returns that.
4. **Hardcoded fallback:** `postgresql://localhost:5432/disc_dev`.

The resolver lives in `lib/project-context.ts` (`resolveProjectContext` walks up; `resolveDsn` builds the connection string). For commands that auto-start the bundled PostgreSQL (`serve`, `migrate`, `shell`, `start`), `postgres/ensure-running.ts` (`ensurePgRunning`) takes the resolved context and discovers/starts/creates the instance as needed.

### `disc.toml` keys vs env vars vs CLI flags

| Setting       | CLI flag           | env var                         | `disc.toml`                                                      |
| ------------- | ------------------ | ------------------------------- | ---------------------------------------------------------------- |
| Database URL  | `--backend-dsn`    | `DATABASE_URL`                  | `[database] backend_dsn`                                         |
| Managed PG    | (auto)             | (auto)                          | `[database] managed = true`                                      |
| Instance name | (auto from `name`) | (auto)                          | `[database] instance_name`                                       |
| Server host   | `--host`/`-H`      | `DISC_HOST`                     | `[server] host`                                                  |
| Server port   | `--port`           | `DISC_PORT`                     | `[server] port`                                                  |
| JWT secret    | `--jwt-secret`     | `DISC_JWT_SECRET`               | (env/CLI only — secret)                                          |
| TLS cert/key  | `--tls-cert/key`   | `DISC_TLS_CERT[_ENV]/KEY[_ENV]` | (env/CLI only — secret-adjacent)                                 |
| Require auth  | `--require-auth`   | `DISC_REQUIRE_AUTH`             | `[server] require_auth`                                          |
| Read-only     | `--read-only`      | `DISC_READ_ONLY`                | `[server] read_only`                                             |
| Trust proxy   | `--trust-proxy`    | `DISC_TRUST_PROXY`              | `[server] trust_proxy`                                           |
| CORS knobs    | (none)             | `DISC_CORS_ORIGINS`             | `[server] enable_cors`, `cors_origins`, `cors_allow_credentials` |
| Drain timeout | (none)             | `DISC_SHUTDOWN_DRAIN_TIMEOUT`   | (env/CLI only)                                                   |
| Rate limit    | (none)             | `DISC_RATE_LIMIT_RPM`           | `[server] rate_limit_rpm`                                        |
| Binary port   | `--binary-port`    | `DISC_BINARY_PORT`              | (env/CLI only)                                                   |

CLI flags always win over env vars, which always win over `disc.toml`. Secrets (JWT, TLS keys) deliberately have no `disc.toml` representation — they belong in env / a secrets manager, not in a tracked file. See [CLI → Project Context Resolution](cli.md#project-context-resolution) for the full `disc.toml` reference.

---

## HTTP API Endpoints

### `GET /`

Returns server information and a listing of all available endpoints. Useful for service discovery.

**Response (200):**

```json
{
  "endpoints": {
    "auth": {
      "login": "/auth/login",
      "logout": "/auth/logout",
      "refresh": "/auth/refresh",
      "register": "/auth/register",
      "reset": "/auth/reset",
      "reset_confirm": "/auth/reset/confirm",
      "password": "/auth/password",
      "profile": "/auth/profile",
      "verify": "/auth/verify"
    },
    "health": "/health",
    "healthLive": "/health/live",
    "healthReady": "/health/ready",
    "metrics": "/metrics",
    "query": "/query",
    "schema": {
      "describe": "/schema",
      "type": "/schema/types/:name",
      "types": "/schema/types"
    },
    "stats": "/stats",
    "websocket": "ws://upgrade"
  },
  "name": "Disc Database",
  "protocol": "HTTP/JSON",
  "version": "0.1.0"
}
```

The `auth`, `schema`, `metrics`, and `extensions` sections only appear when those features are enabled.

### `POST /query`

Execute an EdgeQL query. This is the primary endpoint for all data operations.

**Request body:**

```json
{
  "query": "select User { email, name } filter .email = <str>$email",
  "variables": { "email": "ada@example.com" }
}
```

| Field           | Type                      | Required | Description                      |
| --------------- | ------------------------- | -------- | -------------------------------- |
| `operationName` | `string`                  | No       | Operation name (for multi-query) |
| `query`         | `string`                  | Yes      | EdgeQL query string              |
| `variables`     | `Record<string, unknown>` | No       | Query parameters                 |

**Successful response (200):**

```json
{
  "data": [
    {
      "email": "ada@example.com",
      "name": "Ada"
    }
  ],
  "extensions": {
    "cacheHit": false,
    "compileMs": 3,
    "durationMs": 12,
    "executeMs": 8,
    "parseMs": 1,
    "queryHash": "a1b2c3d4"
  }
}
```

**Error response (400):**

```json
{
  "errors": [
    {
      "extensions": {
        "code": "COMPILATION_ERROR",
        "phase": "compilation"
      },
      "message": "Unknown type 'Userr'"
    }
  ]
}
```

**Validation error (400):**

```json
{
  "errors": [
    {
      "extensions": { "code": "VALIDATION_ERROR" },
      "message": "Query is required and must be a string"
    }
  ]
}
```

**Timeout (408):**

```json
{
  "errors": [
    {
      "extensions": { "code": "TIMEOUT" },
      "message": "Request timed out after 30000ms"
    }
  ]
}
```

The query endpoint validates requests before execution. Validation checks include:

- Query must be a non-empty string.
- Query must not exceed 100KB.
- Variables, if provided, must be an object.
- Basic EdgeQL syntax validation (balanced braces, valid start keyword).

### `GET /health`

Full health status including database connectivity, connection pool stats, server uptime, and extension health.

**Response (200 when healthy, 503 when unhealthy):**

```json
{
  "database": {
    "connected": true,
    "latencyMs": 2
  },
  "extensions": {
    "full-text-search": { "healthy": true },
    "graphql": { "healthy": true }
  },
  "pool": {
    "active": 2,
    "idle": 8,
    "total": 10,
    "waiters": 0
  },
  "status": "healthy",
  "timestamp": "2026-03-20T12:00:00.000Z",
  "uptimeMs": 3600000
}
```

The `status` field is one of:

- `"healthy"` -- database connected, pool has capacity.
- `"degraded"` -- database connected but pool has waiters queued.
- `"unhealthy"` -- database unreachable or pool closed.

### `GET /health/live`

Lightweight liveness probe. Returns 200 if the server process is running.

```json
{ "status": "alive" }
```

Use this for Kubernetes liveness probes or load balancer health checks where you only need to know the process is alive.

### `GET /health/ready`

Readiness probe. Returns 200 when the database is connected and the server can accept queries. Returns 503 when the database is unreachable.

```json
{ "status": "healthy" }
```

Use this for Kubernetes readiness probes to control whether traffic is routed to this instance.

### `GET /stats`

Detailed server statistics for monitoring and debugging.

**Response (200):**

```json
{
  "cache": {
    "compilation": {
      "evictions": 0,
      "hitRate": 0.8,
      "hits": 1200,
      "misses": 300,
      "size": 300
    },
    "parse": {
      "evictions": 0,
      "hitRate": 0.73,
      "hits": 1100,
      "misses": 400,
      "size": 400
    }
  },
  "connections": {
    "active": 5,
    "http": 40,
    "total": 42,
    "websocket": 2
  },
  "memoryUsage": {
    "external": 1048576,
    "heapTotal": 67108864,
    "heapUsed": 52428800
  },
  "queries": {
    "avgDurationMs": 15.3,
    "failed": 20,
    "successful": 1480,
    "total": 1500
  },
  "queryMetrics": {
    "avgCompileMs": 2.1,
    "avgExecuteMs": 12.7,
    "avgParseMs": 0.5,
    "cacheHitRate": 0.8,
    "totalQueries": 1500
  },
  "rateLimit": {
    "activeClients": 12,
    "rejectedCount": 3
  },
  "transactions": {
    "active": 1,
    "committed": 300,
    "rolledBack": 5
  },
  "uptimeMs": 3600000
}
```

### `GET /metrics`

Prometheus-compatible metrics endpoint. Only available when `DISC_ENABLE_METRICS=true` (or `enableMetrics: true` in config). Returns `text/plain; version=0.0.4` format.

**Response (200):**

```
# HELP disc_http_requests_total Total HTTP requests
# TYPE disc_http_requests_total counter
disc_http_requests_total 1500
# HELP disc_http_requests_successful_total Successful HTTP requests
# TYPE disc_http_requests_successful_total counter
disc_http_requests_successful_total 1480
# HELP disc_http_requests_failed_total Failed HTTP requests
# TYPE disc_http_requests_failed_total counter
disc_http_requests_failed_total 20
# HELP disc_query_cache_hits_total Query compilation cache hits
# TYPE disc_query_cache_hits_total counter
disc_query_cache_hits_total 1200
# HELP disc_pool_connections_active Active pool connections
# TYPE disc_pool_connections_active gauge
disc_pool_connections_active 2
# HELP disc_process_memory_heap_used_bytes Process heap memory used
# TYPE disc_process_memory_heap_used_bytes gauge
disc_process_memory_heap_used_bytes 52428800
# HELP disc_uptime_seconds Server uptime in seconds
# TYPE disc_uptime_seconds gauge
disc_uptime_seconds 3600
```

Available metric families:

| Metric                                 | Type    | Description                      |
| -------------------------------------- | ------- | -------------------------------- |
| `disc_http_requests_failed_total`      | counter | Failed HTTP requests             |
| `disc_http_requests_successful_total`  | counter | Successful HTTP requests         |
| `disc_http_requests_total`             | counter | Total HTTP requests              |
| `disc_parse_cache_hits_total`          | counter | Parse cache hits                 |
| `disc_parse_cache_misses_total`        | counter | Parse cache misses               |
| `disc_parse_cache_size`                | gauge   | Current parse cache size         |
| `disc_pool_connections_active`         | gauge   | Active pool connections          |
| `disc_pool_connections_idle`           | gauge   | Idle pool connections            |
| `disc_pool_connections_total`          | gauge   | Total pool connections           |
| `disc_pool_waiters`                    | gauge   | Pool connection waiters          |
| `disc_process_memory_external_bytes`   | gauge   | Process external memory          |
| `disc_process_memory_heap_total_bytes` | gauge   | Process heap memory total        |
| `disc_process_memory_heap_used_bytes`  | gauge   | Process heap memory used         |
| `disc_query_cache_evictions_total`     | counter | Compilation cache evictions      |
| `disc_query_cache_hits_total`          | counter | Compilation cache hits           |
| `disc_query_cache_misses_total`        | counter | Compilation cache misses         |
| `disc_query_cache_size`                | gauge   | Current compilation cache size   |
| `disc_rate_limit_active_clients`       | gauge   | Active rate limit client buckets |
| `disc_rate_limit_rejected_total`       | counter | Rate-limited requests rejected   |
| `disc_uptime_seconds`                  | gauge   | Server uptime in seconds         |

### Schema Introspection

| Method | Path                  | Description                     |
| ------ | --------------------- | ------------------------------- |
| GET    | `/schema`             | Full schema description         |
| GET    | `/schema/types`       | List all object types           |
| GET    | `/schema/types/:name` | Get details for a specific type |

These endpoints are available when a schema is loaded into the server.

### Auth Endpoints

Available when `jwtSecret` is configured and `enableAuth` is not `false`. For full details, see the [Auth documentation](auth.md).

| Method | Path                  | Description                       |
| ------ | --------------------- | --------------------------------- |
| POST   | `/auth/login`         | Login with email/username         |
| POST   | `/auth/logout`        | Logout and revoke session         |
| POST   | `/auth/password`      | Update password                   |
| GET    | `/auth/profile`       | Get current user profile          |
| POST   | `/auth/refresh`       | Refresh access token              |
| POST   | `/auth/register`      | Register a new user               |
| POST   | `/auth/reset`         | Request password reset            |
| POST   | `/auth/reset/confirm` | Confirm password reset with token |
| GET    | `/auth/verify`        | Verify email address              |

### Extension Endpoints

Extensions register routes under `/ext/<extension-name>/<path>`. For details, see the [Extensions documentation](extensions.md).

### Admin UI

The admin UI is served at `/ui` when enabled. For details, see the [Admin UI documentation](admin-ui.md).

---

## WebSocket Protocol

The Disc server supports WebSocket connections for real-time queries and subscriptions. Connect by sending a WebSocket upgrade request to the server URL.

### Connecting

```typescript
const ws = new WebSocket("ws://localhost:5656");
```

WebSocket support must be enabled on the server (`enableWebsockets: true`, the default).

### Client-to-Server Messages

All messages are JSON objects with a `type` field.

**Query:**

Execute a one-off query and receive the result.

```json
{
  "payload": {
    "query": "select User { email, name }",
    "variables": {}
  },
  "type": "query"
}
```

**Subscribe:**

Start a subscription. The server sends `data` messages whenever results change.

```json
{
  "payload": {
    "id": "sub_12345",
    "query": "select User { email, name }",
    "variables": {}
  },
  "type": "subscribe"
}
```

**Unsubscribe:**

Stop receiving updates for a subscription.

```json
{
  "payload": {
    "subscriptionId": "sub_12345"
  },
  "type": "unsubscribe"
}
```

### Server-to-Client Messages

**Query result:**

```json
{
  "payload": {
    "data": [{
      "email": "ada@example.com",
      "name": "Ada"
    }]
  },
  "type": "query_result"
}
```

**Subscription data:**

```json
{
  "id": "sub_12345",
  "payload": [{
    "email": "ada@example.com",
    "name": "Ada"
  }],
  "type": "data"
}
```

**Error:**

```json
{
  "payload": { "message": "Invalid message format" },
  "type": "error"
}
```

**Subscription stopped:**

```json
{
  "payload": { "subscriptionId": "sub_12345" },
  "type": "subscription_stopped"
}
```

For a high-level client, use the SDK’s `SubscriptionClient` (see [Client SDK](client-sdk.md)).

---

## Binary Protocol

Disc supports a Gel-compatible binary wire protocol for interoperability with existing Gel/EdgeDB client libraries. This runs on a separate port from the HTTP server.

### Enabling

Set the binary port via config or environment variable:

```bash
DISC_BINARY_PORT=5657
```

Or programmatically:

```typescript
const server = new DiscServer({
  binaryPassword: "secret",
  binaryPort: 5657
});
```

### Authentication

The binary protocol uses SCRAM-SHA-256 authentication. Set a password via `binaryPassword` in the server options. If no password is set, authentication is not required.

### Protocol Details

The binary protocol shares the same schema as the HTTP handler. Queries submitted via binary protocol go through the same EdgeQL parser, compiler, and execution pipeline. This means existing Gel client libraries (Python, JavaScript, Go, etc.) can connect to a Disc server.

---

## Multi-Database

Disc can route queries to different PostgreSQL databases within the same cluster. Each named database gets its own connection pool and can have its own schema and migrations.

### Enabling

```bash
DISC_ENABLE_MULTI_DATABASE=true
```

Or programmatically:

```typescript
const server = new DiscServer({
  enableMultiDatabase: true
});
```

### Targeting a Database

Clients specify the target database using one of these methods (in order of precedence):

1. **`X-Database` header** -- set on the HTTP request.
2. **`?database=` query parameter** -- appended to the request URL.
3. **Default** -- falls back to `"disc"`.

```bash
# Via header
curl -H "X-Database: analytics" \
     -d '{"query": "select Event { name }"}' \
     http://localhost:5656/query

# Via query parameter
curl -d '{"query": "select Event { name }"}' \
     http://localhost:5656/query?database=analytics
```

### Database Names

Database names must start with a lowercase letter and contain only lowercase letters, digits, and underscores. Disc prefixes all managed PostgreSQL databases with `disc_` to avoid collisions with system databases.

---

## Rate Limiting

The server uses a token-bucket rate limiter keyed by client IP address.

### Configuration

```bash
DISC_RATE_LIMIT_RPM=600   # 600 requests per minute per IP
DISC_RATE_LIMIT_BURST=600 # burst size (defaults to RPM value)
```

Or programmatically:

```typescript
const server = new DiscServer({
  rateLimitBurst: 100,
  rateLimitRpm: 600
});
```

### Behavior

- Each client IP gets a token bucket that refills at `rateLimitRpm / 60` tokens per second.
- The bucket holds at most `rateLimitBurst` tokens. This allows short bursts above the average rate.
- When a client exhausts its tokens, the server responds with `429 Too Many Requests` and a `Retry-After: 60` header.
- Idle client buckets are cleaned up after 2 minutes of inactivity.

Rate limiting is applied before any request processing, including before incrementing request counters or creating connection/session objects.

---

## TLS / HTTPS

### Configuration

Provide certificate and key file paths to enable HTTPS:

```bash
DISC_TLS_CERT=/path/to/cert.pem
DISC_TLS_KEY=/path/to/key.pem
```

Or programmatically:

```typescript
const server = new DiscServer({
  tls: {
    certFile: "/path/to/cert.pem",
    keyFile: "/path/to/key.pem"
  }
});
```

### HTTP-to-HTTPS Redirect

Enable automatic redirect from HTTP to HTTPS:

```bash
DISC_TLS_CERT=/path/to/cert.pem
DISC_TLS_KEY=/path/to/key.pem
DISC_TLS_REDIRECT=true
DISC_TLS_REDIRECT_PORT=80
```

Or:

```typescript
const server = new DiscServer({
  tls: {
    certFile: "/path/to/cert.pem",
    keyFile: "/path/to/key.pem",
    redirect: true,
    redirectPort: 80
  }
});
```

When redirect is enabled, the server starts a second HTTP listener on `redirectPort` that responds to all requests with a `301 Moved Permanently` redirect to the HTTPS equivalent.

---

## Graceful Shutdown

The server handles `SIGTERM` and `SIGINT` signals for graceful shutdown.

### Shutdown Sequence

1. **Signal received** -- the server sets a shutting-down flag.
2. **Reject new requests** -- all new incoming requests receive `503 Service Unavailable` with `{"error": "Server is shutting down"}`.
3. **Drain in-flight requests** -- the server waits for all currently processing requests to complete, up to `shutdownDrainTimeout` milliseconds (default: 30000).
4. **Stop binary protocol server** -- if running, the binary protocol server is shut down.
5. **Stop HTTP server** -- the Deno HTTP server is shut down.
6. **Shut down extensions** -- all registered extensions are shut down.
7. **Close database registry** -- if multi-database is enabled, all database pools are drained.
8. **Close protocol handler** -- the main connection pool is drained.
9. **Close auth database** -- if authentication is enabled, the auth database connection is closed.

### Configuration

```bash
# Set drain timeout (default: 30 seconds)
```

Programmatically:

```typescript
const server = new DiscServer({
  shutdownDrainTimeout: 10000 // 10 seconds
});
```

The `stop()` method is idempotent -- calling it multiple times is safe and only the first call initiates shutdown.

---

## Server Lifecycle

### Startup Sequence

When `server.start()` is called, the following steps execute in order:

1. **Initialize protocol handler** -- creates and warms up the PostgreSQL connection pool.
2. **Initialize database registry** -- if multi-database is enabled, creates the default database pool.
3. **Initialize authentication** -- if `jwtSecret` is set, creates the auth database, provider, middleware, and route handlers.
4. **Initialize extensions** -- registered extensions are initialized with access to the schema and config. Extension functions and types are merged into the protocol handler’s schema.
5. **Start binary protocol server** -- if `binaryPort` is configured, starts the binary protocol listener.
6. **Start HTTP server** -- begins accepting HTTP and WebSocket connections.
7. **Register signal handlers** -- `SIGINT` and `SIGTERM` are registered for graceful shutdown.
8. **Start cleanup intervals** -- background tasks begin:
   - Idle connection cleanup every 5 minutes.
   - Expired session cleanup every 10 minutes.
   - Abandoned transaction cleanup every 2 minutes.

### Protocol Handlers

The server supports two protocol handler implementations:

| Handler                       | Flag       | Description                                       |
| ----------------------------- | ---------- | ------------------------------------------------- |
| `SimpleEdgeQLProtocolHandler` | `"simple"` | Simulated compilation for development and testing |
| `EdgeQLProtocolHandler`       | `"full"`   | Full EdgeQL parser, compiler, and SQL generation  |

The `full` handler provides:

- Real EdgeQL parsing and compilation with error reporting.
- Parse and compilation caches (configurable size via `cacheMaxSize`).
- EXPLAIN plan caching (when `enableExplain` is true).
- Slow query logging (configurable threshold via `slowQueryThresholdMs`).
- Query timeout enforcement (via `requestTimeout`).
- Access policy enforcement (when `enableAccessPolicies` is true).

Set the handler via:

```bash
DISC_PROTOCOL=full
```

Or:

```typescript
const server = new DiscServer({ protocol: "full" });
```

### CORS

CORS is enabled by default. To restrict allowed origins:

```bash
DISC_CORS_ORIGINS="https://app.example.com,https://admin.example.com"
```

When CORS is enabled, the server responds to `OPTIONS` preflight requests with appropriate `Access-Control-Allow-*` headers and a `204 No Content` status. The `Access-Control-Max-Age` header is set to 86400 seconds (24 hours).

To disable CORS entirely:

```bash
DISC_ENABLE_CORS=false
```

---

## Key Exports

From `disc/server/server.ts`:

| Export                        | Description                                 |
| ----------------------------- | ------------------------------------------- |
| `DiscServer`                  | Main server class                           |
| `DiscServerOptions`           | Constructor options interface               |
| `createDefaultConfig()`       | Returns a default `ServerConfig`            |
| `createServerFromEnv()`       | Creates a server from environment variables |
| `HttpServer`                  | Low-level HTTP server                       |
| `EdgeQLProtocolHandler`       | Full EdgeQL protocol handler                |
| `SimpleEdgeQLProtocolHandler` | Simple (simulated) protocol handler         |
| `ConnectionManager`           | HTTP/WebSocket connection tracking          |
| `SessionManager`              | Session lifecycle management                |
| `TransactionManager`          | Transaction state management                |
| `DatabaseRegistry`            | Multi-database pool management              |
| `BinaryProtocolServer`        | Gel-compatible binary protocol server       |

From `disc/server/types.ts`:

| Export            | Description                                          |
| ----------------- | ---------------------------------------------------- |
| `ServerConfig`    | Full server configuration interface                  |
| `QueryRequest`    | Query payload (query, variables, operationName)      |
| `QueryResponse`   | Response envelope (data, errors, extensions)         |
| `QueryError`      | Single query error                                   |
| `SessionContext`  | Session state (id, database, variables)              |
| `Connection`      | Connection state (id, type, session, remoteAddr)     |
| `Transaction`     | Transaction state (id, sessionId, isolation)         |
| `ServerStats`     | Server statistics                                    |
| `HealthStatus`    | Health check result                                  |
| `AuthContext`     | Per-request auth context (userId, roles, JWT claims) |
| `QueryContext`    | Full query context (session, auth, requestId)        |
| `ProtocolHandler` | Protocol handler interface                           |

---

## See Also

- [Getting Started](getting-started.md) -- Quick introduction to Disc
- [Client SDK](client-sdk.md) -- TypeScript SDK for consuming the HTTP API
- [Auth](auth.md) -- Authentication system details
- [Access Policies](access-policies.md) -- Object-level access policies
- [Extensions](extensions.md) -- Extension system architecture
- [Bundled PostgreSQL](bundled-postgres.md) -- How Disc manages PostgreSQL
- [Production Deployment](production-deployment.md) -- TLS, monitoring, Docker, and systemd

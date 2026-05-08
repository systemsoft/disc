# Disc Production Deployment Guide

This guide covers deploying the Disc database server in production environments.

All configuration is driven by environment variables, which makes Disc compatible with container orchestration, PaaS platforms, and traditional VM deployments.

---

## Environment Configuration Reference

All Disc server settings are read at startup via `create_server_from_env()`.

No restart is required for most infrastructure changes — redeploy the container or process with updated environment variables.

| Variable                      | Default                            | Description                                                                                                                                    |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                | `postgresql://localhost:5432/disc` | PostgreSQL connection string. Overrides the bundled instance DSN when set.                                                                     |
| `DISC_HOST`                   | `localhost`                        | IP address or hostname the HTTP server binds to. Set to `0.0.0.0` to accept external connections.                                              |
| `DISC_PORT`                   | `5656`                             | TCP port the HTTP server listens on.                                                                                                           |
| `DISC_MAX_CONNECTIONS`        | `100`                              | Maximum number of PostgreSQL connections in the connection pool.                                                                               |
| `DISC_REQUEST_TIMEOUT`        | `30000`                            | Per-request timeout in milliseconds. Requests exceeding this limit return HTTP 408.                                                            |
| `DISC_ENABLE_CORS`            | `true`                             | Enable CORS headers on all responses. Set to `false` when behind a proxy that manages CORS.                                                    |
| `DISC_CORS_ORIGINS`           | _(unrestricted)_                   | Comma-separated list of allowed origins, e.g. `https://app.example.com,https://admin.example.com`. When unset, all origins are permitted.      |
| `DISC_ENABLE_WEBSOCKETS`      | `true`                             | Enable WebSocket upgrade handling on the same port as HTTP.                                                                                    |
| `DISC_JWT_SECRET`             | _(none)_                           | Secret used to sign and verify JWT tokens. Required to enable authentication. Must be at least 32 characters.                                  |
| `DISC_ENABLE_AUTH`            | _(auto)_                           | Explicitly enable (`true`) or disable (`false`) the auth subsystem. When unset, auth is enabled automatically if `DISC_JWT_SECRET` is present. |
| `DISC_ENABLE_ACCESS_POLICIES` | _(none)_                           | Set to `true` to enforce object-level access policies defined in SDL. Requires `DISC_PROTOCOL=full`.                                           |
| `DISC_CACHE_MAX_SIZE`         | `1000`                             | Maximum number of entries in the query compilation and parse caches combined. Reduce on memory-constrained hosts.                              |
| `DISC_SLOW_QUERY_MS`          | `1000`                             | Queries exceeding this threshold (in milliseconds) are logged as slow queries. Set to `0` to disable.                                          |
| `DISC_RATE_LIMIT_RPM`         | `0` (disabled)                     | Maximum requests per minute per client IP. Set to `0` to disable rate limiting.                                                                |
| `DISC_RATE_LIMIT_BURST`       | _(equals RPM)_                     | Maximum burst size above the per-minute rate. Defaults to the same value as `DISC_RATE_LIMIT_RPM`.                                             |
| `DISC_TLS_CERT`               | _(none)_                           | Path to the PEM-encoded TLS certificate file. Both `DISC_TLS_CERT` and `DISC_TLS_KEY` must be set to enable TLS.                               |
| `DISC_TLS_KEY`                | _(none)_                           | Path to the PEM-encoded TLS private key file.                                                                                                  |
| `DISC_TLS_CERT_ENV`           | _(none)_                           | Name of an env var holding the PEM cert contents (for K8s/Fly.io/Render env-only secret injection); materializes to a 0600 temp file at boot.  |
| `DISC_TLS_KEY_ENV`            | _(none)_                           | Name of an env var holding the PEM key contents.                                                                                               |
| `DISC_TLS_REDIRECT`           | `false`                            | When `true`, start a second listener on `DISC_TLS_REDIRECT_PORT` that issues HTTP 301 redirects to the HTTPS port.                             |
| `DISC_TLS_REDIRECT_PORT`      | `80`                               | Port for the HTTP-to-HTTPS redirect listener.                                                                                                  |
| `DISC_ENABLE_METRICS`         | `false`                            | Expose a Prometheus-compatible `/metrics` endpoint. Keep this disabled or firewall-protected in production.                                    |
| `DISC_LOG_LEVEL`              | `INFO`                             | Log verbosity. One of `DEBUG`, `INFO`, `WARN`, `ERROR`. Use `WARN` or `ERROR` in production.                                                   |
| `DISC_LOG_FORMAT`             | `json`                             | Log output format. `json` for structured logging (recommended in production), `text` for human-readable output.                                |
| `DISC_EXPLAIN_CACHE_TTL`      | `300000`                           | Time-to-live in milliseconds for cached `EXPLAIN` plan results. Default is 5 minutes.                                                          |
| `DISC_PROTOCOL`               | `simple`                           | Protocol handler to use. `simple` uses simulated compilation; `full` enables the real EdgeQL compiler with access policy support.              |
| `DISC_SHUTDOWN_DRAIN_TIMEOUT` | `30000`                            | Maximum time in milliseconds to wait for in-flight requests to complete before forcing shutdown.                                               |

---

## TLS Setup

Disc reads TLS certificate files directly from disk at startup. The server uses Deno's native TLS support, so no external TLS library is required.

### Self-Signed Certificate (Development)

Generate a self-signed certificate for local testing:

```bash
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout disc.key \
  -out disc.crt \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

Start Disc with TLS enabled:

```bash
DISC_TLS_CERT=./disc.crt \
DISC_TLS_KEY=./disc.key \
DISC_PORT=5657 \
disc serve
```

### Let's Encrypt (Production)

Use `certbot` to obtain a certificate for a public domain:

```bash
certbot certonly --standalone \
  --domain disc.example.com \
  --email ops@example.com \
  --agree-tos
```

Certificates are written to `/etc/letsencrypt/live/disc.example.com/`.

```bash
DISC_TLS_CERT=/etc/letsencrypt/live/disc.example.com/fullchain.pem \
DISC_TLS_KEY=/etc/letsencrypt/live/disc.example.com/privkey.pem \
DISC_TLS_REDIRECT=true \
DISC_TLS_REDIRECT_PORT=80 \
DISC_PORT=443 \
disc serve
```

Set up automatic renewal:

```bash
# Add to root crontab
0 3 * * * certbot renew --quiet && systemctl restart disc
```

### TLS Certificate Hot-Reload

Disc can reload TLS certificates from disk without a process restart — useful for `certbot` / cert-manager renewals on long-running production servers (`server/tls-reload.ts`, gh/geldata#4277).

Enable hot-reload via the `tls.reload` option:

```typescript
const server = new DiscServer({
  tls: {
    certFile: "/etc/letsencrypt/live/disc.example.com/fullchain.pem",
    keyFile: "/etc/letsencrypt/live/disc.example.com/privkey.pem",
    reload: true,
    reloadDebounceMs: 500 // optional, default 500
  }
});
```

When enabled, Disc watches both files via `Deno.watchFs`. After a debounce window (`reloadDebounceMs`, default 500 ms) collapses the burst of events that renewal tools emit when they write the key and cert back-to-back, the server:

1. Validates the new files have intact PEM envelopes.
2. Drains in-flight requests on the existing TLS listener.
3. Stops the old listener.
4. Starts a new listener on the same port with the renewed cert.

Expect a sub-second blip in connection accepts during the swap. New requests during the swap window queue at the OS socket level and proceed once the new listener binds. There is no full process restart, no in-flight request loss, and no cache flush.

If the new cert fails cryptographic validation (mismatched key, expired, malformed), the server logs an error and keeps the old listener running — a half-rotation never lands.

#### Cert-expiry Prometheus gauge

When TLS is configured, Disc exports two Prometheus gauges (`server/tls-cert-info.ts`, gh/geldata#6205):

| Metric                                      | Type  | Description                                        |
| ------------------------------------------- | ----- | -------------------------------------------------- |
| `disc_tls_certificate_expiration_time`      | gauge | Leaf certificate `notAfter` as Unix epoch seconds. |
| `disc_tls_certificate_seconds_until_expiry` | gauge | Seconds until expiry. Negative means expired.      |

Use the second one for alerting:

```yaml
# prometheus-alerts.yml
groups:
  - name: disc-tls
    rules:
      - alert: DiscTlsCertExpiringSoon
        expr: disc_tls_certificate_seconds_until_expiry < 7 * 24 * 3600
        for: 10m
        annotations:
          summary: "Disc TLS cert expires in less than 7 days"
      - alert: DiscTlsCertExpired
        expr: disc_tls_certificate_seconds_until_expiry < 0
        for: 1m
        annotations:
          summary: "Disc TLS cert is expired"
```

The gauges refresh on initial bind and after every successful TLS hot-reload, so `certbot renew` followed by Disc swapping the cert in-place updates the metric without a Disc restart.

### Reverse Proxy TLS Termination (Recommended for Production)

Terminate TLS at the load balancer or reverse proxy and forward plain HTTP to Disc.

This is the most common pattern for production deployments.

Nginx example (TLS termination in front of Disc):

```nginx
upstream disc {
  server 127.0.0.1:5656;
  keepalive 32;
}

server {
  listen 443 ssl http2;
  server_name disc.example.com;

  ssl_certificate     /etc/letsencrypt/live/disc.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/disc.example.com/privkey.pem;
  ssl_protocols       TLSv1.2 TLSv1.3;
  ssl_ciphers         HIGH:!aNULL:!MD5;

  location / {
    proxy_pass         http://disc;
    proxy_http_version 1.1;

    # Required for WebSocket support
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";

    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;

    proxy_read_timeout 35s;
    proxy_send_timeout 35s;
  }
}

server {
  listen 80;
  server_name disc.example.com;
  return 301 https://$host$request_uri;
}
```

When using a reverse proxy, bind Disc to localhost only:

```bash
DISC_HOST=127.0.0.1
DISC_ENABLE_CORS=false
```

---

## Connection Pool Tuning

Disc maintains a pool of PostgreSQL connections. The total connections across all Disc instances must stay below PostgreSQL's `max_connections` limit, with headroom reserved for administrative connections.

**Formula:**

```
DISC_MAX_CONNECTIONS * disc_instance_count <= pg_max_connections - 5
```

| Deployment Size      | `DISC_MAX_CONNECTIONS` | PostgreSQL `max_connections` | Disc Instances |
| -------------------- | ---------------------- | ---------------------------- | -------------- |
| Development          | 10                     | 100                          | 1              |
| Small (< 100 req/s)  | 25                     | 100                          | 2              |
| Medium (< 500 req/s) | 50                     | 200                          | 2-4            |
| Large (< 2000 req/s) | 100                    | 500                          | 3-5            |
| High-availability    | 50                     | 500                          | 8+             |

**PostgreSQL connection overhead:** Each connection consumes approximately 5-10 MB of shared memory on the PostgreSQL side. Do not set `max_connections` higher than needed on the database server.

**PgBouncer:** For high-concurrency deployments, place PgBouncer in transaction mode between Disc and PostgreSQL. Set `DISC_MAX_CONNECTIONS` to the PgBouncer pool size and configure PgBouncer's `max_client_conn` to match your PostgreSQL limit.

---

## Health Check Integration

Disc exposes three health endpoints:

| Endpoint            | Purpose                                                | Success                         | Failure                           |
| ------------------- | ------------------------------------------------------ | ------------------------------- | --------------------------------- |
| `GET /health`       | Full status with database ping, pool stats, and uptime | HTTP 200                        | HTTP 503                          |
| `GET /health/live`  | Liveness — is the process running?                     | HTTP 200 `{"status":"alive"}`   | Process not running               |
| `GET /health/ready` | Readiness — is the database reachable?                 | HTTP 200 `{"status":"healthy"}` | HTTP 503 `{"status":"unhealthy"}` |

### Kubernetes

```yaml
livenessProbe:
  failureThreshold: 3
  httpGet:
    path: /health/live
    port: 5656
  initialDelaySeconds: 5
  periodSeconds: 10

readinessProbe:
  failureThreshold: 2
  httpGet:
    path: /health/ready
    port: 5656
  initialDelaySeconds: 10
  periodSeconds: 5

startupProbe:
  failureThreshold: 12
  httpGet:
    path: /health
    port: 5656
  initialDelaySeconds: 15
  periodSeconds: 5
```

### AWS Application Load Balancer

In the target group settings:

- **Protocol:** HTTP
- **Path:** `/health/ready`
- **Port:** 5656
- **Healthy threshold:** 2 consecutive checks
- **Unhealthy threshold:** 3 consecutive checks
- **Timeout:** 5 seconds
- **Interval:** 15 seconds
- **Success codes:** 200

### Docker Compose

```yaml
healthcheck:
  interval: 15s
  retries: 3
  start_period: 20s
  test: ["CMD", "curl", "-sf", "http://localhost:5656/health/ready"]
  timeout: 5s
```

---

## Rate Limiting

Disc applies per-IP rate limiting using a token bucket algorithm. Burst allows short spikes above the per-minute rate.

| Use Case                           | `DISC_RATE_LIMIT_RPM` | `DISC_RATE_LIMIT_BURST` |
| ---------------------------------- | --------------------- | ----------------------- |
| Public API                         | `60`                  | `20`                    |
| Authenticated API                  | `300`                 | `50`                    |
| Internal service (trusted network) | `600`                 | `100`                   |
| Development / local                | `0` (disabled)        | —                       |

When a client exceeds the rate limit, Disc returns:

```
HTTP 429 Too Many Requests
Retry-After: 60
{"error": "Rate limit exceeded"}
```

**Important:** If Disc is behind a reverse proxy, the rate limiter sees the proxy's IP rather than the real client IP. Ensure the proxy forwards `X-Real-IP` or `X-Forwarded-For`, and configure your infrastructure so Disc can trust these headers.

Consider applying rate limiting at the proxy layer instead for proxy deployments.

---

## Logging Configuration

### Format

`DISC_LOG_FORMAT=json` (recommended for production):

```json
{
  "duration_ms": 12,
  "level": "INFO",
  "msg": "Query executed",
  "query_hash": "a3f9b2",
  "time": "2026-03-17T10:00:00.000Z"
}
```

`DISC_LOG_FORMAT=text` (useful for local development):

```
INFO  2026-03-17T10:00:00.000Z Query executed duration_ms=12
```

### Log Level Recommendations

| Environment | `DISC_LOG_LEVEL` |
| ----------- | ---------------- |
| Production  | `WARN`           |
| Staging     | `INFO`           |
| Development | `DEBUG`          |

### Log Aggregation

**Elastic (ELK) via Filebeat:**

```yaml
# filebeat.yml
filebeat.inputs:
  - type: container
    paths:
      - /var/lib/docker/containers/*/*.log
    processors:
      - add_docker_metadata: ~
      - decode_json_fields:
          fields: ["message"]
          target: ""
          overwrite_keys: true

output.elasticsearch:
  hosts: ["https://elasticsearch:9200"]
  index: "disc-logs-%{+yyyy.MM.dd}"
```

**Grafana Loki via Promtail:**

```yaml
# promtail-config.yml
scrape_configs:
  - job_name: disc
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 5s
    relabel_configs:
      - source_labels: [__meta_docker_container_name]
        regex: disc.*
        action: keep
      - source_labels: [__meta_docker_container_name]
        target_label: container
```

**AWS CloudWatch via Fluent Bit:**

```ini
[INPUT]
    Name              tail
    Path              /var/log/disc/*.log
    Parser            json
    Tag               disc.*

[OUTPUT]
    Name              cloudwatch_logs
    Match             disc.*
    region            us-east-1
    log_group_name    /disc/production
    log_stream_prefix disc-
    auto_create_group true
```

---

## Prometheus Metrics

Enable the `/metrics` endpoint by setting `DISC_ENABLE_METRICS=true`. The endpoint returns metrics in Prometheus text exposition format (content type `text/plain; version=0.0.4`).

**Important:** Do not expose `/metrics` publicly. Restrict access via firewall rules, a network policy, or a separate internal port at the proxy layer.

### Prometheus Scrape Configuration

```yaml
scrape_configs:
  - job_name: disc
    static_configs:
      - targets: ["disc-internal:5656"]
    metrics_path: /metrics
    scrape_interval: 15s
    scrape_timeout: 10s
```

### Key Metrics

| Metric                           | Type        | Alert Condition                                  |
| -------------------------------- | ----------- | ------------------------------------------------ |
| `disc_http_requests_total`       | Counter     | Sudden drop to 0 (server down)                   |
| `disc_http_errors_total`         | Counter     | Error rate > 1% sustained                        |
| `disc_http_request_duration_ms`  | Gauge (avg) | p99 > request timeout                            |
| `disc_pool_active_connections`   | Gauge       | Approaches `DISC_MAX_CONNECTIONS`                |
| `disc_pool_waiters`              | Gauge       | Sustained value > 0                              |
| `disc_cache_hit_rate`            | Gauge       | Falls below 0.7                                  |
| `disc_query_avg_compile_ms`      | Gauge       | Rising trend indicates schema complexity growth  |
| `disc_rate_limit_rejected_total` | Counter     | Spikes indicate client misconfiguration or abuse |
| `disc_memory_heap_used_bytes`    | Gauge       | Sustained growth (memory leak)                   |

### Grafana Dashboard Suggestions

Create panels for:

1. Request throughput (requests/s) split by success/error
2. P50/P95/P99 request latency
3. Connection pool utilization (active / max)
4. Cache hit rate over time
5. Rate limit rejections per minute
6. Memory usage trend (heap used vs heap total)
7. Slow query count per minute

---

## Docker Deployment

Disc ships with production-ready Docker files in the repository root.

### Production Image (External PostgreSQL)

Use the multi-stage `Dockerfile` for production deployments with an external PostgreSQL.

This image caches dependencies in a separate stage, removes test and documentation files, runs as a non-root user, and includes a built-in health check.

```bash
docker build -t disc .
docker run -e DATABASE_URL="postgres://user:pass@host:5432/disc" -p 5656:5656 disc
```

The entrypoint supports running any CLI subcommand:

```bash
docker run disc migrate    # Run migrations
docker run disc shell      # Open EdgeQL shell
```

See `Dockerfile` for the full multi-stage build definition.

### All-in-One Image (Bundled PostgreSQL)

Use `Dockerfile.bundled` for development, demos, or single-container deployments.

This image installs PostgreSQL 16 inside the container and manages its lifecycle automatically via an entrypoint script.

```bash
docker build -f Dockerfile.bundled -t disc-bundled .
docker run -p 5656:5656 disc-bundled
```

No `DATABASE_URL` is required -- the entrypoint initializes PostgreSQL, creates the database, and connects Disc automatically.

See `Dockerfile.bundled` for the full build definition and entrypoint script.

### Docker Compose

The repository includes two compose files:

- `docker-compose.yml` -- production stack with Disc and PostgreSQL
- `docker-compose.monitoring.yml` -- overlay that adds Prometheus and Grafana

```bash
# Production stack (Disc + PostgreSQL)
docker compose up -d

# With monitoring (adds Prometheus + Grafana)
docker compose -f docker-compose.yml -f docker-compose.monitoring.yml up -d

# View logs
docker compose logs -f disc

# Stop
docker compose down
```

The monitoring overlay expects a Prometheus config at `deploy/prometheus.yml` and automatically sets `DISC_ENABLE_METRICS=true` on the Disc service.

Convenience tasks are available in `deno.json`:

```bash
deno task docker:build   # Build the production image
deno task docker:up      # Start the compose stack
deno task docker:down    # Stop the compose stack
```

---

## Native Binary

Disc can be compiled to a self-contained native binary using Deno's `deno compile`.

The resulting binary requires no runtime installation -- it embeds Deno and all dependencies.

### Building

```bash
# Build for the current platform
disc build

# Or via Deno task
deno task build
```

The binary is written to `./disc` by default.

### Cross-Compilation

Target a specific platform with the `--platform` flag:

```bash
disc build --platform linux-x64
disc build --platform linux-arm64
disc build --platform darwin-x64
disc build --platform darwin-arm64
```

Platform-specific Deno tasks are also available:

```bash
deno task build:linux-x64
deno task build:linux-arm64
deno task build:darwin-x64
deno task build:darwin-arm64
```

When cross-compiling, the output binary is named `./disc-{platform}` (e.g., `./disc-linux-x64`). You can override the output path with `--output`:

```bash
disc build --platform linux-x64 --output ./dist/disc-server
```

### Available Platforms

| Platform       | Deno Target                 |
| -------------- | --------------------------- |
| `darwin-arm64` | `aarch64-apple-darwin`      |
| `darwin-x64`   | `x86_64-apple-darwin`       |
| `linux-arm64`  | `aarch64-unknown-linux-gnu` |
| `linux-x64`    | `x86_64-unknown-linux-gnu`  |

### Cross-Compilation Limitations

Deno's cross-compilation downloads a platform-specific runtime snapshot. This works reliably for most cases, but note:

- The binary size may differ across platforms
- Native plugins or FFI bindings (if any) are not cross-compiled
- The resulting binary cannot be executed on the build host when targeting a different OS or architecture

### Deployment with Native Binary

The compiled binary can be deployed directly to a VM or bare-metal server:

```bash
# Build for Linux
disc build --platform linux-x64

# Copy to server
scp ./disc-linux-x64 server:/usr/local/bin/disc

# Run on server
ssh server "DATABASE_URL=postgres://... /usr/local/bin/disc serve"
```

This pairs well with the systemd service unit generated by `disc deploy --format systemd`.

---

## Deploy Scaffold Generator

The `disc deploy` command generates project-specific deployment artifacts. Instead of writing Dockerfiles, compose files, or service units from scratch, use the scaffold generator to produce a starting point tailored to your project.

### Usage

```bash
disc deploy --format <format> [--output <directory>]
```

The `--output` flag controls where generated files are written. Defaults to `./deploy`.

### Formats

| Format    | Output File          | Description                                          |
| --------- | -------------------- | ---------------------------------------------------- |
| `docker`  | `Dockerfile`         | Basic Dockerfile for running Disc with external PG   |
| `compose` | `docker-compose.yml` | Compose stack with Disc and PostgreSQL               |
| `systemd` | `disc.service`       | systemd service unit for Linux deployments           |
| `env`     | `.env.production`    | Environment variable template with all Disc settings |

### Examples

Generate an environment variable template:

```bash
disc deploy --format env
# Writes ./deploy/.env.production
```

Generate a systemd service unit to a custom directory:

```bash
disc deploy --format systemd --output ./infra
# Writes ./infra/disc.service
```

Generate a docker-compose file:

```bash
disc deploy --format compose
# Writes ./deploy/docker-compose.yml
```

The generated files include comments indicating they were scaffolded by `disc deploy` and are meant to be customized for your specific infrastructure.

---

## Security Checklist

Before going live, verify each item:

- [ ] TLS enabled directly or behind a TLS-terminating proxy
- [ ] `DISC_JWT_SECRET` is set to a randomly generated string of 32 or more characters
- [ ] `DISC_RATE_LIMIT_RPM` is set to a value appropriate for your traffic pattern
- [ ] `DISC_CORS_ORIGINS` is restricted to your application's domains; not left as wildcard in production
- [ ] `DISC_ENABLE_ACCESS_POLICIES=true` if serving multiple tenants or users with different data access rights
- [ ] `DISC_ENABLE_METRICS=false` (default) or the `/metrics` endpoint is firewalled from public access
- [ ] `DISC_LOG_LEVEL=WARN` in production to avoid logging sensitive query content
- [ ] `DATABASE_URL` credentials use a dedicated database user with only the required privileges; not the PostgreSQL superuser
- [ ] The Disc process runs as a non-root OS user
- [ ] `DISC_HOST=127.0.0.1` when behind a reverse proxy (do not bind to `0.0.0.0` unless required)
- [ ] Database credentials are stored in a secrets manager, not in environment files committed to version control
- [ ] PostgreSQL is not exposed on a public network interface

---

## Graceful Shutdown

Disc handles `SIGINT` and `SIGTERM` signals with an ordered shutdown sequence.

This ensures in-flight requests complete and connections are cleanly released.

Shutdown sequence:

1. Signal received (`SIGINT` or `SIGTERM`)
2. Server enters shutting-down state — new requests receive HTTP 503 immediately
3. Wait up to `DISC_SHUTDOWN_DRAIN_TIMEOUT` milliseconds for in-flight requests to finish (polls every 100 ms)
4. HTTP server and redirect server (if running) are shut down
5. Protocol handler closes the PostgreSQL connection pool (drains remaining connections)
6. Auth database connection is closed
7. Process exits

The default drain timeout is 30 seconds. For long-running query workloads, increase this value to match your expected maximum query duration:

```bash
DISC_SHUTDOWN_DRAIN_TIMEOUT=60000  # 60 seconds
```

In Kubernetes, set `terminationGracePeriodSeconds` to at least `DISC_SHUTDOWN_DRAIN_TIMEOUT / 1000 + 5` to give Disc enough time to drain before the kubelet force-kills the pod.

```yaml
spec:
  terminationGracePeriodSeconds: 40
```

---

## Troubleshooting

### Connection Pool Exhaustion

**Symptoms:**

- `DISC_MAX_CONNECTIONS` gauge in `/metrics` is at maximum
- `disc_pool_waiters` metric is consistently above 0
- Queries begin timing out or returning 408
- `/health/ready` returns HTTP 503 with `{"status":"unhealthy"}`

**Diagnosis:**

```bash
# Check pool stats in real time
curl -s http://localhost:5656/stats | jq ".cache, .query_metrics"
curl -s http://localhost:5656/health | jq ".pool"
```

**Fix:**

- Increase `DISC_MAX_CONNECTIONS` if PostgreSQL `max_connections` allows headroom
- Add more Disc instances (horizontal scaling)
- Identify slow queries holding connections open (see Slow Queries below)
- Consider adding PgBouncer in transaction mode

### High Memory Usage

**Symptoms:**

- `disc_memory_heap_used_bytes` grows over time without leveling off
- Deno process OOM-killed

**Diagnosis:**

```bash
curl -s http://localhost:5656/stats | jq ".memory_usage, .cache"
```

**Fix:**

- Reduce `DISC_CACHE_MAX_SIZE`. The query cache holds compiled query plans in memory.
  A value of 500 is sufficient for most schemas.
- Reduce `DISC_EXPLAIN_CACHE_TTL` to evict cached EXPLAIN results more frequently
- Add memory limits to the container and monitor the heap-used-to-heap-total ratio

### Slow Queries

**Symptoms:**

- High average query duration in `/stats`
- Log entries with `slow_query=true` when `DISC_SLOW_QUERY_MS` is set

**Diagnosis:**

Enable slow query logging at an appropriate threshold:

```bash
DISC_SLOW_QUERY_MS=200  # Log queries taking more than 200ms
DISC_LOG_LEVEL=INFO
```

Then check logs for the query text and use PostgreSQL `EXPLAIN ANALYZE` directly:

```sql
EXPLAIN ANALYZE SELECT ...;
```

**Fix:**

- Add indexes on frequently filtered columns
- Break complex queries into simpler shapes
- Check for N+1 patterns in nested link traversal

### Rate Limit False Positives

**Symptoms:**

- Legitimate clients receiving HTTP 429 unexpectedly
- `disc_rate_limit_rejected_total` metric increasing during normal traffic

**Diagnosis:**

```bash
curl -s http://localhost:5656/stats | jq ".rate_limit"
```

**Fix:**

- Increase `DISC_RATE_LIMIT_RPM` for the traffic pattern
- Increase `DISC_RATE_LIMIT_BURST` to absorb bursty but legitimate clients
- If behind a proxy, verify that rate limiting at the proxy layer is preferred over per-IP limiting at Disc (since Disc will see the proxy IP, not the real client)

### TLS Certificate Errors

**Symptoms:**

- Server fails to start with a TLS-related error
- Clients report certificate verification failures

**Common causes and fixes:**

| Error                        | Cause                                        | Fix                                                                        |
| ---------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| `cert file not found`        | `DISC_TLS_CERT` path is wrong or not mounted | Verify file path and container volume mounts                               |
| `key does not match cert`    | Certificate and key are mismatched           | Re-generate or ensure the correct pair is used                             |
| `certificate expired`        | Let's Encrypt renewal failed                 | Run `certbot renew` manually; verify cron job                              |
| `ERR_CERT_AUTHORITY_INVALID` | Self-signed cert not trusted by client       | Use a CA-signed cert or add the self-signed cert to the client trust store |

Verify the certificate before starting Disc:

```bash
openssl x509 -in "$DISC_TLS_CERT" -noout -text | grep -E "Not After|Subject:"
openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt "$DISC_TLS_CERT"
```

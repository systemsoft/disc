# Docker Compose

Run Disc and PostgreSQL together with one command. This guide covers the production stack (`docker-compose.yml`), the all-in-one bundled image (`Dockerfile.bundled`), and the optional monitoring overlay.

Related documentation: [Production Deployment](production-deployment.md) | [Bundled PostgreSQL](bundled-postgres.md) | [Server Configuration](server.md)

---

## TL;DR

The repository ships with a working `docker-compose.yml` at the project root:

```bash
docker compose up -d
docker compose logs -f disc
docker compose down
```

That spins up Disc (port `5656`) and PostgreSQL 16 (internal-only) with persistent volumes, a healthcheck on `/health/ready`, and `restart: unless-stopped` so the stack survives reboots.

---

## Production Stack

The shipped `docker-compose.yml`:

```yaml
services:
  disc:
    build: .
    ports:
      - "5656:5656"
    environment:
      DATABASE_URL: postgres://disc:disc@postgres:5432/disc
      DISC_HOST: "0.0.0.0"
      DISC_PORT: "5656"
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: disc
      POSTGRES_PASSWORD: disc
      POSTGRES_DB: disc
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U disc"]
      interval: 5s
      timeout: 5s
      retries: 5
    restart: unless-stopped

volumes:
  pgdata:
```

### What it does

- **Disc service** is built from the repo’s production `Dockerfile` (multi-stage Deno build, non-root user, `HEALTHCHECK` on `/health/ready`). Connects to PostgreSQL via the compose-network DNS name `postgres`.
- **PostgreSQL service** uses the official `postgres:16-alpine` image. `pg_isready` healthcheck blocks Disc from starting until PG accepts connections (`depends_on: condition: service_healthy`).
- **Named volume** `pgdata` holds the PostgreSQL data directory across `docker compose down` / `up` cycles. Use `docker compose down -v` to wipe it.

### Hardening for production

Before deploying this compose file to a production host, edit it to:

1. **Replace the default password** (`POSTGRES_PASSWORD: disc`). Use a Docker secret or `.env` file:

   ```yaml
   environment:
     POSTGRES_PASSWORD_FILE: /run/secrets/pg_password
   secrets:
     - pg_password
   ```

2. **Set a JWT secret** for the auth subsystem (see [Auth](auth.md)):

   ```yaml
   environment:
     DISC_JWT_SECRET: ${DISC_JWT_SECRET:?set in .env}
     DISC_ENABLE_AUTH: "true"
   ```

3. **Bind to localhost only** when running behind a reverse proxy:

   ```yaml
   ports:
     - "127.0.0.1:5656:5656"
   ```

4. **Enable Prometheus metrics** behind a firewall:

   ```yaml
   environment:
     DISC_ENABLE_METRICS: "true"
   ```

5. **Mount TLS certificates** (or terminate at the proxy — see [Production Deployment → Reverse Proxy](production-deployment.md#reverse-proxy-tls-termination-recommended-for-production)):

   ```yaml
   environment:
     DISC_TLS_CERT: /certs/fullchain.pem
     DISC_TLS_KEY: /certs/privkey.pem
   volumes:
     - /etc/letsencrypt/live/disc.example.com:/certs:ro
   ```

### `.env` template

Pair the compose file with a `.env` (gitignored) for secrets:

```dotenv
# .env -- never commit
POSTGRES_PASSWORD=use-a-real-password
DISC_JWT_SECRET=at-least-32-bytes-of-entropy-here
DISC_LOG_LEVEL=WARN
DISC_RATE_LIMIT_RPM=600
```

`docker compose` automatically loads `.env` from the working directory; reference values via `${VAR}` substitution in `docker-compose.yml`.

---

## Single-Container (Bundled) Image

For demos, CI fixtures, or single-tenant deployments where running PostgreSQL as a separate service is overkill, use the bundled image:

```bash
docker build -f Dockerfile.bundled -t disc-bundled .
docker run -p 5656:5656 disc-bundled
```

The bundled image installs PostgreSQL 16 inside the container; an entrypoint script initializes the data directory on first boot, starts PostgreSQL, then execs Disc. No external `DATABASE_URL` required.

To persist data across restarts, mount the PostgreSQL data directory:

```bash
docker run -p 5656:5656 \
  -v disc-data:/var/lib/postgresql/16/disc \
  disc-bundled
```

---

## Bundled PostgreSQL Mode (No External PG)

Disc’s CLI also manages a PostgreSQL instance under `~/.disc/instances/<project>/`. To use this mode inside Docker (instead of running PG as a sibling service), mount the Disc home directory:

```yaml
services:
  disc:
    build: .
    ports:
      - "5656:5656"
    environment:
      DISC_HOME: /var/disc
    volumes:
      - disc-instances:/var/disc/instances
    restart: unless-stopped

volumes:
  disc-instances:
```

The container runs `disc serve`, which auto-starts the bundled PostgreSQL on first boot (creates an instance, downloads the PG binary if not cached, runs `initdb`). Subsequent restarts reuse the persisted instance.

For full lifecycle details — directory layout, version upgrades, socket configuration — see [Bundled PostgreSQL](bundled-postgres.md).

---

## Monitoring Overlay

The repository also ships `docker-compose.monitoring.yml` which adds Prometheus and Grafana. Use it as an overlay:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.monitoring.yml \
  up -d
```

The overlay automatically sets `DISC_ENABLE_METRICS=true` on the Disc service and mounts a Prometheus config from `deploy/prometheus.yml` (relative to the compose file). Disc does not generate this file — provide your own. A minimal config that scrapes the Disc metrics endpoint:

```yaml
# deploy/prometheus.yml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: disc
    static_configs:
      - targets: ["disc:5656"]
```

---

## Healthcheck

The Disc image ships with a built-in healthcheck (`docker inspect <container>` shows `Healthcheck.Status`). It hits `/health/ready` every 30 seconds and reports `unhealthy` on three consecutive failures.

Compose-level healthcheck override:

```yaml
services:
  disc:
    # ...
    healthcheck:
      test: ["CMD", "deno", "eval", "const r = await fetch('http://localhost:5656/health/ready'); if (!r.ok) Deno.exit(1);"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 20s
```

`/health/live` returns 200 as long as the process is up; `/health/ready` returns 503 when PostgreSQL is unreachable. See [Server → Health Check](server.md#get-health) for the full schema.

---

## Generating a starter compose file

`disc deploy --format compose` writes a project-specific `docker-compose.yml` (and starter `prometheus.yml`) into `./deploy`:

```bash
disc deploy --format compose
# → ./deploy/docker-compose.yml
```

That output is a starting point — copy it into the project root and tweak ports, passwords, volumes, and TLS mounts to match your infrastructure.

---

## See Also

- [Production Deployment](production-deployment.md) — TLS, rate limiting, sizing, security checklist
- [Bundled PostgreSQL](bundled-postgres.md) — instance lifecycle and binary management
- [Server Configuration](server.md) — every environment variable Disc reads
- [Performance](performance.md) — connection-pool and cache tuning

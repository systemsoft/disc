# CLI Reference

The `disc` command-line interface provides tools for project initialization, schema management, code generation, database administration, and server operation.

**See also:** [Getting Started](getting-started.md) | [Migrations](migrations.md) | [Codegen](codegen.md) | [Server](server.md) | [Bundled PostgreSQL](bundled-postgres.md)

---

## Global Options

These options apply to most commands:

```
-h, --help           Show help message
-v, --version        Show version information
-s, --schema <file>  Schema file path (single-file mode)
--schema-dir <dir>   Schema directory for multi-file discovery (default: ./dbschema)
-c, --config <file>  Configuration file path
--backend-dsn <url>  Use external PostgreSQL (skip bundled)
--database-url <url> PostgreSQL connection URL
```

---

## disc init

Initialize a new Disc project. Creates the project directory, scaffolds schema files, generates configuration, and optionally sets up a bundled PostgreSQL instance.

**Usage:**

```bash
disc init [name] [options]
```

**Arguments:**

| Argument | Description  | Default        |
| -------- | ------------ | -------------- |
| `name`   | Project name | `disc-project` |

**Options:**

| Flag                   | Description                                    | Default                                |
| ---------------------- | ---------------------------------------------- | -------------------------------------- |
| `--template <type>`    | Schema template: `minimal`, `basic`, or `full` | `basic`                                |
| `--database-url <url>` | PostgreSQL connection URL for the project      | `postgresql://localhost:5432/disc_dev` |
| `--backend-dsn <url>`  | Use an external PostgreSQL instead of bundled  | --                                     |
| `--skip-postgres`      | Skip bundled PostgreSQL setup                  | `false`                                |
| `--force`              | Overwrite existing project directory           | `false`                                |
| `--directory <dir>`    | Parent directory for the project               | `.` (current directory)                |

**Templates:**

- **minimal** -- An empty `module default {}` schema. Start from scratch.
- **basic** -- A `User` type with `name`, `email` (exclusive constraint), and `createdAt`. Good starting point for most projects.
- **full** -- A `User` type and a `Post` type with a link between them. Demonstrates relationships, constraints, and defaults.

**Examples:**

```bash
# Create a new project with the default (basic) template
disc init my-project

# Create a project with the full template
disc init my-app --template full

# Initialize without bundled PostgreSQL (use an external one)
disc init my-app --backend-dsn "postgres://user:pass@host:5432/mydb"

# Initialize without any PostgreSQL setup
disc init my-app --skip-postgres
```

**Generated files:**

```
my-project/
  schema.disc   # Schema definition
  deno.json     # Deno configuration with tasks
  .env          # Environment variables
  .gitignore    # Git ignore rules
  mod.ts        # Module entry point
  README.md     # Project readme
  migrations/   # Migration directory
  disc.toml     # Disc instance configuration (when using bundled PG)
```

**Project name rules:** Lowercase letters, numbers, and hyphens only. Cannot start or end with a hyphen.

---

## disc migrate

Generate and apply schema migrations. Compares the current schema definition against the stored migration history to detect changes, then generates and executes the necessary DDL statements.

**Usage:**

```bash
disc migrate [options]
```

**Options:**

| Flag                  | Description                                                                                                  | Default                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `-s, --schema <file>` | Path to the schema file                                                                                      | `./dbschema/default.disc`                                        |
| `--dry-run`           | Show what would be done without executing                                                                    | `false`                                                          |
| `--auto-approve`      | Skip confirmation prompts                                                                                    | `false`                                                          |
| `--create`            | Create migration files without applying them                                                                 | `false`                                                          |
| `--status`            | Show migration status (applied count, latest migration)                                                      | --                                                               |
| `--rollback`          | Rollback the most recent migration (requires `--force`)                                                      | --                                                               |
| `--rollback-to <id>`  | Rollback all migrations after the specified ID (requires `--force`)                                          | --                                                               |
| `--squash`            | Squash multiple migrations into one                                                                          | --                                                               |
| `--squash-from <id>`  | Start of the squash range (inclusive)                                                                        | --                                                               |
| `--squash-to <id>`    | End of the squash range (inclusive)                                                                          | --                                                               |
| `--force`             | Required for destructive operations (rollback)                                                               | `false`                                                          |
| `--unsafe`            | Permit unsafe/ambiguous operations (`DropType`, `DropProperty`, `RecreateScalar`, ambiguous classifications) | `false`                                                          |
| `--backend-dsn <url>` | PostgreSQL connection URL                                                                                    | `DATABASE_URL` env var or `postgresql://localhost:5432/disc_dev` |

**Examples:**

```bash
# Apply pending migrations
disc migrate

# Preview changes without applying
disc migrate --dry-run

# Apply without confirmation prompts
disc migrate --auto-approve

# Create migration files without applying
disc migrate --create

# Check migration status
disc migrate --status

# Rollback the most recent migration
disc migrate --rollback --force

# Rollback to a specific migration
disc migrate --rollback-to m20240101T100000_abc123 --force

# Squash all migrations into one
disc migrate --squash

# Squash a specific range
disc migrate --squash --squash-from m001 --squash-to m005
```

**Status output:**

```
Migration Status

  Applied migrations: 5
  Current schema hash: a1b2c3d4

  Latest migration:
    ID: m20240315T140000_add_posts
    Name: add_posts
    Applied at: 2024-03-15T14:00:00.000Z

  Schema status: 2 pending operation(s)
    - [safe] AddProperty
    - [ambiguous] ChangeType

  Run `disc migrate` to apply.
```

The "Schema status" line is a drift check: `disc migrate --status` parses the SDL file on disk, runs it through the diff engine against the applied state, and surfaces pending operations with their safety classification (`safe`/`unsafe`/`ambiguous`). When the SDL matches the applied state the line reads `Schema status: in sync`. (gh/geldata#8899)

**Pre-migrate preflight (running-server detection).** Before each live migration the CLI scans `pg_stat_activity` for connections tagged `application_name = "disc-server"`. If any are found, it warns:

```
⚠ Detected 1 active Disc server connection(s) on this database.
  Migrate will succeed, but the server’s in-memory schema cache will be stale until reload.
  Trigger a schema reload (admin UI Diff page → Apply, or restart the server) after migration.
```

The migration still proceeds — this is an advisory, not a refusal. After applying, trigger a schema reload via the admin UI’s Diff page (Apply Migration), or restart the server. Best-effort: silently no-ops if `pg_stat_activity` is restricted on the deployment. (gh/geldata#9034)

**Rollback safety:** Rollback is a destructive operation. Rolling back a `DROP TABLE` migration cannot restore lost data. The `--force` flag is required to acknowledge this risk.

---

## disc serve

Start the Disc server. Starts the bundled PostgreSQL instance, loads the project schema, and serves the HTTP API and optional binary wire protocol.

**Usage:**

```bash
disc serve [options]
```

**Options:**

| Flag                       | Description                                                           | Default     |
| -------------------------- | --------------------------------------------------------------------- | ----------- |
| `--port <port>`            | HTTP server port                                                      | `5656`      |
| `--host <host>`            | Host to bind to                                                       | `localhost` |
| `--jwt-secret <key>`       | JWT signing secret for authentication                                 | --          |
| `--enable-auth`            | Enable the authentication system                                      | `false`     |
| `--enable-access-policies` | Enable object-level access policy enforcement                         | `false`     |
| `--binary-port <port>`     | Start binary wire protocol server on this port                        | --          |
| `--tls-cert <path>`        | Path to TLS certificate file                                          | --          |
| `--tls-key <path>`         | Path to TLS private key file                                          | --          |
| `--no-ui`                  | Start server without serving UI assets                                | `false`     |
| `--require-auth`           | Reject unauthenticated requests on protected routes (gh/geldata#5234) | `false`     |
| `--read-only`              | Refuse INSERT/UPDATE/DELETE/DDL at the AST level                      | `false`     |
| `--trust-proxy`            | Trust `X-Forwarded-For` / `X-Forwarded-Proto` headers for client IP   | `false`     |

**Examples:**

```bash
# Start with defaults (port 5656, localhost)
disc serve

# Start on a custom port
disc serve --port 8080

# Start with authentication
disc serve --jwt-secret "your-secret-key" --enable-auth

# Start with authentication and access policies
disc serve --jwt-secret "your-secret-key" --enable-auth --enable-access-policies

# Start with TLS
disc serve --tls-cert /path/to/cert.pem --tls-key /path/to/key.pem

# Start with binary protocol on a separate port
disc serve --binary-port 5657

# Bind to all interfaces (production)
disc serve --host 0.0.0.0
```

**Lifecycle:**

1. Starts (or creates) the bundled PostgreSQL instance for the project
2. Loads the schema from `./dbschema/default.disc`
3. Starts the HTTP server
4. Optionally starts the binary protocol server
5. On SIGINT or SIGTERM, stops the server and PostgreSQL gracefully

**Environment variables:** The following environment variables are also recognized and can be used instead of CLI flags:

- `DISC_JWT_SECRET` -- JWT signing secret
- `DISC_ENABLE_AUTH` -- Set to `"true"` to enable auth
- `DISC_ENABLE_ACCESS_POLICIES` -- Set to `"true"` to enable access policies
- `DISC_TLS_CERT` -- Path to TLS certificate
- `DISC_TLS_KEY` -- Path to TLS private key
- `DATABASE_URL` -- PostgreSQL connection URL
- `DISC_TLS_CERT_ENV` -- Name of an env var holding PEM cert contents (for K8s/Fly.io/Render env-only secret injection); materializes to a 0600 temp file
- `DISC_TLS_KEY_ENV` -- Name of an env var holding PEM key contents
- `DISC_REQUIRE_AUTH` -- Set to `"true"` / `"1"` / `"yes"` to require auth on protected routes (mirrors `--require-auth`)
- `DISC_READ_ONLY` -- Set to `"true"` / `"1"` / `"yes"` to enable read-only mode (mirrors `--read-only`)
- `DISC_TRUST_PROXY` -- Set to `"true"` / `"1"` / `"yes"` to trust forwarded headers (mirrors `--trust-proxy`)
- `DISC_ENABLE_DATA_WATCH` -- Set to `"false"` to disable the live-data subscription endpoint (`/admin/data-watch`); default `true`
- `DISC_ENABLE_REST` -- Set to `"false"` to disable the schema-derived REST surface; default `true`
- `DISC_SHUTDOWN_DRAIN_TIMEOUT` -- Milliseconds to wait for in-flight connections to drain on SIGTERM

---

## disc shell

Open an interactive EdgeQL REPL. Connects to a running Disc instance (or starts one) and provides a prompt for executing queries.

**Usage:**

```bash
disc shell [options]
```

**Options:**

| Flag                  | Description                     | Default     |
| --------------------- | ------------------------------- | ----------- |
| `--host <host>`       | Database host                   | `localhost` |
| `-p, --port <port>`   | Database port                   | `5656`      |
| `--database <name>`   | Database name                   | `disc`      |
| `-s, --schema <file>` | Load a schema file on startup   | --          |
| `--non-interactive`   | Disable interactive mode        | `false`     |
| `--execute <query>`   | Execute a single query and exit | --          |

**Examples:**

```bash
# Open interactive REPL
disc shell

# Execute a single query
disc shell --execute "select User { email, name };"

# Connect to a specific database
disc shell --database my_app

# Load a schema file on startup
disc shell --schema ./dbschema/default.disc
```

**Shell commands:**

| Command         | Description                                  |
| --------------- | -------------------------------------------- |
| `\?` or `\help` | Show help                                    |
| `\q` or `\quit` | Quit shell                                   |
| `\d`            | List tables                                  |
| `\dt`           | List tables with details (size, description) |
| `\c <database>` | Connect to a different database              |
| `\i <file>`     | Execute queries from a file                  |
| `\timing`       | Toggle query timing display                  |
| `\history`      | Show command history                         |
| `\clear`        | Clear the screen                             |

> The same table appears in [`docs/getting-started.md`](getting-started.md#shell-commands).
> Keep them in sync — column widths included — so a `git diff`
> instantly flags drift.

**Multiline queries:** Queries that do not end with a semicolon are treated as multiline input. The prompt changes to `...` until a semicolon terminates the query.

```
disc> select User {
...   email,
...   name
... };
```

---

## disc codegen

Generate TypeScript types, query builders, and client code from your schema. Supports both single-file and multi-file schema discovery.

**Usage:**

```bash
disc codegen [options]
```

**Options:**

| Flag                  | Description                                   | Default                                            |
| --------------------- | --------------------------------------------- | -------------------------------------------------- |
| `-s, --schema <file>` | Single schema file path                       | --                                                 |
| `--schema-dir <dir>`  | Schema directory for multi-file discovery     | `./dbschema`                                       |
| `-o, --output <dir>`  | Output directory for generated code           | `./dbschema/disc-client`                           |
| `-t, --target <type>` | Codegen target: `client`, `server`, or `both` | `client`                                           |
| `--no-queries`        | Skip query builder generation                 | `false`                                            |
| `--no-mutations`      | Skip mutation method generation               | `false`                                            |
| `--no-client`         | Skip client library generation                | `false`                                            |
| `--no-format`         | Skip output formatting                        | `false`                                            |
| `--js`                | _Reserved:_ generate JavaScript output        | `false` (not implemented yet — tracked in backlog) |

**Examples:**

```bash
# Generate from default schema directory (./dbschema/)
disc codegen

# Generate from a single schema file
disc codegen --schema ./schema.disc

# Generate from a custom schema directory
disc codegen --schema-dir ./schema

# Custom output directory
disc codegen --output ./src/generated

# Generate server-side types only
disc codegen --target server

# Generate types without query builders
disc codegen --no-queries --no-mutations
```

**Multi-file discovery:** When using `--schema-dir`, Disc discovers all `.disc` files in the directory and merges them into a unified schema before generating code.

**Generated output:**

```
dbschema/disc-client/
  client.ts           # DiscClient class
  index.ts            # Client entry point
  queries.ts          # Type-safe query builder functions
  types.ts            # TypeScript type definitions
```

**Usage after generation:**

```typescript
import { DiscClient } from "./dbschema/disc-client/index.ts";

const client = new DiscClient({ baseUrl: "http://localhost:5656" });
const users = await client.user.select();
```

---

## disc watch

Watch schema files for changes and automatically run migrations (dry-run) and regenerate TypeScript types. Designed for development workflows.

**Usage:**

```bash
disc watch [options]
```

**Options:**

| Flag                  | Description                          | Default         |
| --------------------- | ------------------------------------ | --------------- |
| `-s, --schema <file>` | Schema file to watch                 | `./schema.disc` |
| `-o, --output <dir>`  | Output directory for generated types | `./generated`   |

**Examples:**

```bash
# Watch the default schema file
disc watch

# Watch a specific schema file
disc watch --schema ./dbschema/default.disc

# Watch with custom output directory
disc watch --schema ./schema.disc --output ./src/generated
```

**Behavior:**

1. Performs an initial build on startup
2. Watches the directory containing the schema file for `.disc` file changes
3. Debounces changes (1 second) to avoid rapid rebuilds
4. On each change, creates a dry-run migration plan and regenerates TypeScript types
5. Stops on SIGINT (Ctrl+C) or SIGTERM

If the schema file does not exist, the watcher creates a default schema with a basic `User` type.

---

## disc start

Start the bundled PostgreSQL instance for the current project. Creates the instance if it does not exist.

**Usage:**

```bash
disc start [options]
```

**Options:**

| Flag                | Description               | Default |
| ------------------- | ------------------------- | ------- |
| `-p, --port <port>` | PostgreSQL port           | `5432`  |
| `--no-monitor`      | Disable health monitoring | `false` |

**Examples:**

```bash
# Start PostgreSQL
disc start

# Start on a custom port
disc start --port 5433

# Start without health monitoring
disc start --no-monitor
```

**Output:**

```
PostgreSQL started successfully
  PID: 12345
  Port: 5432
  Data: /Users/you/.disc/instances/my-project/data
  DSN: postgresql://disc@localhost:5432/disc
```

---

## disc stop

Stop the bundled PostgreSQL instance for the current project.

**Usage:**

```bash
disc stop
```

**Examples:**

```bash
disc stop
```

---

## disc restart

Restart the bundled PostgreSQL instance for the current project. Stops the running instance and starts it again.

**Usage:**

```bash
disc restart
```

**Examples:**

```bash
disc restart
```

---

## disc status

Show the status of the bundled PostgreSQL instance for the current project, including health check information when available.

**Usage:**

```bash
disc status
```

**Output when running:**

```
PostgreSQL Status for project: my-project

  Status: Running
   PID: 12345
   Port: 5432
   Started: 3/20/2026, 2:30:00 PM

  Health Check:
   Healthy: Yes
   Connections: 3
   Latency: 2ms
   Uptime: 120 minutes

  Data Directory: /Users/you/.disc/instances/my-project/data
  Socket Path: /Users/you/.disc/instances/my-project/socket
  Version: PostgreSQL 18.4
```

**Output when stopped:**

```
PostgreSQL Status for project: my-project

  Status: Stopped

  Data Directory: /Users/you/.disc/instances/my-project/data
  Socket Path: /Users/you/.disc/instances/my-project/socket
  Version: PostgreSQL 18.4
```

---

## disc ui

Open the Disc admin UI in the default browser. Requires the UI to be built first.

**Usage:**

```bash
disc ui [options]
```

**Options:**

| Flag                | Description                   | Default |
| ------------------- | ----------------------------- | ------- |
| `-p, --port <port>` | Port the server is running on | `5656`  |

**Examples:**

```bash
# Open admin UI
disc ui

# Open admin UI for a server on a custom port
disc ui --port 8080
```

The UI must be built before use. If it is not built, the command outputs instructions:

```
cd ui && npm install && npm run build
```

---

## disc build

Compile Disc into a self-contained binary using `deno compile`. Supports cross-compilation to multiple platforms.

**Usage:**

```bash
disc build [options]
```

**Options:**

| Flag                    | Description                                           | Default                                             |
| ----------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| `--platform <platform>` | Target platform for cross-compilation                 | Current platform                                    |
| `-o, --output <path>`   | Output binary path                                    | `./disc` (or `./disc-<platform>` for cross-compile) |
| `--lite`                | Skip UI assets in the build (reserved for future use) | `false`                                             |

**Supported platforms:**

| Platform       | Deno Target                 |
| -------------- | --------------------------- |
| `darwin-arm64` | `aarch64-apple-darwin`      |
| `darwin-x64`   | `x86_64-apple-darwin`       |
| `linux-arm64`  | `aarch64-unknown-linux-gnu` |
| `linux-x64`    | `x86_64-unknown-linux-gnu`  |
| `windows-x64`  | `x86_64-pc-windows-msvc`    |

> Windows ARM64 has no `deno compile` target and no Zonky PG build, so `windows-x64` is the only Windows target. Windows-on-ARM runs it under x64 emulation. The compiled binary is written with a `.exe` extension (`disc-windows-x64.exe`).

**Examples:**

```bash
# Build for the current platform
disc build

# Build for Linux x64
disc build --platform linux-x64

# Build with a custom output path
disc build --output ./my-disc

# Cross-compile for Linux ARM64
disc build --platform linux-arm64 --output ./disc-linux-arm64
```

**Cross-platform PG staging:**

When `--platform <p>` is set, `disc build` stages the target platform’s PostgreSQL distribution into `dist/embedded-pg/<platform>/<version>/` before regenerating the embedded-PG manifest. The resulting binary embeds the right PG for its target — without this step, the build machine’s host PG would be embedded into every cross-compiled binary, breaking on extraction. Per-platform staging caches are reused across builds, so producing every platform binary from a single CI runner only downloads each PG distribution once.

**Output:**

```
Building Disc binary...
  Output: ./disc
  Command: deno compile --allow-net --allow-read --allow-write --allow-env --allow-run --output ./disc cli/main.ts

Build complete!
  Binary: ./disc (45.23 MB)
```

---

## disc deploy

Generate deployment artifacts for production environments. Scaffolds Dockerfiles, docker-compose configurations, systemd service units, or environment variable templates.

**Usage:**

```bash
disc deploy --format <format> [options]
```

**Options:**

| Flag                 | Description                                                            | Default    |
| -------------------- | ---------------------------------------------------------------------- | ---------- |
| `--format <format>`  | Deployment format (required): `docker`, `compose`, `systemd`, or `env` | --         |
| `-o, --output <dir>` | Output directory for generated files                                   | `./deploy` |

**Formats:**

### docker

Generates a `Dockerfile` based on the official Deno image. Exposes port 5656 and expects `DATABASE_URL` to be set at runtime.

```bash
disc deploy --format docker
```

Generated file: `./deploy/Dockerfile`

### compose

Generates a `docker-compose.yml` with a Disc service and a PostgreSQL 16 service. Includes health checks and volume persistence.

```bash
disc deploy --format compose
```

Generated file: `./deploy/docker-compose.yml`

### systemd

Generates a `disc.service` unit file for running Disc as a systemd service. Includes security hardening directives.

```bash
disc deploy --format systemd
```

Generated file: `./deploy/disc.service`

Installation:

```bash
sudo cp deploy/disc.service /etc/systemd/system/disc.service
sudo systemctl daemon-reload
sudo systemctl enable disc
sudo systemctl start disc
```

### env

Generates a `.env.production` template with all documented environment variables, organized by category: database, server, authentication, logging, rate limiting, cache, TLS, and metrics.

```bash
disc deploy --format env
```

Generated file: `./deploy/.env.production`

**Examples:**

```bash
# Generate a Dockerfile
disc deploy --format docker

# Generate docker-compose.yml
disc deploy --format compose

# Generate a systemd service unit
disc deploy --format systemd

# Generate an environment variable template
disc deploy --format env

# Generate into a custom directory
disc deploy --format docker --output ./infra
```

---

## disc db create

Create a new Disc-managed database. Creates a PostgreSQL database with the `disc_` prefix.

**Usage:**

```bash
disc db create <name> [options]
```

**Arguments:**

| Argument | Description                                                                          |
| -------- | ------------------------------------------------------------------------------------ |
| `name`   | Database name (lowercase letters, digits, and underscores; must start with a letter) |

**Options:**

| Flag                   | Description               | Default                                                      |
| ---------------------- | ------------------------- | ------------------------------------------------------------ |
| `--database-url <url>` | PostgreSQL connection URL | `DATABASE_URL` env var or `postgresql://localhost:5432/disc` |

**Examples:**

```bash
# Create a database named "my_app" (PG name: disc_my_app)
disc db create my_app

# Create using a specific connection
disc db create staging --database-url "postgres://admin:pass@db:5432/disc"
```

**Naming rules:** Database names must start with a lowercase letter and contain only lowercase letters, digits, and underscores. The actual PostgreSQL database is created with a `disc_` prefix to avoid collisions with system databases.

---

## disc db list

List all Disc-managed databases (those with the `disc_` prefix).

**Usage:**

```bash
disc db list [options]
```

**Options:**

| Flag                   | Description               | Default                                                      |
| ---------------------- | ------------------------- | ------------------------------------------------------------ |
| `--database-url <url>` | PostgreSQL connection URL | `DATABASE_URL` env var or `postgresql://localhost:5432/disc` |

**Examples:**

```bash
disc db list
```

**Output:**

```
Disc-managed databases:

  NAME
  ------------------------------
  my_app
  staging
  test

  3 database(s) total.
```

---

## disc db drop

Drop a Disc-managed database. This operation is irreversible and requires the `--force` flag.

**Usage:**

```bash
disc db drop <name> --force [options]
```

**Arguments:**

| Argument | Description           |
| -------- | --------------------- |
| `name`   | Database name to drop |

**Options:**

| Flag                   | Description                                    | Default                                                      |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `--force`              | Required. Confirms the irreversible operation. | --                                                           |
| `--database-url <url>` | PostgreSQL connection URL                      | `DATABASE_URL` env var or `postgresql://localhost:5432/disc` |

**Examples:**

```bash
# Drop the "test" database
disc db drop test --force
```

**Restrictions:** The default `disc` database cannot be dropped.

---

## disc pg log

View PostgreSQL logs for the current project’s bundled instance.

**Usage:**

```bash
disc pg log [options]
```

**Options:**

| Flag               | Description                                                       | Default                |
| ------------------ | ----------------------------------------------------------------- | ---------------------- |
| `-f, --follow`     | Follow log output (like `tail -f`)                                | `false`                |
| `--lines <n>`      | Number of recent log lines to show                                | `50`                   |
| `--level <level>`  | Filter logs by level: `ERROR`, `WARNING`, `LOG`, `FATAL`, `PANIC` | -- (show all)          |
| `--name <project>` | Project name (overrides auto-detection)                           | Current directory name |

**Examples:**

```bash
# View the last 50 lines of PostgreSQL log
disc pg log

# Follow log output in real-time
disc pg log -f

# Show the last 100 lines
disc pg log --lines 100

# Show only errors
disc pg log --level ERROR

# Show only errors and follow
disc pg log --level ERROR -f
```

**Log location:** Logs are stored at `~/.disc/instances/<project>/logs/postgresql.log`. If no log file exists, the command reports an error suggesting that PostgreSQL may not be running.

**Follow mode:** Press Ctrl+C to stop following. The command polls for new content every 500 milliseconds.

---

## disc pg upgrade

Upgrade the bundled PostgreSQL instance to a newer version. Uses a pg_dumpall/pg_restore strategy with automatic backup and rollback on failure.

**Usage:**

```bash
disc pg upgrade --target-version <version> [options]
```

**Options:**

| Flag                         | Description                             | Default                |
| ---------------------------- | --------------------------------------- | ---------------------- |
| `--target-version <version>` | Target PostgreSQL version (required)    | --                     |
| `--dry-run`                  | Show the upgrade plan without executing | `false`                |
| `--name <project>`           | Project name (overrides auto-detection) | Current directory name |

**Available versions:** `16.4`, `17.0`, `18.4` (default)

**Examples:**

```bash
# Preview the upgrade plan
disc pg upgrade --target-version 17.0 --dry-run

# Perform the upgrade
disc pg upgrade --target-version 17.0
```

**Dry-run output:**

```
PostgreSQL Upgrade Plan:
  Project: my-project
  Current version: 18.4
  Target version: 17.0
  Strategy: pg_dump/pg_restore
  Backup: yes

Dry run complete. No changes were made.
```

**Upgrade process:**

1. **Download** the target version binary
2. **Backup** the current instance (automatic)
3. **Dump** the database using `pg_dumpall`
4. **Stop** the current instance
5. **Rename** the data directory (preserved as backup)
6. **Initialize** a new data directory with the target version
7. **Start** the new instance
8. **Restore** the database from the dump
9. **Verify** the new instance is running and healthy
10. **Record** the upgrade in `version.json`

**Automatic rollback:** If any step after the dump fails, the upgrade process automatically attempts to:

- Stop the new instance (if running)
- Restore the original data directory from backup
- Restart the old instance

**Restrictions:** The target version must be newer than the current version. Downgrading is not supported.

---

## Project Context Resolution

Every CLI command automatically resolves the project it belongs to. No manual DSN configuration or flags are needed when working inside a project directory.

### How It Works

When you run any `disc` command, the CLI:

1. Walks up from the current working directory looking for `disc.toml` (like `git` finds `.git/`).
2. Parses `disc.toml` for the project name, database settings, and server configuration.
3. Derives instance paths at `~/.disc/instances/{instance_name}/`.
4. For commands that need PostgreSQL (`serve`, `migrate`, `shell`, `start`), auto-starts the managed instance if it is not already running.

This means `disc serve`, `disc migrate`, and `disc shell` all work from any subdirectory of a project with zero configuration.

### Resolution Priority (DSN)

Commands resolve the database connection in this order:

1. `--backend-dsn` CLI flag (explicit external PostgreSQL)
2. `DATABASE_URL` environment variable
3. `disc.toml` project context (managed socket DSN or `backend_dsn`)
4. Hardcoded fallback: `postgresql://localhost:5432/disc_dev`

### `disc.toml`

The `disc.toml` file is created automatically by `disc init`:

```toml
name = "my-project"
version = "0.1.0"

[database]
managed = true
instance_name = "my-project"
# backend_dsn = "postgresql://user:pass@host:5432/db"  # for external PG

[server]
host = "localhost"
port = 5656
# require_auth = true
# read_only = false
# enable_cors = true
# cors_origins = ["https://app.example.com", "https://*.example.com"]
# cors_allow_credentials = true
# trust_proxy = true
# enable_websockets = true
# enable_metrics = true
# max_request_body_bytes = 4194304
# request_timeout = 30000
# rate_limit_rpm = 600
```

| Section      | Key                      | Default       | Description                                                        |
| ------------ | ------------------------ | ------------- | ------------------------------------------------------------------ |
| _(top)_      | `name`                   | _(required)_  | Project name                                                       |
| `[database]` | `managed`                | `true`        | Use bundled PostgreSQL                                             |
| `[database]` | `instance_name`          | same as name  | Instance directory under `~/.disc/instances/`                      |
| `[database]` | `backend_dsn`            | _(none)_      | External PostgreSQL connection string                              |
| `[server]`   | `host`                   | `"localhost"` | Server bind host                                                   |
| `[server]`   | `port`                   | `5656`        | Server bind port                                                   |
| `[server]`   | `require_auth`           | `false`       | Reject data-plane requests without a valid `Authorization` header  |
| `[server]`   | `read_only`              | `false`       | Reject INSERT/UPDATE/DELETE/CONFIGURE and migrations               |
| `[server]`   | `enable_cors`            | `true`        | Emit CORS headers on HTTP responses                                |
| `[server]`   | `cors_origins`           | _(any)_       | Allowlist of origins; entries may use `https://*.example.com`      |
| `[server]`   | `cors_allow_credentials` | `false`       | Emit `Access-Control-Allow-Credentials: true` (requires allowlist) |
| `[server]`   | `trust_proxy`            | `false`       | Honor `X-Forwarded-For`/`X-Real-IP`/`X-Forwarded-Proto`            |
| `[server]`   | `enable_websockets`      | `true`        | Accept WebSocket upgrades on the HTTP port                         |
| `[server]`   | `enable_metrics`         | `false`       | Expose Prometheus metrics on `/metrics`                            |
| `[server]`   | `max_request_body_bytes` | `4194304`     | Reject `POST /query` bodies larger than this with 413              |
| `[server]`   | `request_timeout`        | _(none)_      | Per-request timeout in ms                                          |
| `[server]`   | `rate_limit_rpm`         | _(none)_      | Per-client rate limit in requests/minute                           |

When no `disc.toml` is found, commands fall back to the current directory name as the project name. CLI flags always win over `disc.toml`, which wins over environment variables.

---

## Environment Variables

| Variable                      | Description                                 | Used by                           |
| ----------------------------- | ------------------------------------------- | --------------------------------- |
| `DATABASE_URL`                | PostgreSQL connection string                | `migrate`, `serve`, `db` commands |
| `DISC_CACHE_MAX_SIZE`         | Maximum query cache size                    | `serve`                           |
| `DISC_ENABLE_ACCESS_POLICIES` | Enable access policies (`true`/`false`)     | `serve`                           |
| `DISC_ENABLE_AUTH`            | Enable authentication (`true`/`false`)      | `serve`                           |
| `DISC_ENABLE_METRICS`         | Enable Prometheus metrics endpoint          | `serve`                           |
| `DISC_HOST`                   | Server bind host                            | `serve`                           |
| `DISC_JWT_SECRET`             | JWT signing secret                          | `serve`                           |
| `DISC_LOG_FORMAT`             | Log format: `text`, `json`                  | `serve`                           |
| `DISC_LOG_LEVEL`              | Log level: `debug`, `info`, `warn`, `error` | `serve`                           |
| `DISC_PORT`                   | Server bind port                            | `serve`                           |
| `DISC_RATE_LIMIT_REQUESTS`    | Max requests per rate limit window          | `serve`                           |
| `DISC_RATE_LIMIT_WINDOW_MS`   | Rate limit window in milliseconds           | `serve`                           |
| `DISC_SLOW_QUERY_MS`          | Slow query threshold in milliseconds        | `serve`                           |
| `DISC_TLS_CERT`               | Path to TLS certificate                     | `serve`                           |
| `DISC_TLS_KEY`                | Path to TLS private key                     | `serve`                           |

---

## Exit Codes

| Code | Meaning                                                                  |
| ---- | ------------------------------------------------------------------------ |
| `0`  | Success                                                                  |
| `1`  | General error (invalid arguments, command failure, missing requirements) |

---

## Command Quick Reference

| Command                                | Description                                 |
| -------------------------------------- | ------------------------------------------- |
| `disc init [name]`                     | Initialize a new project                    |
| `disc start`                           | Start bundled PostgreSQL                    |
| `disc stop`                            | Stop bundled PostgreSQL                     |
| `disc restart`                         | Restart bundled PostgreSQL                  |
| `disc status`                          | Show PostgreSQL status and health           |
| `disc migrate`                         | Generate and apply schema migrations        |
| `disc serve`                           | Start the Disc server (includes PostgreSQL) |
| `disc shell`                           | Open interactive EdgeQL REPL                |
| `disc codegen`                         | Generate TypeScript types from schema       |
| `disc watch`                           | Watch schema files and auto-rebuild         |
| `disc ui`                              | Open admin UI in browser                    |
| `disc build`                           | Compile to self-contained binary            |
| `disc deploy --format <fmt>`           | Generate deployment artifacts               |
| `disc db create <name>`                | Create a Disc-managed database              |
| `disc db list`                         | List Disc-managed databases                 |
| `disc db drop <name> --force`          | Drop a Disc-managed database                |
| `disc pg log`                          | View PostgreSQL logs                        |
| `disc pg upgrade --target-version <v>` | Upgrade PostgreSQL version                  |

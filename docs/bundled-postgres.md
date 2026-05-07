# Bundled PostgreSQL

Disc downloads and manages PostgreSQL automatically. Users never install, configure, or manage PostgreSQL directly. Running `disc init` triggers the download of a platform-specific PostgreSQL binary, initializes a data directory, and creates a fully managed instance. The bundled PostgreSQL is ready to use immediately with no external dependencies.

---

## How It Works

When you run `disc init`, the following happens:

1. **Platform detection.** Disc detects your operating system and CPU architecture (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`).
2. **Binary download.** A pre-built PostgreSQL binary is downloaded from a trusted source and cached at `~/.disc/postgres/<version>/`. If the binary is already cached, the download is skipped.
3. **Checksum verification.** The downloaded archive is verified against a SHA-256 checksum before extraction. If the checksum does not match, the download is rejected.
4. **Archive extraction.** The binary archive is extracted and the directory structure is normalized so that `bin/`, `lib/`, and `share/` are directly under the version directory.
5. **Instance initialization.** `initdb` creates a new PostgreSQL data directory with UTF-8 encoding, the `disc` superuser, and trust-based local authentication.
6. **Configuration generation.** A `postgresql.conf` is written with settings tuned for Disc: Unix socket only, no TCP listener, logging collector enabled, and conservative memory defaults.

Subsequent runs of `disc start` reuse the cached binary and existing data directory without repeating the download or initialization steps.

---

## Directory Layout

All Disc-managed PostgreSQL data lives under `~/.disc/`:

```
~/.disc/
  instances/
    my-project/
      data/       # PostgreSQL data directory (PGDATA)
      logs/       # PostgreSQL and Disc server logs
      socket/     # Unix domain socket directory
      disc.toml   # Instance configuration
  postgres/
    16.4/         # Cached PostgreSQL 16.4 binary
      bin/        # postgres, initdb, pg_ctl, psql, etc.
      lib/        # Shared libraries
      share/      # Extensions, timezone data, configs
    17.0/         # Multiple versions can coexist
      bin/
      lib/
      share/
```

Each project gets its own instance directory under `~/.disc/instances/`. Data directories, logs, and Unix sockets are isolated per project. PostgreSQL binaries are shared across all instances of the same version.

---

## Platform Support

| Platform | Architecture | Source                                |
| -------- | ------------ | ------------------------------------- |
| macOS    | arm64        | EDB official binaries                 |
| macOS    | x64          | EDB official binaries                 |
| Linux    | x64          | Zonky embedded-postgres-binaries      |
| Linux    | arm64        | Zonky embedded-postgres-binaries      |
| Windows  | x64          | Docker fallback (not yet implemented) |

Supported PostgreSQL versions: **16.4** (default), **17.0**.

The platform is detected automatically from `Deno.build.os` and `Deno.build.arch`. If Disc does not recognize your platform, it will report an error with the detected OS and architecture.

---

## Instance Management

### Starting

Start the bundled PostgreSQL and the Disc server together:

```bash
disc start
```

This starts PostgreSQL via `pg_ctl start`, waits up to 60 seconds for the process to become ready, and then launches the Disc HTTP server. If PostgreSQL is already running, it is not restarted.

Most commands (`serve`, `migrate`, `shell`, `start`) auto-start PostgreSQL when needed. You rarely need to run `disc start` explicitly -- just `disc serve` or `disc shell` from any subdirectory of your project and the CLI will locate `disc.toml`, resolve the instance, and start PostgreSQL if it is not already running.

### Stopping

Stop the Disc server and PostgreSQL:

```bash
disc stop
```

PostgreSQL is stopped with `pg_ctl stop -m fast`, which rolls back any in-progress transactions and shuts down cleanly. If a clean shutdown fails, Disc sends `SIGTERM` and waits 5 seconds. If the process is still alive, `SIGKILL` is used as a last resort.

### Status

Check whether the server and PostgreSQL are running:

```bash
disc status
```

This reports the running state, PID, data directory, socket path, port, PostgreSQL version, and health monitor status.

### Restarting

Restart PostgreSQL without restarting the full Disc server:

```bash
disc stop && disc start
```

The `PostgresInstance.restart()` method performs a stop followed by a start internally.

---

## Logs

View PostgreSQL logs:

```bash
disc pg log
```

Follow log output in real time:

```bash
disc pg log --follow
```

Show only the last 50 lines:

```bash
disc pg log --lines 50
```

Filter by log level:

```bash
disc pg log --level error
```

Logs are stored at `~/.disc/instances/<name>/logs/postgresql.log`. The logging collector is enabled by default with daily rotation and a 100 MB size limit. Log files follow the naming pattern `postgresql-YYYY-MM-DD_HHMMSS.log`.

The log line prefix includes the timestamp, process ID, user, and database:

```
2026-03-20 14:30:15 UTC [12345] disc@my-project LOG:  statement: SELECT 1
```

Slow queries exceeding 100 ms are logged automatically via `log_min_duration_statement`.

---

## Upgrading PostgreSQL

Upgrade the bundled PostgreSQL to a newer version:

```bash
disc pg upgrade --target-version 17
```

Preview what would happen without making changes:

```bash
disc pg upgrade --target-version 17 --dry-run
```

The upgrade process:

1. Downloads the target PostgreSQL version if not already cached.
2. Stops the running instance.
3. Creates a backup of the current data directory.
4. Runs the migration from the old version to the new version.
5. Starts the instance with the new binary.
6. If any step fails, rolls back to the previous version and restarts.

The old PostgreSQL binary remains cached at `~/.disc/postgres/<old-version>/` and is not deleted, so rollback is always possible.

> **Status:** the full `pg_dump`/`pg_restore` upgrade pipeline isn't implemented yet — `upgradeInstance` currently throws an error indicating the feature is in development. The CLI surface and the flow described above are the intended behavior. The command is gated until the pipeline ships, so running it on a real instance is safe (it errors out before touching anything).

---

## Configuration

### postgresql.conf

Disc generates a `postgresql.conf` tuned for local development. The configuration is written to the data directory during `disc init` and can be edited manually afterward.

Default settings:

```
# Connection Settings
listen_addresses = ""   # Unix socket only, no TCP
max_connections = 100
port = 5432             # Port for socket file naming
superuser_reserved_connections = 3

# Memory Settings
effective_cache_size = 512MB
maintenance_work_mem = 64MB
shared_buffers = 128MB
work_mem = 4MB

# WAL Settings
checkpoint_completion_target = 0.9
max_wal_size = 1GB
min_wal_size = 80MB
wal_level = replica

# Query Tuning
default_statistics_target = 100
random_page_cost = 1.1

# Logging
log_min_duration_statement = 100
log_rotation_age = 1d
log_rotation_size = 100MB
log_statement = "all"
logging_collector = on

# Disc-specific
jit = off               # Disabled for predictable performance
timezone = "UTC"
```

### Memory Tuning

Disc can auto-tune memory settings based on available system memory:

```typescript
import { PostgresConfig } from "disc/postgres/mod.ts";

const config = new PostgresConfig();
const tuned = config.tuneForMemory(4096); // 4 GB of RAM
// {
//   maxConnections: 100,
//   sharedBuffers: "1024MB",
//   workMem: "40MB"
// }
```

For systems with less than 1 GB of RAM, `maxConnections` is automatically reduced to 50.

### Connection Limits

Adjust the connection limit in `disc.toml` or by editing `postgresql.conf` directly:

```
max_connections = 200
```

Three connections are always reserved for superuser access (`superuser_reserved_connections = 3`).

### Socket Configuration

By default, PostgreSQL listens only on a Unix domain socket. The socket file is created at:

```
~/.disc/instances/<name>/socket/.s.PGSQL.5432
```

The connection DSN for socket-based connections:

```
postgresql://disc@/<instance-name>?host=/path/to/socket
```

No TCP port is exposed unless you explicitly set a port:

```typescript
const instance = new PostgresInstance({
  dataDir: "/path/to/data",
  instanceName: "my-project",
  port: 5433, // Enable TCP on this port
});
```

When a non-zero port is set, PostgreSQL listens on both the TCP port and the Unix socket.

---

## External PostgreSQL

For production deployments or environments where you manage your own PostgreSQL, use the `--backend-dsn` escape hatch:

```bash
disc init my-app --backend-dsn "postgres://user:pass@host:5432/disc"
```

When `--backend-dsn` is provided:

- Disc skips the PostgreSQL binary download entirely.
- No local data directory or socket is created.
- Disc connects to the external PostgreSQL using the provided DSN.
- The user is responsible for managing that PostgreSQL server (backups, upgrades, monitoring).
- Disc still manages its own internal schema tables (`disc_migrations`, `disc_schema`, etc.) within the target database.

You can also point to an existing PostgreSQL binary directory instead of downloading:

```typescript
const instance = new PostgresInstance({
  dataDir: "/path/to/data",
  instanceName: "my-project",
  pgBinDir: "/usr/local/pgsql/bin", // Use existing PG binaries
});
```

When `pgBinDir` is set, the download step is skipped and Disc uses the binaries at the specified path.

---

## Health Monitoring

The `PostgresMonitor` runs periodic health checks against the PostgreSQL instance.

### Default Behavior

- Health checks run every **30 seconds**.
- Each check connects to PostgreSQL, runs a lightweight query to measure latency, and reports the number of active connections, uptime, and version string.
- On a successful check, the restart attempt counter resets to zero.

### Auto-Restart

When a health check fails (connection refused, query timeout, or process not running):

1. Disc waits **5 seconds** before attempting a restart.
2. The instance is restarted via `pg_ctl stop` followed by `pg_ctl start`.
3. If the restart succeeds, monitoring continues normally.
4. If the restart fails, the attempt counter increments.
5. After **3 consecutive failures**, monitoring stops and an error is logged:
   ```
   PostgreSQL failed after 3 restart attempts. Manual intervention required.
   ```

### Configuring the Monitor

```typescript
import { PostgresMonitor } from "disc/postgres/mod.ts";

const monitor = new PostgresMonitor(instance, {
  autoRestart: true, // Enable auto-restart (default: true)
  checkIntervalMs: 15000, // Check every 15 seconds
  maxRestartAttempts: 5, // Allow 5 restart attempts before giving up
  restartDelayMs: 10000, // Wait 10 seconds between restart attempts
});

await monitor.start();
```

### Health Status

Query the current health status programmatically:

```typescript
const health = await monitor.checkHealth();
// {
//   connections: 3,
//   healthy: true,
//   lastCheck: 2026-03-20T14:30:00.000Z,
//   latencyMs: 5,
//   uptime: 86400,
//   version: "PostgreSQL 16.4 on ..."
// }

monitor.isHealthy(); // true
```

### Detailed Metrics

The monitor can also collect detailed database metrics:

```typescript
const metrics = await monitor.getMetrics();
// {
//   connections: { active: 2, idle: 5, total: 7 },
//   database: { size: "42 MB" },
//   tables: { count: 12, totalSize: "38 MB" }
// }
```

### Maintenance

Run ANALYZE and VACUUM on all tables:

```typescript
await monitor.performMaintenance();
```

This updates table statistics and reclaims storage from dead rows. It is safe to run during normal operation but may cause a brief increase in I/O.

---

## Multiple Instances

Disc supports multiple project instances running simultaneously. Each instance has its own data directory, log directory, and Unix socket:

```bash
disc init project-a
disc init project-b
```

The `PostgresManager` tracks all known instances:

```typescript
import { PostgresManager } from "disc/postgres/mod.ts";

const manager = new PostgresManager();

// Discover instances from disk
await manager.discoverInstances();

// List all known instances
manager.listInstances(); // ["project-a", "project-b"]

// Start a specific instance
await manager.startInstance("project-a");

// Get status for a specific instance
const status = await manager.getInstanceStatus("project-a");
```

Instances are independent. Starting, stopping, or destroying one instance does not affect others.

### Backup and Restore

Back up an instance to a `tar.gz` archive:

```typescript
await manager.backupInstance("my-project", "/backups/my-project.tar.gz");
```

The backup process stops PostgreSQL for a consistent snapshot, creates the archive, and restarts PostgreSQL. If the instance was not running before the backup, it remains stopped afterward.

Restore from a backup:

```typescript
await manager.restoreInstance("restored-project", "/backups/my-project.tar.gz");
```

This creates a new instance with the restored data. The instance name must not already exist.

### Destroying Instances

Remove an instance from the manager without deleting data:

```typescript
await manager.destroyInstance("my-project");
```

Remove an instance and delete all data:

```typescript
await manager.destroyInstance("my-project", true);
```

---

## Security

### Socket-Only by Default

PostgreSQL listens exclusively on a Unix domain socket. No TCP port is exposed unless explicitly configured. This means:

- No remote network access to PostgreSQL is possible by default.
- No firewall rules are needed for the database port.
- Connections are limited to processes on the local machine with filesystem access to the socket directory.

### Authentication

Local connections use `trust` authentication by default, which is appropriate for development. The `pg_hba.conf` generated by Disc allows:

- Local Unix socket connections from all users.
- IPv4 connections from `127.0.0.1/32` (localhost only).
- IPv6 connections from `::1/128` (localhost only).

For production use with an external PostgreSQL, configure your server’s `pg_hba.conf` with appropriate authentication methods (e.g., `scram-sha-256`).

### Checksummed Downloads

All PostgreSQL binary downloads are verified against SHA-256 checksums before extraction. If a checksum does not match, the download is rejected and the archive is deleted. This prevents tampered binaries from being installed.

### File Permissions

Extracted PostgreSQL binaries are set to mode `0755` (owner read/write/execute, group and others read/execute). The data directory is owned by the current user and is not world-readable by default.

---

## CLI Commands Reference

| Command                                         | Description                                         |
| ----------------------------------------------- | --------------------------------------------------- |
| `disc start`                                    | Start bundled PostgreSQL and the Disc server        |
| `disc stop`                                     | Stop the Disc server and bundled PostgreSQL         |
| `disc status`                                   | Show instance status (running, PID, port, data dir) |
| `disc pg log`                                   | View PostgreSQL logs                                |
| `disc pg log --follow`                          | Tail PostgreSQL logs in real time                   |
| `disc pg log --lines 50`                        | Show last 50 log lines                              |
| `disc pg log --level error`                     | Filter logs by severity level                       |
| `disc pg upgrade --target-version 17`           | Upgrade PostgreSQL to version 17                    |
| `disc pg upgrade --target-version 17 --dry-run` | Preview upgrade without making changes              |
| `disc init --backend-dsn <url>`                 | Use an external PostgreSQL instead of bundled       |

---

## Troubleshooting

### PostgreSQL fails to start

Check the logs first:

```bash
disc pg log --lines 20
```

Common causes:

- **Stale PID file.** If PostgreSQL was killed without a clean shutdown, a stale `postmaster.pid` file may remain. Disc detects and cleans up stale PID files automatically.
- **Port conflict.** If using TCP mode, ensure the port is not already in use.
- **Corrupted data directory.** If the data directory is corrupted, restore from a backup or reinitialize with `disc init`.

### Health monitor stops

After 3 consecutive failed restart attempts, the monitor stops and logs:

```
PostgreSQL failed after 3 restart attempts. Manual intervention required.
```

Investigate the cause in the PostgreSQL logs, fix the issue, and restart manually:

```bash
disc stop && disc start
```

### Binary download fails

If the download URL is unreachable or the checksum does not match, Disc reports the error and exits. Check your network connection and try again. The cached binary at `~/.disc/postgres/<version>/` can be deleted to force a fresh download:

```bash
rm -rf ~/.disc/postgres/16.4
disc start
```

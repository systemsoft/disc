# Postgres

Bundled PostgreSQL binary management and lifecycle for Disc. Handles downloading platform-specific PostgreSQL binaries, initializing data directories, starting/stopping instances, health monitoring, and instance management. Users never install or configure PostgreSQL directly.

## Import

```typescript
import {
  createInstance,
  getDefaultManager,
  getInstance,
  listInstances,
  PostgresBinaryDownloader,
  PostgresConfig,
  PostgresInstance,
  PostgresManager,
  PostgresMonitor,
  startInstance,
  stopInstance
} from "disc/postgres/mod.ts";
```

## Directory Layout

```
~/.disc/
  instances/
    my-project/
      data/           # PostgreSQL data directory (PGDATA)
      logs/           # PostgreSQL log files
      socket/         # Unix domain socket
  postgres/
    16.4/             # Downloaded PostgreSQL version
      bin/            # pg_ctl, initdb, postgres, etc.
      lib/            # Shared libraries
      share/          # Extensions and configs
    17.0/             # Multiple versions side-by-side
      ...
```

## PostgresManager

High-level manager for creating, starting, stopping, and discovering PostgreSQL instances.

```typescript
const manager = new PostgresManager();
// Or with custom base dir:
const manager = new PostgresManager("/custom/path/instances");
```

### Instance Lifecycle

```typescript
// Create and initialize a new instance
const instance = await manager.createInstance("my-project", {
  port: 5433, // optional, 0 = Unix socket only (default)
  postgresVersion: "16.4" // optional (default: "16.4")
});

// Start with health monitor
await manager.startInstance("my-project");

// Start without health monitor
await manager.startInstance("my-project", false);

// Stop
await manager.stopInstance("my-project");

// Destroy (stop + remove from manager, optionally delete data)
await manager.destroyInstance("my-project", true); // removeData = true
```

### Instance Discovery and Status

```typescript
// List known instance names
manager.listInstances(); // ["my-project", "test-db"]

// Get an instance by name
const instance = manager.getInstance("my-project");

// Get status with health info
const status = await manager.getInstanceStatus("my-project");
// { running: true, port: 0, pid: 12345, health: { healthy: true, ... } }

// Discover instances from disk (recover instances created in prior sessions)
await manager.discoverInstances();
```

### Backup and Restore

```typescript
// Backup (stops instance for consistency, creates tar.gz, restarts)
await manager.backupInstance("my-project", "/backups/my-project.tar.gz");

// Restore from backup
await manager.restoreInstance("restored-project", "/backups/my-project.tar.gz");
```

### Upgrade

```typescript
// Stop instance for upgrade to a target version
await manager.upgradeInstance("my-project", "17.0");
```

## PostgresInstance

Low-level instance that wraps `initdb`, `pg_ctl`, and PostgreSQL process management.

```typescript
import { PostgresInstance } from "disc/postgres/mod.ts";
import type { PostgresInstanceOptions } from "disc/postgres/mod.ts";

const instance = new PostgresInstance({
  instanceName: "my-project",
  dataDir: "/path/to/data",
  socketDir: "/path/to/socket", // optional
  port: 0, // 0 = Unix socket only
  postgresVersion: "16.4", // optional
  pgBinDir: "/custom/pg/bin" // optional: skip download, use existing binaries
});
```

### Lifecycle Methods

```typescript
await instance.init(); // download PG (if needed), initdb, generate config
await instance.start(); // pg_ctl start (waits for startup)
await instance.stop(); // pg_ctl stop -m fast (with force-kill fallback)
await instance.restart(); // stop + start
```

### Status and Connection

```typescript
const status = await instance.status();
// { running: true, pid: 12345, port: 0, dataDir: "...", socketPath: "...", version: "16.4" }

const dsn = instance.dsn();
// Unix socket: "postgresql://disc@/my-project?host=/path/to/socket"
// TCP: "postgresql://disc@localhost:5433/my-project"

instance.getSocketPath(); // "/path/to/socket/.s.PGSQL.5432"
instance.getDataDir(); // "/path/to/data"
instance.getPort(); // 0
```

## PostgresBinaryDownloader

Downloads and manages PostgreSQL binaries per platform. Binaries are cached in `~/.disc/postgres/<version>/`.

```typescript
const downloader = new PostgresBinaryDownloader();
// Or with custom base dir:
const downloader = new PostgresBinaryDownloader("/custom/path/postgres");

// Download (or verify already downloaded)
const versionDir = await downloader.download("16.4");

// Convenience: ensure + return path
const versionDir = await downloader.ensurePostgres("16.4");
```

### Platform Support

| Platform      | Source                           |
| ------------- | -------------------------------- |
| macOS (arm64) | EDB official binaries            |
| macOS (x64)   | EDB official binaries            |
| Linux (x64)   | Zonky embedded-postgres-binaries |
| Linux (arm64) | Zonky embedded-postgres-binaries |

Supported versions: `16.4`, `17.0`. Downloads are SHA-256 checksummed.

## PostgresConfig

Generates `postgresql.conf` and `pg_hba.conf` content tuned for Disc.

```typescript
const config = new PostgresConfig();

// Generate postgresql.conf
const content = config.generate({
  dataDir: "/path/to/data",
  port: 0, // 0 = socket only
  socketDir: "/path/to/socket",
  maxConnections: 100, // default: 100
  sharedBuffers: "128MB", // default: "128MB"
  workMem: "4MB" // default: "4MB"
});

// Generate pg_hba.conf
const hbaContent = config.generateHBAConfig();

// Auto-tune based on available memory
const tuned = config.tuneForMemory(4096); // 4GB
// { sharedBuffers: "1024MB", workMem: "40MB", maxConnections: 100 }
```

### Default Configuration Highlights

- Unix socket only (no TCP by default)
- `listen_addresses = ''`
- WAL level: replica
- Logging collector enabled with daily rotation
- Slow query logging at 100ms threshold
- JIT disabled for predictable performance
- UTC timezone

## PostgresMonitor

Health monitor that periodically checks PostgreSQL status and auto-restarts on failure.

```typescript
const monitor = new PostgresMonitor(instance, {
  checkIntervalMs: 30000, // default: 30 seconds
  autoRestart: true, // default: true
  maxRestartAttempts: 3, // default: 3
  restartDelayMs: 5000 // default: 5 seconds
});

await monitor.start();

// Check health on demand
const health = await monitor.checkHealth();
// { healthy: true, latencyMs: 5, connections: 3, uptime: 3600, version: "..." }

// Get last cached health status
monitor.getLastHealthStatus();

// Quick healthy check
monitor.isHealthy(); // true | false

// Get detailed metrics (db size, table stats, connections)
const metrics = await monitor.getMetrics();

// Run maintenance (ANALYZE + VACUUM)
await monitor.performMaintenance();

monitor.stop();
```

### Auto-Restart Behavior

When a health check fails and `autoRestart` is enabled:

1. Wait `restartDelayMs` before attempting restart.
2. Call `instance.restart()`.
3. If restart fails, increment attempt counter.
4. After `maxRestartAttempts` consecutive failures, stop monitoring and log an error requiring manual intervention.
5. Reset attempt counter on any successful health check.

## Convenience Functions

The module exports convenience functions that use a default singleton `PostgresManager`:

```typescript
import {
  createInstance,
  getInstance,
  listInstances,
  startInstance,
  stopInstance
} from "disc/postgres/mod.ts";

const instance = await createInstance("test-db");
await startInstance("test-db");
const inst = getInstance("test-db");
const names = listInstances();
await stopInstance("test-db");
```

## CLI Commands

```bash
disc start                 # Start server + bundled PostgreSQL
disc stop                  # Stop server + PostgreSQL
disc status                # Show instance status (running, port, data dir)
disc pg log                # View PostgreSQL logs
disc pg log -f             # Follow log output
disc pg upgrade --target-version 17.0  # Upgrade PostgreSQL version
```

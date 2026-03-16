/**
 * PostgreSQL Test Harness for Disc
 *
 * Provides utilities for running tests against a real PostgreSQL instance.
 * Supports three modes:
 *
 *   1. External PG via DISC_PG_TEST_URL — user provides a running Postgres.
 *   2. Auto-start PG via DISC_PG_AUTO=1 — harness finds local PG binaries,
 *      spins up a temporary instance on a random TCP port, and tears it down
 *      when the process exits.
 *   3. Skipped — when neither env var is set, `canRunPgTests()` returns false
 *      and test files should use `{ ignore: !canRunPgTests() }`.
 *
 * Usage in a test file:
 *
 *   import { canRunPgTests, getTestDsn, cleanupTestTables } from "../tests/pg-test-harness.ts";
 *
 *   Deno.test({ name: "...", ignore: !canRunPgTests(), fn: async () => {
 *     const dsn = await getTestDsn();
 *     // ... use dsn ...
 *     await cleanupTestTables(dsn);
 *   }});
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { PostgresInstance } from "../postgres/instance.ts";

// ---------------------------------------------------------------------------
// Module-level singleton state
// ---------------------------------------------------------------------------

/** Cached DSN so we only start PG once per process. */
let cachedDsn: string | undefined;

/** The temporary PostgresInstance (only when auto-started). */
let tempInstance: PostgresInstance | undefined;

/** The temp directory holding the PG data dir (for cleanup). */
let tempBaseDir: string | undefined;

/** Whether we have already registered the unload handler. */
let cleanupRegistered = false;

// ---------------------------------------------------------------------------
// findPgBinDir
// ---------------------------------------------------------------------------

/**
 * Auto-detect a directory containing PostgreSQL binaries (`initdb`, `pg_ctl`).
 *
 * Search order:
 *   1. `DISC_PG_BINARY_PATH` environment variable
 *   2. macOS Postgres.app (latest)
 *   3. Homebrew postgresql@16, then unversioned postgresql
 *   4. `which pg_ctl` fallback
 *
 * Returns the path if both `initdb` and `pg_ctl` exist inside it, otherwise
 * `undefined`.
 */
export function findPgBinDir(): string | undefined {
  // 1. Explicit env var
  const envPath = Deno.env.get("DISC_PG_BINARY_PATH");
  if (envPath && hasPgBinaries(envPath)) {
    return envPath;
  }

  // 2. macOS Postgres.app
  const postgresApp = "/Applications/Postgres.app/Contents/Versions/latest/bin";
  if (hasPgBinaries(postgresApp)) {
    return postgresApp;
  }

  // 3. Homebrew paths
  const brewPaths = [
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/opt/postgresql/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/usr/local/opt/postgresql/bin",
  ];

  for (const p of brewPaths) {
    if (hasPgBinaries(p)) {
      return p;
    }
  }

  // 4. Fall back to `which pg_ctl`
  try {
    const cmd = new Deno.Command("which", {
      args: ["pg_ctl"],
      stdout: "piped",
      stderr: "piped",
    });
    const output = cmd.outputSync();

    if (output.success) {
      const pgCtlPath = new TextDecoder().decode(output.stdout).trim();

      if (pgCtlPath) {
        // pg_ctl lives in a bin/ directory — go up one level to get the dir
        const binDir = pgCtlPath.replace(/\/pg_ctl$/, "");

        if (hasPgBinaries(binDir)) {
          return binDir;
        }
      }
    }
  } catch {
    // `which` not available or failed — ignore
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// canRunPgTests
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the environment is configured to run PG-dependent tests.
 *
 * Either:
 *   - `DISC_PG_TEST_URL` is set (user provides their own PG), OR
 *   - `DISC_PG_AUTO=1` is set AND `findPgBinDir()` locates usable binaries.
 */
export function canRunPgTests(): boolean {
  if (Deno.env.get("DISC_PG_TEST_URL")) {
    return true;
  }

  if (Deno.env.get("DISC_PG_AUTO") === "1" && findPgBinDir() !== undefined) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// getTestDsn
// ---------------------------------------------------------------------------

/**
 * Returns a PostgreSQL connection string suitable for tests.
 *
 * - If `DISC_PG_TEST_URL` is set, returns it immediately.
 * - Otherwise, starts a temporary PostgreSQL instance on a random TCP port,
 *   creates a `disc_test` database, and returns the DSN.
 *
 * The temporary instance is cached as a module-level singleton so that
 * multiple calls (from different test files in the same process) reuse the
 * same server.
 *
 * Cleanup is registered via `globalThis.addEventListener("unload", ...)` to
 * stop PG and remove the temp directory when the process exits.
 */
export async function getTestDsn(): Promise<string> {
  // Fast path: already resolved
  if (cachedDsn) {
    return cachedDsn;
  }

  // External PG provided by the user
  const externalUrl = Deno.env.get("DISC_PG_TEST_URL");

  if (externalUrl) {
    cachedDsn = externalUrl;
    return cachedDsn;
  }

  // Auto-start a temporary PG instance
  const pgBinDir = findPgBinDir();

  if (!pgBinDir) {
    throw new Error(
      "Cannot start test PostgreSQL: no PG binaries found. " +
        "Set DISC_PG_BINARY_PATH or install PostgreSQL locally.",
    );
  }

  // Find a free TCP port
  const port = await findFreePort();

  // Create temp directories
  // Use /tmp directly to keep Unix socket paths under the 108-char limit.
  // Default Deno temp dirs on macOS (/var/folders/...) are too long.
  tempBaseDir = await Deno.makeTempDir({ dir: "/tmp", prefix: "disc-pg-" });
  const dataDir = join(tempBaseDir, "data");
  const socketDir = join(tempBaseDir, "socket");
  const logsDir = join(tempBaseDir, "logs");

  await ensureDir(dataDir);
  await ensureDir(socketDir);
  await ensureDir(logsDir);

  // Create and initialize the PG instance
  tempInstance = new PostgresInstance({
    dataDir,
    instanceName: "disc_test",
    pgBinDir,
    port,
    socketDir,
  });

  await tempInstance.init();

  // Overwrite postgresql.conf to enable TCP on our port (the default config
  // generated by PostgresInstance sets listen_addresses = '' for socket-only;
  // we need TCP for deno-postgres compatibility).
  const confPath = join(dataDir, "postgresql.conf");
  const confContent = buildTestPgConf(port, socketDir);
  await Deno.writeTextFile(confPath, confContent);

  // Start PostgreSQL
  await tempInstance.start();

  // Wait briefly for TCP listener to be ready
  await waitForPg(port);

  // Create the test database.
  // initdb creates a default superuser named "disc" (see instance.ts runInitDb).
  // Connect to the default "postgres" database to create disc_test.
  await createTestDatabase(port);

  cachedDsn = `postgresql://disc@localhost:${port}/disc_test`;

  // Register cleanup on process exit (only once)
  registerCleanup();

  return cachedDsn;
}

// ---------------------------------------------------------------------------
// cleanupTestTables
// ---------------------------------------------------------------------------

/**
 * Drop Disc migration tracking tables from the given database.
 * Useful for resetting state between tests.
 */
export async function cleanupTestTables(dsn: string): Promise<void> {
  const config = parseDsn(dsn);
  const client = new Client(config);

  try {
    await client.connect();
    await client.queryArray(
      "DROP TABLE IF EXISTS disc_migrations CASCADE;",
    );
    await client.queryArray(
      "DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE;",
    );
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a directory contains both `initdb` and `pg_ctl`.
 */
function hasPgBinaries(dir: string): boolean {
  try {
    const initdb = Deno.statSync(join(dir, "initdb"));
    const pgCtl = Deno.statSync(join(dir, "pg_ctl"));
    return initdb.isFile && pgCtl.isFile;
  } catch {
    return false;
  }
}

/**
 * Find a free TCP port by binding to port 0 and immediately closing.
 */
async function findFreePort(): Promise<number> {
  const listener = Deno.listen({ port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();

  // Small delay to ensure the OS fully releases the port
  await new Promise((resolve) => setTimeout(resolve, 50));
  return port;
}

/**
 * Build a minimal postgresql.conf that enables TCP on the given port.
 * The test instance is ephemeral so we optimise for fast startup, not
 * durability.
 */
function buildTestPgConf(port: number, socketDir: string): string {
  return [
    "# Disc test harness — ephemeral PostgreSQL configuration",
    `listen_addresses = 'localhost'`,
    `port = ${port}`,
    `unix_socket_directories = '${socketDir}'`,
    `max_connections = 20`,
    `shared_buffers = 32MB`,
    `work_mem = 4MB`,
    `fsync = off`,
    `synchronous_commit = off`,
    `full_page_writes = off`,
    `logging_collector = off`,
    `log_statement = 'none'`,
    `jit = off`,
  ].join("\n");
}

/**
 * Wait until PostgreSQL is accepting TCP connections on the given port.
 * Times out after 15 seconds.
 */
async function waitForPg(
  port: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      conn.close();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  throw new Error(
    `Timed out waiting for PostgreSQL on port ${port} after ${timeoutMs}ms`,
  );
}

/**
 * Connect to the `postgres` default database and create `disc_test`.
 */
async function createTestDatabase(port: number): Promise<void> {
  const client = new Client({
    hostname: "localhost",
    port,
    user: "disc",
    database: "postgres",
  });

  try {
    await client.connect();

    // Check if the database already exists
    const result = await client.queryObject<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = 'disc_test') AS exists`,
    );

    const row = result.rows[0];

    if (!row?.exists) {
      await client.queryArray(`CREATE DATABASE disc_test`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Parse a postgresql:// DSN into Client connection options.
 */
function parseDsn(
  dsn: string,
): { hostname: string; port: number; user: string; database: string } {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test",
  };
}

/**
 * Register a process-exit handler that stops the temporary PG and removes
 * the temp directory. Only registered once.
 */
function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  globalThis.addEventListener("unload", () => {
    // Best-effort cleanup — we cannot await here, so use sync where possible
    // and fire-and-forget the async stop.
    if (tempInstance) {
      try {
        // pg_ctl stop is the cleanest path; run it synchronously via
        // Deno.Command so the process waits for PG to shut down.
        const pgBinDir = findPgBinDir();

        if (pgBinDir && tempBaseDir) {
          const dataDir = join(tempBaseDir, "data");
          const pgCtl = join(pgBinDir, "pg_ctl");
          const cmd = new Deno.Command(pgCtl, {
            args: ["stop", "-D", dataDir, "-m", "immediate", "-w", "-t", "5"],
            stdout: "piped",
            stderr: "piped",
          });
          cmd.outputSync();
        }
      } catch {
        // Ignore — process is exiting anyway
      }

      tempInstance = undefined;
    }

    if (tempBaseDir) {
      try {
        Deno.removeSync(tempBaseDir, { recursive: true });
      } catch {
        // Ignore — temp dir cleanup is best effort
      }

      tempBaseDir = undefined;
    }
  });
}

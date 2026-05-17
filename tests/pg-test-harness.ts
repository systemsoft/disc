/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

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
 *
 * Debug mode:
 *
 *   Set DISC_PG_DEBUG=1 to enable verbose logging during PG startup/teardown.
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import type { DatabaseConnection } from "../lib/database.ts";
import { PostgresInstance } from "../postgres/instance.ts";

// ---------------------------------------------------------------------------
// Debug logging helper
// ---------------------------------------------------------------------------

const PG_DEBUG = Deno.env.get("DISC_PG_DEBUG") === "1";

function debugLog(msg: string): void {
  if (PG_DEBUG) {
    // deno-lint-ignore no-console
    console.error(`[pg-harness] ${msg}`);
  }
}

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
// P1-47: cache the result so repeated tests don't fork `which pg_ctl`.
// Cleared automatically at test-process exit; explicit null means
// "we tried once and failed" so subsequent calls short-circuit too.
let cachedPgBinDir: string | undefined | null = undefined;

export function findPgBinDir(): string | undefined {
  if (cachedPgBinDir !== undefined) {
    return cachedPgBinDir ?? undefined;
  }
  const result = findPgBinDirUncached();
  cachedPgBinDir = result ?? null;
  return result;
}

function findPgBinDirUncached(): string | undefined {
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
    "/usr/local/opt/postgresql/bin"
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
      stderr: "piped"
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
        "Set DISC_PG_BINARY_PATH or install PostgreSQL locally."
    );
  }

  // Find a free TCP port
  const port = await findFreePort();

  debugLog(`Starting temporary PG on port ${port}, bin=${pgBinDir}`);

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

  debugLog(`Temp dirs: data=${dataDir}, socket=${socketDir}`);

  // Create and initialize the PG instance
  tempInstance = new PostgresInstance({
    dataDir,
    instanceName: "disc_test",
    pgBinDir,
    port,
    socketDir
  });

  await tempInstance.init();
  debugLog("PG initdb complete");

  // Overwrite postgresql.conf to enable TCP on our port (the default config
  // generated by PostgresInstance sets listen_addresses = '' for socket-only;
  // we need TCP for deno-postgres compatibility).
  const confPath = join(dataDir, "postgresql.conf");
  const confContent = buildTestPgConf(port, socketDir);
  await Deno.writeTextFile(confPath, confContent);

  // Start PostgreSQL
  await tempInstance.start();
  debugLog("PG process started, waiting for TCP listener…");

  // Wait for TCP listener to be ready (30s with exponential backoff)
  await waitForPg(port);
  debugLog("PG is accepting connections");

  // Create the test database.
  // initdb creates a default superuser named "disc" (see instance.ts runInitDb).
  // Connect to the default "postgres" database to create disc_test.
  await createTestDatabase(port);
  debugLog("disc_test database created");

  cachedDsn = `postgresql://disc@localhost:${port}/disc_test`;

  // Register cleanup on process exit (only once)
  registerCleanup();

  return cachedDsn;
}

// ---------------------------------------------------------------------------
// makePool
// ---------------------------------------------------------------------------

/**
 * Build a small `ConnectionPool` suited to a single test file. Defaults match
 * the per-file helpers that previously lived in every pg-*.test.ts: 1-3
 * connections and no idle cleanup timer.
 */
export function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0
  });
}

// ---------------------------------------------------------------------------
// Per-file DB helpers
//
// These wrap the raw `deno-postgres` Client so each test file can open and
// dispose its own connection without paying the pool setup cost. Use these
// for ad-hoc inspection (does this table exist? what columns does it have?)
// alongside the ConnectionPool used by the system-under-test.
// ---------------------------------------------------------------------------

/**
 * `true` when the `public` schema contains a table named `tableName`. Matches
 * the casing PostgreSQL uses for unquoted identifiers (lowercase).
 */
export async function tableExists(
  dsn: string,
  tableName: string
): Promise<boolean> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    const result = await client.queryObject<{ exists: boolean; }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [tableName]
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

/**
 * DROP each table with CASCADE. Identifiers are quoted so PG-reserved names
 * like `user` don't break on parse. Best-effort — runs each DROP
 * independently and ignores errors from missing tables.
 *
 * For trigger-function or rewrite-fn cleanup, keep a file-local helper —
 * those queries vary by feature being tested.
 */
export async function dropTables(
  dsn: string,
  ...tableNames: string[]
): Promise<void> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    for (const name of tableNames) {
      await client.queryArray(`DROP TABLE IF EXISTS "${name}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Run a SQL statement (or list of params + parameterized SQL) on a fresh
 * client connection. Returns nothing — for SELECTs, use `queryRows`.
 */
export async function execSQL(
  dsn: string,
  sql: string,
  params?: unknown[]
): Promise<void> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    if (params) {
      await client.queryArray(sql, params);
    } else {
      await client.queryArray(sql);
    }
  } finally {
    await client.end();
  }
}

/**
 * Run a SQL query and return rows typed as `T`. Caller supplies the row
 * shape; this just plumbs the generic through to `queryObject`.
 */
export async function queryRows<T>(
  dsn: string,
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    const result = params ?
      await client.queryObject<T>(sql, params) :
      await client.queryObject<T>(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * Return all columns of `tableName` (public schema), ordered by ordinal
 * position. Always selects the full common set — callers ignore fields they
 * don't need. Range/array tests rely on `udt_name`; the comprehensive
 * migration suite relies on `is_nullable`.
 */
export async function getColumns(
  dsn: string,
  tableName: string
): Promise<
  {
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
  }[]
> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    const result = await client.queryObject<{
      column_name: string;
      data_type: string;
      udt_name: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );
    return result.rows;
  } finally {
    await client.end();
  }
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
      "DROP TABLE IF EXISTS disc_migrations CASCADE;"
    );
    await client.queryArray(
      "DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE;"
    );
  } finally {
    await client.end();
  }
}

/**
 * Drop all user-created tables in the public schema (excluding system tables
 * and disc migration tracking tables). Accepts either a ConnectionPool or a
 * DatabaseConnection.
 *
 * Use this in test teardown to ensure a clean slate without recreating the
 * entire database.
 */
export async function resetTestDatabase(
  pool: ConnectionPool | DatabaseConnection
): Promise<void> {
  const result = await pool.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename NOT LIKE 'pg_%'
  `);

  for (const row of result.rows) {
    const tableName = row["tablename"] as string;
    await pool.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
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
  await new Promise(resolve => setTimeout(resolve, 50));
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
    `jit = off`
  ]
    .join("\n");
}

/**
 * Wait until PostgreSQL is accepting TCP connections on the given port.
 *
 * Uses exponential backoff starting at 100ms, doubling each retry up to a
 * per-attempt cap of 5000ms. Total timeout is 30 seconds.
 */
async function waitForPg(
  port: number,
  timeoutMs = 30_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 100;
  const maxDelay = 5_000;
  let attempts = 0;

  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: "127.0.0.1", port });
      conn.close();
      debugLog(`PG ready after ${attempts} retries`);
      return;
    } catch {
      attempts++;
      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        break;
      }

      const wait = Math.min(delay, maxDelay, remaining);
      debugLog(
        `Waiting ${wait}ms for PG on port ${port} (attempt ${attempts})`
      );
      await new Promise(resolve => setTimeout(resolve, wait));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  throw new Error(
    `Timed out waiting for PostgreSQL on port ${port} after ${timeoutMs}ms`
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
    database: "postgres"
  });

  try {
    await client.connect();

    // Check if the database already exists
    const result = await client.queryObject<{ exists: boolean; }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = 'disc_test') AS exists`
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
 * Parse a `postgresql://` DSN into the connection options that
 * `deno-postgres`'s `Client` constructor expects. Defaults match the test
 * instance (`disc` superuser, `disc_test` database, localhost:5432).
 */
export function parseDsn(
  dsn: string
): { hostname: string; port: number; user: string; database: string; } {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test"
  };
}

/**
 * Register a process-exit handler that stops the temporary PG and removes
 * the temp directory. Only registered once.
 *
 * Cleanup errors are caught and logged (when DISC_PG_DEBUG=1) so they do not
 * mask test failures.
 */
function registerCleanup(): void {
  if (cleanupRegistered) {
    return;
  }
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
          debugLog(`Stopping PG: ${pgCtl} stop -D ${dataDir}`);
          const cmd = new Deno.Command(pgCtl, {
            args: [
              "stop",
              "-D",
              dataDir,
              "-m",
              "immediate",
              "-w",
              "-t",
              "10"
            ],
            stdout: "piped",
            stderr: "piped"
          });

          try {
            const out = cmd.outputSync();
            debugLog(
              `pg_ctl stop exited with code ${out.code}`
            );
          } catch (stopErr) {
            debugLog(`pg_ctl stop failed: ${stopErr}`);
          }
        }
      } catch (err) {
        debugLog(`Cleanup error during PG shutdown: ${err}`);
      }

      tempInstance = undefined;
    }

    if (tempBaseDir) {
      try {
        Deno.removeSync(tempBaseDir, { recursive: true });
        debugLog(`Removed temp dir: ${tempBaseDir}`);
      } catch (err) {
        debugLog(`Failed to remove temp dir ${tempBaseDir}: ${err}`);
      }

      tempBaseDir = undefined;
    }
  });
}

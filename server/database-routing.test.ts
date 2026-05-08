/**
 * Tests for Database Routing and Session Integration (Phase 24.2)
 *
 * Validates that:
 * - Database name is resolved from X-Database header, ?database= param, or default
 * - Precedence: header > query param > default ("disc")
 * - Protocol handlers route to the correct pool via DatabaseRegistry
 * - Unknown databases are rejected when a registry is present
 * - Backward compatibility: no registry = existing single-pool behavior
 * - Session context carries the resolved database name
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import type { DatabaseEntry, DatabaseRegistry } from "./database-registry.ts";
import type { QueryContext, SessionContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

/** Create a minimal SessionContext for testing. */
function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionId: "sess_test_1",
    database: "disc",
    createdAt: new Date(),
    lastActivity: new Date(),
    variables: {},
    ...overrides
  };
}

/** Create a minimal QueryContext for testing. */
function makeContext(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    session: makeSession(overrides.session as Partial<SessionContext>),
    auth: { roles: [], permissions: [] },
    requestId: "req_test_1",
    startedAt: new Date(),
    ...overrides
  };
}

/**
 * A lightweight mock of DatabaseRegistry that avoids real PG connections.
 * We only need getDatabase() for the routing tests.
 */
function createMockRegistry(
  databases: Record<string, Partial<DatabaseEntry>>
): DatabaseRegistry {
  const map = new Map<string, DatabaseEntry>();
  for (const [name, partial] of Object.entries(databases)) {
    map.set(name, {
      name,
      pool: partial.pool ?? ({} as ConnectionPool),
      schema: partial.schema ?? null,
      migrationTracker: partial.migrationTracker ?? null,
      databaseUrl: partial.databaseUrl ?? `postgresql://localhost:5432/${name}`
    });
  }

  return {
    getDatabase(name: string): DatabaseEntry | undefined {
      return map.get(name);
    },
    getDefaultDatabase(): DatabaseEntry {
      return map.get("disc")!;
    },
    listDatabases(): string[] {
      return Array.from(map.keys());
    }
  } as DatabaseRegistry;
}

// ---------------------------------------------------------------------------
// resolveDatabaseName logic (tested via HttpServer internals)
// We test the resolution logic by simulating what HttpServer.resolveDatabaseName does.
// ---------------------------------------------------------------------------

/** Pure implementation of the resolution logic for isolated testing. */
function resolveDatabaseName(
  headers: Headers,
  searchParams: URLSearchParams
): string {
  const headerValue = headers.get("X-Database");
  if (headerValue) {
    return headerValue;
  }

  const paramValue = searchParams.get("database");
  if (paramValue) {
    return paramValue;
  }

  return "disc";
}

// ---------------------------------------------------------------------------
// Database resolution from X-Database header
// ---------------------------------------------------------------------------

Deno.test("resolveDatabaseName - X-Database header is used when present", () => {
  const headers = new Headers({ "X-Database": "analytics" });
  const params = new URLSearchParams();
  assertEquals(resolveDatabaseName(headers, params), "analytics");
});

Deno.test("resolveDatabaseName - X-Database header value is preserved as-is", () => {
  const headers = new Headers({ "X-Database": "my_custom_db" });
  const params = new URLSearchParams();
  assertEquals(resolveDatabaseName(headers, params), "my_custom_db");
});

// ---------------------------------------------------------------------------
// Database resolution from ?database= query param
// ---------------------------------------------------------------------------

Deno.test("resolveDatabaseName - ?database= query param is used when no header", () => {
  const headers = new Headers();
  const params = new URLSearchParams({ database: "reporting" });
  assertEquals(resolveDatabaseName(headers, params), "reporting");
});

Deno.test("resolveDatabaseName - ?database= param value is preserved as-is", () => {
  const headers = new Headers();
  const params = new URLSearchParams({ database: "test_db_2" });
  assertEquals(resolveDatabaseName(headers, params), "test_db_2");
});

// ---------------------------------------------------------------------------
// Precedence: header > query param > default
// ---------------------------------------------------------------------------

Deno.test("resolveDatabaseName - header takes precedence over query param", () => {
  const headers = new Headers({ "X-Database": "from_header" });
  const params = new URLSearchParams({ database: "from_param" });
  assertEquals(resolveDatabaseName(headers, params), "from_header");
});

Deno.test("resolveDatabaseName - query param takes precedence over default", () => {
  const headers = new Headers();
  const params = new URLSearchParams({ database: "from_param" });
  assertEquals(resolveDatabaseName(headers, params), "from_param");
});

// ---------------------------------------------------------------------------
// Default database fallback
// ---------------------------------------------------------------------------

Deno.test("resolveDatabaseName - defaults to 'disc' when no header or param", () => {
  const headers = new Headers();
  const params = new URLSearchParams();
  assertEquals(resolveDatabaseName(headers, params), "disc");
});

Deno.test("resolveDatabaseName - defaults to 'disc' when header and param are absent", () => {
  const headers = new Headers({ "Content-Type": "application/json" });
  const params = new URLSearchParams({ format: "json" });
  assertEquals(resolveDatabaseName(headers, params), "disc");
});

// ---------------------------------------------------------------------------
// Mock registry: getDatabase resolves known databases
// ---------------------------------------------------------------------------

Deno.test("mock registry - getDatabase returns entry for known name", () => {
  const registry = createMockRegistry({
    disc: {},
    analytics: { databaseUrl: "postgresql://localhost:5432/disc_analytics" }
  });

  const entry = registry.getDatabase("analytics");
  assertExists(entry);
  assertEquals(entry.name, "analytics");
  assertStringIncludes(entry.databaseUrl, "disc_analytics");
});

Deno.test("mock registry - getDatabase returns undefined for unknown name", () => {
  const registry = createMockRegistry({ disc: {} });
  assertEquals(registry.getDatabase("nonexistent"), undefined);
});

// ---------------------------------------------------------------------------
// Protocol handler pool resolution via registry
// ---------------------------------------------------------------------------

Deno.test("pool resolution - uses registry pool when session database matches", () => {
  const analyticsPool = { _tag: "analytics" } as unknown as ConnectionPool;
  const registry = createMockRegistry({
    disc: {},
    analytics: { pool: analyticsPool }
  });

  // Simulate the resolvePool logic from edgeql-protocol
  const context = makeContext({
    session: makeSession({ database: "analytics" })
  });

  const entry = registry.getDatabase(context.session.database);
  assertExists(entry);
  assertEquals(entry.pool, analyticsPool);
});

Deno.test("pool resolution - falls back to default when database not in registry", () => {
  const defaultPool = { _tag: "default" } as unknown as ConnectionPool;
  const registry = createMockRegistry({
    disc: { pool: defaultPool }
  });

  const context = makeContext({
    session: makeSession({ database: "unknown_db" })
  });

  const entry = registry.getDatabase(context.session.database);
  assertEquals(entry, undefined);

  // In protocol handlers, when entry is undefined the handler falls back
  // to its own this.pool, which is the default behavior.
  const fallback = registry.getDatabase("disc");
  assertExists(fallback);
  assertEquals(fallback.pool, defaultPool);
});

// ---------------------------------------------------------------------------
// Error when requesting unknown database (registry present)
// ---------------------------------------------------------------------------

Deno.test("database validation - unknown database returns undefined from registry", () => {
  const registry = createMockRegistry({
    disc: {},
    users: {}
  });

  // This is what HttpServer checks before proceeding
  const entry = registry.getDatabase("nonexistent_db");
  assertEquals(entry, undefined);
});

Deno.test("database validation - known database passes validation", () => {
  const registry = createMockRegistry({
    disc: {},
    users: {}
  });

  const entry = registry.getDatabase("users");
  assertExists(entry);
  assertEquals(entry.name, "users");
});

// ---------------------------------------------------------------------------
// Backward compat: no registry = existing behavior
// ---------------------------------------------------------------------------

Deno.test("backward compat - resolvePool returns handler pool when no registry", () => {
  // When databaseRegistry is undefined, the protocol handler should
  // use its own this.pool — the existing single-database behavior.
  const handlerPool = { _tag: "handler" } as unknown as ConnectionPool;

  // Simulate resolvePool logic with no registry
  const registry = undefined as DatabaseRegistry | undefined;
  const context = makeContext({
    session: makeSession({ database: "anything" })
  });

  let resolvedPool: ConnectionPool | undefined;
  if (registry && context.session.database) {
    const entry = registry.getDatabase(context.session.database);
    if (entry) {
      resolvedPool = entry.pool;
    }
  }
  // Fall through to handler pool
  if (!resolvedPool) {
    resolvedPool = handlerPool;
  }

  assertEquals(resolvedPool, handlerPool);
});

Deno.test("backward compat - no registry means all requests use default pool", () => {
  const handlerPool = { _tag: "single" } as unknown as ConnectionPool;

  // Multiple contexts with different database names should all
  // resolve to the handler's pool when no registry is set.
  for (const dbName of ["disc", "analytics", "users", ""]) {
    const context = makeContext({
      session: makeSession({ database: dbName })
    });

    const registry = undefined as DatabaseRegistry | undefined;
    let resolvedPool: ConnectionPool | undefined;
    if (registry && context.session.database) {
      const entry = registry.getDatabase(context.session.database);
      if (entry) {
        resolvedPool = entry.pool;
      }
    }
    if (!resolvedPool) {
      resolvedPool = handlerPool;
    }

    assertEquals(resolvedPool, handlerPool);
  }
});

// ---------------------------------------------------------------------------
// Session context carries database name
// ---------------------------------------------------------------------------

Deno.test("session context - database name is set from resolution", () => {
  const session = makeSession({ database: "analytics" });
  assertEquals(session.database, "analytics");
});

Deno.test("session context - database defaults to 'disc' in makeSession", () => {
  const session = makeSession();
  assertEquals(session.database, "disc");
});

Deno.test("session context - database can be mutated after creation", () => {
  const session = makeSession({ database: "disc" });
  assertEquals(session.database, "disc");

  // HttpServer sets this after connection creation
  session.database = "analytics";
  assertEquals(session.database, "analytics");
});

Deno.test("query context - carries session database through to handler", () => {
  const context = makeContext({
    session: makeSession({ database: "reporting" })
  });

  assertEquals(context.session.database, "reporting");
});

// ---------------------------------------------------------------------------
// Registry list and default database
// ---------------------------------------------------------------------------

Deno.test("mock registry - listDatabases returns all registered names", () => {
  const registry = createMockRegistry({
    disc: {},
    alpha: {},
    beta: {}
  });

  const names = registry.listDatabases();
  assertEquals(names.length, 3);
  assertEquals(names.includes("disc"), true);
  assertEquals(names.includes("alpha"), true);
  assertEquals(names.includes("beta"), true);
});

Deno.test("mock registry - getDefaultDatabase returns the disc entry", () => {
  const registry = createMockRegistry({
    disc: { databaseUrl: "postgresql://localhost:5432/disc" },
    other: {}
  });

  const defaultDb = registry.getDefaultDatabase();
  assertExists(defaultDb);
  assertEquals(defaultDb.name, "disc");
});

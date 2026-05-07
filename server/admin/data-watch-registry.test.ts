/**
 * Unit + integration tests for `DataWatchRegistry` (Bundle L — #3c
 * Phase 2).
 *
 * Unit tests use a mock pool that returns canned change-log rows so
 * we exercise dispatch + debounce without spinning up Postgres. The
 * PG-backed test runs the full mutation → poll → invalidate roundtrip
 * (skipped without DISC_PG_AUTO=1).
 */

import { assertEquals, assertGreater } from "@std/assert";
import { canRunPgTests, getTestDsn } from "../../tests/pg-test-harness.ts";
import { ConnectionPool } from "../../lib/connection-pool.ts";
import { bootstrapDataWatch, CHANGE_LOG_TABLE } from "./data-watch-ddl.ts";
import { DataWatchRegistry } from "./data-watch-registry.ts";

// ---------------------------------------------------------------------------
// Mock pool — just enough surface for the registry to call.
// ---------------------------------------------------------------------------

function makeMockPool(rowsByCall: Array<unknown[]>) {
  let callIndex = 0;
  return {
    query(_sql: string, _params?: unknown[]) {
      const rows = rowsByCall[callIndex] ?? [];
      callIndex++;
      return Promise.resolve({ rows, rowCount: rows.length });
    },
    execute() {
      return Promise.resolve();
    },
  } as unknown as ConnectionPool;
}

Deno.test("registry — fans invalidate to subscribers whose tables intersect", async () => {
  // Call 1 (cursor read) → empty. Call 2 (poll) → one row on `users`.
  const pool = makeMockPool([
    [{ cur: 0 }], // initial cursor read in start()
    [{ id: 1, table_name: "users" }],
  ]);
  const registry = new DataWatchRegistry({
    pool,
    pollIntervalMs: 1_000_000, // disable real timer
    invalidateDebounceMs: 0, // immediate fire
    pruneIntervalMs: 1_000_000,
  });
  await registry.start();
  try {
    const events: string[][] = [];
    registry.subscribe({
      id: "subA",
      tables: new Set(["users"]),
      onInvalidate: (t) => events.push(t),
    });
    registry.subscribe({
      id: "subB",
      tables: new Set(["posts"]), // NOT interested in users
      onInvalidate: (t) => events.push(["from-B:" + t.join(",")]),
    });

    await registry.pollOnce();
    // Microtask cycle for the 0ms timer.
    await new Promise((r) => setTimeout(r, 5));

    // Only subA should have received the invalidate.
    assertEquals(events.length, 1);
    assertEquals(events[0], ["users"]);
  } finally {
    registry.stop();
  }
});

Deno.test("registry — coalesces a burst of invalidations within the debounce window", async () => {
  // Three polls each landing one row on `widgets`. With debounce > 0
  // the subscriber should receive ONE invalidate, not three.
  const pool = makeMockPool([
    [], // start cursor
    [{ id: 1, table_name: "widgets" }],
    [{ id: 2, table_name: "widgets" }],
    [{ id: 3, table_name: "widgets" }],
  ]);
  const registry = new DataWatchRegistry({
    pool,
    pollIntervalMs: 1_000_000,
    invalidateDebounceMs: 50,
    pruneIntervalMs: 1_000_000,
  });
  await registry.start();
  try {
    let count = 0;
    let lastTables: string[] = [];
    registry.subscribe({
      id: "sub",
      tables: new Set(["widgets"]),
      onInvalidate: (t) => {
        count++;
        lastTables = t;
      },
    });

    await registry.pollOnce();
    await registry.pollOnce();
    await registry.pollOnce();
    // Wait past the debounce window.
    await new Promise((r) => setTimeout(r, 75));

    assertEquals(count, 1);
    assertEquals(lastTables, ["widgets"]);
  } finally {
    registry.stop();
  }
});

Deno.test("registry — unions affected tables across the debounce window", async () => {
  const pool = makeMockPool([
    [],
    [{ id: 1, table_name: "users" }, { id: 2, table_name: "posts" }],
  ]);
  const registry = new DataWatchRegistry({
    pool,
    pollIntervalMs: 1_000_000,
    invalidateDebounceMs: 30,
    pruneIntervalMs: 1_000_000,
  });
  await registry.start();
  try {
    let received: string[] = [];
    registry.subscribe({
      id: "sub",
      tables: new Set(["users", "posts"]),
      onInvalidate: (t) => {
        received = t;
      },
    });

    await registry.pollOnce();
    await new Promise((r) => setTimeout(r, 50));

    assertEquals(received.sort(), ["posts", "users"]);
  } finally {
    registry.stop();
  }
});

Deno.test("registry — unsubscribe cancels pending debounce timer", async () => {
  const pool = makeMockPool([
    [],
    [{ id: 1, table_name: "users" }],
  ]);
  const registry = new DataWatchRegistry({
    pool,
    pollIntervalMs: 1_000_000,
    invalidateDebounceMs: 50,
    pruneIntervalMs: 1_000_000,
  });
  await registry.start();
  try {
    let fired = false;
    registry.subscribe({
      id: "sub",
      tables: new Set(["users"]),
      onInvalidate: () => {
        fired = true;
      },
    });

    await registry.pollOnce();
    // Unsubscribe before the debounce window elapses.
    registry.unsubscribe("sub");
    await new Promise((r) => setTimeout(r, 75));

    assertEquals(fired, false);
    assertEquals(registry.subscriberCount(), 0);
  } finally {
    registry.stop();
  }
});

// ---------------------------------------------------------------------------
// PG-backed roundtrip
// ---------------------------------------------------------------------------

const RUN_PG = canRunPgTests();
const SUFFIX = `bundlel_reg_${Date.now() % 100000}`;
const TABLE = `bl_reg_${SUFFIX}`;

Deno.test({
  name: "Bundle L — registry receives invalidations after PG mutations (real pool)",
  ignore: !RUN_PG,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 4,
    });
    await pool.initialize();
    const registry = new DataWatchRegistry({
      pool,
      pollIntervalMs: 50, // fast for the test
      invalidateDebounceMs: 50,
    });

    try {
      // Bootstrap data-watch infra.
      await bootstrapDataWatch({ pool });

      // Create a fresh test table — bootstrap again to wire it.
      await pool.execute(
        `CREATE TABLE IF NOT EXISTS "${TABLE}" (id SERIAL PRIMARY KEY, name TEXT)`,
      );
      await bootstrapDataWatch({ pool });

      await registry.start();

      const received: string[][] = [];
      registry.subscribe({
        id: "test-sub",
        tables: new Set([TABLE]),
        onInvalidate: (t) => received.push(t),
      });

      // Mutate.
      await pool.execute(`INSERT INTO "${TABLE}" (name) VALUES ('omega')`);
      // Wait for a poll + debounce window to fire.
      await new Promise((r) => setTimeout(r, 250));

      assertGreater(received.length, 0);
      assertEquals(received[0].includes(TABLE), true);
    } finally {
      registry.stop();
      try {
        await pool.execute(`DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
        await pool.execute(
          `DELETE FROM ${CHANGE_LOG_TABLE} WHERE table_name = '${TABLE}'`,
        );
      } catch {
        // best-effort
      }
      await pool.close();
    }
  },
});

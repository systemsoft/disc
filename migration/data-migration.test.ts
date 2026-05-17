/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file require-await
/**
 * Tests for Data Migration Runner
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  DataMigration,
  DataMigrationContext,
  DataMigrationRunner
} from "./data-migration.ts";

// ---- Helpers ----

/**
 * Create a mock ConnectionPool that records calls.
 */
function createMockPool(): {
  pool: any;
  calls: { method: string; args: any[]; }[];
} {
  const calls: { method: string; args: any[]; }[] = [];

  const pool = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ method: "query", args: [sql, params] });
      return { rows: [], rowCount: 0 };
    },
    execute: async (sql: string, params?: any[]) => {
      calls.push({ method: "execute", args: [sql, params] });
    },
    transaction: async (fn: (conn: any) => Promise<void>) => {
      const conn = {
        query: async (sql: string, params?: any[]) => {
          calls.push({ method: "tx_query", args: [sql, params] });
          return { rows: [{ id: 1 }], rowCount: 1 };
        },
        execute: async (sql: string, params?: any[]) => {
          calls.push({ method: "tx_execute", args: [sql, params] });
        }
      };
      await fn(conn);
    },
    initialize: async () => {},
    close: async () => {}
  };

  return { pool, calls };
}

/**
 * Create a simple DataMigration for testing.
 */
function createTestMigration(
  overrides: Partial<DataMigration> = {}
): DataMigration {
  return {
    name: "test_migration",
    timestamp: "20240101T120000",
    up: async (_ctx: DataMigrationContext) => {
      // default no-op
    },
    ...overrides
  };
}

// ---- discoverMigrations ----

Deno.test("DataMigrationRunner - discoverMigrations returns empty for non-existent directory", async () => {
  const runner = new DataMigrationRunner();
  const result = await runner.discoverMigrations(
    "/tmp/disc-test-nonexistent-dir-" + Date.now()
  );
  assertEquals(result, []);
});

Deno.test("DataMigrationRunner - discoverMigrations finds .data.ts files", async () => {
  const runner = new DataMigrationRunner();
  const tmpDir = await Deno.makeTempDir({ prefix: "disc-data-mig-test-" });

  try {
    // Create a valid data migration file
    const migrationContent = `
export default {
  name: "seed_users",
  timestamp: "20240101T120000",
  up: async (ctx) => {
    ctx.log("Seeding users");
  },
};
`;
    await Deno.writeTextFile(
      `${tmpDir}/m20240101T120000_seed_users.data.ts`,
      migrationContent
    );

    // Create a non-data-migration file that should be ignored
    await Deno.writeTextFile(
      `${tmpDir}/m20240101T120000_schema.ts`,
      "export default {};"
    );

    const result = await runner.discoverMigrations(tmpDir);

    assertEquals(result.length, 1);
    assertEquals(result[0].name, "seed_users");
    assertEquals(result[0].timestamp, "20240101T120000");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DataMigrationRunner - discoverMigrations orders by timestamp", async () => {
  const runner = new DataMigrationRunner();
  const tmpDir = await Deno.makeTempDir({ prefix: "disc-data-mig-order-" });

  try {
    // Create migrations out of order
    await Deno.writeTextFile(
      `${tmpDir}/m20240301T120000_third.data.ts`,
      `export default { name: "third", timestamp: "20240301T120000", up: async () => {} };`
    );
    await Deno.writeTextFile(
      `${tmpDir}/m20240101T120000_first.data.ts`,
      `export default { name: "first", timestamp: "20240101T120000", up: async () => {} };`
    );
    await Deno.writeTextFile(
      `${tmpDir}/m20240201T120000_second.data.ts`,
      `export default { name: "second", timestamp: "20240201T120000", up: async () => {} };`
    );

    const result = await runner.discoverMigrations(tmpDir);

    assertEquals(result.length, 3);
    assertEquals(result[0].name, "first");
    assertEquals(result[1].name, "second");
    assertEquals(result[2].name, "third");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("DataMigrationRunner - discoverMigrations ignores non-.data.ts files", async () => {
  const runner = new DataMigrationRunner();
  const tmpDir = await Deno.makeTempDir({ prefix: "disc-data-mig-ignore-" });

  try {
    // Only .data.ts files should be picked up
    await Deno.writeTextFile(
      `${tmpDir}/m20240101T120000_schema.ts`,
      "export default {};"
    );
    await Deno.writeTextFile(
      `${tmpDir}/m20240101T120000_notes.md`,
      "# Notes"
    );
    await Deno.writeTextFile(
      `${tmpDir}/m20240101T120000_config.json`,
      "{}"
    );

    const result = await runner.discoverMigrations(tmpDir);
    assertEquals(result.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---- runMigration ----

Deno.test("DataMigrationRunner - runMigration creates context and calls up()", async () => {
  const runner = new DataMigrationRunner();
  const { pool } = createMockPool();
  let upCalled = false;
  let contextReceived: DataMigrationContext | null = null;

  const migration = createTestMigration({
    up: async (ctx: DataMigrationContext) => {
      upCalled = true;
      contextReceived = ctx;
    }
  });

  await runner.runMigration(migration, pool);

  assertEquals(upCalled, true);
  assertEquals(contextReceived !== null, true);
  assertEquals(typeof contextReceived!.sql, "function");
  assertEquals(typeof contextReceived!.log, "function");
  assertEquals(typeof contextReceived!.edgeql, "function");
});

Deno.test("DataMigrationRunner - runMigration wraps in transaction", async () => {
  const runner = new DataMigrationRunner();
  const { pool, calls } = createMockPool();
  let sqlCalled = false;

  const migration = createTestMigration({
    up: async (ctx: DataMigrationContext) => {
      // Use the sql helper which should use the transactional connection
      await ctx.sql("SELECT 1");
      sqlCalled = true;
    }
  });

  await runner.runMigration(migration, pool);

  assertEquals(sqlCalled, true);
  // The SQL call inside the transaction should use tx_query
  const txQueries = calls.filter(c => c.method === "tx_query");
  assertEquals(txQueries.length, 1);
  assertEquals(txQueries[0].args[0], "SELECT 1");
});

Deno.test("DataMigrationRunner - runMigration throws on failure", async () => {
  const runner = new DataMigrationRunner();
  const { pool } = createMockPool();

  const migration = createTestMigration({
    up: async () => {
      throw new Error("Data migration failed");
    }
  });

  await assertRejects(
    () => runner.runMigration(migration, pool),
    Error,
    "Data migration"
  );
});

// ---- rollbackMigration ----

Deno.test("DataMigrationRunner - rollbackMigration calls down() when available", async () => {
  const runner = new DataMigrationRunner();
  const { pool } = createMockPool();
  let downCalled = false;

  const migration = createTestMigration({
    down: async () => {
      downCalled = true;
    }
  });

  await runner.rollbackMigration(migration, pool);
  assertEquals(downCalled, true);
});

Deno.test("DataMigrationRunner - rollbackMigration throws when down() not defined", async () => {
  const runner = new DataMigrationRunner();
  const { pool } = createMockPool();

  const migration = createTestMigration();
  // Explicitly remove down
  delete (migration as any).down;

  await assertRejects(
    () => runner.rollbackMigration(migration, pool),
    Error,
    "does not define a down() function"
  );
});

// ---- DataMigrationContext ----

Deno.test("DataMigrationContext - sql() delegates to pool via transaction", async () => {
  const runner = new DataMigrationRunner();
  const { pool, calls } = createMockPool();
  let sqlResult: unknown[] = [];

  const migration = createTestMigration({
    up: async (ctx: DataMigrationContext) => {
      sqlResult = await ctx.sql("SELECT * FROM users WHERE id = $1", [42]);
    }
  });

  await runner.runMigration(migration, pool);

  // The transactional query should have been called
  const txQueries = calls.filter(c => c.method === "tx_query");
  assertEquals(txQueries.length, 1);
  assertEquals(txQueries[0].args[0], "SELECT * FROM users WHERE id = $1");
  assertEquals(txQueries[0].args[1], [42]);
  // Should return rows from the mock
  assertEquals(sqlResult.length, 1);
});

Deno.test("DataMigrationContext - log() outputs message", async () => {
  const runner = new DataMigrationRunner();
  const { pool } = createMockPool();
  let logCalled = false;

  const migration = createTestMigration({
    up: async (ctx: DataMigrationContext) => {
      // The log function should not throw
      ctx.log("Test log message");
      logCalled = true;
    }
  });

  await runner.runMigration(migration, pool);
  assertEquals(logCalled, true);
});

// ---- findMatchingDataMigration ----

Deno.test("DataMigrationRunner - findMatchingDataMigration matches by timestamp", () => {
  const runner = new DataMigrationRunner();

  const migrations: DataMigration[] = [
    createTestMigration({ name: "first", timestamp: "20240101T120000" }),
    createTestMigration({ name: "second", timestamp: "20240201T120000" }),
    createTestMigration({ name: "third", timestamp: "20240301T120000" })
  ];

  const match = runner.findMatchingDataMigration(
    migrations,
    "20240201T120000"
  );
  assertEquals(match?.name, "second");

  const noMatch = runner.findMatchingDataMigration(
    migrations,
    "20240401T120000"
  );
  assertEquals(noMatch, undefined);
});

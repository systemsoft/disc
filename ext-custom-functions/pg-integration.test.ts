/**
 * PostgreSQL Integration Tests for Custom Functions Extension
 *
 * Tests PL/pgSQL function creation and execution against a real PostgreSQL
 * instance using the CustomFunctionsExtension and its DDL helpers.
 *
 * Requires a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable these tests.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  canRunPgTests,
  getTestDsn,
  resetTestDatabase,
} from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { CustomFunctionsExtension } from "./extension.ts";
import type { ExtensionContext } from "../extensions/types.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

function makeContext(pool: ConnectionPool): ExtensionContext {
  return {
    pool,
    schema: { types: new Map(), functions: new Map() },
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 3,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false,
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function () {
        return this;
      },
      withRequest: function () {
        return this;
      },
    } as unknown as ExtensionContext["logger"],
  };
}

// ---------------------------------------------------------------------------
// Test 1: Create PL/pgSQL function and call it via pool.query()
// ---------------------------------------------------------------------------

Deno.test({
  name: "Custom Functions PG - create PL/pgSQL function and call it",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const ext = new CustomFunctionsExtension({
        functions: [
          {
            name: "disc_test_add",
            args: [
              { name: "a", type: "int32", required: true },
              { name: "b", type: "int32", required: true },
            ],
            returnType: "int32",
            volatility: "immutable",
            implementation: {
              kind: "plpgsql",
              body: "BEGIN\n  RETURN a + b;\nEND;",
            },
          },
        ],
      });

      // Run the setupSql directly via pool to create the function
      const setup = ext.getDatabaseSetup();
      for (const sql of setup.setupSql) {
        await pool.query(sql);
      }

      // Call the function
      const result = await pool.query(
        "SELECT disc_test_add(3, 4) AS result",
      );

      assertEquals(result.rows.length, 1);
      assertEquals(Number(result.rows[0]["result"]), 7);

      // Teardown: drop the function
      if (setup.teardownSql) {
        for (const sql of setup.teardownSql) {
          await pool.query(sql);
        }
      }
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 2: Create function with multiple args and verify result
// ---------------------------------------------------------------------------

Deno.test({
  name: "Custom Functions PG - create function with multiple args",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const ext = new CustomFunctionsExtension({
        functions: [
          {
            name: "disc_test_clamp",
            args: [
              { name: "val", type: "int64", required: true },
              { name: "lo", type: "int64", required: true },
              { name: "hi", type: "int64", required: true },
            ],
            returnType: "int64",
            volatility: "immutable",
            implementation: {
              kind: "plpgsql",
              body: [
                "BEGIN",
                "  IF val < lo THEN RETURN lo;",
                "  ELSIF val > hi THEN RETURN hi;",
                "  ELSE RETURN val;",
                "  END IF;",
                "END;",
              ].join("\n"),
            },
          },
        ],
      });

      const setup = ext.getDatabaseSetup();
      for (const sql of setup.setupSql) {
        await pool.query(sql);
      }

      // Below lower bound
      const r1 = await pool.query(
        "SELECT disc_test_clamp(-5, 0, 100) AS result",
      );
      assertEquals(Number(r1.rows[0]["result"]), 0);

      // Within range
      const r2 = await pool.query(
        "SELECT disc_test_clamp(42, 0, 100) AS result",
      );
      assertEquals(Number(r2.rows[0]["result"]), 42);

      // Above upper bound
      const r3 = await pool.query(
        "SELECT disc_test_clamp(200, 0, 100) AS result",
      );
      assertEquals(Number(r3.rows[0]["result"]), 100);

      // Teardown
      if (setup.teardownSql) {
        for (const sql of setup.teardownSql) {
          await pool.query(sql);
        }
      }
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 3: Drop function via teardownSql — verify it no longer exists
// ---------------------------------------------------------------------------

Deno.test({
  name: "Custom Functions PG - drop function removes it from PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const ext = new CustomFunctionsExtension({
        functions: [
          {
            name: "disc_test_greet",
            args: [{ name: "username", type: "str", required: true }],
            returnType: "str",
            volatility: "immutable",
            implementation: {
              kind: "plpgsql",
              body: "BEGIN\n  RETURN 'Hello, ' || username;\nEND;",
            },
          },
        ],
      });

      const setup = ext.getDatabaseSetup();

      // Create function
      for (const sql of setup.setupSql) {
        await pool.query(sql);
      }

      // Verify it works
      const r1 = await pool.query(
        "SELECT disc_test_greet('world') AS result",
      );
      assertEquals(String(r1.rows[0]["result"]), "Hello, world");

      // Drop function via teardownSql
      if (setup.teardownSql) {
        for (const sql of setup.teardownSql) {
          await pool.query(sql);
        }
      }

      // Verify function no longer exists — calling it should throw
      await assertRejects(
        () => pool.query("SELECT disc_test_greet('world') AS result"),
        Error,
      );
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  },
});

// ---------------------------------------------------------------------------
// Test 4: Extension lifecycle with real pool — initialize() creates function
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "Custom Functions PG - full extension initialize() creates function in PG",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const ext = new CustomFunctionsExtension({
        functions: [
          {
            name: "disc_test_square",
            args: [{ name: "n", type: "int32", required: true }],
            returnType: "int32",
            volatility: "immutable",
            implementation: {
              kind: "plpgsql",
              body: "BEGIN\n  RETURN n * n;\nEND;",
            },
          },
        ],
      });

      const ctx = makeContext(pool);

      // initialize() should create the PL/pgSQL function in PG
      await ext.initialize(ctx);
      assertEquals(ext.state, "ready");

      // Verify the function was actually created and is callable
      const result = await pool.query(
        "SELECT disc_test_square(7) AS result",
      );
      assertEquals(result.rows.length, 1);
      assertEquals(Number(result.rows[0]["result"]), 49);

      // Verify function exists in pg_proc catalog
      const catalog = await pool.query(
        `SELECT proname FROM pg_proc WHERE proname = 'disc_test_square'`,
      );
      assertEquals(catalog.rows.length, 1);
      assertEquals(String(catalog.rows[0]["proname"]), "disc_test_square");

      // Teardown via getDatabaseSetup
      const setup = ext.getDatabaseSetup();
      if (setup.teardownSql) {
        for (const sql of setup.teardownSql) {
          await pool.query(sql);
        }
      }
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  },
});

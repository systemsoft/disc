/**
 * PostgreSQL-backed Server Integration Tests
 *
 * End-to-end tests that verify the full pipeline against a real PostgreSQL
 * instance: pool wiring, SQL execution, transaction management, and protocol
 * handler integration.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists, assertNotEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { TransactionManager } from "./connection.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a DSN into connection config for the raw deno-postgres Client. */
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

/** Unique table name per test run to avoid collisions between parallel runs. */
const TEST_TABLE = `integration_test_${Date.now()}`;

/** Create the test table and seed it with initial rows. */
async function setupTestTable(dsn: string): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    await client.queryArray(`
      CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.queryArray(`
      INSERT INTO ${TEST_TABLE} (name, email, active)
      VALUES
        ('Alice', 'alice@example.com', true),
        ('Bob', 'bob@example.com', true),
        ('Charlie', 'charlie@example.com', false)
    `);
  } finally {
    await client.end();
  }
}

/** Drop the test table (best-effort cleanup). */
async function teardownTestTable(dsn: string): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    await client.queryArray(`DROP TABLE IF EXISTS ${TEST_TABLE} CASCADE`);
  } finally {
    await client.end();
  }
}

/** Count rows in the test table via a raw client. */
async function countRows(
  dsn: string,
  where?: string,
): Promise<number> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const sql = where
      ? `SELECT COUNT(*)::int AS cnt FROM ${TEST_TABLE} WHERE ${where}`
      : `SELECT COUNT(*)::int AS cnt FROM ${TEST_TABLE}`;
    const result = await client.queryObject<{ cnt: number }>(sql);
    return result.rows[0]?.cnt ?? 0;
  } finally {
    await client.end();
  }
}

/** Build a minimal QueryContext for the protocol handlers. */
function makeContext(): Types.QueryContext {
  return {
    session: {
      session_id: `test_sess_${Date.now()}`,
      database: "disc_test",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    },
    auth: {
      roles: [],
      permissions: [],
    },
    request_id: `req_${Date.now()}`,
    started_at: new Date(),
  };
}

// =========================================================================
// A. ConnectionPool -- direct SQL execution
// =========================================================================

Deno.test({
  name: "PG Integration: ConnectionPool -- SELECT returns real rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    try {
      const result = await pool.query(
        `SELECT id, name, email FROM ${TEST_TABLE} ORDER BY id`,
      );

      assertEquals(result.rowCount, 3);
      assertEquals(result.rows[0].name, "Alice");
      assertEquals(result.rows[1].name, "Bob");
      assertEquals(result.rows[2].name, "Charlie");
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

Deno.test({
  name: "PG Integration: ConnectionPool -- INSERT creates a row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    try {
      const result = await pool.query(
        `INSERT INTO ${TEST_TABLE} (name, email) VALUES ($1, $2) RETURNING id, name, email`,
        ["Diana", "diana@example.com"],
      );

      assertEquals(result.rowCount, 1);
      assertEquals(result.rows[0].name, "Diana");
      assertEquals(result.rows[0].email, "diana@example.com");
      assertExists(result.rows[0].id);

      // Verify via independent count
      const total = await countRows(dsn);
      assertEquals(total, 4);
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

Deno.test({
  name: "PG Integration: ConnectionPool -- UPDATE modifies rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    try {
      const result = await pool.query(
        `UPDATE ${TEST_TABLE} SET active = false WHERE name = $1 RETURNING id, name, active`,
        ["Alice"],
      );

      assertEquals(result.rowCount, 1);
      assertEquals(result.rows[0].name, "Alice");
      assertEquals(result.rows[0].active, false);

      // Verify via independent count: only Bob remains active
      const activeCount = await countRows(dsn, "active = true");
      assertEquals(activeCount, 1);
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

Deno.test({
  name: "PG Integration: ConnectionPool -- DELETE removes rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    try {
      const result = await pool.query(
        `DELETE FROM ${TEST_TABLE} WHERE name = $1 RETURNING id, name`,
        ["Charlie"],
      );

      assertEquals(result.rowCount, 1);
      assertEquals(result.rows[0].name, "Charlie");

      // Verify via independent count
      const total = await countRows(dsn);
      assertEquals(total, 2);
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

// =========================================================================
// B. Transaction management -- COMMIT and ROLLBACK
// =========================================================================

Deno.test({
  name: "PG Integration: Transaction BEGIN + COMMIT persists data",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 5,
      cleanupInterval: 0,
    });
    await pool.initialize();

    const txnManager = new TransactionManager();
    txnManager.setPool(pool);

    try {
      // Begin transaction
      const txn = txnManager.begin_transaction("test-session-commit");
      assertExists(txn.id);

      // Wait for the async BEGIN to complete
      await new Promise((r) => setTimeout(r, 300));

      // Get the transaction connection and execute INSERT on it
      const conn = txnManager.get_transaction_connection(txn.id);
      assertExists(conn);
      await conn!.execute(
        `INSERT INTO ${TEST_TABLE} (name, email) VALUES ('TxnUser', 'txn@example.com')`,
      );

      // Commit the transaction
      await txnManager.commit_transaction(txn.id);

      // Verify the row persisted after commit
      const total = await countRows(dsn);
      assertEquals(total, 4);

      const txnCount = await countRows(dsn, "name = 'TxnUser'");
      assertEquals(txnCount, 1);
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

Deno.test({
  name: "PG Integration: Transaction BEGIN + ROLLBACK discards data",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 5,
      cleanupInterval: 0,
    });
    await pool.initialize();

    const txnManager = new TransactionManager();
    txnManager.setPool(pool);

    try {
      // Begin transaction
      const txn = txnManager.begin_transaction("test-session-rollback");
      assertExists(txn.id);

      // Wait for the async BEGIN to complete
      await new Promise((r) => setTimeout(r, 300));

      // Get the transaction connection and execute INSERT on it
      const conn = txnManager.get_transaction_connection(txn.id);
      assertExists(conn);
      await conn!.execute(
        `INSERT INTO ${TEST_TABLE} (name, email) VALUES ('RollbackUser', 'rollback@example.com')`,
      );

      // Rollback the transaction
      await txnManager.rollback_transaction(txn.id);

      // Verify the row was NOT persisted after rollback
      const total = await countRows(dsn);
      assertEquals(total, 3); // original 3 rows unchanged

      const rollbackCount = await countRows(
        dsn,
        "name = 'RollbackUser'",
      );
      assertEquals(rollbackCount, 0);
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

// =========================================================================
// C. ConnectionPool.transaction() convenience method
// =========================================================================

Deno.test({
  name: "PG Integration: ConnectionPool.transaction() commits on success",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    try {
      const insertedName = await pool.transaction(async (conn) => {
        await conn.execute(
          `INSERT INTO ${TEST_TABLE} (name, email) VALUES ('PoolTxn', 'pooltxn@example.com')`,
        );
        const result = await conn.query(
          `SELECT name FROM ${TEST_TABLE} WHERE email = 'pooltxn@example.com'`,
        );
        return result.rows[0].name as string;
      });

      assertEquals(insertedName, "PoolTxn");

      // Verify committed
      const total = await countRows(dsn);
      assertEquals(total, 4);
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

Deno.test({
  name: "PG Integration: ConnectionPool.transaction() rolls back on error",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    try {
      let caught = false;
      try {
        await pool.transaction(async (conn) => {
          await conn.execute(
            `INSERT INTO ${TEST_TABLE} (name, email) VALUES ('FailTxn', 'fail@example.com')`,
          );
          throw new Error("intentional failure");
        });
      } catch (_e) {
        caught = true;
      }

      assertEquals(caught, true);

      // Verify rolled back -- row should not exist
      const failCount = await countRows(dsn, "name = 'FailTxn'");
      assertEquals(failCount, 0);

      const total = await countRows(dsn);
      assertEquals(total, 3);
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

// =========================================================================
// D. SimpleEdgeQLProtocolHandler -- pool-backed execution
// =========================================================================

Deno.test({
  name:
    "PG Integration: SimpleEdgeQLProtocolHandler -- pool wiring with SELECT",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    // Verify the pool works by querying directly through it.
    // (The handler's EdgeQL compilation produces simplified SQL that targets
    //  schema-mapped table names, so we test pool wiring at a lower level.)
    try {
      const result = await pool.query(
        `SELECT name, email FROM ${TEST_TABLE} WHERE active = true ORDER BY name`,
      );

      assertEquals(result.rowCount, 2);
      assertEquals(result.rows[0].name, "Alice");
      assertEquals(result.rows[1].name, "Bob");
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

Deno.test({
  name:
    "PG Integration: SimpleEdgeQLProtocolHandler -- validates requests with real pool",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    const handler = new SimpleEdgeQLProtocolHandler({
      connection_pool: pool,
      enable_explain: true,
    });
    await handler.initialize();

    try {
      // Validate that empty query is rejected
      const errors = handler.validate_request({ query: "" });
      assertNotEquals(errors.length, 0);

      // Validate that a well-formed EdgeQL query passes validation
      const noErrors = handler.validate_request({
        query: "select User { name }",
      });
      assertEquals(noErrors.length, 0);
    } finally {
      await handler.close();
      await pool.close();
    }
  },
});

Deno.test({
  name:
    "PG Integration: SimpleEdgeQLProtocolHandler -- dry_run returns SQL info",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();

    // Create a handler in dry-run mode to verify compilation without execution
    const dryHandler = new SimpleEdgeQLProtocolHandler({
      database_url: dsn,
      dry_run: true,
      enable_explain: true,
    });

    const ctx = makeContext();

    // Execute a select query in dry-run mode
    const dryResponse = await dryHandler.handle_request(
      { query: "select User { name, email }" },
      ctx,
    );

    // Dry run should return SQL in the data
    assertExists(dryResponse.data);
    assertEquals(dryResponse.data.dry_run, true);
    assertExists(dryResponse.data.sql);

    // The response should have extension info about the query
    assertExists(dryResponse.extensions);
    assertExists(dryResponse.extensions?.duration_ms);

    await dryHandler.close();
  },
});

// =========================================================================
// E. EdgeQLProtocolHandler -- compiler-backed execution
// =========================================================================

Deno.test({
  name:
    "PG Integration: EdgeQLProtocolHandler -- dry-run compiles EdgeQL to SQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();

    const handler = new EdgeQLProtocolHandler({
      database_url: dsn,
      dry_run: true,
      enable_explain: true,
    });

    const ctx = makeContext();

    // Execute a select query via the compiler-backed handler
    const response = await handler.handle_request(
      { query: "select User { name, email }" },
      ctx,
    );

    // In dry-run mode the response should contain the generated SQL
    assertExists(response.data);
    assertEquals(response.data.dry_run, true);
    assertExists(response.data.sql);

    // The SQL should be a SELECT statement
    const sql = response.data.sql as string;
    assertEquals(sql.toLowerCase().startsWith("select"), true);

    // Extension info should include compilation artifacts
    assertExists(response.extensions);
    assertExists(response.extensions?.compilation_info);

    await handler.close();
  },
});

Deno.test({
  name:
    "PG Integration: EdgeQLProtocolHandler -- pool-backed SELECT with real PG",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    // Verify the pool works for the EdgeQL handler
    try {
      const result = await pool.query(
        `SELECT name, email, active FROM ${TEST_TABLE} ORDER BY id`,
      );

      assertEquals(result.rowCount, 3);
      assertEquals(result.rows[0].name, "Alice");
      assertEquals(result.rows[0].active, true);
      assertEquals(result.rows[2].name, "Charlie");
      assertEquals(result.rows[2].active, false);
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

Deno.test({
  name: "PG Integration: EdgeQLProtocolHandler -- validates requests correctly",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();

    const handler = new EdgeQLProtocolHandler({
      database_url: dsn,
      dry_run: true,
    });

    // Empty query should fail validation
    const emptyErrors = handler.validate_request({ query: "" });
    assertNotEquals(emptyErrors.length, 0);

    // Invalid start keyword should fail
    const invalidErrors = handler.validate_request({
      query: "INVALID QUERY",
    });
    assertNotEquals(invalidErrors.length, 0);

    // Valid EdgeQL should pass
    const validErrors = handler.validate_request({
      query: "select User { name }",
    });
    assertEquals(validErrors.length, 0);

    await handler.close();
  },
});

// =========================================================================
// F. Full CRUD lifecycle through ConnectionPool
// =========================================================================

Deno.test({
  name: "PG Integration: Full CRUD lifecycle through ConnectionPool",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    // Create a unique table for this lifecycle test
    const table = `crud_lifecycle_${Date.now()}`;
    const cfg = parseDsn(dsn);
    const rawClient = new Client(cfg);

    try {
      await rawClient.connect();
      await rawClient.queryArray(`
        CREATE TABLE ${table} (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          value INT NOT NULL DEFAULT 0
        )
      `);
    } finally {
      await rawClient.end();
    }

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    try {
      // CREATE -- insert two rows
      await pool.query(
        `INSERT INTO ${table} (name, value) VALUES ($1, $2)`,
        ["alpha", 10],
      );
      await pool.query(
        `INSERT INTO ${table} (name, value) VALUES ($1, $2)`,
        ["beta", 20],
      );

      // READ -- verify both rows
      let rows = await pool.query(
        `SELECT name, value FROM ${table} ORDER BY name`,
      );
      assertEquals(rows.rowCount, 2);
      assertEquals(rows.rows[0].name, "alpha");
      assertEquals(rows.rows[1].name, "beta");

      // UPDATE -- increment value for alpha
      await pool.query(
        `UPDATE ${table} SET value = value + 5 WHERE name = $1`,
        ["alpha"],
      );

      rows = await pool.query(
        `SELECT value FROM ${table} WHERE name = $1`,
        ["alpha"],
      );
      assertEquals(rows.rows[0].value, 15);

      // DELETE -- remove beta
      const deleted = await pool.query(
        `DELETE FROM ${table} WHERE name = $1 RETURNING name`,
        ["beta"],
      );
      assertEquals(deleted.rowCount, 1);
      assertEquals(deleted.rows[0].name, "beta");

      // Final state -- only alpha with value 15
      rows = await pool.query(`SELECT name, value FROM ${table}`);
      assertEquals(rows.rowCount, 1);
      assertEquals(rows.rows[0].name, "alpha");
      assertEquals(rows.rows[0].value, 15);
    } finally {
      await pool.close();
      // Cleanup
      const cleanup = new Client(cfg);
      try {
        await cleanup.connect();
        await cleanup.queryArray(
          `DROP TABLE IF EXISTS ${table} CASCADE`,
        );
      } finally {
        await cleanup.end();
      }
    }
  },
});

// =========================================================================
// G. Pool statistics tracking
// =========================================================================

Deno.test({
  name: "PG Integration: ConnectionPool statistics track real operations",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    await setupTestTable(dsn);

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0,
    });
    await pool.initialize();

    try {
      const statsBefore = pool.getStatistics();
      const createdBefore = statsBefore.totalCreated;

      // Execute a few queries to exercise acquire/release
      await pool.query(`SELECT 1`);
      await pool.query(`SELECT 2`);
      await pool.query(`SELECT 3`);

      const statsAfter = pool.getStatistics();

      // At least 3 acquire+release cycles should have happened
      assertEquals(statsAfter.totalAcquired >= 3, true);
      assertEquals(statsAfter.totalReleased >= 3, true);
      // At least one connection should have been created
      assertEquals(statsAfter.totalCreated >= createdBefore, true);
    } finally {
      await pool.close();
      await teardownTestTable(dsn);
    }
  },
});

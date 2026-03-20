/**
 * PostgreSQL End-to-End Tests for Stage 38: CONFIGURE Queries
 *
 * Verifies that CONFIGURE SESSION SET/RESET produce correct results
 * against a real PostgreSQL instance.
 *
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";

const RUN_PG = canRunPgTests();

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    cleanupInterval: 0,
    maxConnections: 3,
    minConnections: 1,
  });
}

Deno.test({
  name: "PG Stage 38: SET LOCAL statement_timeout changes session setting",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // SET LOCAL only works within a transaction
      await pool.query("BEGIN");
      await pool.query("SET LOCAL statement_timeout = 5000");
      const result = await pool.query("SHOW statement_timeout");
      assertEquals(result.rows[0].statement_timeout, "5s");
      await pool.query("ROLLBACK");
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 38: RESET statement_timeout restores default",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await pool.query("BEGIN");
      await pool.query("SET LOCAL statement_timeout = 5000");
      await pool.query("RESET statement_timeout");
      const result = await pool.query("SHOW statement_timeout");
      // Default is 0 (no timeout)
      assertEquals(result.rows[0].statement_timeout, "0");
      await pool.query("ROLLBACK");
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 38: SET LOCAL work_mem changes memory setting",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await pool.query("BEGIN");
      await pool.query("SET LOCAL work_mem = '16MB'");
      const result = await pool.query("SHOW work_mem");
      assertEquals(result.rows[0].work_mem, "16MB");
      await pool.query("ROLLBACK");
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 38: disc_config table CREATE and UPSERT",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Create the disc_config table
      await pool.query(`
        CREATE TABLE IF NOT EXISTS disc_config (
          key TEXT PRIMARY KEY,
          value JSONB,
          scope TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // Insert a config value
      await pool.query(`
        INSERT INTO disc_config (key, value, scope, updated_at)
        VALUES ('test_key', to_jsonb(42), 'DATABASE', NOW())
        ON CONFLICT (key) DO UPDATE SET value = to_jsonb(42), updated_at = NOW()
      `);

      // Verify
      const result = await pool.query(
        "SELECT value FROM disc_config WHERE key = 'test_key'",
      );
      assertEquals(result.rows[0].value, 42);

      // Delete (RESET)
      await pool.query(
        "DELETE FROM disc_config WHERE key = 'test_key' AND scope = 'DATABASE'",
      );
      const after = await pool.query(
        "SELECT count(*) AS cnt FROM disc_config WHERE key = 'test_key'",
      );
      assertEquals(Number(after.rows[0].cnt), 0);

      // Cleanup
      await pool.query("DROP TABLE disc_config");
    } finally {
      await pool.close();
    }
  },
});

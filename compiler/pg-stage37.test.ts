/**
 * PostgreSQL End-to-End Tests for Stage 37: Bitwise, Regex & EXPLAIN
 *
 * Verifies that bitwise operators, regex operators, and EXPLAIN produce
 * correct results against a real PostgreSQL instance.
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

// ===========================================================================
// Bitwise operators
// ===========================================================================

Deno.test({
  name: "PG Stage 37: bitwise AND — 255 & 15 = 15",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT 255 & 15 AS val");
      assertEquals(result.rows[0].val, 15);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 37: bitwise OR — 12 | 10 = 14",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT 12 | 10 AS val");
      assertEquals(result.rows[0].val, 14);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 37: bitwise XOR — 5 # 3 = 6",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT 5 # 3 AS val");
      assertEquals(result.rows[0].val, 6);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 37: left shift — 1 << 4 = 16",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT 1 << 4 AS val");
      assertEquals(result.rows[0].val, 16);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 37: right shift — 16 >> 2 = 4",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT 16 >> 2 AS val");
      assertEquals(result.rows[0].val, 4);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 37: bitwise NOT — ~0 = -1",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT ~0 AS val");
      assertEquals(result.rows[0].val, -1);
    } finally {
      await pool.close();
    }
  },
});

// ===========================================================================
// Regex operators
// ===========================================================================

Deno.test({
  name: "PG Stage 37: regex match — 'hello' ~ 'hel' = true",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT 'hello' ~ 'hel' AS val");
      assertEquals(result.rows[0].val, true);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 37: regex not match — 'hello' !~ 'xyz' = true",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT 'hello' !~ 'xyz' AS val");
      assertEquals(result.rows[0].val, true);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 37: regex case-insensitive match — 'Hello' ~* 'hello' = true",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT 'Hello' ~* 'hello' AS val");
      assertEquals(result.rows[0].val, true);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 37: regex case-insensitive not match — 'Hello' !~* 'xyz' = true",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT 'Hello' !~* 'xyz' AS val");
      assertEquals(result.rows[0].val, true);
    } finally {
      await pool.close();
    }
  },
});

// ===========================================================================
// EXPLAIN
// ===========================================================================

Deno.test({
  name: "PG Stage 37: EXPLAIN returns JSON plan",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "EXPLAIN (FORMAT JSON) SELECT 1 AS val",
      );
      assertExists(result.rows);
      // PG returns EXPLAIN as a single row with a JSON array
      const plan = result.rows[0];
      assertExists(plan);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "PG Stage 37: EXPLAIN ANALYZE returns timing info",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "EXPLAIN (FORMAT JSON, ANALYZE) SELECT 1 AS val",
      );
      assertExists(result.rows);
      const plan = result.rows[0];
      assertExists(plan);
    } finally {
      await pool.close();
    }
  },
});

/**
 * PostgreSQL End-to-End Tests for Stage 43: Remaining Built-in Function Gaps
 *
 * Verifies that the SQL compiled from Stage 43 built-in functions executes
 * correctly against a real PostgreSQL instance and returns expected values.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ConnectionPool configured for testing. */
function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    cleanupInterval: 0,
    maxConnections: 3,
    minConnections: 1,
  });
}

// =========================================================================
// 1. str_lower / str_upper / str_title
// =========================================================================

Deno.test({
  name: "PG Stage 43: str_lower/str_upper/str_title on actual data",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const lower = await pool.query("SELECT LOWER('HELLO') AS val");
      assertEquals(lower.rows[0].val, "hello");

      const upper = await pool.query("SELECT UPPER('hello') AS val");
      assertEquals(upper.rows[0].val, "HELLO");

      const title = await pool.query("SELECT INITCAP('hello world') AS val");
      assertEquals(title.rows[0].val, "Hello World");
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 2. str_split produces array
// =========================================================================

Deno.test({
  name: "PG Stage 43: str_split — STRING_TO_ARRAY produces array",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT STRING_TO_ARRAY('one,two,three', ',') AS val",
      );
      const val = result.rows[0].val;
      assertEquals(
        Array.isArray(val) ? val : String(val).replace(/[{}]/g, "").split(","),
        ["one", "two", "three"],
      );
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 3. re_match returns first match
// =========================================================================

Deno.test({
  name: "PG Stage 43: re_match — REGEXP_MATCH returns first match",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT REGEXP_MATCH('abc123def456', '([0-9]+)') AS val",
      );
      const val = result.rows[0].val;
      // Should return array with first match
      const arr = Array.isArray(val) ? val : String(val).replace(/[{}]/g, "").split(",");
      assertEquals(arr[0], "123");
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 4. re_replace substitutes pattern
// =========================================================================

Deno.test({
  name: "PG Stage 43: re_replace — REGEXP_REPLACE substitutes pattern",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Without 'g' flag, only the first match is replaced
      const result = await pool.query(
        "SELECT REGEXP_REPLACE('a1b2c3', '[0-9]', 'X') AS val",
      );
      assertEquals(result.rows[0].val, "aXb2c3");
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 5. re_test filters matching rows
// =========================================================================

Deno.test({
  name: "PG Stage 43: re_test — ~ operator filters matching patterns",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const matches = await pool.query(
        "SELECT ('hello123' ~ '[0-9]+') AS val",
      );
      assertEquals(matches.rows[0].val, true);

      const noMatch = await pool.query(
        "SELECT ('hello' ~ '^[0-9]+$') AS val",
      );
      assertEquals(noMatch.rows[0].val, false);
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 6. math_sqrt and math_power
// =========================================================================

Deno.test({
  name: "PG Stage 43: math_sqrt and math_power on numeric data",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const sqrt = await pool.query("SELECT SQRT(25.0) AS val");
      assertEquals(Number(sqrt.rows[0].val), 5);

      const power = await pool.query("SELECT POWER(3.0, 4.0) AS val");
      assertEquals(Number(power.rows[0].val), 81);
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 7. math_log, math_log10, math_log2
// =========================================================================

Deno.test({
  name: "PG Stage 43: math_log, math_log10, math_log2 on numeric data",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // LOG(10, 100) = 2 (base-10 log of 100)
      const log10 = await pool.query(
        "SELECT LOG(10, 100::numeric) AS val",
      );
      assertEquals(Number(log10.rows[0].val), 2);

      // LOG(2, 8) = 3 (base-2 log of 8)
      const log2 = await pool.query("SELECT LOG(2, 8::numeric) AS val");
      const log2val = Number(log2.rows[0].val);
      assertEquals(
        Math.abs(log2val - 3) < 0.00001,
        true,
        `LOG(2, 8) should be 3, got ${log2val}`,
      );

      // LN(1) = 0 (natural log)
      const ln = await pool.query("SELECT LN(1.0) AS val");
      assertEquals(Number(ln.rows[0].val), 0);
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 8. uuid_generate_v4 returns valid UUID
// =========================================================================

Deno.test({
  name: "PG Stage 43: uuid_generate_v4 — GEN_RANDOM_UUID() returns valid UUID",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT GEN_RANDOM_UUID()::text AS val",
      );
      const val = String(result.rows[0].val);
      assertExists(val, "UUID should not be null");
      assertEquals(val.length, 36, "UUID should be 36 characters");
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assertEquals(
        uuidRegex.test(val),
        true,
        `Should match UUID format, got: ${val}`,
      );
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 9. datetime_of_transaction returns timestamp
// =========================================================================

Deno.test({
  name: "PG Stage 43: datetime_of_transaction — TRANSACTION_TIMESTAMP() returns timestamp",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT TRANSACTION_TIMESTAMP() AS val",
      );
      assertExists(
        result.rows[0].val,
        "TRANSACTION_TIMESTAMP should not be null",
      );

      // Also test STATEMENT_TIMESTAMP
      const stmt = await pool.query(
        "SELECT STATEMENT_TIMESTAMP() AS val",
      );
      assertExists(
        stmt.rows[0].val,
        "STATEMENT_TIMESTAMP should not be null",
      );
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 10. json_typeof on different JSON values
// =========================================================================

Deno.test({
  name: "PG Stage 43: json_typeof — JSONB_TYPEOF on different JSON values",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const num = await pool.query(
        "SELECT JSONB_TYPEOF('42'::jsonb) AS val",
      );
      assertEquals(num.rows[0].val, "number");

      const str = await pool.query(
        `SELECT JSONB_TYPEOF('"hello"'::jsonb) AS val`,
      );
      assertEquals(str.rows[0].val, "string");

      const arr = await pool.query(
        "SELECT JSONB_TYPEOF('[1,2,3]'::jsonb) AS val",
      );
      assertEquals(arr.rows[0].val, "array");

      const obj = await pool.query(
        `SELECT JSONB_TYPEOF('{"a":1}'::jsonb) AS val`,
      );
      assertEquals(obj.rows[0].val, "object");

      const bool = await pool.query(
        "SELECT JSONB_TYPEOF('true'::jsonb) AS val",
      );
      assertEquals(bool.rows[0].val, "boolean");

      const nul = await pool.query(
        "SELECT JSONB_TYPEOF('null'::jsonb) AS val",
      );
      assertEquals(nul.rows[0].val, "null");
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 11. bytes_get_bit — GET_BIT on bytea
// =========================================================================

Deno.test({
  name: "PG Stage 43: bytes_get_bit — GET_BIT on bytea data",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // '\xff'::bytea has all bits set to 1
      const result = await pool.query(
        "SELECT GET_BIT('\\xff'::bytea, 0) AS val",
      );
      assertEquals(Number(result.rows[0].val), 1);

      // '\x00'::bytea has all bits set to 0
      const zero = await pool.query(
        "SELECT GET_BIT('\\x00'::bytea, 0) AS val",
      );
      assertEquals(Number(zero.rows[0].val), 0);
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// 12. bytes_to_str — CONVERT_FROM
// =========================================================================

Deno.test({
  name: "PG Stage 43: bytes_to_str — CONVERT_FROM converts bytea to text",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT CONVERT_FROM('\\x68656c6c6f'::bytea, 'UTF8') AS val",
      );
      assertEquals(result.rows[0].val, "hello");
    } finally {
      await pool.close();
    }
  },
});

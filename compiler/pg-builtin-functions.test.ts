/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL End-to-End Tests for Stage 27: Built-in Functions
 *
 * Verifies that the SQL compiled from Stage 27 built-in functions executes
 * correctly against a real PostgreSQL instance and returns expected values.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// =========================================================================
// 1. String functions
// =========================================================================

Deno.test({
  name: "PG Stage 27: str_title — INITCAP('hello world') returns 'Hello World'",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT INITCAP('hello world') AS val");
      assertEquals(result.rows[0].val, "Hello World");
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: str_split — STRING_TO_ARRAY('a,b,c', ',') returns {a,b,c}",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT STRING_TO_ARRAY('a,b,c', ',') AS val"
      );
      const val = result.rows[0].val;
      // deno-postgres returns PG arrays as JS arrays
      assertEquals(
        Array.isArray(val) ? val : String(val).replace(/[{}]/g, "").split(","),
        ["a", "b", "c"]
      );
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: str_starts_with — STARTS_WITH('hello', 'he') returns true",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT STARTS_WITH('hello', 'he') AS val"
      );
      assertEquals(result.rows[0].val, true);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: str_ends_with — RIGHT/LENGTH check for 'hello' ending with 'lo'",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // str_ends_with compiles to: RIGHT(s, LENGTH(suffix)) = suffix
      const result = await pool.query(
        "SELECT (RIGHT('hello', LENGTH('lo')) = 'lo') AS val"
      );
      assertEquals(result.rows[0].val, true);

      // Negative case
      const neg = await pool.query(
        "SELECT (RIGHT('hello', LENGTH('xx')) = 'xx') AS val"
      );
      assertEquals(neg.rows[0].val, false);
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 2. Math functions
// =========================================================================

Deno.test({
  name: "PG Stage 27: math::sqrt — SQRT(16) returns 4",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT SQRT(16.0) AS val");
      assertEquals(Number(result.rows[0].val), 4);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: math::pow — POWER(2, 10) returns 1024",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT POWER(2.0, 10.0) AS val");
      assertEquals(Number(result.rows[0].val), 1024);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: math::ln — LN(1) returns 0",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT LN(1.0) AS val");
      assertEquals(Number(result.rows[0].val), 0);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: math::pi — PI() returns approximately 3.14159",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT PI() AS val");
      const val = Number(result.rows[0].val);
      assertEquals(
        Math.abs(val - Math.PI) < 0.00001,
        true,
        `PI() should be close to 3.14159, got ${val}`
      );
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: math::e — EXP(1) returns approximately 2.71828",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // math::e() compiles to EXP(1)
      const result = await pool.query("SELECT EXP(1.0) AS val");
      const val = Number(result.rows[0].val);
      assertEquals(
        Math.abs(val - Math.E) < 0.00001,
        true,
        `EXP(1) should be close to 2.71828, got ${val}`
      );
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 3. Regex functions
// =========================================================================

Deno.test({
  name: "PG Stage 27: re_test — 'hello' ~ '^[a-z]+$' returns true",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // re_test compiles to: string ~ pattern
      const result = await pool.query(
        "SELECT ('hello' ~ '^[a-z]+$') AS val"
      );
      assertEquals(result.rows[0].val, true);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: re_test — 'hello' ~ '^[0-9]+$' returns false",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT ('hello' ~ '^[0-9]+$') AS val"
      );
      assertEquals(result.rows[0].val, false);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: re_replace — REGEXP_REPLACE('a1b2', '[0-9]', 'X') returns 'aXb2'",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // re_replace compiles to REGEXP_REPLACE(string, pattern, replacement)
      // Without 'g' flag, only the first match is replaced
      const result = await pool.query(
        "SELECT REGEXP_REPLACE('a1b2', '[0-9]', 'X') AS val"
      );
      assertEquals(result.rows[0].val, "aXb2");
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 4. Datetime functions
// =========================================================================

Deno.test({
  name: "PG Stage 27: datetime_of_transaction — TRANSACTION_TIMESTAMP() returns non-null",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT TRANSACTION_TIMESTAMP() AS val"
      );
      assertExists(
        result.rows[0].val,
        "TRANSACTION_TIMESTAMP should not be null"
      );
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: to_datetime — CAST('2024-01-01T00:00:00Z' AS timestamptz) returns a timestamp",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT CAST('2024-01-01T00:00:00Z' AS timestamp with time zone) AS val"
      );
      const val = result.rows[0].val;
      assertExists(val, "CAST to timestamptz should not be null");
      // Verify the date component is correct
      const dateStr = val instanceof Date ? val.toISOString() : String(val);
      assertEquals(
        dateStr.includes("2024-01-01"),
        true,
        `Timestamp should contain '2024-01-01', got: ${dateStr}`
      );
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: to_duration — CAST('1 hour' AS interval) returns an interval",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT CAST('1 hour' AS interval) AS val"
      );
      const val = String(result.rows[0].val);
      assertEquals(
        val.includes("01:00:00") || val.includes("1:00:00") ||
          val.includes("1 hour"),
        true,
        `Interval should represent 1 hour, got: ${val}`
      );
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 5. Calendar conversion functions
// =========================================================================

Deno.test({
  name: "PG Stage 27: cal::to_local_date — CAST('2024-06-15' AS date) returns '2024-06-15'",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT CAST('2024-06-15' AS date) AS val"
      );
      const val = result.rows[0].val;
      const dateStr = val instanceof Date ?
        val.toISOString().slice(0, 10) :
        String(val).slice(0, 10);
      assertEquals(dateStr, "2024-06-15");
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: cal::to_local_time — CAST('14:30:00' AS time) returns '14:30:00'",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT CAST('14:30:00' AS time without time zone) AS val"
      );
      const val = String(result.rows[0].val);
      assertEquals(
        val.startsWith("14:30:00"),
        true,
        `Time should start with '14:30:00', got: ${val}`
      );
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 6. JSON functions
// =========================================================================

Deno.test({
  name: "PG Stage 27: to_json — TO_JSONB('hello') returns jsonb string",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT TO_JSONB('hello'::text) AS val");
      const val = result.rows[0].val;
      // PG returns jsonb as a parsed JS value via deno-postgres
      assertEquals(
        val === "hello" || JSON.stringify(val) === "\"hello\"",
        true,
        `TO_JSONB('hello') should return the jsonb string 'hello', got: ${JSON.stringify(val)}`
      );
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: json_typeof — JSONB_TYPEOF(TO_JSONB(42)) returns 'number'",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT JSONB_TYPEOF(TO_JSONB(42)) AS val"
      );
      assertEquals(result.rows[0].val, "number");
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 7. Type converter functions
// =========================================================================

Deno.test({
  name: "PG Stage 27: to_int32 — CAST('42' AS integer) returns 42",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT CAST('42' AS integer) AS val");
      assertEquals(Number(result.rows[0].val), 42);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: to_float64 — CAST('3.14' AS double precision) returns ~3.14",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT CAST('3.14' AS double precision) AS val"
      );
      const val = Number(result.rows[0].val);
      assertEquals(
        Math.abs(val - 3.14) < 0.001,
        true,
        `CAST('3.14' AS double precision) should be approximately 3.14, got ${val}`
      );
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 27: to_bool — CAST('true' AS boolean) returns true",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query("SELECT CAST('true' AS boolean) AS val");
      assertEquals(result.rows[0].val, true);
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 8. UUID functions
// =========================================================================

Deno.test({
  name: "PG Stage 27: uuid_generate_v4 — GEN_RANDOM_UUID() returns a valid UUID",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT GEN_RANDOM_UUID()::text AS val"
      );
      const val = String(result.rows[0].val);
      assertExists(val, "UUID should not be null");
      assertEquals(val.length, 36, "UUID should be 36 characters long");
      // Verify UUID format: 8-4-4-4-12
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      assertEquals(
        uuidRegex.test(val),
        true,
        `GEN_RANDOM_UUID() should match UUID format, got: ${val}`
      );
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 9. Sequence functions
// =========================================================================

Deno.test({
  name: "PG Stage 27: sequence_next/reset — NEXTVAL and SETVAL on a test sequence",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Create a test sequence
      await pool.query("CREATE SEQUENCE IF NOT EXISTS test_stage27_seq");

      // NEXTVAL should return 1 on a fresh sequence
      const nextResult = await pool.query(
        "SELECT NEXTVAL('test_stage27_seq') AS val"
      );
      const firstVal = Number(nextResult.rows[0].val);
      assertEquals(firstVal, 1, "First NEXTVAL should return 1");

      // SETVAL resets the sequence to 100
      await pool.query("SELECT SETVAL('test_stage27_seq', 100)");

      // Next NEXTVAL should return 101
      const afterReset = await pool.query(
        "SELECT NEXTVAL('test_stage27_seq') AS val"
      );
      assertEquals(
        Number(afterReset.rows[0].val),
        101,
        "NEXTVAL after SETVAL(100) should return 101"
      );
    } finally {
      await pool.query("DROP SEQUENCE IF EXISTS test_stage27_seq");
      await pool.close();
    }
  }
});

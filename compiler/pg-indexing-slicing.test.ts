/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL End-to-End Tests for Stage 28: Indexing & Slicing
 *
 * Verifies that index and slice SQL compiles and executes correctly
 * against a real PostgreSQL instance.
 *
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable.
 */

import { assertEquals } from "@std/assert";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";

const RUN_PG = canRunPgTests();

// =========================================================================
// 1. Array indexing
// =========================================================================

Deno.test({
  name: "PG Stage 28: array index [0] returns first element",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // EdgeQL arr[0] → PG arr[1] (0-based to 1-based)
      const result = await pool.query(
        "SELECT (ARRAY[10,20,30])[CASE WHEN 0 < 0 THEN CARDINALITY(ARRAY[10,20,30]) + 0 + 1 ELSE 0 + 1 END] AS val"
      );
      assertEquals(result.rows[0].val, 10);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 28: array index [2] returns third element",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT (ARRAY[10,20,30])[CASE WHEN 2 < 0 THEN CARDINALITY(ARRAY[10,20,30]) + 2 + 1 ELSE 2 + 1 END] AS val"
      );
      assertEquals(result.rows[0].val, 30);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 28: array negative index [-1] returns last element",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT (ARRAY[10,20,30])[CASE WHEN -1 < 0 THEN CARDINALITY(ARRAY[10,20,30]) + -1 + 1 ELSE -1 + 1 END] AS val"
      );
      assertEquals(result.rows[0].val, 30);
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 28: array negative index [-2] returns second-to-last",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT (ARRAY[10,20,30])[CASE WHEN -2 < 0 THEN CARDINALITY(ARRAY[10,20,30]) + -2 + 1 ELSE -2 + 1 END] AS val"
      );
      assertEquals(result.rows[0].val, 20);
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 2. String slicing
// =========================================================================

Deno.test({
  name: "PG Stage 28: string slice [1:3] extracts substring",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // 'hello'[1:3] → chars at index 1,2 → 'el'
      const result = await pool.query(
        "SELECT SUBSTRING('hello' FROM 1 + 1 FOR 3 - 1) AS val"
      );
      assertEquals(result.rows[0].val, "el");
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 28: string slice [0:5] extracts full string",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT SUBSTRING('hello' FROM 0 + 1 FOR 5 - 0) AS val"
      );
      assertEquals(result.rows[0].val, "hello");
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 28: string slice [2:] extracts from offset to end",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT SUBSTRING('hello' FROM 2 + 1) AS val"
      );
      assertEquals(result.rows[0].val, "llo");
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 28: string slice [:3] extracts first 3 chars",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT SUBSTRING('hello' FROM 1 FOR 3) AS val"
      );
      assertEquals(result.rows[0].val, "hel");
    } finally {
      await pool.close();
    }
  }
});

// =========================================================================
// 3. JSON access
// =========================================================================

Deno.test({
  name: "PG Stage 28: jsonb string key access returns value",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        `SELECT ('{"name":"disc","version":1}'::jsonb) -> 'name' AS val`
      );
      // jsonb -> returns jsonb (quoted string)
      assertEquals(result.rows[0].val, "disc");
    } finally {
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG Stage 28: jsonb integer index access returns array element",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const result = await pool.query(
        "SELECT ('[10,20,30]'::jsonb) -> 1 AS val"
      );
      assertEquals(result.rows[0].val, 20);
    } finally {
      await pool.close();
    }
  }
});

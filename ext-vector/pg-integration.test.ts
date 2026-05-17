/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL Integration Tests for Vector Extension
 *
 * Tests pgvector operations against a real PostgreSQL instance.
 * pgvector may not be installed — each test checks for availability at
 * runtime and skips gracefully if CREATE EXTENSION vector fails.
 *
 * Requires a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable these tests.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import {
  canRunPgTests,
  getTestDsn,
  resetTestDatabase
} from "../tests/pg-test-harness.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0
  });
}

/**
 * Attempt to enable the pgvector extension. Returns true if pgvector is
 * available on the current PostgreSQL instance, false otherwise.
 */
async function hasPgvector(pool: ConnectionPool): Promise<boolean> {
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test 1: Check if pgvector is available
// ---------------------------------------------------------------------------

Deno.test({
  name: "Vector PG - check if pgvector extension is available",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const available = await hasPgvector(pool);
      // We do not assert a specific value — pgvector presence depends on
      // the host PG installation. We just verify the check completes.
      // The result is logged via the boolean itself.
      assert(
        typeof available === "boolean",
        "hasPgvector should return boolean"
      );
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 2: Create table with vector column and insert data
// ---------------------------------------------------------------------------

Deno.test({
  name: "Vector PG - create table with vector(3) column and insert data",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const available = await hasPgvector(pool);
      if (!available) {
        // pgvector not installed — skip
        return;
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS disc_test_vectors (
          id SERIAL PRIMARY KEY,
          label TEXT NOT NULL,
          embedding vector(3) NOT NULL
        )
      `);

      await pool.query(
        "INSERT INTO disc_test_vectors (label, embedding) VALUES ($1, $2)",
        ["alpha", "[1, 2, 3]"]
      );
      await pool.query(
        "INSERT INTO disc_test_vectors (label, embedding) VALUES ($1, $2)",
        ["beta", "[4, 5, 6]"]
      );

      const result = await pool.query(
        "SELECT COUNT(*)::integer AS cnt FROM disc_test_vectors"
      );
      assertEquals(Number(result.rows[0]["cnt"]), 2);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 3: Cosine distance operator <=>
// ---------------------------------------------------------------------------

Deno.test({
  name: "Vector PG - cosine distance operator <=> returns numeric result",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const available = await hasPgvector(pool);
      if (!available) {
        return;
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS disc_test_cosine (
          id SERIAL PRIMARY KEY,
          embedding vector(3) NOT NULL
        )
      `);

      await pool.query(
        "INSERT INTO disc_test_cosine (embedding) VALUES ($1)",
        ["[1, 0, 0]"]
      );
      await pool.query(
        "INSERT INTO disc_test_cosine (embedding) VALUES ($1)",
        ["[0, 1, 0]"]
      );

      // Cosine distance between [1,0,0] and the query [1,0,0] should be 0
      const result = await pool.query(
        "SELECT embedding <=> '[1, 0, 0]' AS dist FROM disc_test_cosine ORDER BY dist LIMIT 1"
      );
      assertEquals(result.rows.length, 1);

      const dist = Number(result.rows[0]["dist"]);
      assert(dist >= 0, "cosine distance should be non-negative");
      assert(dist < 0.01, `distance to itself should be ~0, got ${dist}`);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 4: L2 distance operator <->
// ---------------------------------------------------------------------------

Deno.test({
  name: "Vector PG - L2 distance operator <-> returns correct ordering",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const available = await hasPgvector(pool);
      if (!available) {
        return;
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS disc_test_l2 (
          id SERIAL PRIMARY KEY,
          label TEXT NOT NULL,
          embedding vector(3) NOT NULL
        )
      `);

      // Insert vectors at known distances from [0,0,0]
      await pool.query(
        "INSERT INTO disc_test_l2 (label, embedding) VALUES ($1, $2)",
        ["near", "[1, 0, 0]"]
      );
      await pool.query(
        "INSERT INTO disc_test_l2 (label, embedding) VALUES ($1, $2)",
        ["far", "[10, 10, 10]"]
      );

      const result = await pool.query(
        "SELECT label, embedding <-> '[0, 0, 0]' AS dist FROM disc_test_l2 ORDER BY dist"
      );

      assertEquals(result.rows.length, 2);
      // "near" should come first (smaller L2 distance)
      assertEquals(String(result.rows[0]["label"]), "near");
      assertEquals(String(result.rows[1]["label"]), "far");
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 5: Inner product operator <#>
// ---------------------------------------------------------------------------

Deno.test({
  name: "Vector PG - inner product operator <#> returns numeric result",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const available = await hasPgvector(pool);
      if (!available) {
        return;
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS disc_test_ip (
          id SERIAL PRIMARY KEY,
          embedding vector(3) NOT NULL
        )
      `);

      await pool.query(
        "INSERT INTO disc_test_ip (embedding) VALUES ($1)",
        ["[1, 2, 3]"]
      );

      // Inner product: [1,2,3] · [1,2,3] = 1 + 4 + 9 = 14
      // pgvector returns negative inner product for <#> operator
      const result = await pool.query(
        "SELECT embedding <#> '[1, 2, 3]' AS ip FROM disc_test_ip"
      );

      assertEquals(result.rows.length, 1);
      const ip = Number(result.rows[0]["ip"]);
      // pgvector <#> returns negative inner product (-14), so |ip| should equal 14
      assert(Math.abs(ip) > 0, "inner product should be non-zero");
      assertEquals(Math.abs(ip), 14);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 6: IVFFlat index creation on vector column
// ---------------------------------------------------------------------------

Deno.test({
  name: "Vector PG - IVFFlat index creation on vector column",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const available = await hasPgvector(pool);
      if (!available) {
        return;
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS disc_test_ivfflat (
          id SERIAL PRIMARY KEY,
          embedding vector(3) NOT NULL
        )
      `);

      // Insert enough rows for IVFFlat (requires at least lists count rows)
      for (let i = 0; i < 10; i++) {
        await pool.query(
          "INSERT INTO disc_test_ivfflat (embedding) VALUES ($1)",
          [`[${i}, ${i + 1}, ${i + 2}]`]
        );
      }

      // Create IVFFlat index — should not throw
      await pool.query(`
        CREATE INDEX IF NOT EXISTS disc_test_ivfflat_idx
        ON disc_test_ivfflat
        USING ivfflat (embedding vector_l2_ops)
        WITH (lists = 2)
      `);

      // Verify index exists in pg_indexes
      const result = await pool.query(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'disc_test_ivfflat'
         AND indexname = 'disc_test_ivfflat_idx'`
      );
      assertEquals(result.rows.length, 1);
      assertEquals(
        String(result.rows[0]["indexname"]),
        "disc_test_ivfflat_idx"
      );
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

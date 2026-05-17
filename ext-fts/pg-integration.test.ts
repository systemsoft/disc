/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL Integration Tests for FTS Extension
 *
 * Tests full-text search operations against a real PostgreSQL instance.
 * tsvector/tsquery are built into PostgreSQL, so no extension install is needed.
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

// ---------------------------------------------------------------------------
// Test 1: Create table with FTS column and GIN index
// ---------------------------------------------------------------------------

Deno.test({
  name: "FTS PG - create table with fts_vector column and GIN index, verify index exists",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Create base table
      await pool.query(`
        CREATE TABLE disc_test_fts_articles (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL
        )
      `);

      // Add generated tsvector column
      await pool.query(`
        ALTER TABLE disc_test_fts_articles
        ADD COLUMN fts_vector tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
          to_tsvector('english', coalesce(body, ''))
        ) STORED
      `);

      // Create GIN index
      await pool.query(`
        CREATE INDEX disc_test_fts_articles_fts_idx
        ON disc_test_fts_articles USING GIN (fts_vector)
      `);

      // Verify the GIN index exists in pg_indexes
      const result = await pool.query(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'disc_test_fts_articles'
         AND indexname = 'disc_test_fts_articles_fts_idx'`
      );
      assertEquals(result.rows.length, 1);
      assertEquals(
        String(result.rows[0]["indexname"]),
        "disc_test_fts_articles_fts_idx"
      );
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 2: Insert data and search with fts_vector @@ plainto_tsquery
// ---------------------------------------------------------------------------

Deno.test({
  name: "FTS PG - insert data and fts::search returns matching rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await pool.query(`
        CREATE TABLE disc_test_fts_docs (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          fts_vector tsvector GENERATED ALWAYS AS (
            to_tsvector('english', coalesce(title, '')) ||
            to_tsvector('english', coalesce(body, ''))
          ) STORED
        )
      `);

      await pool.query(
        "INSERT INTO disc_test_fts_docs (title, body) VALUES ($1, $2)",
        [
          "PostgreSQL Tutorial",
          "Learn how to use PostgreSQL for full-text search"
        ]
      );
      await pool.query(
        "INSERT INTO disc_test_fts_docs (title, body) VALUES ($1, $2)",
        ["Cooking Recipes", "How to bake the perfect sourdough bread"]
      );
      await pool.query(
        "INSERT INTO disc_test_fts_docs (title, body) VALUES ($1, $2)",
        [
          "Database Indexing",
          "PostgreSQL GIN indexes speed up text search queries"
        ]
      );

      // Search for "PostgreSQL" -- should match 2 rows
      const result = await pool.query(
        `SELECT title FROM disc_test_fts_docs
         WHERE fts_vector @@ plainto_tsquery('english', $1)
         ORDER BY title`,
        ["PostgreSQL"]
      );
      assertEquals(result.rows.length, 2);
      assertEquals(String(result.rows[0]["title"]), "Database Indexing");
      assertEquals(String(result.rows[1]["title"]), "PostgreSQL Tutorial");
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 3: ts_rank ordering -- higher-ranked results first
// ---------------------------------------------------------------------------

Deno.test({
  name: "FTS PG - fts::rank ordering returns higher-ranked results first",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await pool.query(`
        CREATE TABLE disc_test_fts_ranked (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          fts_vector tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(body, '')), 'D')
          ) STORED
        )
      `);

      // Row with "database" in title (weight A) should rank higher
      await pool.query(
        "INSERT INTO disc_test_fts_ranked (title, body) VALUES ($1, $2)",
        ["Database Systems", "An introduction to relational systems"]
      );
      // Row with "database" only in body (weight D) should rank lower
      await pool.query(
        "INSERT INTO disc_test_fts_ranked (title, body) VALUES ($1, $2)",
        ["Introduction", "This is about database systems and storage"]
      );

      const result = await pool.query(
        `SELECT title, ts_rank(fts_vector, plainto_tsquery('english', $1)) AS rank
         FROM disc_test_fts_ranked
         WHERE fts_vector @@ plainto_tsquery('english', $1)
         ORDER BY rank DESC`,
        ["database"]
      );

      assertEquals(result.rows.length, 2);
      // Title match (weight A) should come first
      assertEquals(String(result.rows[0]["title"]), "Database Systems");
      assertEquals(String(result.rows[1]["title"]), "Introduction");

      // First rank should be higher than second
      const rank1 = Number(result.rows[0]["rank"]);
      const rank2 = Number(result.rows[1]["rank"]);
      assert(rank1 > rank2, `Expected ${rank1} > ${rank2}`);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 4: Search with no matches returns empty result
// ---------------------------------------------------------------------------

Deno.test({
  name: "FTS PG - search with no matches returns empty result",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await pool.query(`
        CREATE TABLE disc_test_fts_empty (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          fts_vector tsvector GENERATED ALWAYS AS (
            to_tsvector('english', coalesce(title, ''))
          ) STORED
        )
      `);

      await pool.query(
        "INSERT INTO disc_test_fts_empty (title) VALUES ($1)",
        ["PostgreSQL Full-Text Search"]
      );

      // Search for a term that does not exist
      const result = await pool.query(
        `SELECT title FROM disc_test_fts_empty
         WHERE fts_vector @@ plainto_tsquery('english', $1)`,
        ["nonexistent_xyzzy_term"]
      );
      assertEquals(result.rows.length, 0);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 5: Multi-column weighted search -- title matches rank higher
// ---------------------------------------------------------------------------

Deno.test({
  name: "FTS PG - multi-column weighted search ranks title matches higher than body",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await pool.query(`
        CREATE TABLE disc_test_fts_weighted (
          id SERIAL PRIMARY KEY,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          fts_vector tsvector GENERATED ALWAYS AS (
            setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(body, '')), 'D')
          ) STORED
        )
      `);

      // "typescript" appears in title of first row
      await pool.query(
        "INSERT INTO disc_test_fts_weighted (title, body) VALUES ($1, $2)",
        ["TypeScript Guide", "A comprehensive guide to building applications"]
      );
      // "typescript" appears only in body of second row
      await pool.query(
        "INSERT INTO disc_test_fts_weighted (title, body) VALUES ($1, $2)",
        [
          "Programming Languages",
          "Learn TypeScript and JavaScript for web development"
        ]
      );

      const result = await pool.query(
        `SELECT title, ts_rank(fts_vector, plainto_tsquery('english', $1)) AS rank
         FROM disc_test_fts_weighted
         WHERE fts_vector @@ plainto_tsquery('english', $1)
         ORDER BY rank DESC`,
        ["typescript"]
      );

      assertEquals(result.rows.length, 2);
      // Title match should rank first
      assertEquals(String(result.rows[0]["title"]), "TypeScript Guide");
      assertEquals(String(result.rows[1]["title"]), "Programming Languages");

      const rank1 = Number(result.rows[0]["rank"]);
      const rank2 = Number(result.rows[1]["rank"]);
      assert(
        rank1 > rank2,
        `Title match rank (${rank1}) should be higher than body match rank (${rank2})`
      );
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

/**
 * PostgreSQL End-to-End Tests for Range & Multirange Types
 *
 * Validates that range and multirange types work correctly against a real
 * PostgreSQL instance:
 *   - DDL: SDL with range/multirange properties -> migration -> correct PG column types
 *   - DML: INSERT range values via raw SQL, SELECT back and verify
 *   - Functions: range_get_lower, range_get_upper, range_is_empty, contains, overlaps
 *   - Operators: @> in FILTER clauses
 *   - Datetime ranges: tstzrange round-trip
 *   - Multirange construction and round-trip
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";

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

/** Get column info for a table via a raw client, including udt_name for range types. */
async function getColumns(
  dsn: string,
  tableName: string,
): Promise<{ column_name: string; data_type: string; udt_name: string }[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<
      { column_name: string; data_type: string; udt_name: string }
    >(
      `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName],
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

/** Drop one or more tables by name (best-effort cleanup). */
async function dropTables(
  dsn: string,
  ...tableNames: string[]
): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    for (const name of tableNames) {
      await client.queryArray(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }
  } finally {
    await client.end();
  }
}

/** Execute raw SQL via a fresh client connection. */
async function execRawSQL(
  dsn: string,
  sql: string,
): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    await client.queryArray(sql);
  } finally {
    await client.end();
  }
}

/** Query raw SQL and return rows via a fresh client connection. */
async function queryRawSQL(
  dsn: string,
  sql: string,
): Promise<Record<string, unknown>[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject(sql);
    return result.rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

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
// Test 1: DDL — range<int32> column creation
// =========================================================================

Deno.test({
  name:
    "PG Range E2E: range<int32> property creates int4range column in PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "range_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type RangeTest {
          required name: str;
          score_range: range<int32>;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${
          result.ok ? "" : JSON.stringify(result)
        }`,
      );

      // Range types report as USER-DEFINED in data_type; check udt_name instead
      const columns = await getColumns(dsn, expectedTable);
      const rangeCol = columns.find((c) => c.column_name === "score_range");
      assertEquals(
        rangeCol !== undefined,
        true,
        "Table should have a 'score_range' column",
      );
      assertEquals(
        rangeCol!.udt_name,
        "int4range",
        "range<int32> should map to PostgreSQL 'int4range' udt_name",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 2: DDL — multirange<int64> column creation
// =========================================================================

Deno.test({
  name:
    "PG Range E2E: multirange<int64> property creates int8multirange column in PostgreSQL",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "multi_range_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type MultiRangeTest {
          required name: str;
          ranges: multirange<int64>;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${
          result.ok ? "" : JSON.stringify(result)
        }`,
      );

      // Multirange types also report as USER-DEFINED; check udt_name
      const columns = await getColumns(dsn, expectedTable);
      const mrCol = columns.find((c) => c.column_name === "ranges");
      assertEquals(
        mrCol !== undefined,
        true,
        "Table should have a 'ranges' column",
      );
      assertEquals(
        mrCol!.udt_name,
        "int8multirange",
        "multirange<int64> should map to PostgreSQL 'int8multirange' udt_name",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 3: INSERT + SELECT range value round-trip
// =========================================================================

Deno.test({
  name:
    "PG Range E2E: INSERT int4range value via raw SQL, SELECT back and verify bounds",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "range_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type RangeTest {
          required name: str;
          score_range: range<int32>;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema failed: ${JSON.stringify(result)}`,
      );

      // Insert a row with a range value
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, name, score_range)
         VALUES (gen_random_uuid(), 'alpha', int4range(1, 10))`,
      );

      // Select back the range value and verify it round-trips
      const rows = await queryRawSQL(
        dsn,
        `SELECT name, score_range::text AS score_range FROM ${expectedTable} WHERE name = 'alpha'`,
      );

      assertEquals(rows.length, 1, "Should have one row");
      assertEquals(rows[0].name, "alpha");

      // int4range(1, 10) produces '[1,10)' (inclusive lower, exclusive upper)
      const rangeStr = String(rows[0].score_range);
      assertEquals(
        rangeStr,
        "[1,10)",
        "int4range(1, 10) should round-trip as '[1,10)'",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 4: range_get_lower() and range_get_upper() via PG LOWER/UPPER
// =========================================================================

Deno.test({
  name: "PG Range E2E: LOWER() and UPPER() return correct bounds of int4range",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Direct SQL: no schema needed — just verify PG range functions work
      const rows = await queryRawSQL(
        dsn,
        `SELECT
           LOWER(int4range(5, 20)) AS lower_bound,
           UPPER(int4range(5, 20)) AS upper_bound`,
      );

      assertEquals(rows.length, 1, "Should return one row");
      assertEquals(
        Number(rows[0].lower_bound),
        5,
        "LOWER(int4range(5, 20)) should be 5",
      );
      assertEquals(
        Number(rows[0].upper_bound),
        20,
        "UPPER(int4range(5, 20)) should be 20",
      );
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// Test 5: range_is_empty() via PG ISEMPTY
// =========================================================================

Deno.test({
  name:
    "PG Range E2E: ISEMPTY() correctly identifies empty and non-empty ranges",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // An empty range: int4range(5, 5) is empty because [5,5) contains nothing
      const rows = await queryRawSQL(
        dsn,
        `SELECT
           ISEMPTY(int4range(5, 5)) AS is_empty,
           ISEMPTY(int4range(1, 10)) AS is_not_empty`,
      );

      assertEquals(rows.length, 1, "Should return one row");
      assertEquals(
        rows[0].is_empty,
        true,
        "int4range(5, 5) should be empty",
      );
      assertEquals(
        rows[0].is_not_empty,
        false,
        "int4range(1, 10) should NOT be empty",
      );
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// Test 6: contains(range, elem) via PG @> operator
// =========================================================================

Deno.test({
  name: "PG Range E2E: @> operator checks element containment in range",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "range_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type RangeTest {
          required name: str;
          score_range: range<int32>;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema failed: ${JSON.stringify(result)}`,
      );

      // Insert rows with different ranges
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, name, score_range) VALUES
           (gen_random_uuid(), 'low', int4range(1, 10)),
           (gen_random_uuid(), 'mid', int4range(10, 20)),
           (gen_random_uuid(), 'high', int4range(20, 30))`,
      );

      // Use @> to find which range contains the value 15
      const rows = await queryRawSQL(
        dsn,
        `SELECT name FROM ${expectedTable} WHERE score_range @> 15 ORDER BY name`,
      );

      // 15 is in [10,20) → only 'mid' should match
      assertEquals(rows.length, 1, "Only one range should contain 15");
      assertEquals(
        rows[0].name,
        "mid",
        "int4range(10, 20) should contain 15",
      );
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 7: overlaps(r1, r2) via PG && operator
// =========================================================================

Deno.test({
  name: "PG Range E2E: && operator detects range overlap",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      // Test overlap between two ranges
      const rows = await queryRawSQL(
        dsn,
        `SELECT
           (int4range(1, 10) && int4range(5, 15)) AS do_overlap,
           (int4range(1, 5) && int4range(10, 20)) AS no_overlap`,
      );

      assertEquals(rows.length, 1, "Should return one row");
      assertEquals(
        rows[0].do_overlap,
        true,
        "[1,10) && [5,15) should overlap",
      );
      assertEquals(
        rows[0].no_overlap,
        false,
        "[1,5) && [10,20) should NOT overlap",
      );
    } finally {
      await pool.close();
    }
  },
});

// =========================================================================
// Test 8: @> operator in a FILTER clause — find rows where range contains value
// =========================================================================

Deno.test({
  name:
    "PG Range E2E: @> operator in WHERE clause filters rows by range containment",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "range_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type RangeTest {
          required name: str;
          score_range: range<int32>;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema failed: ${JSON.stringify(result)}`,
      );

      // Insert rows with overlapping ranges
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, name, score_range) VALUES
           (gen_random_uuid(), 'range_a', int4range(1, 50)),
           (gen_random_uuid(), 'range_b', int4range(40, 80)),
           (gen_random_uuid(), 'range_c', int4range(100, 200))`,
      );

      // Find all rows where the range contains 45
      // range_a: [1,50) contains 45 → yes
      // range_b: [40,80) contains 45 → yes
      // range_c: [100,200) contains 45 → no
      const rows = await queryRawSQL(
        dsn,
        `SELECT name FROM ${expectedTable}
         WHERE score_range @> 45
         ORDER BY name`,
      );

      assertEquals(rows.length, 2, "Two ranges should contain 45");
      assertEquals(rows[0].name, "range_a");
      assertEquals(rows[1].name, "range_b");
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 9: Range with datetime type — tstzrange round-trip
// =========================================================================

Deno.test({
  name:
    "PG Range E2E: range<datetime> creates tstzrange column and round-trips timestamp ranges",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "date_range_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type DateRangeTest {
          required name: str;
          period: range<datetime>;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema failed: ${JSON.stringify(result)}`,
      );

      // Verify column type is tstzrange
      const columns = await getColumns(dsn, expectedTable);
      const periodCol = columns.find((c) => c.column_name === "period");
      assertEquals(
        periodCol !== undefined,
        true,
        "Table should have a 'period' column",
      );
      assertEquals(
        periodCol!.udt_name,
        "tstzrange",
        "range<datetime> should map to PostgreSQL 'tstzrange' udt_name",
      );

      // Insert a timestamp range
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, name, period)
         VALUES (
           gen_random_uuid(),
           'meeting',
           tstzrange('2024-06-15 09:00:00+00', '2024-06-15 10:30:00+00')
         )`,
      );

      // Query back and verify bounds via LOWER/UPPER
      const rows = await queryRawSQL(
        dsn,
        `SELECT
           name,
           LOWER(period)::text AS lower_ts,
           UPPER(period)::text AS upper_ts
         FROM ${expectedTable}
         WHERE name = 'meeting'`,
      );

      assertEquals(rows.length, 1, "Should have one row");

      const lowerStr = String(rows[0].lower_ts);
      const upperStr = String(rows[0].upper_ts);

      assertEquals(
        lowerStr.includes("2024-06-15") && lowerStr.includes("09:00:00"),
        true,
        `Lower bound should contain '2024-06-15' and '09:00:00', got: ${lowerStr}`,
      );
      assertEquals(
        upperStr.includes("2024-06-15") && upperStr.includes("10:30:00"),
        true,
        `Upper bound should contain '2024-06-15' and '10:30:00', got: ${upperStr}`,
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

// =========================================================================
// Test 10: Multirange construction and round-trip
// =========================================================================

Deno.test({
  name:
    "PG Range E2E: multirange<int64> column stores and round-trips multirange values",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "multi_range_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type MultiRangeTest {
          required name: str;
          ranges: multirange<int64>;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema failed: ${JSON.stringify(result)}`,
      );

      // Insert a multirange value: two disjoint ranges [1,5) and [10,20)
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, name, ranges)
         VALUES (
           gen_random_uuid(),
           'multi',
           '{[1,5), [10,20)}'::int8multirange
         )`,
      );

      // Select back and verify
      const rows = await queryRawSQL(
        dsn,
        `SELECT name, ranges::text AS ranges
         FROM ${expectedTable}
         WHERE name = 'multi'`,
      );

      assertEquals(rows.length, 1, "Should have one row");
      assertEquals(rows[0].name, "multi");

      // Multirange text representation: {[1,5),[10,20)}
      const mrStr = String(rows[0].ranges);
      assertEquals(
        mrStr.includes("[1,5)") && mrStr.includes("[10,20)"),
        true,
        `Multirange should contain '[1,5)' and '[10,20)', got: ${mrStr}`,
      );

      // Verify @> containment on multiranges
      const containsRows = await queryRawSQL(
        dsn,
        `SELECT
           ('{[1,5), [10,20)}'::int8multirange @> 3::bigint) AS contains_3,
           ('{[1,5), [10,20)}'::int8multirange @> 7::bigint) AS contains_7,
           ('{[1,5), [10,20)}'::int8multirange @> 15::bigint) AS contains_15`,
      );

      assertEquals(containsRows.length, 1, "Should return one row");
      assertEquals(
        containsRows[0].contains_3,
        true,
        "Multirange {[1,5),[10,20)} should contain 3",
      );
      assertEquals(
        containsRows[0].contains_7,
        false,
        "Multirange {[1,5),[10,20)} should NOT contain 7",
      );
      assertEquals(
        containsRows[0].contains_15,
        true,
        "Multirange {[1,5),[10,20)} should contain 15",
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints",
      );
      await pool.close();
    }
  },
});

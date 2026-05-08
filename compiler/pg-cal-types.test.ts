/**
 * PostgreSQL End-to-End Tests for Calendar Type Support
 *
 * Tests that verify cal::local_date, cal::local_time, cal::local_datetime,
 * cal::relative_duration, and cal::date_duration are correctly mapped to
 * PostgreSQL column types and round-trip through the SchemaManager SDL pipeline.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a DSN into connection config for the raw deno-postgres Client. */
function parseDsn(
  dsn: string
): { hostname: string; port: number; user: string; database: string; } {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test"
  };
}

/** Get column info for a table via a raw client. */
async function getColumns(
  dsn: string,
  tableName: string
): Promise<{ column_name: string; data_type: string; }[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<
      { column_name: string; data_type: string; }
    >(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
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
  params?: unknown[]
): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    if (params) {
      await client.queryArray(sql, params);
    } else {
      await client.queryArray(sql);
    }
  } finally {
    await client.end();
  }
}

/** Query raw SQL and return rows via a fresh client connection. */
async function queryRawSQL(
  dsn: string,
  sql: string,
  params?: unknown[]
): Promise<Record<string, unknown>[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = params ? await client.queryObject(sql, params) : await client.queryObject(sql);
    return result.rows as Record<string, unknown>[];
  } finally {
    await client.end();
  }
}

/** Create a ConnectionPool configured for testing. */
function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0
  });
}

// =========================================================================
// Test 1: cal::local_date column DDL and round-trip
// =========================================================================

Deno.test({
  name: "PG cal types: cal::local_date maps to date and round-trips",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "cal_date_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type CalDateTest {
          required birthday: cal::local_date;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Verify column type is 'date'
      const columns = await getColumns(dsn, expectedTable);
      const birthdayCol = columns.find(c => c.column_name === "birthday");
      assertEquals(
        birthdayCol !== undefined,
        true,
        "Table should have a 'birthday' column"
      );
      assertEquals(
        birthdayCol!.data_type,
        "date",
        "cal::local_date should map to PostgreSQL 'date' type"
      );

      // Insert a row and round-trip
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, birthday) VALUES (gen_random_uuid(), '2024-06-15'::date)`
      );

      const rows = await queryRawSQL(
        dsn,
        `SELECT birthday FROM ${expectedTable} LIMIT 1`
      );
      assertEquals(rows.length, 1, "Should have one row");

      // PostgreSQL returns date as a Date object or string; verify the value
      const val = rows[0].birthday;
      const dateStr = val instanceof Date ? val.toISOString().slice(0, 10) : String(val).slice(0, 10);
      assertEquals(
        dateStr,
        "2024-06-15",
        "Round-tripped cal::local_date value should be '2024-06-15'"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 2: cal::local_time column DDL and round-trip
// =========================================================================

Deno.test({
  name: "PG cal types: cal::local_time maps to time without time zone and round-trips",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "cal_time_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type CalTimeTest {
          required alarm_time: cal::local_time;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Verify column type is 'time without time zone'
      const columns = await getColumns(dsn, expectedTable);
      const alarmCol = columns.find(c => c.column_name === "alarm_time");
      assertEquals(
        alarmCol !== undefined,
        true,
        "Table should have an 'alarm_time' column"
      );
      assertEquals(
        alarmCol!.data_type,
        "time without time zone",
        "cal::local_time should map to PostgreSQL 'time without time zone' type"
      );

      // Insert a row and round-trip
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, alarm_time) VALUES (gen_random_uuid(), '14:30:00'::time)`
      );

      const rows = await queryRawSQL(
        dsn,
        `SELECT alarm_time FROM ${expectedTable} LIMIT 1`
      );
      assertEquals(rows.length, 1, "Should have one row");

      // Verify the time value contains '14:30:00'
      const val = String(rows[0].alarm_time);
      assertEquals(
        val.startsWith("14:30:00"),
        true,
        `Round-tripped cal::local_time value should start with '14:30:00', got: ${val}`
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 3: cal::local_datetime column DDL and round-trip
// =========================================================================

Deno.test({
  name: "PG cal types: cal::local_datetime maps to timestamp without time zone and round-trips",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "cal_date_time_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type CalDateTimeTest {
          required event_at: cal::local_datetime;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Verify column type is 'timestamp without time zone'
      const columns = await getColumns(dsn, expectedTable);
      const eventCol = columns.find(c => c.column_name === "event_at");
      assertEquals(
        eventCol !== undefined,
        true,
        "Table should have an 'event_at' column"
      );
      assertEquals(
        eventCol!.data_type,
        "timestamp without time zone",
        "cal::local_datetime should map to PostgreSQL 'timestamp without time zone' type"
      );

      // Insert a row and round-trip
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, event_at) VALUES (gen_random_uuid(), '2024-06-15 14:30:00'::timestamp)`
      );

      // `timestamp without time zone` decodes through the deno-postgres
      // driver as a JS Date in the *local* timezone, and converting via
      // `toISOString()` would shift those naive wall-clock values into
      // UTC (e.g. `14:30 PDT` → `21:30Z`). Round-trip through PG's
      // own text formatter so the assertion is timezone-stable. (P2-X)
      const rows = await queryRawSQL(
        dsn,
        `SELECT to_char(event_at, 'YYYY-MM-DD HH24:MI:SS') AS event_at_text
         FROM ${expectedTable} LIMIT 1`
      );
      assertEquals(rows.length, 1, "Should have one row");

      const tsStr = String(rows[0].event_at_text);
      assertEquals(
        tsStr,
        "2024-06-15 14:30:00",
        `Round-tripped cal::local_datetime should be '2024-06-15 14:30:00', got: ${tsStr}`
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 4: cal::relative_duration column DDL and round-trip
// =========================================================================

Deno.test({
  name: "PG cal types: cal::relative_duration maps to interval and round-trips",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "cal_duration_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type CalDurationTest {
          required time_span: cal::relative_duration;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Verify column type is 'interval'
      const columns = await getColumns(dsn, expectedTable);
      const spanCol = columns.find(c => c.column_name === "time_span");
      assertEquals(
        spanCol !== undefined,
        true,
        "Table should have a 'time_span' column"
      );
      assertEquals(
        spanCol!.data_type,
        "interval",
        "cal::relative_duration should map to PostgreSQL 'interval' type"
      );

      // Insert a row and round-trip
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, time_span) VALUES (gen_random_uuid(), '2 hours 30 minutes'::interval)`
      );

      const rows = await queryRawSQL(
        dsn,
        `SELECT time_span FROM ${expectedTable} LIMIT 1`
      );
      assertEquals(rows.length, 1, "Should have one row");

      // PostgreSQL returns interval in various formats; verify it represents 2h30m
      const val = String(rows[0].time_span);
      assertEquals(
        val.includes("02:30:00") || val.includes("2:30:00") ||
          val.includes("2 hours 30 min"),
        true,
        `Round-tripped cal::relative_duration should represent 2h30m, got: ${val}`
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 5: cal::date_duration column DDL and round-trip
// =========================================================================

Deno.test({
  name: "PG cal types: cal::date_duration maps to interval and round-trips",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "cal_date_dur_test";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type CalDateDurTest {
          required date_span: cal::date_duration;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Verify column type is 'interval'
      const columns = await getColumns(dsn, expectedTable);
      const spanCol = columns.find(c => c.column_name === "date_span");
      assertEquals(
        spanCol !== undefined,
        true,
        "Table should have a 'date_span' column"
      );
      assertEquals(
        spanCol!.data_type,
        "interval",
        "cal::date_duration should map to PostgreSQL 'interval' type"
      );

      // Insert a row and round-trip
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (id, date_span) VALUES (gen_random_uuid(), '3 days'::interval)`
      );

      const rows = await queryRawSQL(
        dsn,
        `SELECT date_span FROM ${expectedTable} LIMIT 1`
      );
      assertEquals(rows.length, 1, "Should have one row");

      // PostgreSQL returns '3 days' interval in various formats
      const val = String(rows[0].date_span);
      assertEquals(
        val.includes("3 day") || val.includes("3 days") ||
          val.includes("72:00:00"),
        true,
        `Round-tripped cal::date_duration should represent 3 days, got: ${val}`
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// =========================================================================
// Test 6: All five cal types in one type
// =========================================================================

Deno.test({
  name: "PG cal types: All five cal types in one type with correct DDL and round-trip",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    const expectedTable = "cal_all_types";

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const sdl = `
        type CalAllTypes {
          required local_date_val: cal::local_date;
          required local_time_val: cal::local_time;
          required local_datetime_val: cal::local_datetime;
          required relative_dur_val: cal::relative_duration;
          required date_dur_val: cal::date_duration;
        }
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Verify all column types
      const columns = await getColumns(dsn, expectedTable);
      const colMap = new Map(
        columns.map(c => [c.column_name, c.data_type])
      );

      assertEquals(
        colMap.get("local_date_val"),
        "date",
        "cal::local_date should map to 'date'"
      );
      assertEquals(
        colMap.get("local_time_val"),
        "time without time zone",
        "cal::local_time should map to 'time without time zone'"
      );
      assertEquals(
        colMap.get("local_datetime_val"),
        "timestamp without time zone",
        "cal::local_datetime should map to 'timestamp without time zone'"
      );
      assertEquals(
        colMap.get("relative_dur_val"),
        "interval",
        "cal::relative_duration should map to 'interval'"
      );
      assertEquals(
        colMap.get("date_dur_val"),
        "interval",
        "cal::date_duration should map to 'interval'"
      );

      // Insert a row with all five values
      await execRawSQL(
        dsn,
        `INSERT INTO ${expectedTable} (
          id,
          local_date_val,
          local_time_val,
          local_datetime_val,
          relative_dur_val,
          date_dur_val
        ) VALUES (
          gen_random_uuid(),
          '2024-06-15'::date,
          '14:30:00'::time,
          '2024-06-15 14:30:00'::timestamp,
          '2 hours 30 minutes'::interval,
          '3 days'::interval
        )`
      );

      // Select back and verify all values. Cast naive date/time/timestamp
      // columns through `to_char` so the assertion is timezone-stable —
      // otherwise the deno-postgres driver decodes through JS Date
      // (UTC) and shifts wall-clock values when the host is in a
      // non-UTC zone. (P2-X)
      const rows = await queryRawSQL(
        dsn,
        `SELECT
          to_char(local_date_val, 'YYYY-MM-DD') AS local_date_val_text,
          to_char(local_time_val, 'HH24:MI:SS') AS local_time_val_text,
          to_char(local_datetime_val, 'YYYY-MM-DD HH24:MI:SS') AS local_datetime_val_text,
          relative_dur_val,
          date_dur_val
        FROM ${expectedTable} LIMIT 1`
      );
      assertEquals(rows.length, 1, "Should have one row");

      const row = rows[0];

      assertEquals(
        String(row.local_date_val_text),
        "2024-06-15",
        `local_date_val should be '2024-06-15', got: ${row.local_date_val_text}`
      );
      assertEquals(
        String(row.local_time_val_text),
        "14:30:00",
        `local_time_val should be '14:30:00', got: ${row.local_time_val_text}`
      );
      assertEquals(
        String(row.local_datetime_val_text),
        "2024-06-15 14:30:00",
        `local_datetime_val should be '2024-06-15 14:30:00', got: ${row.local_datetime_val_text}`
      );

      // Verify relative_dur_val
      const relDurVal = String(row.relative_dur_val);
      assertEquals(
        relDurVal.includes("02:30:00") || relDurVal.includes("2:30:00") ||
          relDurVal.includes("2 hours 30 min"),
        true,
        `relative_dur_val should represent 2h30m, got: ${relDurVal}`
      );

      // Verify date_dur_val
      const dateDurVal = String(row.date_dur_val);
      assertEquals(
        dateDurVal.includes("3 day") || dateDurVal.includes("3 days") ||
          dateDurVal.includes("72:00:00"),
        true,
        `date_dur_val should represent 3 days, got: ${dateDurVal}`
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        expectedTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

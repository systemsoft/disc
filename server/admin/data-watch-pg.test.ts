/**
 * PG-backed integration test for the data-watch DDL bootstrap (Bundle
 * L — #3c).
 *
 * Verifies the full mutation → trigger → change-log roundtrip:
 *
 *   1. bootstrapDataWatch() creates the table, function, and triggers.
 *   2. INSERT/UPDATE/DELETE on a managed table writes a row to
 *      `disc_change_log` tagged with the table + op.
 *   3. Bootstrap is idempotent — running it twice produces no errors
 *      and doesn't duplicate triggers.
 *   4. pruneChangeLog() drops old rows.
 *
 * Skipped when no PG harness is available (DISC_PG_AUTO=1 or
 * DISC_PG_TEST_URL set).
 */

import { assertEquals, assertGreater } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, getTestDsn } from "../../tests/pg-test-harness.ts";
import { ConnectionPool } from "../../lib/connection-pool.ts";
import { bootstrapDataWatch, CHANGE_LOG_TABLE, pruneChangeLog } from "./data-watch-ddl.ts";

const RUN_PG = canRunPgTests();
const SUFFIX = `bundlel_${Date.now() % 100000}`;
const TABLE = `bl_widget_${SUFFIX}`;

function parseDsn(dsn: string) {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test",
  };
}

async function execSql(dsn: string, sql: string): Promise<void> {
  const client = new Client(parseDsn(dsn));
  await client.connect();
  try {
    await client.queryArray(sql);
  } finally {
    await client.end();
  }
}

async function cleanup(dsn: string): Promise<void> {
  await execSql(dsn, `DROP TABLE IF EXISTS "${TABLE}" CASCADE`);
  // The change-log table may not exist yet (first run); ignore the
  // "relation does not exist" error rather than blowing up the cleanup.
  try {
    await execSql(
      dsn,
      `DELETE FROM ${CHANGE_LOG_TABLE} WHERE table_name = '${TABLE}'`,
    );
  } catch {
    // change-log not bootstrapped yet — fine.
  }
}

Deno.test({
  name: "Bundle L — bootstrap creates change-log table + function + triggers; mutations append rows",
  ignore: !RUN_PG,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await cleanup(dsn);

    // Create a fresh user table to attach triggers to.
    await execSql(
      dsn,
      `CREATE TABLE "${TABLE}" (id SERIAL PRIMARY KEY, name TEXT)`,
    );

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 4,
    });
    try {
      await pool.initialize();

      // Phase 1: bootstrap. Idempotent — calling twice should be fine.
      const firstWired: string[] = [];
      const result1 = await bootstrapDataWatch({
        pool,
        log: (m) => firstWired.push(m),
      });
      const result2 = await bootstrapDataWatch({ pool });

      // Both runs should report our test table among the wired set.
      assertEquals(result1.wiredTables.includes(TABLE), true);
      assertEquals(result2.wiredTables.includes(TABLE), true);

      // Phase 2: trigger fires on INSERT.
      const insertCursor = await pool.query(
        `SELECT COALESCE(MAX(id), 0)::bigint AS cur FROM ${CHANGE_LOG_TABLE}`,
      );
      const startId = Number(insertCursor.rows[0].cur);

      await pool.execute(
        `INSERT INTO "${TABLE}" (name) VALUES ('alpha'), ('bravo')`,
      );

      const afterInsert = await pool.query(
        `SELECT id, table_name, op FROM ${CHANGE_LOG_TABLE} WHERE id > $1 ORDER BY id`,
        [String(startId)],
      );
      // FOR EACH STATEMENT — single INSERT (even multi-row) → one log row.
      assertEquals(afterInsert.rows.length, 1);
      assertEquals(afterInsert.rows[0].table_name, TABLE);
      assertEquals(afterInsert.rows[0].op, "INSERT");

      // Phase 3: trigger fires on UPDATE.
      const updateStart = Number(afterInsert.rows[0].id);
      await pool.execute(`UPDATE "${TABLE}" SET name = 'charlie'`);
      const afterUpdate = await pool.query(
        `SELECT op FROM ${CHANGE_LOG_TABLE} WHERE id > $1 ORDER BY id`,
        [String(updateStart)],
      );
      assertEquals(afterUpdate.rows.length, 1);
      assertEquals(afterUpdate.rows[0].op, "UPDATE");

      // Phase 4: trigger fires on DELETE.
      const updateId = Number(
        (await pool.query(`SELECT MAX(id)::bigint AS cur FROM ${CHANGE_LOG_TABLE}`))
          .rows[0].cur,
      );
      await pool.execute(`DELETE FROM "${TABLE}"`);
      const afterDelete = await pool.query(
        `SELECT op FROM ${CHANGE_LOG_TABLE} WHERE id > $1 ORDER BY id`,
        [String(updateId)],
      );
      assertEquals(afterDelete.rows.length, 1);
      assertEquals(afterDelete.rows[0].op, "DELETE");
    } finally {
      await pool.close();
      await cleanup(dsn);
    }
  },
});

Deno.test({
  name: "Bundle L — change-log table is excluded from triggers (no infinite loop)",
  ignore: !RUN_PG,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 4,
    });
    try {
      await pool.initialize();
      const result = await bootstrapDataWatch({ pool });

      // The wired-tables list explicitly should NOT contain the
      // change-log itself; otherwise a single INSERT into the log
      // would loop.
      assertEquals(result.wiredTables.includes(CHANGE_LOG_TABLE), false);

      // Sanity check: confirm via pg_trigger that no trigger exists.
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM pg_trigger
         WHERE tgrelid = '${CHANGE_LOG_TABLE}'::regclass
         AND NOT tgisinternal`,
      );
      assertEquals(Number(r.rows[0].n), 0);
    } finally {
      await pool.close();
    }
  },
});

Deno.test({
  name: "Bundle L — pruneChangeLog drops rows older than the lookback",
  ignore: !RUN_PG,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 4,
    });
    try {
      await pool.initialize();
      await bootstrapDataWatch({ pool });

      // Seed a "stale" row 2 hours in the past.
      await pool.execute(
        `INSERT INTO ${CHANGE_LOG_TABLE} (table_name, op, created_at)
         VALUES ('___test_stale', 'INSERT', now() - interval '2 hours')`,
      );
      // And a recent row.
      await pool.execute(
        `INSERT INTO ${CHANGE_LOG_TABLE} (table_name, op)
         VALUES ('___test_recent', 'INSERT')`,
      );

      const before = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ${CHANGE_LOG_TABLE} WHERE table_name LIKE '___test_%'`,
      );
      assertGreater(Number(before.rows[0].n), 1);

      const pruned = await pruneChangeLog(pool, 3600); // 1h lookback
      assertGreater(pruned, 0);

      const after = await pool.query(
        `SELECT table_name FROM ${CHANGE_LOG_TABLE} WHERE table_name LIKE '___test_%'`,
      );
      // Stale row should be gone; recent row should remain.
      assertEquals(
        after.rows.some((r: any) => r.table_name === "___test_stale"),
        false,
      );
      assertEquals(
        after.rows.some((r: any) => r.table_name === "___test_recent"),
        true,
      );

      // Cleanup our seeded test rows.
      await pool.execute(
        `DELETE FROM ${CHANGE_LOG_TABLE} WHERE table_name LIKE '___test_%'`,
      );
    } finally {
      await pool.close();
    }
  },
});

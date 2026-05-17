/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * gh/geldata#2071 — migrations fail after dump/restore round-trip.
 *
 * Upstream context: with edgedb's `dump --all`/`restore --all`, the
 * migration tracker state lived in a sidecar that was *not* round-tripped
 * properly, so after restore the database appeared empty while the
 * filesystem still listed N migrations as applied.
 *
 * Disc context: the migration tracker (`disc_migrations`) is a regular
 * table inside the same PostgreSQL database. A standard `pg_dump`/`psql`
 * round-trip therefore restores the tracker alongside everything else,
 * and a subsequent `disc migrate` is a no-op. This test pins that
 * structural property so future refactors can't accidentally regress it.
 *
 * PG-backed: requires DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import {
  canRunPgTests,
  findPgBinDir,
  getTestDsn
} from "../tests/pg-test-harness.ts";
import { MigrationTracker } from "./tracker.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

function parseDsn(dsn: string): {
  database: string;
  hostname: string;
  port: number;
  user: string;
} {
  const url = new URL(dsn);
  return {
    database: url.pathname.slice(1) || "disc_test",
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc"
  };
}

/** Run pg_dump against the test instance and return the SQL bytes. */
async function pgDump(dsn: string, pgBinDir: string): Promise<Uint8Array> {
  const cfg = parseDsn(dsn);
  const child = new Deno.Command(join(pgBinDir, "pg_dump"), {
    args: [
      "--host",
      cfg.hostname,
      "--port",
      String(cfg.port),
      "--username",
      cfg.user,
      "--no-owner",
      "--no-acl",
      // --clean emits DROP statements before each CREATE. This makes the
      // dump idempotent against a non-empty target — the same property
      // production users rely on with `disc db restore --clean`.
      "--clean",
      "--if-exists",
      "--format=plain",
      cfg.database
    ],
    stderr: "piped",
    stdin: "null",
    stdout: "piped"
  });
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`pg_dump failed: ${new TextDecoder().decode(stderr)}`);
  }
  return stdout;
}

/** Drop and recreate a schema, then pipe SQL bytes through psql to restore. */
async function pgRestore(
  dsn: string,
  pgBinDir: string,
  sql: Uint8Array
): Promise<void> {
  const cfg = parseDsn(dsn);
  const child = new Deno.Command(join(pgBinDir, "psql"), {
    args: [
      "--host",
      cfg.hostname,
      "--port",
      String(cfg.port),
      "--username",
      cfg.user,
      "--dbname",
      cfg.database,
      "--quiet",
      "--set",
      "ON_ERROR_STOP=1"
    ],
    stderr: "piped",
    stdin: "piped",
    stdout: "piped"
  })
    .spawn();

  const writer = child.stdin.getWriter();
  await writer.write(sql);
  await writer.close();

  const { code, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`psql restore failed: ${new TextDecoder().decode(stderr)}`);
  }
}

/** Drop a list of tables (best-effort). */
async function dropTables(dsn: string, ...tables: string[]): Promise<void> {
  const client = new Client(parseDsn(dsn));
  try {
    await client.connect();
    for (const t of tables) {
      await client.queryArray(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
  } finally {
    await client.end();
  }
}

Deno.test({
  name: "Gel #2071: disc_migrations survives pg_dump/psql round-trip (no `database is empty` after restore)",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pgBinDir = findPgBinDir();
    if (!pgBinDir) {
      throw new Error(
        "findPgBinDir() returned undefined; cannot run #2071 pin"
      );
    }

    // Use unique table names so this test can run in parallel with others.
    const userTable = `dump_test_user_${Date.now()}`;
    const migrationId = `dump_test_${Date.now()}`;

    const pool = new ConnectionPool({
      connectionString: dsn,
      minConnections: 1,
      maxConnections: 3,
      cleanupInterval: 0
    });

    try {
      await pool.initialize();

      // 1. Create a real domain table + record a migration in the tracker.
      await pool.execute(
        `CREATE TABLE ${userTable} (id uuid PRIMARY KEY, name text NOT NULL)`
      );

      const tracker = new MigrationTracker(pool);
      const initRes = await tracker.initialize();
      assertEquals(initRes.ok, true, "tracker init should succeed");

      const migration: Types.Migration = {
        id: migrationId,
        name: "dump_test_migration",
        description: "round-trip pin",
        createdAt: new Date(),
        appliedAt: new Date(),
        schemaHash: "round_trip_hash",
        operations: []
      };

      const recordRes = await tracker.recordMigration(migration, {
        appliedAt: new Date(),
        durationMs: 5,
        migrationId,
        success: true
      });
      assertEquals(recordRes.ok, true, "record should succeed");

      // 2. pg_dump the entire database.
      const dump = await pgDump(dsn, pgBinDir);
      // Sanity: dump must mention disc_migrations *and* our user table.
      const dumpText = new TextDecoder().decode(dump);
      assertEquals(
        dumpText.includes("disc_migrations"),
        true,
        "dump must include the migration tracker table"
      );
      assertEquals(
        dumpText.includes(userTable),
        true,
        "dump must include the domain table"
      );

      // 3. Drop the tables and tracker, simulating a wipe-then-restore.
      await pool.close();
      await dropTables(
        dsn,
        userTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );

      // 4. Restore.
      await pgRestore(dsn, pgBinDir, dump);

      // 5. Verify the tracker row is back, exactly as written.
      const verifyClient = new Client(parseDsn(dsn));
      try {
        await verifyClient.connect();
        const result = await verifyClient.queryObject<
          { id: string; name: string; schema_hash: string; }
        >(
          `SELECT id, name, schema_hash FROM disc_migrations WHERE id = $1`,
          [migrationId]
        );
        assertEquals(
          result.rows.length,
          1,
          "tracker row must be restored — Gel #2071 regression check"
        );
        assertEquals(result.rows[0].name, "dump_test_migration");
        assertEquals(result.rows[0].schema_hash, "round_trip_hash");
      } finally {
        await verifyClient.end();
      }
    } finally {
      await dropTables(
        dsn,
        userTable,
        "disc_migrations",
        "disc_migration_checkpoints"
      );
    }
  }
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL-backed tests for the `/config` edit affordance (#5988 + #6444).
 *
 * Exercises the real write path against a live instance: `setConfigValue`
 * runs `ALTER SYSTEM SET` + `pg_reload_conf()` and the value round-trips
 * back through `getConfigValues` (the reader the GET endpoint uses). Also
 * drives `handleSetConfig` end-to-end with the live handler as its writer.
 *
 * Requires a running PostgreSQL — set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertExists } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import { handleSetConfig } from "./config-endpoint.ts";

const RUN_PG = canRunPgTests();

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0
  });
}

/** Restore a GUC to its built-in default so test runs don't accumulate. */
async function resetSetting(pool: ConnectionPool, pgName: string): Promise<void> {
  await pool.query(`ALTER SYSTEM RESET ${pgName}`);
  await pool.query("SELECT pg_reload_conf()");
}

Deno.test({
  name: "PG /config write: SIGHUP setting round-trips via ALTER SYSTEM + reload",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    const handler = new SimpleEdgeQLProtocolHandler({ connectionPool: pool });

    try {
      // work_mem is SIGHUP-class: a reload makes it live immediately.
      const result = await handler.setConfigValue("work_mem", "8MB");
      assertEquals(result.pendingRestart, false);
      assertEquals(result.value, "8MB");

      // It must also be visible through the reader the GET endpoint uses,
      // proving the change actually persisted (not just echoed back).
      const live = await handler.getConfigValues(["work_mem"]);
      assertEquals(live.get("work_mem"), "8MB");
    } finally {
      await resetSetting(pool, "work_mem");
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG /config write: aliased key (query_execution_timeout) maps to statement_timeout",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    const handler = new SimpleEdgeQLProtocolHandler({ connectionPool: pool });

    try {
      // handleSetConfig resolves the EdgeQL key -> pgName; the writer should
      // receive "statement_timeout" and the value should land there.
      const response = await handleSetConfig(
        { name: "query_execution_timeout", value: "30s" },
        {
          defaultHeaders: () => new Headers({ "Content-Type": "application/json" }),
          setValue: (pgName, value) => handler.setConfigValue(pgName, value)
        }
      );
      assertEquals(response.status, 200);
      const body = JSON.parse(await response.text());
      assertEquals(body.name, "query_execution_timeout");
      assertEquals(body.currentValue, "30s");

      const live = await handler.getConfigValues(["statement_timeout"]);
      assertEquals(live.get("statement_timeout"), "30s");
    } finally {
      await resetSetting(pool, "statement_timeout");
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG /config write: restart-class setting reports pendingRestart",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    const handler = new SimpleEdgeQLProtocolHandler({ connectionPool: pool });

    try {
      // shared_buffers is POSTMASTER-class: ALTER SYSTEM persists it but it
      // cannot take effect without a restart -> pending_restart is true and
      // the live value stays at the old setting.
      const before = (await handler.getConfigValues(["shared_buffers"]))
        .get("shared_buffers");
      const result = await handler.setConfigValue("shared_buffers", "256MB");
      assertEquals(result.pendingRestart, true);
      // Live value unchanged until restart.
      assertEquals(result.value, before);
    } finally {
      await resetSetting(pool, "shared_buffers");
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG /config write: PostgreSQL rejects an invalid value (surfaces as throw)",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    const handler = new SimpleEdgeQLProtocolHandler({ connectionPool: pool });

    try {
      let threw = false;
      try {
        await handler.setConfigValue("work_mem", "definitely-not-a-memory-value");
      } catch {
        threw = true;
      }
      assertEquals(threw, true);

      // And through the endpoint, that rejection becomes a 400.
      const response = await handleSetConfig(
        { name: "work_mem", value: "definitely-not-a-memory-value" },
        {
          defaultHeaders: () => new Headers({ "Content-Type": "application/json" }),
          setValue: (pgName, value) => handler.setConfigValue(pgName, value)
        }
      );
      assertEquals(response.status, 400);
      const body = JSON.parse(await response.text());
      assertExists(body.error);
    } finally {
      await pool.close();
    }
  }
});

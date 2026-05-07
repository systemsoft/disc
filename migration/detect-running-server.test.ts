/**
 * Pins SchemaManager.detectRunningServers() — pre-migrate preflight
 * that surfaces a stale-cache risk when a Disc server is already
 * connected to the same database (gh/geldata#9034).
 *
 * Strategy: open a second pool tagged `application_name = "disc-server"`
 * to simulate a running server, then call `detectRunningServers()`
 * from a separate, CLI-tagged manager and assert the simulated
 * server's pid surfaces.
 *
 * PG-backed: requires DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

const RUN_PG = canRunPgTests();

Deno.test({
  name: "detectRunningServers — surfaces a tagged disc-server pool",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();

    // Simulate a running server by opening a pool tagged disc-server.
    // Holding a connection ensures pg_stat_activity has a live row to
    // find.
    const serverPool = new ConnectionPool({
      connectionString: dsn,
      applicationName: "disc-server",
      minConnections: 1,
      maxConnections: 2,
    });
    await serverPool.initialize();
    const heldConn = await serverPool.acquire();

    // Open a CLI pool and run the preflight from a manager wired to it.
    const cliPool = new ConnectionPool({
      connectionString: dsn,
      applicationName: "disc-cli",
      minConnections: 1,
      maxConnections: 2,
    });
    await cliPool.initialize();

    const mgr = new SchemaManager({ pool: cliPool, dryRun: false });
    await mgr.initialize();

    try {
      const result = await mgr.detectRunningServers();
      assert(
        result.ok,
        `preflight should succeed: ${!result.ok && result.error.message}`,
      );
      // At least one disc-server-tagged connection should be reported.
      // The preflight excludes the caller's own pid via
      // `pg_backend_pid()`, so the disc-cli pool's own connection
      // doesn't count.
      assert(
        result.value.length >= 1,
        `expected at least 1 disc-server connection; got ${result.value.length}`,
      );
      assertEquals(result.value[0].applicationName, "disc-server");
    } finally {
      serverPool.release(heldConn);
      await serverPool.close();
      await cliPool.close();
    }
  },
});

Deno.test({
  name: "detectRunningServers — clean DB returns empty list",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();

    const cliPool = new ConnectionPool({
      connectionString: dsn,
      applicationName: "disc-cli",
      minConnections: 1,
      maxConnections: 2,
    });
    await cliPool.initialize();

    const mgr = new SchemaManager({ pool: cliPool, dryRun: false });
    await mgr.initialize();

    try {
      const result = await mgr.detectRunningServers();
      assert(result.ok);
      assertEquals(
        result.value.length,
        0,
        `expected no disc-server connections; got ${result.value.map((r) => `${r.pid}/${r.applicationName}`).join(", ")}`,
      );
    } finally {
      await cliPool.close();
    }
  },
});

Deno.test("detectRunningServers — dry-run manager returns empty list (no pool)", async () => {
  const mgr = new SchemaManager({ dryRun: true });
  await mgr.initialize();
  const result = await mgr.detectRunningServers();
  assert(result.ok);
  assertEquals(result.value.length, 0);
});

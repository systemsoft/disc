/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * S15: `maxConnections` holds against a live PostgreSQL under concurrent load.
 *
 * The bug: acquire() compared `connections.size` with the cap and then awaited
 * the creation that registers the connection, so every concurrent caller passed
 * the check. A pool capped at 8 opened 20 server connections for 20 queries.
 *
 * Every query reports how many backends carry this pool's `application_name`
 * while it runs, so the count is taken by the server at the moment of load.
 *
 * Requires a real PostgreSQL (see pg-test-harness); skipped otherwise.
 */

import { assertEquals } from "@std/assert";
import { canRunPgTests, getTestDsn, queryRows } from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "./connection-pool.ts";

const APPLICATION_NAME = "disc-pool-cap-test";
const CALLERS = 20;
const MAX_CONNECTIONS = 8;
const BACKENDS = "(select count(*)::int from pg_stat_activity where application_name = $1)";

Deno.test({
  name: "ConnectionPool (PG) - 20 concurrent queries on a pool capped at 8 never hold more than 8 server connections",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({
      applicationName: APPLICATION_NAME,
      cleanupInterval: 0,
      connectionString: dsn,
      maxConnections: MAX_CONNECTIONS,
      minConnections: 0
    });

    try {
      await pool.initialize();

      const results = await Promise.all(
        Array.from({ length: CALLERS }, () => pool.query(`select ${BACKENDS} as backends, pg_sleep(0.1)`, [APPLICATION_NAME]))
      );

      const seen = results.map(result => result.rows[0].backends as number);
      assertEquals(results.length, CALLERS);
      assertEquals(Math.max(...seen) <= MAX_CONNECTIONS, true, `a query saw ${Math.max(...seen)} backends: ${seen}`);

      const [after] = await queryRows<{ backends: number; }>(dsn, `select ${BACKENDS} as backends`, [APPLICATION_NAME]);
      assertEquals(after.backends <= MAX_CONNECTIONS, true, `${after.backends} backends after the burst`);

      const stats = pool.getStatistics();
      assertEquals(stats.totalCreated, MAX_CONNECTIONS);
      assertEquals(stats.totalAcquired, CALLERS);
      assertEquals(stats.totalReleased, CALLERS);
      assertEquals(stats.waitQueueSize, 0);
      assertEquals(pool.getIdleConnections(), MAX_CONNECTIONS);
    } finally {
      await pool.close();
    }
  }
});

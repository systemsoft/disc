/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Binary-protocol query arguments bind exactly like HTTP `/query` variables.
 *
 * `executeBinaryQuery` used to pass decoded arguments straight to the driver,
 * skipping `prepareParameters`: a tuple or json argument went out as a
 * PostgreSQL array literal (rejected by the jsonb cast), `bytes` was not
 * decoded, and a missing required argument was not reported.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { unwrapExactNumbers } from "../lib/exact-json.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";

Deno.test({
  name: "PG binary arguments: tuples, json and missing arguments bind like HTTP variables",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 2, minConnections: 1 });
    await pool.initialize();
    await resetTestDatabase(pool);

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema("module default { type BinParamItem { required label: str; } }");
      assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
      const handler = new EdgeQLProtocolHandler({ connectionPool: pool, schema: manager.getSchema()! });

      const value = async (query: string, args: Record<string, unknown>): Promise<unknown> => {
        const { rows } = await handler.executeBinaryQuery(query, args);
        return unwrapExactNumbers(Object.values(rows[0])[0]);
      };

      assertEquals(await value("select <tuple<int64, str>>$t", { t: [1, "a"] }), [1, "a"]);
      assertEquals(await value("select <json>$j", { j: { a: [1, 2] } }), { a: [1, 2] });
      await assertRejects(() => handler.executeBinaryQuery("select <str>$missing", {}), Error, "Missing variable");
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Regression test: DiscServer must run extension setupSql against the live
 * connection pool at startup.
 *
 * The bug: server.start() built the extension context without a pool, so the
 * `if (context.pool && ...)` gate in ExtensionRegistry.initializeAll skipped
 * every extension's setup DDL — extension-owned tables (e.g. ext-oauth's
 * disc_oauth_identities) were never created.
 *
 * The sentinel table below uses `DEFAULT disc_uuidv7()`, so its mere existence
 * proves two things at once: (1) extension setupSql ran, and (2) bootstrapStdlib
 * ran first (otherwise the CREATE TABLE would fail — the function wouldn't exist).
 *
 * Requires a real PostgreSQL (see pg-test-harness); skipped otherwise.
 */

import { assert } from "@std/assert";
import { BaseExtension } from "../extensions/base-extension.ts";
import type {
  ExtensionDatabaseSetup,
  ExtensionMetadata
} from "../extensions/types.ts";
import {
  canRunPgTests,
  dropTables,
  getTestDsn,
  queryRows,
  tableExists
} from "../tests/pg-test-harness.ts";
import { DiscServer } from "./server.ts";

const PROBE_TABLE = "disc_ext_setup_probe";

class SetupProbeExtension extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    name: "setup-probe",
    version: "1.0.0"
  };

  override getDatabaseSetup(): ExtensionDatabaseSetup {
    return {
      setupSql: [
        `CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (
           id UUID PRIMARY KEY DEFAULT disc_uuidv7(),
           note TEXT NOT NULL
         );`
      ],
      teardownSql: [`DROP TABLE IF EXISTS ${PROBE_TABLE};`]
    };
  }
}

function randomPort(): number {
  return 41000 + Math.floor(Math.random() * 2000);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate())
      return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

Deno.test({
  name: "DiscServer.start runs extension setupSql against the live pool",
  ignore: !canRunPgTests(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dsn = await getTestDsn();
    await dropTables(dsn, PROBE_TABLE);

    const server = new DiscServer({
      protocol: "full",
      databaseUrl: dsn,
      host: "127.0.0.1",
      port: randomPort(),
      enableCors: false,
      enableWebsockets: false,
      enableDataWatch: false,
      extensions: [new SetupProbeExtension()]
    });

    // start() blocks on the HTTP server, but extension init completes first.
    void server.start();

    try {
      const created = await waitFor(() => tableExists(dsn, PROBE_TABLE));
      assert(
        created,
        `${PROBE_TABLE} was not created — extension setupSql did not run`
      );

      // The disc_uuidv7() default must actually work end-to-end.
      await queryRows(
        dsn,
        `INSERT INTO ${PROBE_TABLE} (note) VALUES ('ok')`
      );
      const rows = await queryRows<{ id: string; }>(
        dsn,
        `SELECT id FROM ${PROBE_TABLE}`
      );
      assert(rows.length === 1, "expected one inserted row");
      assert(rows[0].id[14] === "7", `id is not a v7 uuid: ${rows[0].id}`);
    } finally {
      await server.stop();
      await dropTables(dsn, PROBE_TABLE);
    }
  }
});

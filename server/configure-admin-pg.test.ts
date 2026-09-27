/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: persistent configuration is for administrators only, over
 * HTTP and over the Gel binary protocol, and CONFIGURE takes only known keys.
 *
 * `configure system set <key> := …` is `ALTER SYSTEM SET` on the backing
 * PostgreSQL. Over HTTP only the service token or a user with the `admin` or
 * `superuser` role may run it (anyone else: 403, DisabledCapabilityError).
 * Over the binary protocol the admin credential is `DISC_BINARY_PASSWORD`:
 * a connection that authenticated with it may; with no password configured
 * the listener is open to everyone, so no connection may. Unknown keys and
 * dangerous PostgreSQL settings are a ConfigurationError for everyone, and
 * `configure session` stays open for the session-level keys.
 *
 * The effect of `ALTER SYSTEM` is read back from `pg_file_settings`
 * (postgresql.auto.conf), and every key a test sets is reset afterwards.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { BinaryProtocolServer, GEL_ERROR_CODES } from "../protocol/binary-server.ts";
import { Client } from "../tests/binary-protocol-client.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";
import type { QueryResponse } from "./types.ts";

const SERVICE_TOKEN = "configure-admin-pg-service-token-0123456789";
const BINARY_PASSWORD = "configure-admin-pg-binary-password";

const SDL = `module default {
  type ConfigProbe {
    name -> str;
  }
}`;

/*** The value `ALTER SYSTEM` wrote for a setting, or undefined when none is written. ***/
async function autoConfValue(pool: ConnectionPool, pgName: string): Promise<string | undefined> {
  const result = await pool.query(
    "SELECT setting FROM pg_file_settings WHERE name = $1 AND sourcefile LIKE '%postgresql.auto.conf' AND applied IS NOT NULL",
    [pgName]
  );
  return result.rows.at(-1)?.setting as string | undefined;
}

/*** The current database's own value for a setting (`ALTER DATABASE … SET`), or undefined when none is set. ***/
async function databaseValue(pool: ConnectionPool, pgName: string): Promise<string | undefined> {
  const result = await pool.query(
    "SELECT s FROM pg_db_role_setting, unnest(setconfig) AS s " +
      "WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setrole = 0"
  );
  const entry = result.rows.map(row => row.s as string).find(s => s.startsWith(`${pgName}=`));
  return entry?.slice(pgName.length + 1);
}

/*** What a new connection to the database starts with for a setting. ***/
async function freshShow(pgName: string): Promise<string> {
  const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: await getTestDsn(), maxConnections: 1, minConnections: 1 });
  await pool.initialize();
  try {
    return (await pool.query(`SHOW ${pgName}`)).rows[0][pgName] as string;
  } finally {
    await pool.close();
  }
}

/*** Remove the current database's own value for a setting. ***/
async function resetDatabaseValue(pool: ConnectionPool, pgName: string): Promise<void> {
  await pool.query(
    `DO $reset$ BEGIN EXECUTE 'ALTER DATABASE ' || quote_ident(current_database()) || ' RESET ${pgName}'; END $reset$`
  );
}

async function setUp(): Promise<{ handler: EdgeQLProtocolHandler; pool: ConnectionPool; }> {
  const dsn = await getTestDsn();
  const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 4, minConnections: 1 });
  await pool.initialize();
  await resetTestDatabase(pool);
  await pool.query("ALTER SYSTEM RESET default_statistics_target");
  await pool.query("ALTER SYSTEM RESET effective_io_concurrency");
  await resetDatabaseValue(pool, "default_statistics_target");

  const manager = new SchemaManager({ pool });
  await manager.initialize();
  const applied = await manager.applySchema(SDL);
  assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
  const schema = manager.getSchema();
  assert(schema);
  return { handler: new EdgeQLProtocolHandler({ connectionPool: pool, schema }), pool };
}

async function tearDown(pool: ConnectionPool): Promise<void> {
  await pool.query("ALTER SYSTEM RESET default_statistics_target");
  await pool.query("ALTER SYSTEM RESET effective_io_concurrency");
  await resetDatabaseValue(pool, "default_statistics_target");
  await pool.close();
}

Deno.test({
  name: "PG configure over HTTP: only an administrator configures the system, only known keys",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { handler, pool } = await setUp();
    const server = new HttpServer({
      config: {
        databaseUrl: "postgresql://unused",
        enableCors: false,
        enableWebsockets: false,
        host: "127.0.0.1",
        maxConnections: 4,
        port: 0,
        requestTimeout: 30000,
        serviceToken: SERVICE_TOKEN
      },
      protocolHandler: handler
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (server as any).handleRequest(request, info)
    );
    const query = async (text: string, token?: string): Promise<{ body: QueryResponse; status: number; }> => {
      const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
        body: JSON.stringify({ query: text }),
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        method: "POST"
      });
      return { body: await response.json(), status: response.status };
    };

    try {
      // Anonymous: refused before it reaches PostgreSQL.
      const anonymous = await query("configure system set default_statistics_target := 321");
      assertEquals(anonymous.status, 403, JSON.stringify(anonymous.body));
      assertEquals(anonymous.body.errors?.[0]?.extensions?.code, "DISABLED_CAPABILITY");
      assertEquals(await autoConfValue(pool, "default_statistics_target"), undefined);

      // The service token: applied.
      const service = await query("configure system set default_statistics_target := 321", SERVICE_TOKEN);
      assertEquals(service.status, 200, JSON.stringify(service.body));
      assertEquals(await autoConfValue(pool, "default_statistics_target"), "321");

      // The same text again (a compiled-query cache hit) is still refused to an anonymous caller.
      const again = await query("configure system reset default_statistics_target");
      assertEquals(again.status, 403);
      assertEquals(await autoConfValue(pool, "default_statistics_target"), "321");
      assertEquals((await query("configure system reset default_statistics_target", SERVICE_TOKEN)).status, 200);
      assertEquals(await autoConfValue(pool, "default_statistics_target"), undefined);

      // `configure instance` is Gel's name for `configure system`: the same setting, for an administrator only.
      assertEquals((await query("configure instance set default_statistics_target := 432")).status, 403);
      assertEquals(await autoConfValue(pool, "default_statistics_target"), undefined);
      const instance = await query("configure instance set default_statistics_target := 432", SERVICE_TOKEN);
      assertEquals(instance.status, 200, JSON.stringify(instance.body));
      assertEquals(await autoConfValue(pool, "default_statistics_target"), "432");
      assertEquals((await query("configure instance reset default_statistics_target")).status, 403);
      assertEquals((await query("configure instance reset default_statistics_target", SERVICE_TOKEN)).status, 200);
      assertEquals(await autoConfValue(pool, "default_statistics_target"), undefined);
      assertEquals((await query("configure instance set archive_command := 'x'", SERVICE_TOKEN)).status, 400);

      // `configure database` is the current database's own setting (ALTER DATABASE), for an administrator only:
      // every new connection to it starts with the value.
      const before = await freshShow("default_statistics_target");
      assertEquals((await query("configure database set default_statistics_target := 543")).status, 403);
      assertEquals(await databaseValue(pool, "default_statistics_target"), undefined);
      const database = await query("configure database set default_statistics_target := 543", SERVICE_TOKEN);
      assertEquals(database.status, 200, JSON.stringify(database.body));
      assertEquals(await databaseValue(pool, "default_statistics_target"), "543");
      assertEquals(await autoConfValue(pool, "default_statistics_target"), undefined);
      assertEquals(await freshShow("default_statistics_target"), "543");
      assertEquals((await query("configure database reset default_statistics_target")).status, 403);
      assertEquals(await databaseValue(pool, "default_statistics_target"), "543");
      const reset = await query("configure database reset default_statistics_target", SERVICE_TOKEN);
      assertEquals(reset.status, 200, JSON.stringify(reset.body));
      assertEquals(await databaseValue(pool, "default_statistics_target"), undefined);
      assertEquals(await freshShow("default_statistics_target"), before);
      const unknown = await query("configure database set archive_command := 'x'", SERVICE_TOKEN);
      assertEquals(unknown.status, 400, JSON.stringify(unknown.body));
      assertEquals(unknown.body.errors?.[0]?.extensions?.code, "CONFIGURATION_ERROR");

      // Gel's spellings of the same scope: `configure current branch` and `configure current database`.
      assertEquals((await query("configure current branch set default_statistics_target := 654")).status, 403);
      assertEquals(await databaseValue(pool, "default_statistics_target"), undefined);
      const branch = await query("configure current branch set default_statistics_target := 654", SERVICE_TOKEN);
      assertEquals(branch.status, 200, JSON.stringify(branch.body));
      assertEquals(await databaseValue(pool, "default_statistics_target"), "654");
      assertEquals(await freshShow("default_statistics_target"), "654");
      const currentDatabase = await query("configure current database set default_statistics_target := 765", SERVICE_TOKEN);
      assertEquals(currentDatabase.status, 200, JSON.stringify(currentDatabase.body));
      assertEquals(await databaseValue(pool, "default_statistics_target"), "765");
      assertEquals(await autoConfValue(pool, "default_statistics_target"), undefined);
      const branchReset = await query("configure current branch reset default_statistics_target", SERVICE_TOKEN);
      assertEquals(branchReset.status, 200, JSON.stringify(branchReset.body));
      assertEquals(await databaseValue(pool, "default_statistics_target"), undefined);
      assertEquals(await freshShow("default_statistics_target"), before);

      // A WITH block around it changes nothing.
      assertEquals((await query("with x := 1 configure system set effective_io_concurrency := 7")).status, 403);
      assertEquals(await autoConfValue(pool, "effective_io_concurrency"), undefined);

      // Unknown and dangerous keys: a ConfigurationError, even for the service.
      for (
        const text of [
          "configure system set custom_setting := 1",
          "configure system set archive_command := 'cp %p /tmp/%f'",
          "configure system set listen_addresses := '*'",
          "configure session set session_replication_role := 'replica'"
        ]
      ) {
        const reply = await query(text, SERVICE_TOKEN);
        assertEquals(reply.status, 400, text);
        assertEquals(reply.body.errors?.[0]?.extensions?.code, "CONFIGURATION_ERROR", text);
        assertStringIncludes(reply.body.errors?.[0]?.message ?? "", "unrecognized configuration parameter", text);
      }
      assertEquals(await autoConfValue(pool, "archive_command"), undefined);
      assertEquals(await autoConfValue(pool, "listen_addresses"), undefined);

      // Session configure stays open to everyone.
      const session = await query("configure session set query_execution_timeout := '30s'");
      assertEquals(session.status, 200, JSON.stringify(session.body));
    } finally {
      await listener.shutdown();
      await tearDown(pool);
    }
  }
});

Deno.test({
  name: "PG configure over the binary protocol: DISC_BINARY_PASSWORD is the admin credential",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { handler, pool } = await setUp();
    const executor = handler.executeBinaryQuery.bind(handler);
    const schema = handler.getSchema();
    const open = new BinaryProtocolServer({ executor, hostname: "127.0.0.1", port: 0, schema });
    const guarded = new BinaryProtocolServer({ executor, hostname: "127.0.0.1", password: BINARY_PASSWORD, port: 0, schema });
    open.start();
    guarded.start();
    const openConn = await Deno.connect({ hostname: "127.0.0.1", port: open.port });
    const guardedConn = await Deno.connect({ hostname: "127.0.0.1", port: guarded.port });

    try {
      // No password configured: every connection is anonymous, none may configure the system.
      const anonymous = new Client(openConn);
      await anonymous.connect();
      const refused = await anonymous.run("configure system set default_statistics_target := 222");
      assertEquals(refused?.errorCode, GEL_ERROR_CODES.DisabledCapabilityError, refused?.message);
      assertStringIncludes(refused?.message ?? "", "cannot execute configuration commands");
      assertEquals(await autoConfValue(pool, "default_statistics_target"), undefined);
      // Session configure is open.
      assertEquals(await anonymous.run("configure session set lock_timeout := '1s'"), undefined);
      // Unknown keys are a ConfigurationError.
      const unknown = await anonymous.run("configure session set custom_setting := 1");
      assertEquals(unknown?.errorCode, GEL_ERROR_CODES.ConfigurationError, unknown?.message);

      // Authenticated with the password: the connection is the admin.
      const admin = new Client(guardedConn);
      await admin.connect(BINARY_PASSWORD);
      assertEquals(await admin.run("configure system set default_statistics_target := 222"), undefined);
      assertEquals(await autoConfValue(pool, "default_statistics_target"), "222");
      assertEquals(await admin.run("configure system reset default_statistics_target"), undefined);
      assertEquals(await autoConfValue(pool, "default_statistics_target"), undefined);
      // Still only known keys.
      const dangerous = await admin.run("configure system set archive_command := 'cp %p /tmp/%f'");
      assertEquals(dangerous?.errorCode, GEL_ERROR_CODES.ConfigurationError, dangerous?.message);
    } finally {
      openConn.close();
      guardedConn.close();
      await open.stop();
      await guarded.stop();
      await tearDown(pool);
    }
  }
});

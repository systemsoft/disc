/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP, the SDK and the Gel binary protocol: an insert or
 * update violating a type-level `constraint expression on (…)` fails with
 * Gel's ConstraintViolationError — message "invalid <Type>" (or the
 * constraint's errmessage; over HTTP after the "Database query failed: "
 * every database error carries there), details "violated constraint 'std::expression'
 * on object type '<module>::<Type>'" — rather than succeeding, as it did
 * while the constraint produced no CHECK.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { BinaryProtocolServer, GEL_ERROR_CODES } from "../protocol/binary-server.ts";
import { PROTOCOL_MAJOR_VERSION, PROTOCOL_MINOR_VERSION } from "../protocol/enums.ts";
import { ConstraintViolationError, DiscClient } from "../sdk/mod.ts";
import { Client } from "../tests/binary-protocol-client.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDL = `module collab {
  type XsBug { title: str; };
  type XsPatch { title: str; };
  type XsComment {
    body: str;
    bug: XsBug;
    patch: XsPatch;
    constraint expression on ((exists .bug) != (exists .patch));
  };
  scalar type XsEVMAddress extending str { constraint regexp(r'^0x[0-9a-fA-F]{40}$'); };
  type XsWallet { address: XsEVMAddress; };
  type XsRange {
    lo: int64;
    hi: int64;
    constraint expression on (.lo < .hi) { errmessage := "lo must be below hi"; };
  };
};`;

const DETAIL = "violated constraint 'std::expression' on object type 'collab::XsComment'";

Deno.test({
  name: "PG expression constraint violations: Gel's ConstraintViolationError over HTTP, the SDK and the binary protocol",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 4, minConnections: 1 });
    await pool.initialize();
    await resetTestDatabase(pool);

    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);

    const handler = new EdgeQLProtocolHandler({ connectionPool: pool, schema });
    const http = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 4, port: 0, requestTimeout: 30000 },
      protocolHandler: handler,
      transactionPool: pool
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (http as any).handleRequest(request, info)
    );
    const baseUrl = `http://127.0.0.1:${listener.addr.port}`;
    const binary = new BinaryProtocolServer({ executor: handler.executeBinaryQuery.bind(handler), hostname: "127.0.0.1", port: 0, schema });
    binary.start();

    const post = async (query: string): Promise<{ status: number; errors?: { message: string; extensions?: Record<string, unknown>; }[]; }> => {
      const response = await fetch(`${baseUrl}/query`, { body: JSON.stringify({ query }), headers: { "Content-Type": "application/json" }, method: "POST" });
      return { status: response.status, ...(await response.json()) };
    };

    try {
      await t.step("HTTP: a comment on neither is refused with Gel's message and details", async () => {
        const reply = await post(`insert collab::XsComment { body := 'orphan' }`);
        assertEquals(reply.status, 400, JSON.stringify(reply));
        assertEquals(reply.errors?.[0].message, "Database query failed: invalid XsComment");
        assertEquals(reply.errors?.[0].extensions?.sqlState, "23514");
        assertEquals(reply.errors?.[0].extensions?.detail, DETAIL);
        assertEquals(reply.errors?.[0].extensions?.table, "xs_comment");
        assert(String(reply.errors?.[0].extensions?.constraint).startsWith("ck_xs_comment_"));
      });

      await t.step("HTTP: a comment on a bug is kept; linking it to a patch as well is refused", async () => {
        const inserted = await post(`insert collab::XsComment { body := 'on a bug', bug := (insert collab::XsBug { title := 'b' }) }`);
        assertEquals(inserted.status, 200, JSON.stringify(inserted));

        const updated = await post(`update collab::XsComment filter .body = 'on a bug' set { patch := (insert collab::XsPatch { title := 'p' }) }`);
        assertEquals(updated.errors?.[0].message, "Database query failed: invalid XsComment", JSON.stringify(updated));
      });

      await t.step("SDK: a ConstraintViolationError carrying the errmessage", async () => {
        const client = new DiscClient({ baseUrl });
        const error = await assertRejects(() => client.query(`insert collab::XsRange { lo := 5, hi := 1 }`));
        assertInstanceOf(error, ConstraintViolationError);
        assertEquals(error.message, "Database query failed: lo must be below hi");
        assertEquals(error.sqlState, "23514");
        assertEquals(error.detail, "violated constraint 'std::expression' on object type 'collab::XsRange'");
      });

      await t.step("binary protocol: ConstraintViolationError with Gel's message and details", async () => {
        const conn = await Deno.connect({ hostname: "127.0.0.1", port: binary.port });
        const client = new Client(conn);
        try {
          await client.send({
            extensions: [],
            kind: "ClientHandshake",
            majorVersion: PROTOCOL_MAJOR_VERSION,
            minorVersion: PROTOCOL_MINOR_VERSION,
            params: [{ name: "user", value: "test" }, { name: "database", value: "testdb" }]
          });
          await client.readUntilReady();
          const error = await client.run(`insert collab::XsComment { body := 'orphan' }`);
          assert(error, "the insert must fail");
          assertEquals(error.errorCode, GEL_ERROR_CODES.ConstraintViolationError);
          assertEquals(error.message, "invalid XsComment");
          const details = error.attributes.find(attribute => attribute.code === 0x0002);
          assertEquals(details && new TextDecoder().decode(details.value), DETAIL);
        } finally {
          conn.close();
        }
      });

      await t.step("binary protocol: a scalar type's constraint names the scalar, as Gel does", async () => {
        const conn = await Deno.connect({ hostname: "127.0.0.1", port: binary.port });
        const client = new Client(conn);
        try {
          await client.send({
            extensions: [],
            kind: "ClientHandshake",
            majorVersion: PROTOCOL_MAJOR_VERSION,
            minorVersion: PROTOCOL_MINOR_VERSION,
            params: [{ name: "user", value: "test" }, { name: "database", value: "testdb" }]
          });
          await client.readUntilReady();
          const error = await client.run(`insert collab::XsWallet { address := 'nope' }`);
          assert(error, "the insert must fail");
          assertEquals(error.errorCode, GEL_ERROR_CODES.ConstraintViolationError);
          assertEquals(error.message, "invalid XsEVMAddress");
          const details = error.attributes.find(attribute => attribute.code === 0x0002);
          assertEquals(details && new TextDecoder().decode(details.value), "violated constraint 'std::regexp' on scalar type 'collab::XsEVMAddress'");
          assertEquals(await client.run(`insert collab::XsWallet { address := '0x${"ab12".repeat(10)}' }`), undefined);
        } finally {
          conn.close();
        }
      });
    } finally {
      await binary.stop();
      await listener.shutdown();
      await manager.close();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

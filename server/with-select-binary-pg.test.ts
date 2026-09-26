/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over the Gel binary protocol: a `with … select …` is
 * described like the equivalent query without `with`, and a plain scalar
 * select reports its real result cardinality.
 *
 * The output descriptor for any `with` block (other than a shapeless select
 * of an aliased set literal) fell through to the `Object { id }` default, so
 * a Gel client decoded `with … select User { name }` as objects with a null
 * `id` and no `name`. Aliases now resolve to what they are bound to: the
 * shape of an aliased object set, the scalar type of an aliased scalar
 * expression. A scalar select (`select 42`, `select <str>$x`) echoed the
 * client's expected cardinality instead of its own.
 *
 * Every case runs twice with the same query text, so the second run is a
 * prepared-statement cache hit.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { BinaryProtocolServer } from "../protocol/binary-server.ts";
import { Cardinality, PROTOCOL_MAJOR_VERSION, PROTOCOL_MINOR_VERSION } from "../protocol/enums.ts";
import { Client, type Described } from "../tests/binary-protocol-client.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";

const SDL = `module default {
  type WithUser {
    email -> str;
    required name -> str;
  }
}`;

Deno.test({
  name: "PG with-select over the binary protocol: described like the query without with",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
    await pool.query(
      "INSERT INTO with_user (id, name, email) VALUES (gen_random_uuid(), 'ann', 'ann@example.com'), (gen_random_uuid(), 'bob', NULL)"
    );

    const handler = new EdgeQLProtocolHandler({ connectionPool: pool, schema });
    const server = new BinaryProtocolServer({
      executor: handler.executeBinaryQuery.bind(handler),
      hostname: "127.0.0.1",
      port: 0,
      schema
    });
    server.start();
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: server.port });
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

      const int64: Described = { kind: "scalar", type: "std::int64" };
      const str: Described = { kind: "scalar", type: "std::str" };
      const nameEmail: Described = {
        fields: [{ name: "name", type: "std::str" }, { name: "email", type: "std::str" }],
        kind: "object"
      };
      const name: Described = { fields: [{ name: "name", type: "std::str" }], kind: "object" };

      for (const round of ["cache miss", "cache hit"]) {
        // Object sets: the client's expected cardinality (MANY) is echoed,
        // as for the same query without `with`.
        assertEquals(
          await client.query("with u := (select WithUser filter .name = <str>$n) select u { name, email }", [["n", "ann"]]),
          { cardinality: Cardinality.MANY, described: nameEmail, values: [{ email: "ann@example.com", name: "ann" }] },
          round
        );
        assertEquals(
          await client.query("with n := <str>$n select WithUser { name } filter .name = n", [["n", "bob"]]),
          { cardinality: Cardinality.MANY, described: name, values: [{ name: "bob" }] },
          round
        );
        assertEquals(
          await client.query("with module default select WithUser { name } order by .name"),
          { cardinality: Cardinality.MANY, described: name, values: [{ name: "ann" }, { name: "bob" }] },
          round
        );
        assertEquals(
          await client.query(
            "with n := <str>$n, u := (select WithUser filter .name = n) select u { name, email }",
            [["n", "bob"]]
          ),
          { cardinality: Cardinality.MANY, described: nameEmail, values: [{ email: null, name: "bob" }] },
          round
        );
        assertEquals(
          await client.query("with u := (select WithUser { name }) select u order by .name"),
          { cardinality: Cardinality.MANY, described: name, values: [{ name: "ann" }, { name: "bob" }] },
          round
        );

        // Scalar expressions over aliases.
        assertEquals(
          await client.query("with x := 1 select x + 1"),
          { cardinality: Cardinality.ONE, described: int64, values: [2n] },
          round
        );
        assertEquals(
          await client.query("with a := 1, b := a + 1 select b"),
          { cardinality: Cardinality.ONE, described: int64, values: [2n] },
          round
        );
        assertEquals(
          await client.query("with x := <str>$x select x ++ '!'", [["x", "hi"]]),
          { cardinality: Cardinality.ONE, described: str, values: ["hi!"] },
          round
        );

        // Plain scalar selects report their own cardinality, not MANY.
        assertEquals(
          await client.query("select 42"),
          { cardinality: Cardinality.ONE, described: int64, values: [42n] },
          round
        );
        assertEquals(
          await client.query("select <str>$x", [["x", "y"]]),
          { cardinality: Cardinality.ONE, described: str, values: ["y"] },
          round
        );
        assertEquals(
          await client.query("select 1 + 2"),
          { cardinality: Cardinality.ONE, described: int64, values: [3n] },
          round
        );
        assertEquals(
          await client.query("select <optional str>$x", [["x", "y"]]),
          { cardinality: Cardinality.AT_MOST_ONE, described: str, values: ["y"] },
          round
        );
      }
    } finally {
      conn.close();
      await server.stop();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

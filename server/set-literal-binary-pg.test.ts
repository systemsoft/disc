/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over the Gel binary protocol: `select {…}` is described as
 * a set of its elements.
 *
 * The output descriptor for a selected set literal fell through to the
 * `Object { id }` default, so a Gel client decoded `select {1, 2, 3}` as three
 * objects with a null `id`. The descriptor now carries the element type
 * (a base scalar, or the element query's object shape) and the result
 * cardinality follows Gel's union rules.
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
  type SetLiteralNote {
    required label -> str;
  }
}`;

Deno.test({
  name: "PG set literal over the binary protocol: select {…} is described as a set of its elements",
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
    await pool.query("INSERT INTO set_literal_note (id, label) VALUES (gen_random_uuid(), 'a'), (gen_random_uuid(), 'b')");

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

      for (const round of ["cache miss", "cache hit"]) {
        assertEquals(
          await client.query("select {1, 2, 3}"),
          { cardinality: Cardinality.AT_LEAST_ONE, described: int64, values: [1n, 2n, 3n] },
          round
        );
        assertEquals(
          await client.query("select {<str>$a, <str>$b}", [["a", "x"], ["b", "y"]]),
          { cardinality: Cardinality.AT_LEAST_ONE, described: str, values: ["x", "y"] },
          round
        );
        assertEquals(
          await client.query("with xs := {1, 2} select xs"),
          { cardinality: Cardinality.AT_LEAST_ONE, described: int64, values: [1n, 2n] },
          round
        );
        assertEquals(
          await client.query("select {1, 2.5}"),
          { cardinality: Cardinality.AT_LEAST_ONE, described: { kind: "scalar", type: "std::float64" }, values: [1, 2.5] },
          round
        );
        assertEquals(
          await client.query("select {7}"),
          { cardinality: Cardinality.ONE, described: int64, values: [7n] },
          round
        );

        const empty = await client.query("select {}");
        assertEquals(empty.described.kind, "scalar", round);
        assertEquals(empty.cardinality, Cardinality.AT_MOST_ONE, round);
        assertEquals(empty.values, [], round);

        assertEquals(
          await client.query(
            "select {(select SetLiteralNote { label } filter .label = 'b'), (select SetLiteralNote { label } order by .label)}"
          ),
          {
            cardinality: Cardinality.MANY,
            described: { fields: [{ name: "label", type: "std::str" }], kind: "object" },
            values: [{ label: "b" }, { label: "a" }, { label: "b" }]
          },
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

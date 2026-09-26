/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over the Gel binary protocol: bigint and decimal values are
 * described as `std::bigint` / `std::decimal` and sent in their wire format.
 *
 * `select 10n` was described as an int64 10. A value described as bigint or
 * decimal (`select <bigint>7`) was sent as zero bytes: the binary server's
 * scalar codecs had no bigint or decimal entry, so a Gel client could not
 * decode it.
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
  type NumericThing {
    name -> str;
  }
}`;

Deno.test({
  name: "PG numeric literals over the binary protocol: bigint and decimal values round-trip",
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

      const bigint: Described = { kind: "scalar", type: "std::bigint" };
      const decimal: Described = { kind: "scalar", type: "std::decimal" };
      const int64: Described = { kind: "scalar", type: "std::int64" };
      const cases: [string, Described, unknown][] = [
        ["select 10n", bigint, 10n],
        ["select -10n", bigint, -10n],
        ["select 12345678901234567890n", bigint, 12345678901234567890n],
        ["select <bigint>7", bigint, 7n],
        ["select 10n // 4n", bigint, 2n],
        ["select 10n + 1", bigint, 11n],
        ["select 1.5n", decimal, "1.5"],
        ["select -1.50n", decimal, "-1.50"],
        ["select <decimal>-7.5", decimal, "-7.5"],
        ["select 10n / 4n", decimal, "2.5000000000000000"],
        ["select <int64>-7 + 1", int64, -6n]
      ];
      for (const [query, described, value] of cases) {
        assertEquals(await client.query(query), { cardinality: Cardinality.ONE, described, values: [value] }, query);
      }
    } finally {
      conn.close();
      await server.stop();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

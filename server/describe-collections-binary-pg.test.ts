/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over the Gel binary protocol: selected arrays and tuples —
 * literals, casts of parameters, array and tuple properties, `array_agg`,
 * `enumerate` — are described by Gel's array / tuple / named-tuple
 * descriptors and their values decoded from Gel's array and tuple wire
 * formats. Each fell back to the `Object { id }` descriptor, so a Gel
 * client decoded `select [1, 2]` as an object with a null `id`.
 *
 * Seed: one CollItem ann with tags [a, b], nums [1, 2], pair (1, 'p'),
 * named (a := 2, b := 'q'), stamps [<Stamp>7].
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { BinaryProtocolServer } from "../protocol/binary-server.ts";
import { Cardinality, PROTOCOL_MAJOR_VERSION, PROTOCOL_MINOR_VERSION } from "../protocol/enums.ts";
import { Client, type Answer, type Described } from "../tests/binary-protocol-client.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";

const SDL = `module default {
  scalar type Stamp extending int64;
  type CollItem {
    required name: str;
    tags: array<str>;
    nums: array<int64>;
    stamps: array<Stamp>;
    pair: tuple<int64, str>;
    named: tuple<a: int64, b: str>;
  }
}`;

const { AT_LEAST_ONE, MANY, ONE } = Cardinality;
const array = (type: string): Described => ({ kind: "array", type });
const tuple = (type: string): Described => ({ kind: "tuple", type });

Deno.test({
  name: "PG array and tuple descriptions and values over the binary protocol",
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
    await handler.executeBinaryQuery(
      "insert CollItem { name := 'ann', tags := ['a', 'b'], nums := [1, 2], stamps := [<Stamp>7], pair := (1, 'p'), named := (a := 2, b := 'q') }",
      {}
    );
    const server = new BinaryProtocolServer({
      executor: handler.executeBinaryQuery.bind(handler),
      hostname: "127.0.0.1",
      port: 0,
      schema
    });
    server.start();
    const query = async (text: string, args: [string, string | string[]][] = []): Promise<Answer> => {
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
        return await client.query(text, args);
      } finally {
        conn.close();
      }
    };

    try {
      // [query, args, cardinality, described, values]
      const cases: [string, [string, string | string[]][], number, Described, unknown[]][] = [
        // Literals and casts.
        ["select [1, 2]", [], ONE, array("array<std::int64>"), [[1n, 2n]]],
        ["select ['a', 'b']", [], ONE, array("array<std::str>"), [["a", "b"]]],
        ["select [1.5, 2]", [], ONE, array("array<std::float64>"), [[1.5, 2]]],
        ["select <array<int64>>[]", [], ONE, array("array<std::int64>"), [[]]],
        ["select <array<str>>$x", [["x", ["p", "q"]]], ONE, array("array<std::str>"), [["p", "q"]]],
        ["select (1, 'a')", [], ONE, tuple("tuple<std::int64, std::str>"), [[1n, "a"]]],
        ["select (a := 1, b := 'x')", [], ONE, tuple("tuple<a: std::int64, b: std::str>"), [{ a: 1n, b: "x" }]],
        ["select ([1], 'a')", [], ONE, tuple("tuple<array<std::int64>, std::str>"), [[[1n], "a"]]],
        ["select [(1, 'a')]", [], ONE, array("array<tuple<std::int64, std::str>>"), [[[1n, "a"]]]],

        // Functions.
        ["select array_agg({1, 2})", [], ONE, array("array<std::int64>"), [[1n, 2n]]],
        ["select array_agg(CollItem.name)", [], ONE, array("array<std::str>"), [["ann"]]],
        ["select enumerate({'a', 'b'})", [], AT_LEAST_ONE, tuple("tuple<std::int64, std::str>"), [[0n, "a"], [1n, "b"]]],

        // Properties, by path and in a shape.
        ["select CollItem.tags", [], MANY, array("array<std::str>"), [["a", "b"]]],
        ["select CollItem.stamps", [], MANY, array("array<std::int64>"), [[7n]]],
        ["select CollItem.pair", [], MANY, tuple("tuple<std::int64, std::str>"), [[1n, "p"]]],
        ["select CollItem.named", [], MANY, tuple("tuple<a: std::int64, b: std::str>"), [{ a: 2n, b: "q" }]],
        ["select CollItem { tags, nums, pair, named }", [], MANY, {
          fields: [
            { name: "tags", type: "array<std::str>" },
            { name: "nums", type: "array<std::int64>" },
            { name: "pair", type: "tuple<std::int64, std::str>" },
            { name: "named", type: "tuple<a: std::int64, b: std::str>" }
          ],
          kind: "object"
        }, [{ named: { a: 2n, b: "q" }, nums: [1n, 2n], pair: [1n, "p"], tags: ["a", "b"] }]]
      ];
      const failures: string[] = [];
      for (const round of ["cache miss", "cache hit"]) {
        for (const [text, args, cardinality, described, values] of cases) {
          try {
            const answer = await query(text, args);
            try {
              assertEquals(answer, { cardinality, described, values });
            } catch {
              failures.push(`${round}: ${text}: ${Deno.inspect(answer, { depth: 6 })}`);
            }
          } catch (error) {
            failures.push(`${round}: ${text}: ${(error as Error).message}`);
          }
        }
      }
      assertEquals(failures, []);
    } finally {
      await server.stop();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

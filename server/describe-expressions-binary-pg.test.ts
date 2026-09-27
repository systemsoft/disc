/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over the Gel binary protocol: results of function calls,
 * set operators, conditionals, path selects and `for` queries are described
 * by their real type and cardinality, and user-scalar properties by the type
 * they extend.
 *
 * Each of these fell back to the `Object { id }` descriptor (or described a
 * `scalar type Count extending int64` property as a uuid), so a Gel client
 * decoded `select count(User)` or `select User.posts.title` as objects with
 * a null `id`.
 *
 * Seed: users ann (visits 3, Happy), bob (Sad), cy; ann.posts = {Hello,
 * World}, bob.posts = {Zed}; ann.best = Hello; authors: Hello, World → ann,
 * Zed → bob.
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
  scalar type DescCount extending int64;
  scalar type DescMood extending enum<Happy, Sad>;
  type DescPost {
    required title: str;
    author: DescUser;
  }
  type DescUser {
    required name: str;
    visits: DescCount;
    mood: DescMood;
    best: DescPost;
    multi posts: DescPost;
  }
}`;

const ID = (n: number): string => `01234567-89ab-7cde-8f01-${n.toString().padStart(12, "0")}`;
const [ANN, BOB, CY] = [ID(1), ID(2), ID(3)];
const [HELLO, WORLD, ZED] = [ID(11), ID(12), ID(13)];

const { AT_LEAST_ONE, AT_MOST_ONE, MANY, ONE } = Cardinality;
const scalar = (type: string): Described => ({ kind: "scalar", type: `std::${type}` });
const object = (...fields: [string, string][]): Described => ({
  fields: fields.map(([name, type]) => ({ name, type: `std::${type}` })),
  kind: "object"
});
const [bigint, bool, decimal, float64, int64, str] = ["bigint", "bool", "decimal", "float64", "int64", "str"].map(scalar);

/*** The answer with its values sorted, for queries whose row order is unspecified. ***/
function sortedAnswer(answer: Answer): Answer {
  const values = answer.values.map(value => JSON.stringify(value, (_, v) => typeof v === "bigint" ? `${v}n` : v)).sort();
  return { ...answer, values: values.map(value => JSON.parse(value, (_, v) => typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)) };
}

Deno.test({
  name: "PG expression descriptions over the binary protocol: functions, set operators, paths, for, user scalars",
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
      `INSERT INTO desc_user (id, name, visits, mood) VALUES ('${ANN}', 'ann', 3, 'Happy'), ('${BOB}', 'bob', NULL, 'Sad'), ('${CY}', 'cy', NULL, NULL)`
    );
    await pool.query(
      `INSERT INTO desc_post (id, title, author_id) VALUES ('${HELLO}', 'Hello', '${ANN}'), ('${WORLD}', 'World', '${ANN}'), ('${ZED}', 'Zed', '${BOB}')`
    );
    await pool.query(`UPDATE desc_user SET best_id = '${HELLO}' WHERE name = 'ann'`);
    await pool.query(
      `INSERT INTO desc_user_posts (source_id, target_id) VALUES ('${ANN}', '${HELLO}'), ('${ANN}', '${WORLD}'), ('${BOB}', '${ZED}')`
    );

    const handler = new EdgeQLProtocolHandler({ connectionPool: pool, schema });
    const server = new BinaryProtocolServer({
      executor: handler.executeBinaryQuery.bind(handler),
      hostname: "127.0.0.1",
      port: 0,
      schema
    });
    server.start();
    // A failed query can leave messages unread, so each query gets its own
    // connection; the server's prepared-statement cache is shared.
    const query = async (text: string, args: [string, string][] = []): Promise<Answer> => {
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
      // [query, cardinality, described, values, rows in unspecified order]
      const cases: [string, number, Described, unknown[], boolean?][] = [
        // Function calls.
        ["select count(DescUser)", ONE, int64, [3n]],
        ["select count(DescUser.posts)", ONE, int64, [3n]],
        ["select sum({1, 2, 3})", ONE, int64, [6n]],
        ["select sum({1.5, 2.5})", ONE, float64, [4]],
        ["select min(DescUser.name)", AT_MOST_ONE, str, ["ann"]],
        ["select max({1, 5, 3})", AT_MOST_ONE, int64, [5n]],
        ["select len('abc')", ONE, int64, [3n]],
        ["select str_upper('abc')", ONE, str, ["ABC"]],
        ["select str_upper(<optional str>$x)", AT_MOST_ONE, str, ["Y"]],
        ["select to_str(42)", ONE, str, ["42"]],
        ["select contains('abc', 'b')", ONE, bool, [true]],
        ["select round(2.5n)", ONE, decimal, ["3"]],

        // Set operators and conditionals.
        ["select {1} union {2}", AT_LEAST_ONE, int64, [1n, 2n]],
        ["select 1 union 2.5", AT_LEAST_ONE, float64, [1, 2.5]],
        ["select (select DescUser { name } filter .name = 'ann') union (select DescUser { name } filter .name = 'bob')", MANY, object(["name", "str"]), [{
          name: "ann"
        }, { name: "bob" }], true],
        ["select 1 ?? 2", ONE, int64, [1n]],
        ["select <optional str>$x ?? 'd'", ONE, str, ["y"]],
        ["select 1 if true else 2", ONE, int64, [1n]],
        ["select distinct {1, 1, 2}", AT_LEAST_ONE, int64, [1n, 2n], true],
        ["select exists DescUser", ONE, bool, [true]],

        // Path selects.
        ["select DescUser.posts { title } order by .title", MANY, object(["title", "str"]), [{ title: "Hello" }, { title: "World" }, { title: "Zed" }]],
        ["select DescUser.posts.title", MANY, str, ["Hello", "World", "Zed"], true],
        ["select DescUser.best.title", MANY, str, ["Hello"]],
        ["select DescUser.<author[is DescPost] { title } order by .title", MANY, object(["title", "str"]), [{ title: "Hello" }, { title: "World" }, {
          title: "Zed"
        }]],
        ["select DescPost.author.name", MANY, str, ["ann", "bob"], true],

        // For queries.
        ["for u in DescUser union (select u { name })", MANY, object(["name", "str"]), [{ name: "ann" }, { name: "bob" }, { name: "cy" }], true],
        ["for x in {1, 2} union x + 1", AT_LEAST_ONE, int64, [2n, 3n], true],
        ["for u in DescUser union u.name", MANY, str, ["ann", "bob", "cy"], true],

        // User scalars and enums.
        ["select DescUser { name, visits, mood } filter .name = 'ann'", MANY, object(["name", "str"], ["visits", "int64"], ["mood", "str"]), [{
          mood: "Happy",
          name: "ann",
          visits: 3n
        }]],
        ["select DescUser.visits", MANY, int64, [3n]],

        // Mixed numeric set literals take Gel's common type.
        ["select {1, 2n}", AT_LEAST_ONE, bigint, [1n, 2n]],
        ["select {1, 2.5n}", AT_LEAST_ONE, decimal, ["1", "2.5"]],
        ["select {2n, 2.5n}", AT_LEAST_ONE, decimal, ["2", "2.5"]]
      ];
      const failures: string[] = [];
      for (const round of ["cache miss", "cache hit"]) {
        for (const [text, cardinality, described, values, unordered] of cases) {
          const expected: Answer = { cardinality, described, values };
          try {
            const answer = await query(text, text.includes("$x") ? [["x", "y"]] : []);
            const actual = unordered ? sortedAnswer(answer) : answer;
            try {
              assertEquals(actual, unordered ? sortedAnswer(expected) : expected);
            } catch {
              failures.push(`${round}: ${text}: ${Deno.inspect(actual, { depth: 5 })}`);
            }
          } catch (error) {
            failures.push(`${round}: ${text}: ${(error as Error).message}`);
          }
        }
      }
      assertEquals(failures, []);

      // Gel has no implicit cast between floats and decimals.
      const mixed = await query("select {1.5, 2.5n}").then(() => "", (error: Error) => error.message);
      assert(mixed.includes("float64") && mixed.includes("decimal"), `expected a type error, got: ${mixed}`);
    } finally {
      await server.stop();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

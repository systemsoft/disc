/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: `decimal` and `bigint` never hold NaN or ±Infinity.
 *
 * PostgreSQL's numeric has NaN and (since PG 14) ±Infinity; Gel's `decimal`
 * and `bigint` have neither (commit 5e16ace "Prohibit NaN as a std::decimal
 * value": `str_to_decimal` rejects 'NaN', a float → decimal cast rejects NaN
 * and ±Infinity, the `bigint_t` domain rejects NaN; the binary format's sign
 * is only POS or NEG). Each is an InvalidValueError — SQLSTATE 22P02 here —
 * raised by the cast that would produce it, so no such value is written and
 * no client ever has to decode one.
 *
 * `float32`/`float64` do hold NaN and ±Infinity, as in Gel. JSON has no number
 * for them, so the wire form is PostgreSQL's (`to_jsonb`), which Gel's JSON
 * output also is: the strings "NaN", "Infinity", "-Infinity" — bare, in a
 * shape and in an array alike.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDL = `module default {
  type Reading {
    required label: str;
    big: bigint;
    dec: decimal;
    decs: array<decimal>;
    f64: float64;
    f64s: array<float64>;
  }
}`;

interface Reply {
  body: { data?: unknown; errors?: { extensions?: { sqlState?: string; }; message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG non-finite numerics: decimal and bigint reject NaN and ±Infinity; floats keep them as JSON strings",
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

    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 4, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, schema })
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (server as any).handleRequest(request, info)
    );

    async function post(query: string, variables?: Record<string, unknown>): Promise<Reply> {
      const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
        body: JSON.stringify({ query, variables }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      return { body: await response.json(), status: response.status };
    }

    async function data(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      const reply = await post(query, variables);
      assertEquals(reply.status, 200, JSON.stringify(reply.body));
      return reply.body.data;
    }

    /*** Each answered row's one value. ***/
    async function scalars(query: string): Promise<unknown[]> {
      return ((await data(query)) as Record<string, unknown>[]).map(row => Object.values(row)[0]);
    }

    /*** `query` fails as Gel's InvalidValueError for `typeName` (SQLSTATE 22P02). ***/
    async function rejects(query: string, typeName: string, variables?: Record<string, unknown>): Promise<void> {
      const reply = await post(query, variables);
      const error = reply.body.errors?.[0];
      assert(error, `${query} should fail, answered ${JSON.stringify(reply.body)}`);
      assertEquals(error.extensions?.sqlState, "22P02", `${query}: ${error.message}`);
      assertMatch(error.message, new RegExp(`invalid value for ${typeName}`), query);
    }

    try {
      /*** Casts, as in Gel's test_edgeql_dt_decimal_01..04 and test_edgeql_dt_bigint_01..02. ***/
      for (const special of ["NaN", "Infinity", "-Infinity", "nan", "inf"]) {
        await rejects(`select <decimal>'${special}'`, "std::decimal");
        await rejects(`select <bigint>'${special}'`, "std::bigint");
        await rejects(`select <decimal><float64>'${special}'`, "std::decimal");
        await rejects(`select <bigint><float32>'${special}'`, "std::bigint");
      }
      await rejects("select <decimal>(<float64>'Infinity' / <float64>'Infinity')", "std::decimal");
      await rejects("select to_decimal('NaN')", "std::decimal");
      await rejects("select to_bigint('-Infinity')", "std::bigint");
      await rejects("select <decimal><json>'\"NaN\"'", "std::decimal");
      await rejects("select <array<decimal>>['1', 'NaN']", "std::decimal");

      /*** Writes from variables: nothing is stored. ***/
      await rejects("insert Reading { label := 'x', dec := <decimal>$d }", "std::decimal", { d: "NaN" });
      await rejects("insert Reading { label := 'x', big := <bigint>$b }", "std::bigint", { b: "Infinity" });
      await rejects("insert Reading { label := 'x', decs := <array<decimal>>$ds }", "std::decimal", { ds: ["1.5", "-Infinity"] });
      /*** A value that reaches the column without a cast is checked at the write. ***/
      await rejects("insert Reading { label := 'x', dec := $d }", "std::decimal", { d: "NaN" });
      await rejects("insert Reading { label := 'x', big := $b }", "std::bigint", { b: "-Infinity" });
      await rejects("insert Reading { label := 'x', decs := $ds }", "std::decimal", { ds: ["1", "NaN"] });
      await rejects("insert Reading { label := 'x', dec := <float64>'Infinity' }", "std::decimal");
      await rejects("insert Reading { label := 'x', dec := 'NaN' }", "std::decimal");
      assertEquals(await scalars("select count(Reading)"), [0]);

      await data("insert Reading { label := 'ok', big := <bigint>$b, dec := <decimal>$d, decs := <array<decimal>>$ds }", {
        b: "12",
        d: "1.5",
        ds: ["2.5"]
      });
      await rejects("update Reading filter .label = 'ok' set { dec := <decimal>$d }", "std::decimal", { d: "NaN" });
      await rejects("update Reading filter .label = 'ok' set { dec := .dec + <decimal><float64>'Infinity' }", "std::decimal");
      await rejects("update Reading filter .label = 'ok' set { big := $b }", "std::bigint", { b: "NaN" });
      await data("update Reading filter .label = 'ok' set { f64 := <float64>'NaN' }");
      await rejects("update Reading filter .label = 'ok' set { dec := .f64 }", "std::decimal");

      /*** Finite values are untouched, whatever they are cast from. ***/
      assertEquals(
        await data(
          "select Reading { big, dec, decs, from_float := <decimal><float64>'2.25', from_json := <decimal><json>'\"3.5\"', parsed := to_decimal('4.75') } filter .dec = <decimal>$d",
          { d: "1.5" }
        ),
        [{ big: 12, dec: 1.5, decs: [2.5], from_float: 2.25, from_json: 3.5, parsed: 4.75 }]
      );

      /*** Floats keep NaN and ±Infinity; JSON carries them as PostgreSQL's strings. ***/
      await data("insert Reading { label := 'f', f64 := <float64>'NaN', f64s := [<float64>'Infinity', <float64>'-Infinity', 1.5] }");
      assertEquals(await data("select Reading { f64, f64s } filter .label = 'f'"), [{ f64: "NaN", f64s: ["Infinity", "-Infinity", 1.5] }]);
      assertEquals(await scalars("select <float64>'NaN'"), ["NaN"]);
      assertEquals(await scalars("select [<float64>'-Infinity', 0.5]"), [["-Infinity", 0.5]]);
      assertEquals(await scalars("select Reading.f64 filter Reading.label = 'f'"), ["NaN"]);
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

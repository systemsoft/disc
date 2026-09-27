/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: `bigint`, `decimal` and `int64` keep every digit.
 *
 * Gel's HTTP output is the JSON PostgreSQL produces, where these are JSON
 * numbers with all their digits (docs: reference/using/http — "a decimal or a
 * bigint number can be losslessly represented in JSON"). Disc answers the
 * same: an exact JSON number, whether the value is a bare scalar (a numeric
 * or int8 column), sits in a shape (`jsonb_build_object`, parsed from jsonb
 * text) or in an array. Nothing is rounded through a double and nothing
 * becomes a string.
 *
 * Responses are read with a parser that keeps each number's source text, so a
 * JSON number is told apart from a string holding the same digits.
 *
 * Every case runs twice with the same query text, so the second run is a
 * compiled-query cache hit.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDL = `module default {
  type PreciseItem {
    required label: str;
    big: bigint;
    bigs: array<bigint>;
    dec: decimal;
    f64: float64;
    i64: int64;
  }
}`;

const BIG = "12345678901234567890";
const DEC = "0.1000000000000000055511151231257827";
/*** 2^53 + 1: the first integer a double cannot hold. ***/
const I64 = "9007199254740993";

/*** A JSON number, by its source text. ***/
interface Num {
  number: string;
}

function num(source: string): Num {
  return { number: source };
}

type ExactReviver = (key: string, value: unknown, context?: { source?: string; }) => unknown;

/*** Parse JSON keeping each number's source text as `{ number: "…" }`. ***/
function parseKeepingNumbers(text: string): unknown {
  const reviver: ExactReviver = (_key, value, context) => typeof value === "number" ? num(context?.source ?? String(value)) : value;
  return (JSON.parse as (text: string, reviver: ExactReviver) => unknown)(text, reviver);
}

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG numeric precision over HTTP: bigint, decimal and int64 are exact JSON numbers, bare and in shapes",
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
      return { body: parseKeepingNumbers(await response.text()) as Reply["body"], status: response.status };
    }

    async function data(query: string, variables?: Record<string, unknown>): Promise<unknown> {
      const reply = await post(query, variables);
      assertEquals(reply.status, 200, JSON.stringify(reply.body));
      return reply.body.data;
    }

    /*** Each answered row's one value. ***/
    async function scalars(query: string, variables?: Record<string, unknown>): Promise<unknown[]> {
      return ((await data(query, variables)) as Record<string, unknown>[]).map(row => Object.values(row)[0]);
    }

    try {
      const inserted = await data(
        "insert PreciseItem { label := 'a', big := <bigint>$big, bigs := <array<bigint>>$bigs, dec := <decimal>$dec, f64 := 0.5, i64 := <int64>$i64 }",
        { big: BIG, bigs: [BIG, "1"], dec: DEC, i64: I64 }
      ) as Record<string, unknown>;
      assertEquals(
        { big: inserted.big, bigs: inserted.bigs, dec: inserted.dec, f64: inserted.f64, i64: inserted.i64 },
        { big: num(BIG), bigs: [num(BIG), num("1")], dec: num(DEC), f64: "0.5", i64: num(I64) },
        "insert result (RETURNING row); float64 is untouched"
      );

      /*** Variables sent as JSON numbers (raw body text, since a JS number would already be rounded)
           keep every digit on the way in. ***/
      const rawScalars = async (query: string, variablesJson: string): Promise<unknown[]> => {
        const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
          body: `{"query":${JSON.stringify(query)},"variables":${variablesJson}}`,
          headers: { "Content-Type": "application/json" },
          method: "POST"
        });
        const reply = parseKeepingNumbers(await response.text()) as Reply["body"];
        assertEquals(response.status, 200, JSON.stringify(reply));
        return (reply.data as Record<string, unknown>[]).map(row => Object.values(row)[0]);
      };

      assertEquals(await rawScalars("select <bigint>$x", `{"x":${BIG}}`), [num(BIG)], "bigint variable as a JSON number");
      assertEquals(await rawScalars("select <decimal>$x", `{"x":${DEC}}`), [num(DEC)], "decimal variable as a JSON number");
      assertEquals(await rawScalars("select <int64>$x", `{"x":${I64}}`), [num(I64)], "int64 variable as a JSON number");
      assertEquals(await rawScalars("select <array<bigint>>$x", `{"x":[${BIG},1]}`), [[num(BIG), num("1")]], "array<bigint> variable");
      assertEquals(
        await rawScalars("select <json>$x", `{"x":{"n":${BIG}}}`),
        [{ n: num(BIG) }],
        "json variable keeps a big number inside it"
      );

      for (const round of ["cache miss", "cache hit"]) {
        // Bare scalars: numeric and int8 columns.
        assertEquals(await scalars(`select ${BIG}n`), [num(BIG)], round);
        assertEquals(await scalars(`select ${DEC}n`), [num(DEC)], round);
        assertEquals(await scalars("select <bigint>$x", { x: BIG }), [num(BIG)], round);
        assertEquals(await scalars("select <decimal>$x", { x: DEC }), [num(DEC)], round);
        assertEquals(await scalars("select <int64>$x", { x: I64 }), [num(I64)], round);
        assertEquals(await scalars(`select ${I64}`), [num(I64)], round);
        assertEquals(await scalars("select 7n"), [num("7")], round);
        assertEquals(await scalars("select <int64>$x", { x: 42 }), [num("42")], round);

        // Bare paths.
        assertEquals(await scalars("select PreciseItem.big"), [num(BIG)], round);
        assertEquals(await scalars("select PreciseItem.dec"), [num(DEC)], round);
        assertEquals(await scalars("select PreciseItem.i64"), [num(I64)], round);
        assertEquals(await scalars("select PreciseItem.bigs"), [[num(BIG), num("1")]], round);

        // Shapes: jsonb_build_object, parsed from jsonb text.
        assertEquals(
          await data("select PreciseItem { big, bigs, dec, f64, i64 }"),
          [{ big: num(BIG), bigs: [num(BIG), num("1")], dec: num(DEC), f64: num("0.5"), i64: num(I64) }],
          round
        );
        assertEquals(
          await data("select PreciseItem { label } filter .big = <bigint>$b and .dec = <decimal>$d", { b: BIG, d: DEC }),
          [{ label: "a" }],
          round
        );
      }
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

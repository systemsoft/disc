/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: a property of a user scalar behaves as the
 * built-in type the scalar extends (compiler/custom-scalar-properties.test.ts
 * has the compiled forms).
 *
 * A write to a `Count` (`scalar type Count extending bigint`) is checked by
 * the compiler's guard, as a write to a bigint is: a fraction or NaN fails as
 * Gel's InvalidValueError (SQLSTATE 22P02, "invalid input syntax for type
 * std::bigint" / "invalid value for std::bigint") before the column's CHECK
 * (SQLSTATE 23514) is reached. Its arithmetic follows bigint's rules
 * (`bigint / int64` is a decimal), and filters and parameters on it work,
 * through a chain of scalars and in another module alike.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDL = `module default {
  scalar type Count extending bigint;
  scalar type Tally extending Count;
  type Meter {
    required label: str;
    count: Count;
    tally: Tally;
    multi counts: Count;
  }
}
module ledger {
  scalar type Money extending decimal;
  type Account {
    required label: str;
    balance: Money;
  }
}`;

interface Reply {
  body: { data?: unknown; errors?: { extensions?: { sqlState?: string; }; message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG custom scalar properties: writes are checked, arithmetic and filters follow the base type",
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

    /*** The answered values (a select of values answers them bare). ***/
    async function scalars(query: string, variables?: Record<string, unknown>): Promise<unknown[]> {
      return (await data(query, variables)) as unknown[];
    }

    /*** `query` fails with the compiler guard's InvalidValueError (SQLSTATE 22P02), whose message includes `message`. ***/
    async function rejects(query: string, message: string, variables?: Record<string, unknown>): Promise<void> {
      const reply = await post(query, variables);
      const error = reply.body.errors?.[0];
      assert(error, `${query} should fail, answered ${JSON.stringify(reply.body)}`);
      assertEquals(error.extensions?.sqlState, "22P02", `${query}: ${error.message}`);
      assertStringIncludes(error.message, message, query);
    }

    try {
      /*** Writes to a scalar extending bigint are checked like writes to a bigint. ***/
      await rejects("insert Meter { label := 'x', count := 1.5 }", "invalid input syntax for type std::bigint: '1.5'");
      await rejects("insert Meter { label := 'x', count := 1.5n }", "invalid input syntax for type std::bigint: '1.5'");
      await rejects("insert Meter { label := 'x', count := $c }", "invalid input syntax for type std::bigint: '2.5'", { c: "2.5" });
      await rejects("insert Meter { label := 'x', count := 'NaN' }", "invalid value for std::bigint: 'NaN'");
      await rejects("insert Meter { label := 'x', count := $c }", "invalid value for std::bigint: 'Infinity'", { c: "Infinity" });
      await rejects("insert Meter { label := 'x', tally := <float64>'NaN' }", "invalid value for std::bigint: 'NaN'");
      await rejects("insert Meter { label := 'x', counts := {1, 2.5} }", "invalid input syntax for type std::bigint: '2.5'");
      /*** ... and to one extending decimal, in another module. ***/
      await rejects("insert ledger::Account { label := 'x', balance := 'NaN' }", "invalid value for std::decimal: 'NaN'");
      await rejects("insert ledger::Account { label := 'x', balance := $b }", "invalid value for std::decimal: '-Infinity'", { b: "-Infinity" });
      assertEquals(await scalars("select count(Meter)"), [0]);
      assertEquals(await scalars("select count(ledger::Account)"), [0]);

      await data("insert Meter { label := 'a', count := 7, tally := <Tally>$t, counts := {1, 2} }", { t: "9" });
      await data("insert Meter { label := 'b', count := $c }", { c: "12" });
      await data("insert ledger::Account { label := 'acct', balance := <ledger::Money>$b }", { b: "10.5" });
      await rejects("update Meter filter .label = 'a' set { count := .count + 1.5n }", "invalid input syntax for type std::bigint: '8.5'");

      /*** Arithmetic follows the base type: bigint / int64 is a decimal division. ***/
      assertEquals(
        await data("select Meter { half := .count / 2, floor := .count // 2, rest := .tally % 4 } filter .label = 'a'"),
        [{ floor: 3, half: 3.5, rest: 1 }]
      );
      assertEquals(await data("select ledger::Account { half := .balance / 2 }"), [{ half: 5.25 }]);

      /*** Filters and parameters on it. ***/
      assertEquals(await data("select Meter { label } filter .count = <Count>$c", { c: "7" }), [{ label: "a" }]);
      assertEquals(await data("select Meter { label } filter .count > <int64>$n order by .label", { n: 5 }), [{ label: "a" }, { label: "b" }]);
      assertEquals(await data("select Meter { label } filter .tally = <Tally>$t", { t: 9 }), [{ label: "a" }]);
      assertEquals(await data("select Meter { label } filter .count / 2 = 6"), [{ label: "b" }]);
      assertEquals(await data("select ledger::Account { label } filter .balance > <decimal>$b", { b: "10" }), [{ label: "acct" }]);
      assertEquals(await data("select Meter { count, tally, counts } filter .label = 'a'"), [{ count: 7, counts: [1, 2], tally: 9 }]);
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Query variables bind BY NAME (S2).
 *
 * The compiler numbers `$name` parameters in AST-walk order; the client's
 * `variables` object has whatever key order the client built it in. The
 * handler must look each parameter up by name, on a compiled-query cache hit
 * as well as on a miss, and must reject a request whose variables do not match
 * the query's parameters instead of binding the wrong values.
 *
 * No PostgreSQL: a recording pool captures the SQL and the bind values.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as Types from "./types.ts";

interface RecordedCall {
  params: unknown[];
  sql: string;
}

function makeRecordingPool(calls: RecordedCall[]): ConnectionPool {
  return {
    close: () => Promise.resolve(),
    initialize: () => Promise.resolve(),
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ params, sql });
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
  } as unknown as ConnectionPool;
}

function makeContext(): Types.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: "parameter_binding",
    session: {
      createdAt: new Date(),
      database: "test_db",
      lastActivity: new Date(),
      sessionId: "parameter_binding",
      variables: {}
    },
    startedAt: new Date()
  };
}

function makeHandler(): { calls: RecordedCall[]; handler: EdgeQLProtocolHandler; } {
  const calls: RecordedCall[] = [];
  return { calls, handler: new EdgeQLProtocolHandler({ connectionPool: makeRecordingPool(calls) }) };
}

/*** The value bound to the `$n` slot that `column` is compared with. Slots follow AST-walk order,
     so the slot number is read from the SQL rather than assumed. ***/
function boundTo(call: RecordedCall, column: string): unknown {
  const match = new RegExp(`\\.${column} = CAST\\(\\$(\\d+) AS`).exec(call.sql);
  assert(match, `no parameter compared with ${column} in: ${call.sql}`);
  return call.params[Number(match[1]) - 1];
}

const TWO_PARAMS = "select User { name } filter .name = <str>$a and .email = <str>$b";

Deno.test("parameter binding - variables bind by name whatever their key order, on a cache miss and on a cache hit", async () => {
  const { calls, handler } = makeHandler();

  // Round 1 compiles; round 2 is a compiled-query cache hit. Both send the
  // keys in the reverse of the order the parameters appear in.
  for (const round of ["cache miss", "cache hit"]) {
    const response = await handler.handleRequest({ query: TWO_PARAMS, variables: { b: "B", a: "A" } }, makeContext());
    assertEquals(response.errors, undefined, round);
    assertEquals(response.extensions?.cacheHit, round === "cache hit", round);

    const call = calls.at(-1)!;
    assertEquals(boundTo(call, "name"), "A", `${round}: .name is compared with $a`);
    assertEquals(boundTo(call, "email"), "B", `${round}: .email is compared with $b`);
    assertEquals(call.params.length, 2, round);
  }
  assertEquals(calls.length, 2);
});

Deno.test("parameter binding - a parameter used twice is bound once", async () => {
  const { calls, handler } = makeHandler();
  const response = await handler.handleRequest({
    query: "select User { name } filter .name = <str>$n or .email = <str>$n limit <int64>$l",
    variables: { l: 5, n: "N" }
  }, makeContext());

  assertEquals(response.errors, undefined);
  const call = calls.at(-1)!;
  assertEquals(boundTo(call, "name"), "N");
  assertEquals(boundTo(call, "email"), "N");
  assertEquals([...call.params].sort(), [5, "N"]);
});

Deno.test("parameter binding - numeric positional parameters keep their own index", async () => {
  const { calls, handler } = makeHandler();
  const response = await handler.handleRequest({
    query: "select User { name } filter .name = <str>$0 and .email = <str>$1",
    variables: { "1": "B", "0": "A" }
  }, makeContext());

  assertEquals(response.errors, undefined);
  assertEquals(calls.at(-1)!.params, ["A", "B"]);
});

Deno.test("parameter binding - an explicit null is a value, not a missing variable", async () => {
  const { calls, handler } = makeHandler();
  const response = await handler.handleRequest({ query: TWO_PARAMS, variables: { a: null, b: "B" } }, makeContext());

  assertEquals(response.errors, undefined);
  assertEquals(boundTo(calls.at(-1)!, "name"), null);
});

Deno.test("parameter binding - a missing variable is rejected by name, on a cache miss and on a cache hit", async () => {
  const { calls, handler } = makeHandler();

  for (const round of ["cache miss", "cache hit"]) {
    const response = await handler.handleRequest({ query: TWO_PARAMS, variables: { a: "A" } }, makeContext());
    assertEquals(response.data, undefined, round);
    assertEquals(response.errors?.length, 1, round);
    assertStringIncludes(response.errors![0].message, "$b", round);
    assertStringIncludes(response.errors![0].message.toLowerCase(), "missing", round);
    assertEquals(response.errors![0].extensions?.code, "VALIDATION_ERROR", round);
  }
  assertEquals(calls.length, 0, "nothing may reach the database");
});

Deno.test("parameter binding - no variables object at all names the first missing parameter", async () => {
  const { calls, handler } = makeHandler();
  const response = await handler.handleRequest({ query: TWO_PARAMS }, makeContext());

  assertStringIncludes(response.errors?.[0].message ?? "", "$a");
  assertEquals(calls.length, 0);
});

Deno.test("parameter binding - an extra variable is rejected by name, on a cache miss and on a cache hit", async () => {
  const { calls, handler } = makeHandler();

  for (const round of ["cache miss", "cache hit"]) {
    const response = await handler.handleRequest({ query: TWO_PARAMS, variables: { a: "A", b: "B", typo: "x" } }, makeContext());
    assertEquals(response.data, undefined, round);
    assertEquals(response.errors?.length, 1, round);
    assertStringIncludes(response.errors![0].message, "$typo", round);
    assertEquals(response.errors![0].extensions?.code, "VALIDATION_ERROR", round);
  }
  assertEquals(calls.length, 0, "nothing may reach the database");
});

Deno.test("parameter binding - a query without parameters accepts no variables and an empty object", async () => {
  const { calls, handler } = makeHandler();

  assertEquals((await handler.handleRequest({ query: "select User { name }" }, makeContext())).errors, undefined);
  assertEquals((await handler.handleRequest({ query: "select User { name }", variables: {} }, makeContext())).errors, undefined);
  assertEquals(calls.map(call => call.params), [[], []]);
});

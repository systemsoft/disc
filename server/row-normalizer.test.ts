/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Driver rows → JSON-safe rows (D13).
 *
 * deno-postgres decodes `int8` as `bigint`, which `JSON.stringify` refuses, so
 * a bare `insert`/`update` (`RETURNING *`), `select count(…)` or any other
 * unshaped int64 column turned a successful statement into an HTTP 500.
 *
 * The wire form is the one the shape path and the SDK already use for int64: a
 * JSON number while it is exact, a numeric string beyond 2^53 (which is exactly
 * what `reviveResponse` turns back into a `bigint`).
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { reviveResponse } from "../sdk/codecs.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { normalizeRows } from "./row-normalizer.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import * as Types from "./types.ts";

Deno.test("normalizeRows - an int64 that a JSON number holds exactly becomes a number", () => {
  assertEquals(normalizeRows([{ size: 42n }, { size: 0n }, { size: -7n }]), [{ size: 42 }, { size: 0 }, { size: -7 }]);
  assertEquals(normalizeRows([{ size: BigInt(Number.MAX_SAFE_INTEGER) }]), [{ size: Number.MAX_SAFE_INTEGER }]);
  assertEquals(normalizeRows([{ size: BigInt(Number.MIN_SAFE_INTEGER) }]), [{ size: Number.MIN_SAFE_INTEGER }]);
});

Deno.test("normalizeRows - an int64 above Number.MAX_SAFE_INTEGER becomes a numeric string, never a rounded number", () => {
  assertEquals(normalizeRows([{ size: 9007199254740993n }]), [{ size: "9007199254740993" }]);
  assertEquals(normalizeRows([{ size: 9007199254740992n }]), [{ size: "9007199254740992" }]);
  assertEquals(normalizeRows([{ size: -9007199254740993n }]), [{ size: "-9007199254740993" }]);
  assertEquals(normalizeRows([{ size: 9223372036854775807n }]), [{ size: "9223372036854775807" }]);
});

Deno.test("normalizeRows - the large form is the one the SDK reviver turns back into the same bigint", () => {
  const wire = JSON.parse(JSON.stringify(normalizeRows([{ big: 9007199254740993n, small: 42n }])));
  assertEquals(reviveResponse(wire), [{ big: 9007199254740993n, small: 42 }]);
});

Deno.test("normalizeRows - int8[] columns are converted element-wise", () => {
  assertEquals(normalizeRows([{ sizes: [1n, 9007199254740993n, null], nested: [[2n], [3n]] }]), [{
    nested: [[2], [3]],
    sizes: [1, "9007199254740993", null]
  }]);
});

Deno.test("normalizeRows - everything else passes through untouched", () => {
  const created = new Date("2026-09-21T00:00:00Z");
  const json = { a: [1, 2], b: { c: "d" } };
  const [row] = normalizeRows([{ active: true, created, json, missing: null, name: "x", ratio: 1.5 }]);

  assertEquals(row, { active: true, created, json, missing: null, name: "x", ratio: 1.5 });
  assertStrictEquals(row.created, created);
  assertStrictEquals(row.json, json);
  assertEquals(normalizeRows([]), []);
});

// --- Both protocol handlers, on a cache miss and on a cache hit ---

function makeContext(): Types.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: "row_normalizer",
    session: {
      createdAt: new Date(),
      database: "test_db",
      lastActivity: new Date(),
      sessionId: "row_normalizer",
      variables: {}
    },
    startedAt: new Date()
  };
}

/*** A pool whose every query returns one driver-shaped row carrying a `bigint`. ***/
function makeBigintPool(): ConnectionPool {
  return {
    close: () => Promise.resolve(),
    initialize: () => Promise.resolve(),
    query: () => Promise.resolve({ rowCount: 1, rows: [{ id: "01234567-89ab-cdef-0123-456789abcdef", name: "x", size: 42n }] })
  } as unknown as ConnectionPool;
}

const QUERIES = [
  "insert User { name := 'x', email := 'x@example.com' }",
  "update User filter .name = 'x' set { name := 'y' }",
  "select count(User)"
];

Deno.test("EdgeQLProtocolHandler - a bigint in a driver row is JSON-serializable, on a cache miss and on a cache hit", async () => {
  const handler = new EdgeQLProtocolHandler({ connectionPool: makeBigintPool() });

  for (const query of QUERIES) {
    for (const round of ["cache miss", "cache hit"]) {
      const response = await handler.handleRequest({ query }, makeContext());
      assertEquals(response.errors, undefined, `${query} (${round})`);
      assertEquals(response.extensions?.cacheHit, round === "cache hit", `${query} (${round})`);

      // This is the call `server/http-handlers.ts` makes on the response.
      const wire = JSON.parse(JSON.stringify(response)).data;
      assertEquals((Array.isArray(wire) ? wire[0] : wire).size, 42, `${query} (${round})`);
    }
  }
});

Deno.test("SimpleEdgeQLProtocolHandler - a bigint in a driver row is JSON-serializable", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({ connectionPool: makeBigintPool() });

  for (const query of QUERIES.slice(0, 2)) {
    const response = await handler.handleRequest({ query }, makeContext());
    assertEquals(response.errors, undefined, query);

    const wire = JSON.parse(JSON.stringify(response)).data;
    assertEquals((Array.isArray(wire) ? wire[0] : wire).size, 42, query);
  }
});

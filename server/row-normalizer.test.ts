/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Driver rows → JSON-safe rows (D13).
 *
 * deno-postgres decodes `int8` as `bigint`, which `JSON.stringify` refuses, so
 * a bare `insert`/`update` (`RETURNING *`), `select count(…)` or any other
 * unshaped int64 column turned a successful statement into an HTTP 500.
 *
 * The wire form is Gel's, the one a shape's `jsonb_build_object` yields: a JSON
 * number with every digit. Past 2^53 it is written raw (`JSON.rawJSON`), never
 * rounded; the SDK reads it back as a numeric string, which `reviveResponse`
 * turns into a `bigint`. `numeric` columns (`bigint`, `decimal`), which the
 * driver decodes as text, are written the same way.
 */

import { assertEquals, assertStrictEquals } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { parseBytes, parseResponseJson, reviveResponse } from "../sdk/codecs.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { normalizeRows } from "./row-normalizer.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import * as Types from "./types.ts";

Deno.test("normalizeRows - an int64 that a JSON number holds exactly becomes a number", () => {
  assertEquals(normalizeRows([{ size: 42n }, { size: 0n }, { size: -7n }]), [{ size: 42 }, { size: 0 }, { size: -7 }]);
  assertEquals(normalizeRows([{ size: BigInt(Number.MAX_SAFE_INTEGER) }]), [{ size: Number.MAX_SAFE_INTEGER }]);
  assertEquals(normalizeRows([{ size: BigInt(Number.MIN_SAFE_INTEGER) }]), [{ size: Number.MIN_SAFE_INTEGER }]);
});

Deno.test("normalizeRows - an int64 above Number.MAX_SAFE_INTEGER is written as an exact JSON number, never a rounded one", () => {
  assertEquals(JSON.stringify(normalizeRows([{ size: 9007199254740993n }])), `[{"size":9007199254740993}]`);
  assertEquals(JSON.stringify(normalizeRows([{ size: 9007199254740992n }])), `[{"size":9007199254740992}]`);
  assertEquals(JSON.stringify(normalizeRows([{ size: -9007199254740993n }])), `[{"size":-9007199254740993}]`);
  assertEquals(JSON.stringify(normalizeRows([{ size: 9223372036854775807n }])), `[{"size":9223372036854775807}]`);
});

Deno.test("normalizeRows - the large form is the one the SDK reads and revives back into the same bigint", () => {
  const wire = parseResponseJson(JSON.stringify(normalizeRows([{ big: 9007199254740993n, small: 42n }])));
  assertEquals(wire, [{ big: "9007199254740993", small: 42 }]);
  assertEquals(reviveResponse(wire), [{ big: 9007199254740993n, small: 42 }]);
});

Deno.test("normalizeRows - int8[] columns are converted element-wise", () => {
  assertEquals(
    JSON.stringify(normalizeRows([{ nested: [[2n], [3n]], sizes: [1n, 9007199254740993n, null] }])),
    `[{"nested":[[2],[3]],"sizes":[1,9007199254740993,null]}]`
  );
});

Deno.test("normalizeRows - numeric columns (bigint, decimal) are written as exact JSON numbers", () => {
  const rows = [{
    big: "12345678901234567890",
    dec: "0.1000000000000000055511151231257827",
    decs: ["1.50", null, "-7"],
    nan: "NaN",
    text: "12345678901234567890"
  }];
  const columnTypes = { big: 1700, dec: 1700, decs: 1231, nan: 1700, text: 25 };

  assertEquals(
    JSON.stringify(normalizeRows(rows, columnTypes)),
    `[{"big":12345678901234567890,"dec":0.1000000000000000055511151231257827,"decs":[1.50,null,-7],"nan":"NaN","text":"12345678901234567890"}]`
  );
});

Deno.test("normalizeRows - float columns are JSON numbers, with NaN and ±Infinity as PostgreSQL's strings", () => {
  // deno-postgres decodes float8 as text and float4 as a number.
  const rows = [{ f4: -Infinity, f4s: [NaN, 0.5], f8: "NaN", f8s: ["Infinity", "1.5"] }];
  const columnTypes = { f4: 700, f4s: 1021, f8: 701, f8s: 1022 };

  assertEquals(
    JSON.stringify(normalizeRows(rows, columnTypes)),
    `[{"f4":"-Infinity","f4s":["NaN",0.5],"f8":"NaN","f8s":["Infinity",1.5]}]`
  );
});

Deno.test("normalizeRows - without column types, text stays text", () => {
  assertEquals(normalizeRows([{ big: "12345678901234567890" }]), [{ big: "12345678901234567890" }]);
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

Deno.test("normalizeRows - bytea (Uint8Array) becomes base64 without line breaks", () => {
  const long = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
  const [row] = normalizeRows([{ content: new Uint8Array([0x1f, 0x8b, 0x00, 0xff]), empty: new Uint8Array(0), long }]);

  assertEquals(row.content, "H4sA/w==");
  assertEquals(row.empty, "");
  assertEquals(row.long, encodeBase64(long));
  assertEquals((row.long as string).includes("\n"), false);
});

Deno.test("normalizeRows - bytea[] is converted element-wise, nulls kept", () => {
  assertEquals(normalizeRows([{ chunks: [new Uint8Array([1, 2]), null, new Uint8Array(0)] }]), [{ chunks: ["AQI=", null, ""] }]);
});

Deno.test("normalizeRows - the bytes form is the one the SDK decodes back to the same bytes", () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const wire = JSON.parse(JSON.stringify(normalizeRows([{ content: bytes }])));
  assertEquals(parseBytes(wire[0].content), bytes);
});

/*** PostgreSQL type OIDs of `timestamp`, `timestamp[]`, `date` and `date[]`. ***/
const TIMESTAMP = 1114;
const TIMESTAMP_ARRAY = 1115;
const DATE = 1082;
const DATE_ARRAY = 1182;

Deno.test("normalizeRows - timestamp (cal::local_datetime) and date (cal::local_date) keep their wall-clock text, as in a shape", () => {
  // The driver decodes both as a Date in the server's local time zone, which
  // JSON.stringify would shift to UTC; they are written back as the local text.
  const columnTypes = { day: DATE, days: DATE_ARRAY, local: TIMESTAMP, locals: TIMESTAMP_ARRAY, whole: TIMESTAMP };
  const [row] = normalizeRows([{
    day: new Date(2026, 0, 15),
    days: [new Date(2026, 11, 31), null],
    local: new Date(2026, 0, 15, 10, 20, 30, 500),
    locals: [new Date(2026, 0, 15, 23, 59, 59, 123)],
    whole: new Date(2026, 0, 15, 10, 20, 30)
  }], columnTypes);

  assertEquals(row, {
    day: "2026-01-15",
    days: ["2026-12-31", null],
    local: "2026-01-15T10:20:30.5",
    locals: ["2026-01-15T23:59:59.123"],
    whole: "2026-01-15T10:20:30"
  });
  assertEquals(normalizeRows([{ day: Infinity, local: -Infinity }], columnTypes), [{ day: "infinity", local: "-infinity" }]);
});

Deno.test("normalizeRows - timestamptz (datetime) stays a Date, written as an ISO-8601 instant", () => {
  const at = new Date("2026-01-15T10:20:30Z");
  assertStrictEquals(normalizeRows([{ at }], { at: 1184 })[0].at, at);
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

/*** A pool whose every query returns one driver-shaped row carrying a `numeric` value, which the driver decodes as text. ***/
function makeNumericPool(): ConnectionPool {
  return {
    close: () => Promise.resolve(),
    initialize: () => Promise.resolve(),
    query: () =>
      Promise.resolve({
        columnTypes: { big: 1700, id: 2950 },
        rowCount: 1,
        rows: [{ big: "12345678901234567890", id: "01234567-89ab-cdef-0123-456789abcdef" }]
      })
  } as unknown as ConnectionPool;
}

Deno.test("Both protocol handlers - a numeric column in a driver row leaves as an exact JSON number", async () => {
  for (
    const handler of [new EdgeQLProtocolHandler({ connectionPool: makeNumericPool() }), new SimpleEdgeQLProtocolHandler({ connectionPool: makeNumericPool() })]
  ) {
    for (const query of QUERIES.slice(0, 2)) {
      const response = await handler.handleRequest({ query }, makeContext());
      assertEquals(response.errors, undefined, query);
      assertEquals(JSON.stringify(response.data).includes(`"big":12345678901234567890`), true, `${handler.constructor.name}: ${query}`);
    }
  }
});

/*** A pool whose every query returns one driver-shaped row carrying a `bytea` value. ***/
function makeBytesPool(): ConnectionPool {
  return {
    close: () => Promise.resolve(),
    initialize: () => Promise.resolve(),
    query: () => Promise.resolve({ rowCount: 1, rows: [{ content: new Uint8Array([0x1f, 0x8b, 0x00, 0xff]), id: "01234567-89ab-cdef-0123-456789abcdef" }] })
  } as unknown as ConnectionPool;
}

Deno.test("EdgeQLProtocolHandler - bytea in a driver row leaves as base64, on a cache miss and on a cache hit", async () => {
  const handler = new EdgeQLProtocolHandler({ connectionPool: makeBytesPool() });

  for (const query of [...QUERIES.slice(0, 2), "select <bytes>$b"]) {
    for (const round of ["cache miss", "cache hit"]) {
      const response = await handler.handleRequest({ query, variables: query.includes("$b") ? { b: "AA==" } : undefined }, makeContext());
      assertEquals(response.errors, undefined, `${query} (${round})`);
      assertEquals(response.extensions?.cacheHit, round === "cache hit", `${query} (${round})`);

      const wire = JSON.parse(JSON.stringify(response)).data;
      assertEquals((Array.isArray(wire) ? wire[0] : wire).content, "H4sA/w==", `${query} (${round})`);
    }
  }
});

Deno.test("SimpleEdgeQLProtocolHandler - bytea in a driver row leaves as base64", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({ connectionPool: makeBytesPool() });

  for (const query of QUERIES.slice(0, 2)) {
    const response = await handler.handleRequest({ query }, makeContext());
    assertEquals(response.errors, undefined, query);

    const wire = JSON.parse(JSON.stringify(response)).data;
    assertEquals((Array.isArray(wire) ? wire[0] : wire).content, "H4sA/w==", query);
  }
});

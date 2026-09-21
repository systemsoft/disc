/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `bytes` parameters on the way in (D9).
 *
 * JSON has no byte string, so a `<bytes>$p` variable arrives as base64
 * (RFC 4648). The handler decodes it to a `Uint8Array` before binding — bound
 * as the string, PostgreSQL would store the base64 text's ASCII characters and
 * report success. A string starting with `\x` is PostgreSQL's own hex input
 * and is passed through untouched. Anything else is a 400 naming the variable,
 * and nothing reaches the database.
 *
 * No PostgreSQL: a recording pool captures the bind values. Each accepted case
 * runs twice, so the second run is a compiled-query cache hit.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { configureLogging } from "../lib/logger.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as Types from "./types.ts";

interface RecordedCall {
  params: unknown[];
  sql: string;
}

function makeHandler(): { calls: RecordedCall[]; handler: EdgeQLProtocolHandler; } {
  const calls: RecordedCall[] = [];
  const connectionPool = {
    close: () => Promise.resolve(),
    initialize: () => Promise.resolve(),
    query: (sql: string, params: unknown[] = []) => {
      calls.push({ params, sql });
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
  } as unknown as ConnectionPool;
  return { calls, handler: new EdgeQLProtocolHandler({ connectionPool }) };
}

function makeContext(): Types.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: "bytes_param_binding",
    session: {
      createdAt: new Date(),
      database: "test_db",
      lastActivity: new Date(),
      sessionId: "bytes_param_binding",
      variables: {}
    },
    startedAt: new Date()
  };
}

const ONE = "select <bytes>$content";
const MANY = "select <array<bytes>>$chunks";

Deno.test("bytes parameter - base64 is decoded to the bytes it stands for, on a cache miss and on a cache hit", async () => {
  const { calls, handler } = makeHandler();

  for (const round of ["cache miss", "cache hit"]) {
    const response = await handler.handleRequest({ query: ONE, variables: { content: "H4sA/w==" } }, makeContext());
    assertEquals(response.errors, undefined, round);
    assertEquals(response.extensions?.cacheHit, round === "cache hit", round);
    assertEquals(calls.at(-1)!.params, [new Uint8Array([0x1f, 0x8b, 0x00, 0xff])], round);
  }
});

Deno.test("bytes parameter - the empty string is zero bytes; null stays null", async () => {
  const { calls, handler } = makeHandler();

  assertEquals((await handler.handleRequest({ query: ONE, variables: { content: "" } }, makeContext())).errors, undefined);
  assertEquals(calls.at(-1)!.params, [new Uint8Array(0)]);

  assertEquals((await handler.handleRequest({ query: ONE, variables: { content: null } }, makeContext())).errors, undefined);
  assertEquals(calls.at(-1)!.params, [null]);
});

Deno.test("bytes parameter - a \\x string is passed through as PostgreSQL hex input", async () => {
  const { calls, handler } = makeHandler();
  const response = await handler.handleRequest({ query: ONE, variables: { content: "\\x1f8b00ff" } }, makeContext());

  assertEquals(response.errors, undefined);
  assertEquals(calls.at(-1)!.params, ["\\x1f8b00ff"]);
});

Deno.test("bytes parameter - invalid base64 is a validation error naming the variable, and nothing is executed", async () => {
  for (const bad of ["!!!not-base64!!!", "H4sA_w==", "A"]) {
    const { calls, handler } = makeHandler();
    const response = await handler.handleRequest({ query: ONE, variables: { content: bad } }, makeContext());

    assertEquals(response.errors?.length, 1, bad);
    assertEquals(response.errors![0].extensions?.code, "VALIDATION_ERROR", bad);
    assertStringIncludes(response.errors![0].message, "$content", bad);
    assertStringIncludes(response.errors![0].message, "base64", bad);
    assertEquals(calls.length, 0, bad);
  }
});

Deno.test("bytes parameter - a value that is not a string is rejected, not stored as its JSON text", async () => {
  // What a client without the base64 replacer sends for a Uint8Array.
  for (const bad of [{ "0": 31, "1": 139 }, 42, [31, 139]]) {
    const { calls, handler } = makeHandler();
    const response = await handler.handleRequest({ query: ONE, variables: { content: bad } }, makeContext());

    assertEquals(response.errors?.[0].extensions?.code, "VALIDATION_ERROR", JSON.stringify(bad));
    assertStringIncludes(response.errors![0].message, "$content");
    assertEquals(calls.length, 0);
  }
});

Deno.test("array<bytes> parameter - every element is bound as PostgreSQL hex; hex and null elements pass through", async () => {
  const { calls, handler } = makeHandler();

  // Not Uint8Array elements: deno-postgres refuses them ("Can't encode array of buffers"). A `\x…` string
  // element is what PostgreSQL's bytea input reads, and the driver's array encoder escapes it correctly.
  for (const round of ["cache miss", "cache hit"]) {
    const response = await handler.handleRequest({ query: MANY, variables: { chunks: ["AQI=", "", "\\x03", null, "H4sA/w=="] } }, makeContext());
    assertEquals(response.errors, undefined, round);
    assertEquals(calls.at(-1)!.params, [["\\x0102", "\\x", "\\x03", null, "\\x1f8b00ff"]], round);
  }
});

Deno.test("array<bytes> parameter - a bad element or a non-array is a validation error naming the variable", async () => {
  for (const bad of [["AQI=", "!!!"], "AQI=", [["AQI="]]]) {
    const { calls, handler } = makeHandler();
    const response = await handler.handleRequest({ query: MANY, variables: { chunks: bad } }, makeContext());

    assertEquals(response.errors?.[0].extensions?.code, "VALIDATION_ERROR", JSON.stringify(bad));
    assertStringIncludes(response.errors![0].message, "$chunks");
    assertEquals(calls.length, 0);
  }
});

Deno.test("bytes parameter - other parameters of the same query are untouched", async () => {
  const { calls, handler } = makeHandler();
  const response = await handler.handleRequest({
    query: "select (<str>$name, <bytes>$content)",
    variables: { content: "AQID", name: "AQID" }
  }, makeContext());

  assertEquals(response.errors, undefined);
  const params = calls.at(-1)!.params;
  assertEquals(params.length, 2);
  assert(params.includes("AQID"), "the <str> parameter keeps its text");
  assert(params.some(value => value instanceof Uint8Array && value.length === 3), "the <bytes> parameter is decoded");
});

Deno.test("bytes parameter - a multi-megabyte value is not written to the debug log", async () => {
  const lines: string[] = [];
  configureLogging({ format: "json", level: "DEBUG", output: line => lines.push(line) });

  try {
    const { handler } = makeHandler();
    const big = "QUJD".repeat(256 * 1024); // 1 MiB of base64
    const response = await handler.handleRequest({ query: "select (<str>$name, <bytes>$content)", variables: { content: big, name: "short" } }, makeContext());

    assertEquals(response.errors, undefined);
    const logged = lines.filter(line => line.includes("Query variables"));
    assertEquals(logged.length, 1);
    assertStringIncludes(logged[0], "short");
    assert(logged[0].length < 2048, `the variables log line is ${logged[0].length} characters`);
    assert(lines.every(line => line.length < 8192), "no log line carries the payload");
  } finally {
    configureLogging({ format: "text", level: "INFO", output: undefined });
  }
});

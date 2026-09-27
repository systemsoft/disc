/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the admin UI's exact JSON numbers (`ui/src/lib/exact-json.ts`)
 * and the API client that reads `/query` results with them.
 *
 * The server sends `bigint`, `decimal` and `int64` as exact JSON numbers;
 * the UI shows and sends back every digit. Lives in `tests/` so it runs under
 * `deno test`, like the other `ui-*` tests.
 */

import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { DiscAPIClient } from "../ui/src/lib/api/client.ts";
import { ExactNumber, exactNumberValue, parseExactJson } from "../ui/src/lib/exact-json.ts";

const BIG = "12345678901234567890";
const DEC = "0.1000000000000000055511151231257827";
const I64 = "9007199254740993";

Deno.test("parseExactJson: numbers a JS number would misprint keep their source text", () => {
  const parsed = parseExactJson(`{"big":${BIG},"dec":${DEC},"i64":${I64},"bigs":[${BIG},1],"scale":1.50}`) as Record<string, unknown>;

  for (const [key, text] of [["big", BIG], ["dec", DEC], ["i64", I64], ["scale", "1.50"]]) {
    assertInstanceOf(parsed[key], ExactNumber, key);
    assertEquals(String(parsed[key]), text, key);
  }
  assertEquals((parsed.bigs as unknown[]).map(String), [BIG, "1"]);
  assertEquals((parsed.bigs as unknown[])[1], 1, "a number that prints back unchanged stays a number");
});

Deno.test("parseExactJson: plain numbers and strings are untouched", () => {
  assertEquals(parseExactJson(`{"a":42,"b":0.5,"c":-3,"d":"${BIG}"}`), { a: 42, b: 0.5, c: -3, d: BIG });
});

Deno.test("ExactNumber: JSON.stringify writes the digits back as a JSON number", () => {
  const parsed = parseExactJson(`[{"big":${BIG},"dec":${DEC},"n":7}]`);
  assertEquals(JSON.stringify(parsed), `[{"big":${BIG},"dec":${DEC},"n":7}]`);
  assertEquals(JSON.stringify(parsed, null, 2).includes(`"big": ${BIG}`), true);
});

Deno.test("ExactNumber: no own enumerable keys, so it renders as a value, not an object", () => {
  assertEquals(Object.keys(new ExactNumber(BIG)), []);
  assertEquals(`${new ExactNumber(DEC)}`, DEC);
});

Deno.test("exactNumberValue: a JS number when it holds the text exactly, else an ExactNumber", () => {
  assertEquals(exactNumberValue("42"), 42);
  assertEquals(exactNumberValue("0.5"), 0.5);
  const big = exactNumberValue(BIG);
  assertInstanceOf(big, ExactNumber);
  assertEquals(JSON.stringify({ b: big }), `{"b":${BIG}}`);
});

Deno.test("DiscAPIClient.executeQuery: reads /query results exactly and sends ExactNumber variables as JSON numbers", async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = "";

  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sentBody = String(init?.body);
    return Promise.resolve(new Response(`{"data":[{"big":${BIG},"dec":${DEC},"i64":${I64},"n":1}]}`, { status: 200 }));
  };

  try {
    const result = await new DiscAPIClient("http://disc.test").executeQuery("select <bigint>$b", { b: exactNumberValue(BIG) });
    const row = (result.data as Record<string, unknown>[])[0];

    assert(!result.error, result.error);
    assertEquals([String(row.big), String(row.dec), String(row.i64), row.n], [BIG, DEC, I64, 1]);
    assertEquals(sentBody, `{"query":"select <bigint>$b","variables":{"b":${BIG}}}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

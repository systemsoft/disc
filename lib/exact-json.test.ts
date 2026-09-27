/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assert, assertEquals } from "@std/assert";
import { isExactNumber, parseExactJson, rawJsonNumber } from "./exact-json.ts";

Deno.test("isExactNumber: a safe integer or a double that prints back to the same value", () => {
  assert(isExactNumber("42", 42));
  assert(isExactNumber("-9007199254740991", -9007199254740991));
  assert(isExactNumber("0.1", 0.1));
  assert(isExactNumber("1.50", 1.5));
  assert(isExactNumber("1e-7", 1e-7));
  assert(isExactNumber("0.0000001", 1e-7));
  assert(isExactNumber("1.0", 1));
});

Deno.test("isExactNumber: false where a double rounds the value", () => {
  assert(!isExactNumber("9007199254740993", 9007199254740993));
  assert(!isExactNumber("9007199254740992", 9007199254740992), "an integer past 2^53 − 1 is not safe");
  assert(!isExactNumber("12345678901234567890", 12345678901234567890));
  assert(!isExactNumber("0.1000000000000000055511151231257827", 0.1));
  assert(!isExactNumber("1e400", Infinity));
});

Deno.test("parseExactJson: numbers a double cannot hold are written back digit for digit", () => {
  const text = `{"big":12345678901234567890,"dec":0.1000000000000000055511151231257827,"i64":9007199254740993,` +
    `"list":[12345678901234567890,1],"nested":{"x":-0.30000000000000000000001}}`;
  assertEquals(JSON.stringify(parseExactJson(text)), text);
});

Deno.test("parseExactJson: exact numbers stay plain JS numbers", () => {
  assertEquals(parseExactJson(`{"a":1,"b":0.5,"c":[-3,1e21],"d":"12345678901234567890"}`), {
    a: 1,
    b: 0.5,
    c: [-3, 1e21],
    d: "12345678901234567890"
  });
});

Deno.test("rawJsonNumber: a JSON number is written raw; NaN and Infinity stay text", () => {
  assertEquals(JSON.stringify([rawJsonNumber("12345678901234567890"), rawJsonNumber("1.50")]), "[12345678901234567890,1.50]");
  assertEquals(rawJsonNumber("NaN"), "NaN");
  assertEquals(rawJsonNumber("-Infinity"), "-Infinity");
});

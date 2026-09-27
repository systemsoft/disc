/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Round-trip tests for protocol/scalar-codecs.ts.
 *
 * Both upstream Gel clients (Python and JS) build their per-field decoders
 * using exactly these byte layouts, so a regression here translates into
 * "Cannot decode Object" surface failures rather than a localized error.
 * Lock the layouts in.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { ValidationError } from "../lib/errors.ts";
import { parseExactJson } from "../lib/exact-json.ts";
import {
  canonicalScalarName,
  decodeScalar,
  encodeScalar,
  hasScalarCodec
} from "./scalar-codecs.ts";

Deno.test("canonicalScalarName - normalises short names", () => {
  assertEquals(canonicalScalarName("str"), "std::str");
  assertEquals(canonicalScalarName("int32"), "std::int32");
  assertEquals(canonicalScalarName("uuid"), "std::uuid");
  assertEquals(canonicalScalarName("std::str"), "std::str");
  assertEquals(canonicalScalarName("bogus"), "bogus");
});

Deno.test("hasScalarCodec - covers the gel-compat smoke types", () => {
  for (const t of ["str", "int32", "int64", "uuid", "datetime", "bool"]) {
    assertEquals(hasScalarCodec(t), true, t);
  }
  assertEquals(hasScalarCodec("nonsense"), false);
});

Deno.test("str - round-trip ascii", () => {
  const bytes = encodeScalar("str", "alpha");
  assertEquals(bytes, new TextEncoder().encode("alpha"));
  assertEquals(decodeScalar("str", bytes), "alpha");
});

Deno.test("str - round-trip utf-8", () => {
  const value = "café 🦀";
  const bytes = encodeScalar("str", value);
  assertEquals(decodeScalar("str", bytes), value);
});

Deno.test("int32 - encode is 4 bytes BE", () => {
  const bytes = encodeScalar("int32", 1) as Uint8Array;
  assertEquals(bytes.length, 4);
  assertEquals(bytes, new Uint8Array([0, 0, 0, 1]));
  assertEquals(decodeScalar("int32", bytes), 1);
});

Deno.test("int32 - negative round-trips", () => {
  const bytes = encodeScalar("int32", -2);
  assertEquals(decodeScalar("int32", bytes), -2);
});

Deno.test("int64 - 8 bytes BE round-trips", () => {
  const bytes = encodeScalar("int64", 1n << 40n) as Uint8Array;
  assertEquals(bytes.length, 8);
  assertEquals(decodeScalar("int64", bytes), 1n << 40n);
});

Deno.test("bigint - numeric wire format round-trips from a bigint or PostgreSQL's numeric text", () => {
  // 12345 is two base-10000 digit groups: 1, 2345 (ndigits 2, weight 1).
  assertEquals(encodeScalar("bigint", "12345"), new Uint8Array([0, 2, 0, 1, 0, 0, 0, 0, 0, 1, 0x09, 0x29]));
  assertEquals(encodeScalar("bigint", 12345n), encodeScalar("bigint", "12345"));
  assertEquals(decodeScalar("bigint", encodeScalar("bigint", "-12345678901234567890")), -12345678901234567890n);
  assertEquals(decodeScalar("bigint", encodeScalar("bigint", "0")), 0n);
});

Deno.test("decimal - numeric wire format round-trips with its scale", () => {
  assertEquals(decodeScalar("decimal", encodeScalar("decimal", "1.50")), "1.50");
  assertEquals(decodeScalar("decimal", encodeScalar("decimal", "-2.5000000000000000")), "-2.5000000000000000");
  assertEquals(decodeScalar("decimal", encodeScalar("decimal", "12345.6789")), "12345.6789");
});

/*** A PostgreSQL numeric with no digits and `sign`: 0xC000 is NaN, 0xD000 +Infinity, 0xF000 -Infinity. ***/
function specialNumeric(sign: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setUint16(4, sign, false);
  return bytes;
}

Deno.test("bigint and decimal - NaN and ±Infinity are not values of either, in or out", () => {
  // Gel's numeric wire format has only the POS (0x0000) and NEG (0x4000) signs.
  for (const sign of [0xC000, 0xD000, 0xF000]) {
    assertThrows(() => decodeScalar("decimal", specialNumeric(sign)), ValidationError, "std::decimal");
    assertThrows(() => decodeScalar("bigint", specialNumeric(sign)), ValidationError, "std::bigint");
  }
  for (const special of ["NaN", "Infinity", "-Infinity"]) {
    assertThrows(() => encodeScalar("decimal", special), ValidationError, "std::decimal");
    assertThrows(() => encodeScalar("bigint", special), ValidationError, "std::bigint");
  }
});

Deno.test("int64, bigint and decimal - a shape's jsonb number keeps every digit", () => {
  // A shaped row is parsed from jsonb text; a number a double cannot hold arrives as JSON.rawJSON.
  const row = parseExactJson(`{"big":12345678901234567890,"dec":0.1000000000000000055511151231257827,"i64":9007199254740993,"small":7}`) as Record<
    string,
    unknown
  >;
  assertEquals(decodeScalar("bigint", encodeScalar("bigint", row.big)), 12345678901234567890n);
  assertEquals(decodeScalar("decimal", encodeScalar("decimal", row.dec)), "0.1000000000000000055511151231257827");
  assertEquals(decodeScalar("int64", encodeScalar("int64", row.i64)), 9007199254740993n);
  assertEquals(decodeScalar("int64", encodeScalar("int64", row.small)), 7n);
  assertEquals(decodeScalar("bigint", encodeScalar("bigint", row.small)), 7n);
});

Deno.test("uuid - encode is 16 raw bytes", () => {
  const value = "12345678-1234-5678-1234-567812345678";
  const bytes = encodeScalar("uuid", value) as Uint8Array;
  assertEquals(bytes.length, 16);
  assertEquals(decodeScalar("uuid", bytes), value);
});

Deno.test("uuid - rejects non-string non-bytes input", () => {
  assertThrows(() => encodeScalar("uuid", 123));
  assertThrows(() => encodeScalar("uuid", new Uint8Array(8)));
});

Deno.test("datetime - 8 bytes BE microseconds since 2000-01-01", () => {
  const value = new Date("2024-01-01T00:00:00Z");
  const bytes = encodeScalar("datetime", value) as Uint8Array;
  assertEquals(bytes.length, 8);
  // Sanity: 24 years > 0 microseconds since epoch.
  const decoded = decodeScalar("datetime", bytes) as Date;
  assertEquals(decoded.getTime(), value.getTime());
});

Deno.test("bool - 1 byte 0/1", () => {
  assertEquals(encodeScalar("bool", true), new Uint8Array([1]));
  assertEquals(encodeScalar("bool", false), new Uint8Array([0]));
  assertEquals(decodeScalar("bool", new Uint8Array([1])), true);
  assertEquals(decodeScalar("bool", new Uint8Array([0])), false);
});

Deno.test("encodeScalar - unknown type throws", () => {
  assertThrows(() => encodeScalar("nope", 1));
  assertThrows(() => decodeScalar("nope", new Uint8Array()));
});

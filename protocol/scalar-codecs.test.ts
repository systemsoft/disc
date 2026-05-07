/**
 * Round-trip tests for protocol/scalar-codecs.ts.
 *
 * Both upstream Gel clients (Python and JS) build their per-field decoders
 * using exactly these byte layouts, so a regression here translates into
 * "Cannot decode Object" surface failures rather than a localized error.
 * Lock the layouts in.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { canonicalScalarName, decodeScalar, encodeScalar, hasScalarCodec } from "./scalar-codecs.ts";

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

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals } from "@std/assert";
import { encodeHex } from "@std/encoding";

import { hmac, hmacSha256, sha256, sha256Hex } from "./crypto.ts";

/*** sha256 ***/

Deno.test("sha256 - hashes a string (NIST 'abc' vector)", async () => {
  const digest = await sha256("abc");
  assertEquals(
    encodeHex(digest),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

Deno.test("sha256 - hashes Uint8Array input identically to string input", async () => {
  const fromString = await sha256("abc");
  const fromBytes = await sha256(new TextEncoder().encode("abc"));
  assertEquals(fromString, fromBytes);
});

Deno.test("sha256 - returns a 32-byte Uint8Array", async () => {
  const digest = await sha256("");
  assertEquals(digest instanceof Uint8Array, true);
  assertEquals(digest.length, 32);
});

/*** sha256Hex ***/

Deno.test("sha256Hex - empty input (NIST empty vector)", async () => {
  assertEquals(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

Deno.test("sha256Hex - matches encodeHex(sha256(...))", async () => {
  const data = new Uint8Array([1, 2, 3, 255]);
  assertEquals(await sha256Hex(data), encodeHex(await sha256(data)));
});

/*** hmacSha256 ***/

Deno.test("hmacSha256 - RFC 4231 test case 2 ('Jefe')", async () => {
  const sig = await hmacSha256("Jefe", "what do ya want for nothing?");
  assertEquals(
    encodeHex(sig),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
  );
});

Deno.test("hmacSha256 - accepts Uint8Array key and data", async () => {
  const encoder = new TextEncoder();
  const fromStrings = await hmacSha256("Jefe", "what do ya want for nothing?");
  const fromBytes = await hmacSha256(
    encoder.encode("Jefe"),
    encoder.encode("what do ya want for nothing?")
  );
  assertEquals(fromStrings, fromBytes);
});

/*** hmac (variable hash, used by TOTP) ***/

Deno.test("hmac - SHA-1 (RFC 2202 test case 2)", async () => {
  const sig = await hmac("SHA-1", "Jefe", "what do ya want for nothing?");
  assertEquals(encodeHex(sig), "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
});

Deno.test("hmac - SHA-512 (RFC 4231 test case 2)", async () => {
  const sig = await hmac("SHA-512", "Jefe", "what do ya want for nothing?");
  assertEquals(
    encodeHex(sig),
    "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"
  );
});

Deno.test("hmac - SHA-256 agrees with hmacSha256", async () => {
  const viaGeneric = await hmac("SHA-256", "key", "data");
  const viaSpecific = await hmacSha256("key", "data");
  assertEquals(viaGeneric, viaSpecific);
});

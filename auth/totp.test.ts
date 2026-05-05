/**
 * TOTP unit tests — covers the RFC 6238 §B test vectors plus edge cases.
 */

import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  generateSecret,
  generateTOTP,
  verifyTOTP,
} from "./totp.ts";

// ── base32 round-trip ────────────────────────────────────────────────

Deno.test("base32 round-trip preserves bytes", () => {
  const original = new Uint8Array([0, 1, 2, 0x7f, 0x80, 0xff]);
  const encoded = base32Encode(original);
  const decoded = base32Decode(encoded);
  assertEquals(decoded.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assertEquals(decoded[i], original[i]);
  }
});

Deno.test("base32Decode is case-insensitive and strips whitespace", () => {
  const encoded = base32Encode(new Uint8Array([0xff, 0xee, 0xdd]));
  const decoded = base32Decode(encoded.toLowerCase().replace(/(.{2})/g, "$1 "));
  const direct = base32Decode(encoded);
  assertEquals(decoded.length, direct.length);
});

Deno.test("base32Decode rejects invalid characters", () => {
  assertThrows(() => base32Decode("@@@"));
});

// ── RFC 6238 §B test vectors ─────────────────────────────────────────
//
// Spec uses ASCII secret "12345678901234567890" (= 20 bytes).
// Base32 of that is "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".
const RFC_SECRET_SHA1 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const RFC_VECTORS: Array<{ timestampSeconds: number; expected: string }> = [
  { timestampSeconds: 59, expected: "94287082" },
  { timestampSeconds: 1111111109, expected: "07081804" },
  { timestampSeconds: 1111111111, expected: "14050471" },
  { timestampSeconds: 1234567890, expected: "89005924" },
  { timestampSeconds: 2000000000, expected: "69279037" },
];

for (const v of RFC_VECTORS) {
  Deno.test(`RFC 6238 vector: SHA-1, t=${v.timestampSeconds}`, async () => {
    const code = await generateTOTP(RFC_SECRET_SHA1, {
      timestampMs: v.timestampSeconds * 1000,
      digits: 8,
    });
    assertEquals(code, v.expected);
  });
}

// ── verify path ──────────────────────────────────────────────────────

Deno.test("verifyTOTP — current code matches with offset 0", async () => {
  const secret = generateSecret();
  const now = Date.now();
  const code = await generateTOTP(secret, { timestampMs: now });
  const offset = await verifyTOTP(secret, code, { timestampMs: now });
  assertEquals(offset, 0);
});

Deno.test("verifyTOTP — accepts previous step (clock drift -30s)", async () => {
  const secret = generateSecret();
  const now = Date.now();
  // Generate at t-30s, verify at t — should match with offset -1
  const code = await generateTOTP(secret, { timestampMs: now - 30_000 });
  const offset = await verifyTOTP(secret, code, { timestampMs: now });
  assertEquals(offset, -1);
});

Deno.test("verifyTOTP — accepts next step (clock drift +30s)", async () => {
  const secret = generateSecret();
  const now = Date.now();
  const code = await generateTOTP(secret, { timestampMs: now + 30_000 });
  const offset = await verifyTOTP(secret, code, { timestampMs: now });
  assertEquals(offset, 1);
});

Deno.test("verifyTOTP — rejects code from far in the past", async () => {
  const secret = generateSecret();
  const now = Date.now();
  const code = await generateTOTP(secret, { timestampMs: now - 5 * 60_000 });
  const offset = await verifyTOTP(secret, code, { timestampMs: now });
  assertEquals(offset, null);
});

Deno.test("verifyTOTP — rejects malformed code", async () => {
  const secret = generateSecret();
  assertEquals(await verifyTOTP(secret, "abcdef"), null);
  assertEquals(await verifyTOTP(secret, "12345"), null); // too short
  assertEquals(await verifyTOTP(secret, "1234567"), null); // too long
});

Deno.test("verifyTOTP — strips whitespace from user input", async () => {
  const secret = generateSecret();
  const now = Date.now();
  const code = await generateTOTP(secret, { timestampMs: now });
  // Authenticator apps often display "123 456"
  const formatted = `${code.slice(0, 3)} ${code.slice(3)}`;
  const offset = await verifyTOTP(secret, formatted, { timestampMs: now });
  assertEquals(offset, 0);
});

// ── generateSecret ───────────────────────────────────────────────────

Deno.test("generateSecret — produces base32-decodable output", () => {
  const secret = generateSecret();
  const decoded = base32Decode(secret);
  assertEquals(decoded.length, 20);
});

Deno.test("generateSecret — distinct each call", () => {
  const a = generateSecret();
  const b = generateSecret();
  assert(a !== b);
});

// ── otpauth URI ──────────────────────────────────────────────────────

Deno.test("buildOtpauthUri — has issuer, account, secret, defaults to SHA1/6/30", () => {
  const uri = buildOtpauthUri({
    issuer: "Disc",
    accountName: "user@example.com",
    secret: "JBSWY3DPEHPK3PXP",
  });
  assert(uri.startsWith("otpauth://totp/Disc:user%40example.com?"));
  assert(uri.includes("secret=JBSWY3DPEHPK3PXP"));
  assert(uri.includes("issuer=Disc"));
  // Defaults are omitted (apps assume them) — keeps URIs short.
  assert(!uri.includes("digits="));
  assert(!uri.includes("period="));
  assert(!uri.includes("algorithm="));
});

Deno.test("buildOtpauthUri — URL-encodes spaces in issuer", () => {
  const uri = buildOtpauthUri({
    issuer: "My App",
    accountName: "alice",
    secret: "ABCDEFGH",
  });
  assert(uri.includes("totp/My%20App:alice"));
  assert(uri.includes("issuer=My+App") || uri.includes("issuer=My%20App"));
});

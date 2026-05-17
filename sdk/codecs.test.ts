/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import {
  assert,
  assertEquals
} from "@std/assert";
import {
  encodeBytes,
  parseBytes,
  parseDateTime,
  parseInt64,
  reviveResponse
} from "./codecs.ts";

// ── parseDateTime ────────────────────────────────────────────────────

Deno.test("parseDateTime - ISO-8601 with Z", () => {
  const d = parseDateTime("2026-05-05T12:34:56Z");
  assert(d instanceof Date);
  assertEquals(d.toISOString(), "2026-05-05T12:34:56.000Z");
});

Deno.test("parseDateTime - ISO-8601 with offset", () => {
  const d = parseDateTime("2026-05-05T12:34:56+02:00");
  assert(d instanceof Date);
  assertEquals(d.getTime(), Date.parse("2026-05-05T12:34:56+02:00"));
});

Deno.test("parseDateTime - ISO-8601 with fractional seconds", () => {
  const d = parseDateTime("2026-05-05T12:34:56.789Z");
  assert(d instanceof Date);
  assertEquals(d.toISOString(), "2026-05-05T12:34:56.789Z");
});

Deno.test("parseDateTime - rejects date-only string", () => {
  assertEquals(parseDateTime("2026-05-05"), undefined);
});

Deno.test("parseDateTime - rejects garbage", () => {
  assertEquals(parseDateTime("not a date"), undefined);
  assertEquals(parseDateTime(""), undefined);
});

// ── parseInt64 ───────────────────────────────────────────────────────

Deno.test("parseInt64 - small positive", () => {
  assertEquals(parseInt64("42"), 42n);
});

Deno.test("parseInt64 - negative", () => {
  assertEquals(parseInt64("-9999999999999999"), -9999999999999999n);
});

Deno.test("parseInt64 - beyond safe integer", () => {
  assertEquals(parseInt64("9223372036854775807"), 9223372036854775807n);
});

Deno.test("parseInt64 - rejects decimal", () => {
  assertEquals(parseInt64("1.5"), undefined);
});

Deno.test("parseInt64 - rejects garbage", () => {
  assertEquals(parseInt64("abc"), undefined);
  assertEquals(parseInt64(""), undefined);
});

// ── parseBytes / encodeBytes ─────────────────────────────────────────

Deno.test("parseBytes / encodeBytes - round-trip", () => {
  const original = new Uint8Array([0, 1, 2, 254, 255]);
  const encoded = encodeBytes(original);
  const decoded = parseBytes(encoded);
  assert(decoded);
  assertEquals(decoded.length, original.length);
  for (let i = 0; i < original.length; i++) {
    assertEquals(decoded[i], original[i]);
  }
});

Deno.test("parseBytes - rejects malformed base64", () => {
  // atob accepts a lot, but truly invalid input throws.
  assertEquals(parseBytes("!!!not-base64!!!"), undefined);
});

// ── reviveResponse ───────────────────────────────────────────────────

Deno.test("reviveResponse - revives ISO-8601 dates in a flat object", () => {
  const out = reviveResponse<{ created_at: Date; name: string; }>({
    created_at: "2026-05-05T12:34:56Z",
    name: "Alice"
  });
  assert(out.created_at instanceof Date);
  assertEquals(out.created_at.toISOString(), "2026-05-05T12:34:56.000Z");
  assertEquals(out.name, "Alice");
});

Deno.test("reviveResponse - revives bigints beyond safe range", () => {
  const out = reviveResponse<{ id: bigint; small: number; }>({
    id: "9007199254740993", // 2^53 + 1
    small: 42 // already a number, untouched
  });
  assertEquals(typeof out.id, "bigint");
  assertEquals(out.id, 9007199254740993n);
  assertEquals(out.small, 42);
});

Deno.test("reviveResponse - leaves small numeric strings alone (P1-29 conservatism)", () => {
  // "42" looks like a numeric string but is within safe range — keep
  // it as a string so callers don't get surprise type changes.
  const out = reviveResponse<{ small: string; }>({ small: "42" });
  assertEquals(out.small, "42");
});

Deno.test("reviveResponse - leaves date-only strings alone", () => {
  const out = reviveResponse<{ d: string; }>({ d: "2026-05-05" });
  assertEquals(out.d, "2026-05-05");
});

Deno.test("reviveResponse - walks arrays", () => {
  const out = reviveResponse<Array<{ created_at: Date; }>>([
    { created_at: "2026-05-05T00:00:00Z" },
    { created_at: "2026-05-06T00:00:00Z" }
  ]);
  assert(out[0].created_at instanceof Date);
  assert(out[1].created_at instanceof Date);
});

Deno.test("reviveResponse - walks nested structures", () => {
  const out = reviveResponse<{ user: { posts: Array<{ at: Date; }>; }; }>({
    user: {
      posts: [{ at: "2026-05-05T12:00:00Z" }]
    }
  });
  assert(out.user.posts[0].at instanceof Date);
});

Deno.test("reviveResponse - dates: false disables date revival", () => {
  const out = reviveResponse<{ at: string; }>(
    { at: "2026-05-05T12:00:00Z" },
    { dates: false }
  );
  assertEquals(typeof out.at, "string");
});

Deno.test("reviveResponse - bigints: false disables bigint revival", () => {
  const out = reviveResponse<{ id: string; }>(
    { id: "9007199254740993" },
    { bigints: false }
  );
  assertEquals(typeof out.id, "string");
});

Deno.test("reviveResponse - handles null and undefined", () => {
  assertEquals(reviveResponse(null), null);
  assertEquals(reviveResponse(undefined), undefined);
});

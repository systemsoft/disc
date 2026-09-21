/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import {
  assert,
  assertEquals
} from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { Buffer } from "node:buffer";
import {
  encodeBytes,
  jsonReplacer,
  parseBytes,
  parseDateTime,
  parseInt64,
  reviveResponse,
  reviveTyped
} from "./codecs.ts";
import type { TypeInfo } from "./filter-compiler.ts";

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

Deno.test("parseBytes - accepts PostgreSQL hex (\\x…), the pre-base64 wire form", () => {
  assertEquals(parseBytes("\\x1f8b00ff"), new Uint8Array([0x1f, 0x8b, 0x00, 0xff]));
  assertEquals(parseBytes("\\x1F8B"), new Uint8Array([0x1f, 0x8b]));
  assertEquals(parseBytes("\\x"), new Uint8Array(0));
});

Deno.test("parseBytes - rejects malformed hex", () => {
  assertEquals(parseBytes("\\x1f8"), undefined);
  assertEquals(parseBytes("\\xzz"), undefined);
});

Deno.test("parseBytes - empty string is zero bytes", () => {
  assertEquals(parseBytes(""), new Uint8Array(0));
});

Deno.test("encodeBytes - 8 MiB encodes in chunks and matches the reference encoder", () => {
  const big = new Uint8Array(8 * 1024 * 1024);
  for (let i = 0; i < big.length; i++) {
    big[i] = (i * 31 + (i >> 8)) & 0xff;
  }
  const started = performance.now();
  const encoded = encodeBytes(big);
  const elapsed = performance.now() - started;
  assertEquals(encoded.length, Math.ceil(big.length / 3) * 4);
  assert(encoded === encodeBase64(big), "chunked output must equal one-shot base64 (no padding inside the string)");
  assert(elapsed < 5000, `8 MiB took ${elapsed} ms`);
});

Deno.test("encodeBytes - lengths around the chunk boundary carry no inner padding", () => {
  for (const length of [0, 1, 2, 3, 32765, 32766, 32767, 65532, 65533]) {
    const bytes = Uint8Array.from({ length }, (_, i) => i & 0xff);
    assertEquals(encodeBytes(bytes), encodeBase64(bytes), `length ${length}`);
  }
});

// ── jsonReplacer ─────────────────────────────────────────────────────

Deno.test("jsonReplacer - Uint8Array at the top level of the variables", () => {
  const body = JSON.stringify({ content: new Uint8Array([0x1f, 0x8b, 0x00, 0xff]) }, jsonReplacer);
  assertEquals(body, "{\"content\":\"H4sA/w==\"}");
});

Deno.test("jsonReplacer - nested Uint8Array and arrays of them", () => {
  const body = JSON.stringify({
    rows: [{ content: new Uint8Array([1]) }, { content: new Uint8Array(0) }],
    chunks: [new Uint8Array([1, 2]), new Uint8Array([3])]
  }, jsonReplacer);
  assertEquals(JSON.parse(body), { chunks: ["AQI=", "Aw=="], rows: [{ content: "AQ==" }, { content: "" }] });
});

Deno.test("jsonReplacer - a Node Buffer (whose toJSON runs first) is encoded like any Uint8Array", () => {
  const body = JSON.stringify({ content: Buffer.from([0x1f, 0x8b, 0x00, 0xff]), list: [Buffer.from([1])] }, jsonReplacer);
  assertEquals(JSON.parse(body), { content: "H4sA/w==", list: ["AQ=="] });
});

Deno.test("jsonReplacer - a plain object that merely looks like Buffer.toJSON() is left alone", () => {
  const lookalike = { data: [1, 2], type: "Buffer" };
  assertEquals(JSON.parse(JSON.stringify({ v: lookalike }, jsonReplacer)), { v: lookalike });
});

Deno.test("jsonReplacer - bigint still goes out as a numeric string", () => {
  assertEquals(JSON.stringify({ n: 9007199254740993n }, jsonReplacer), "{\"n\":\"9007199254740993\"}");
});

// ── reviveTyped ──────────────────────────────────────────────────────

const PROGRAM_INFO: TypeInfo = { casts: { name: "<str>" }, links: {} };
const OBJECT_INFO: TypeInfo = {
  casts: { chunks: "<array<bytes>>", content: "<bytes>", object_id: "<str>", size: "<int64>" },
  links: { parent: () => OBJECT_INFO, program: () => PROGRAM_INFO }
};

/*** A wire value, typed as the builders see it: not yet known to hold strings where the result holds bytes. ***/
function wire(value: unknown): unknown {
  return value;
}

Deno.test("reviveTyped - <bytes> fields become Uint8Array, everything else is untouched", () => {
  const out = reviveTyped(wire([{ content: "H4sA/w==", object_id: "AQID", size: 4 }]), OBJECT_INFO) as Array<Record<string, unknown>>;
  assertEquals(out[0].content, new Uint8Array([0x1f, 0x8b, 0x00, 0xff]));
  assertEquals(out[0].object_id, "AQID");
  assertEquals(out[0].size, 4);
});

Deno.test("reviveTyped - a single object, null bytes, an absent field", () => {
  assertEquals(reviveTyped({ content: null, object_id: "x" }, OBJECT_INFO), { content: null, object_id: "x" });
  assertEquals(reviveTyped({ object_id: "x" }, OBJECT_INFO), { object_id: "x" });
  assertEquals(reviveTyped(null, OBJECT_INFO), null);
});

Deno.test("reviveTyped - <array<bytes>> is revived element-wise", () => {
  const out = reviveTyped(wire({ chunks: ["AQI=", null, ""] }), OBJECT_INFO) as { chunks: unknown[]; };
  assertEquals(out.chunks, [new Uint8Array([1, 2]), null, new Uint8Array(0)]);
});

Deno.test("reviveTyped - recurses through links, as a one-element array or a plain object", () => {
  const wrapped = reviveTyped(wire({ parent: [{ content: "AQ==", parent: [{ content: "Ag==" }] }] }), OBJECT_INFO) as {
    parent: Array<{ content: Uint8Array; parent: Array<{ content: Uint8Array; }>; }>;
  };
  assertEquals(wrapped.parent[0].content, new Uint8Array([1]));
  assertEquals(wrapped.parent[0].parent[0].content, new Uint8Array([2]));

  const plain = reviveTyped(wire({ parent: { content: "AQ==" }, program: { name: "AQ==" } }), OBJECT_INFO) as {
    parent: { content: Uint8Array; };
    program: { name: string; };
  };
  assertEquals(plain.parent.content, new Uint8Array([1]));
  assertEquals(plain.program.name, "AQ==");
});

Deno.test("reviveTyped - accepts the hex form an older server sends", () => {
  assertEquals(reviveTyped(wire({ content: "\\x0102" }), OBJECT_INFO), { content: new Uint8Array([1, 2]) });
});

Deno.test("reviveTyped - does not mutate its input", () => {
  const input = { content: "AQ==" };
  reviveTyped(input, OBJECT_INFO);
  assertEquals(input.content, "AQ==");
});

// ── reviveResponse ───────────────────────────────────────────────────

Deno.test("reviveResponse - bytes paths revive base64 at those paths only", () => {
  const out = reviveResponse<Array<{ content: Uint8Array; object_id: string; }>>(
    [{ content: "H4sA/w==", object_id: "H4sA/w==" }],
    { bytes: ["content"] }
  );
  assertEquals(out[0].content, new Uint8Array([0x1f, 0x8b, 0x00, 0xff]));
  assertEquals(out[0].object_id, "H4sA/w==");
});

Deno.test("reviveResponse - bytes dot paths cross nested objects and arrays", () => {
  const out = reviveResponse<{ obj: Array<{ chunks: Uint8Array[]; content: Uint8Array; }>; }>(
    { obj: [{ chunks: ["AQ==", "Ag=="], content: "Aw==" }] },
    { bytes: ["obj.content", "obj.chunks"] }
  );
  assertEquals(out.obj[0].content, new Uint8Array([3]));
  assertEquals(out.obj[0].chunks, [new Uint8Array([1]), new Uint8Array([2])]);
});

Deno.test("reviveResponse - a bytes path wins over date/bigint revival of the same string", () => {
  // Valid base64 that is also a numeric string beyond 2^53.
  const out = reviveResponse<{ content: Uint8Array; n: bigint; }>(
    { content: "12345678901234567890", n: "12345678901234567890" },
    { bytes: ["content"] }
  );
  assert(out.content instanceof Uint8Array);
  assertEquals(out.n, 12345678901234567890n);
});

Deno.test("reviveResponse - without bytes paths base64 stays a string", () => {
  assertEquals(reviveResponse({ content: "H4sA/w==" }), { content: "H4sA/w==" });
});

Deno.test("reviveResponse - an already revived Uint8Array passes through intact", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const out = reviveResponse<{ content: Uint8Array; }>({ content: bytes });
  assert(out.content instanceof Uint8Array);
  assertEquals(out.content, bytes);
});

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

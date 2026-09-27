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
  parseResponseJson,
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

// ── parseResponseJson ────────────────────────────────────────────────

Deno.test("parseResponseJson - a number a double cannot hold keeps its digits as a string", () => {
  assertEquals(
    parseResponseJson(
      `{"data":[{"big":12345678901234567890,"dec":0.1000000000000000055511151231257827,"i64":9007199254740993,"list":[-12345678901234567890]}]}`
    ),
    { data: [{ big: "12345678901234567890", dec: "0.1000000000000000055511151231257827", i64: "9007199254740993", list: ["-12345678901234567890"] }] }
  );
});

Deno.test("parseResponseJson - exact numbers stay numbers", () => {
  assertEquals(parseResponseJson(`{"a":1,"b":0.5,"c":1.50,"d":-9007199254740991,"e":1e-7,"f":"x"}`), {
    a: 1,
    b: 0.5,
    c: 1.5,
    d: -9007199254740991,
    e: 1e-7,
    f: "x"
  });
});

Deno.test("parseResponseJson - a large integer revives to the same bigint", () => {
  assertEquals(reviveResponse(parseResponseJson(`[{"big":12345678901234567890,"small":42}]`)), [{ big: 12345678901234567890n, small: 42 }]);
});

// ── reviveTyped ──────────────────────────────────────────────────────

const PROGRAM_INFO: TypeInfo = { casts: { name: "<str>" }, links: {} };
const OBJECT_INFO: TypeInfo = {
  casts: { chunks: "<array<bytes>>", content: "<bytes>", object_id: "<str>", size: "<int32>" },
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

const PRECISE_INFO: TypeInfo = {
  casts: { big: "<bigint>", bigs: "<array<bigint>>", dec: "<decimal>", decs: "<array<decimal>>", size: "<int64>", sizes: "<array<int64>>" },
  links: {}
};

Deno.test("reviveTyped - <bigint> fields become bigint, from a number or a numeric string", () => {
  assertEquals(reviveTyped(wire({ big: 7 }), PRECISE_INFO), { big: 7n });
  assertEquals(reviveTyped(wire({ big: "12345678901234567890" }), PRECISE_INFO), { big: 12345678901234567890n });
  assertEquals(reviveTyped(wire({ big: null }), PRECISE_INFO), { big: null });
  assertEquals(reviveTyped(wire({ bigs: ["12345678901234567890", 1, null] }), PRECISE_INFO), { bigs: [12345678901234567890n, 1n, null] });
});

Deno.test("reviveTyped - <decimal> fields become strings with every digit", () => {
  assertEquals(reviveTyped(wire({ dec: 0.5 }), PRECISE_INFO), { dec: "0.5" });
  assertEquals(reviveTyped(wire({ dec: "0.1000000000000000055511151231257827" }), PRECISE_INFO), { dec: "0.1000000000000000055511151231257827" });
  assertEquals(reviveTyped(wire({ decs: [1.25, "-7", null] }), PRECISE_INFO), { decs: ["1.25", "-7", null] });
});

Deno.test("reviveTyped - <int64> fields become bigint, as codegen declares them", () => {
  assertEquals(reviveTyped(wire({ size: 4 }), PRECISE_INFO), { size: 4n });
  assertEquals(reviveTyped(wire({ size: "9007199254740993" }), PRECISE_INFO), { size: 9007199254740993n });
  assertEquals(reviveTyped(wire({ size: null }), PRECISE_INFO), { size: null });
  // A multi property or an array: element-wise.
  assertEquals(reviveTyped(wire({ sizes: [1, "9007199254740993", null] }), PRECISE_INFO), { sizes: [1n, 9007199254740993n, null] });
  assertEquals(reviveTyped(wire({ size: [2, 3] }), PRECISE_INFO), { size: [2n, 3n] });
});

Deno.test("reviveTyped - int64 fields of linked objects and link properties become bigint", () => {
  const tag: TypeInfo = { casts: { name: "<str>", rank: "<int64>" }, links: {} };
  const item: TypeInfo = {
    casts: { label: "<str>" },
    linkProperties: { tags: { note: "<str>", weight: "<int64>" } },
    links: { tag: () => tag, tags: () => tag }
  };
  assertEquals(
    reviveTyped(
      wire([{ label: "a", tag: [{ rank: 1 }], tags: [{ "@note": "7", "@weight": 5, rank: "9007199254740993" }, { "@weight": null, rank: 2 }] }]),
      item
    ),
    [{ label: "a", tag: [{ rank: 1n }], tags: [{ "@note": "7", "@weight": 5n, rank: 9007199254740993n }, { "@weight": null, rank: 2n }] }]
  );
  // A link property is read only on the link that declares it.
  assertEquals(reviveTyped(wire({ tag: [{ "@weight": 5 }] }), item), { tag: [{ "@weight": 5 }] });
});

const TEMPORAL_INFO: TypeInfo = {
  casts: {
    at: "<datetime>",
    ats: "<array<datetime>>",
    day: "<cal::local_date>",
    local: "<cal::local_datetime>",
    marks: "<datetime>",
    span: "<duration>",
    time: "<cal::local_time>"
  },
  linkProperties: { next: { since: "<datetime>" } },
  links: { next: () => TEMPORAL_INFO },
  multi: ["marks"]
};

Deno.test("reviveTyped - <datetime> fields become Date, in arrays, multi properties, links and link properties", () => {
  const out = reviveTyped(
    wire([{
      at: "2026-01-15T10:20:30.123456+00:00",
      ats: ["2026-01-15T10:20:30+00:00", null],
      marks: ["2026-01-15T10:20:30.000Z"],
      next: [{ "@since": "2026-02-01T00:00:00+00:00", at: "2026-03-01T00:00:00+05:30" }]
    }]),
    TEMPORAL_INFO
  );
  assertEquals(out, [{
    at: new Date("2026-01-15T10:20:30.123Z"),
    ats: [new Date("2026-01-15T10:20:30Z"), null],
    marks: [new Date("2026-01-15T10:20:30Z")],
    next: [{ "@since": new Date("2026-02-01T00:00:00Z"), at: new Date("2026-02-28T18:30:00Z") }]
  }]);
  assertEquals(reviveTyped(wire({ at: null }), TEMPORAL_INFO), { at: null });
  // Something that is not a datetime is left as is rather than made an Invalid Date.
  assertEquals(reviveTyped(wire({ at: "infinity" }), TEMPORAL_INFO), { at: "infinity" });
});

Deno.test("reviveTyped - a value that is already revived is kept", () => {
  const at = new Date("2026-01-15T10:20:30Z");
  assertEquals(reviveTyped(wire({ at, ats: [at] }), TEMPORAL_INFO), { at, ats: [at] });
});

Deno.test("reviveTyped - local date/time and duration fields stay strings", () => {
  const row = { day: "2026-01-15", local: "2026-01-15T10:20:30", span: "PT1H2M", time: "10:20:30.5" };
  assertEquals(reviveTyped(wire(row), TEMPORAL_INFO), row);
});

Deno.test("reviveTyped - durations stay Gel's ISO 8601 strings, alone and inside arrays and tuples", () => {
  const info: TypeInfo = {
    casts: {
      dateSpan: "<cal::date_duration>",
      pair: "<tuple<duration, int64>>",
      relative: "<cal::relative_duration>",
      span: "<duration>",
      spans: "<array<duration>>"
    },
    links: {}
  };
  const row = { dateSpan: "P0D", pair: ["PT-1.5S", 7], relative: "P1Y2M3DT4H5M6.5S", span: "PT49H", spans: ["PT1H", "PT0.000001S"] };
  assertEquals(reviveTyped(wire(row), info), { ...row, pair: ["PT-1.5S", 7n] });
});

const TUPLE_INFO: TypeInfo = {
  casts: {
    pair: "<tuple<int64, str>>",
    pairs: "<array<tuple<int64, str>>>",
    stamp: "<tuple<n: bigint, at: datetime, day: cal::local_date>>",
    tagged: "<tuple<int64, str>>"
  },
  links: {},
  multi: ["tagged"]
};

Deno.test("reviveTyped - int64 and datetime inside tuples, named tuples and arrays of tuples", () => {
  assertEquals(
    reviveTyped(
      wire({
        pair: ["9007199254740993", "x"],
        pairs: [[1, "a"], ["9007199254740993", "b"]],
        stamp: { at: "2026-01-15T10:20:30+00:00", day: "2026-01-15", n: 5 },
        tagged: [[1, "a"], [2, "b"]]
      }),
      TUPLE_INFO
    ),
    {
      pair: [9007199254740993n, "x"],
      pairs: [[1n, "a"], [9007199254740993n, "b"]],
      stamp: { at: new Date("2026-01-15T10:20:30Z"), day: "2026-01-15", n: 5n },
      tagged: [[1n, "a"], [2n, "b"]]
    }
  );
  assertEquals(reviveTyped(wire({ pair: null, pairs: [null] }), TUPLE_INFO), { pair: null, pairs: [null] });
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

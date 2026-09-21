/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Wire-format codecs for `Date`, `bigint`, and `Uint8Array`. (P1-29)
 *
 * The Disc HTTP query envelope is plain JSON, so values that have no JSON
 * primitive equivalent — `Date`, `bigint`, byte arrays — arrive as strings:
 *
 *   - `datetime` / `local_datetime` → ISO-8601 string
 *   - `int64` / `bigint`            → numeric string (precision > 2^53)
 *   - `bytes`                       → base64 string
 *
 * Without revival, these survive as strings forever, which is the right
 * default (silent type coercion is worse than visible strings). When
 * callers want richer types, they can:
 *
 *   1. Reach for one helper at known field paths:
 *
 *      ```ts
 *      const u = await client.query<{ created_at: string }>("…");
 *      const createdAt = parseDateTime(u.created_at);
 *      ```
 *
 *   2. Or pass `{ revive: true }` to walk the response and revive every
 *      string that *unambiguously* looks like one of the above:
 *
 *      ```ts
 *      const rows = await client.query<Row[]>("…", undefined, { revive: true });
 *      // rows[0].created_at is now a Date
 *      ```
 *
 *      Auto-revival is conservative: it only matches ISO-8601 with a date
 *      *and* time component, and only converts numeric strings that exceed
 *      `Number.MAX_SAFE_INTEGER`. Plain `"2026-05-05"` and small integers
 *      pass through unchanged.
 *
 *   3. Or use a Standard Schema validator (Zod / Valibot / …) with a
 *      transform — the most explicit and type-safe option.
 */

import type { TypeInfo } from "./filter-compiler.ts";

const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const NUMERIC_STRING_REGEX = /^-?\d+$/;

const HEX_BYTES_REGEX = /^\\x((?:[0-9a-fA-F]{2})*)$/;

/*** Bytes per `btoa` call in `encodeBytes`. A multiple of 3, so no chunk but the last ends in padding. ***/
const ENCODE_CHUNK_BYTES = 32766;

/**
 * Parse an ISO-8601 datetime string into a `Date`.
 * Returns `undefined` if the input is not a valid ISO-8601 datetime.
 */
export function parseDateTime(value: string): Date | undefined {
  if (!ISO_DATETIME_REGEX.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/**
 * Parse a numeric string into a `bigint`.
 * Returns `undefined` if the input is not a base-10 integer string.
 */
export function parseInt64(value: string): bigint | undefined {
  if (!NUMERIC_STRING_REGEX.test(value)) {
    return undefined;
  }
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

/**
 * Decode a `bytes` wire string into a `Uint8Array`: base64 (what the server
 * sends), or PostgreSQL hex (`\x1f8b…`, what servers before the base64 wire
 * format sent). Returns `undefined` on malformed input.
 */
export function parseBytes(value: string): Uint8Array | undefined {
  if (value.startsWith("\\x")) {
    const hex = HEX_BYTES_REGEX.exec(value)?.[1];
    if (hex === undefined) {
      return undefined;
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * `JSON.stringify` replacer that encodes outbound `bigint` values as numeric
 * strings. Plain `JSON.stringify` throws "Do not know how to serialize a
 * BigInt", which is exactly what callers hit when they pass an `int64` field
 * (typed `bigint` by codegen) back into a query as a variable.
 *
 * Numeric strings are the same wire form `int64` arrives in on responses (see
 * `parseInt64`), and the Disc server binds string params to `int8` columns
 * without precision loss — so the round-trip is lossless even past 2^53.
 *
 * `Uint8Array` values (`bytes`) go out as base64, wherever they sit in the
 * variables; plain `JSON.stringify` would write `{"0":31,"1":139,…}`. A Node
 * `Buffer` is a `Uint8Array` with a `toJSON`, which runs before the replacer
 * and hands it `{ type: "Buffer", data: […] }` — so the original value is read
 * from the holder (`this[key]`), which also leaves alone a plain object that
 * merely has that shape.
 */
export function jsonReplacer(this: unknown, key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  const original = value instanceof Uint8Array ? value : (this as Record<string, unknown> | undefined)?.[key];
  return original instanceof Uint8Array ? encodeBytes(original) : value;
}

/**
 * Encode a `Uint8Array` back into a base64 string for outbound payloads
 * (e.g. variables in `client.query(eql, { blob: encodeBytes(buf) })`).
 */
export function encodeBytes(value: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += ENCODE_CHUNK_BYTES) {
    parts.push(btoa(String.fromCharCode(...value.subarray(i, i + ENCODE_CHUNK_BYTES))));
  }
  return parts.join("");
}

export interface ReviveOptions {
  /** Convert ISO-8601 datetime strings to `Date`. Default: true. */
  dates?: boolean;
  /** Convert numeric strings exceeding `Number.MAX_SAFE_INTEGER` to `bigint`. Default: true. */
  bigints?: boolean;
  /**
   * Dot paths of `bytes` fields to decode into `Uint8Array`, relative to a
   * result row: `["content", "obj.content"]`. Arrays are transparent, so the
   * same path covers a list of rows, a link's rows and an `array<bytes>` field.
   * Default: none — base64 cannot be told from text by looking at it.
   */
  bytes?: string[];
}

/**
 * Walk `value` recursively and revive strings that unambiguously match a
 * known wire format. Returns a new structure — input is not mutated.
 *
 * Auto-revival deliberately avoids `bytes`: base64 strings collide with
 * arbitrary text too often. Name the fields in `options.bytes`, or use
 * `parseBytes()` at the call site.
 */
export function reviveResponse<T = unknown>(
  value: unknown,
  options: ReviveOptions = {}
): T {
  const dates = options.dates ?? true;
  const bigints = options.bigints ?? true;
  // Bytes first: a base64 string can also look like a big integer, and the
  // walk below leaves a `Uint8Array` alone.
  const withBytes = (options.bytes ?? []).reduce((acc, path) => reviveBytesAt(acc, path.split(".")), value);
  return walk(withBytes, dates, bigints) as T;
}

/**
 * Revive a typed query builder's result from its `TypeInfo`: every field cast
 * `<bytes>` (or `<array<bytes>>`) becomes a `Uint8Array`, recursing through
 * `links`. A single link arrives as a one-element array of rows today, a multi
 * link as a longer one; a plain object works too. Returns a new structure —
 * input is not mutated. Other wire strings (datetime, big int64) are left to
 * `reviveResponse`, as before.
 */
export function reviveTyped<T>(data: T, typeInfo: TypeInfo): T {
  return reviveTypedValue(data, typeInfo) as T;
}

function reviveTypedValue(value: unknown, typeInfo: TypeInfo): unknown {
  if (Array.isArray(value)) {
    return value.map(item => reviveTypedValue(item, typeInfo));
  }
  if (value === null || typeof value !== "object" || value instanceof Uint8Array) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const cast = typeInfo.casts[key];
    const link = typeInfo.links[key];
    if (cast === "<bytes>" || cast === "<array<bytes>>") {
      out[key] = reviveBytes(field);
    } else if (link) {
      out[key] = reviveTypedValue(field, link());
    } else {
      out[key] = field;
    }
  }
  return out;
}

/*** A bytes wire string, or an array of them (`array<bytes>`, or the same field across rows). Anything else is returned as is. ***/
function reviveBytes(value: unknown): unknown {
  if (typeof value === "string") {
    return parseBytes(value) ?? value;
  }
  return Array.isArray(value) ? value.map(reviveBytes) : value;
}

function reviveBytesAt(value: unknown, path: string[]): unknown {
  if (path.length === 0) {
    return reviveBytes(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => reviveBytesAt(item, path));
  }
  if (value === null || typeof value !== "object" || value instanceof Uint8Array || !Object.hasOwn(value, path[0])) {
    return value;
  }
  return { ...value, [path[0]]: reviveBytesAt((value as Record<string, unknown>)[path[0]], path.slice(1)) };
}

function walk(value: unknown, dates: boolean, bigints: boolean): unknown {
  if (value === null || value === undefined || value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    if (dates && ISO_DATETIME_REGEX.test(value)) {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) {
        return new Date(ms);
      }
    }
    if (bigints && NUMERIC_STRING_REGEX.test(value)) {
      try {
        const big = BigInt(value);
        if (big > Number.MAX_SAFE_INTEGER || big < -Number.MAX_SAFE_INTEGER) {
          return big;
        }
      } catch {
        // fall through to return original string
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => walk(item, dates, bigints));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walk(v, dates, bigints);
    }
    return out;
  }
  return value;
}

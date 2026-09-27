/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Wire-format codecs for `Date`, `bigint`, and `Uint8Array`. (P1-29)
 *
 * The Disc HTTP query envelope is plain JSON, so values that have no JSON
 * primitive equivalent — `Date`, `bigint`, byte arrays — arrive as strings:
 *
 *   - `datetime` / `local_datetime` → ISO-8601 string
 *   - `int64` / `bigint` / `decimal` → numeric string (precision > 2^53)
 *   - `bytes`                       → base64 string
 *
 * On the wire, `int64`, `bigint` and `decimal` are JSON numbers with every
 * digit (as in Gel). `parseResponseJson` reads one that a double cannot hold
 * exactly as its digits, a numeric string; every other number stays a number.
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

/*** A named tuple parameter, `label: type`; `(?!:)` keeps `cal::local_date` from reading as one. ***/
const TUPLE_LABEL_REGEX = /^([A-Za-z_]\w*)\s*:(?!:)\s*([\s\S]+)$/;

const HEX_BYTES_REGEX = /^\\x((?:[0-9a-fA-F]{2})*)$/;

/*** A JSON number (RFC 8259): sign, integer part, fraction, exponent. ***/
const JSON_NUMBER_REGEX = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

type SourceReviver = (key: string, value: unknown, context?: { source?: string; }) => unknown;

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
 * A number's value as `<sign><significant digits>e<exponent>`, so `1.50`,
 * `1.5` and `15e-1` compare equal. `null` when `text` is not a JSON number.
 */
function canonicalNumber(text: string): string | null {
  const match = JSON_NUMBER_REGEX.exec(text);
  if (!match) {
    return null;
  }
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const digits = (whole + fraction).replace(/^0+/, "");
  const significant = digits.replace(/0+$/, "");
  if (significant === "") {
    return "0";
  }
  const power = Number(exponent) - fraction.length + digits.length - significant.length;
  return `${sign}${significant}e${power}`;
}

/*** Whether the double `value`, parsed from the JSON number `source`, holds it exactly. ***/
function isExactNumber(source: string, value: number): boolean {
  if (NUMERIC_STRING_REGEX.test(source)) {
    return Number.isSafeInteger(value);
  }
  const canonical = canonicalNumber(source);
  return canonical !== null && canonical === canonicalNumber(String(value));
}

/**
 * Parse a Disc response body. Like `JSON.parse`, except a number a double
 * cannot hold exactly (`int64` past 2^53, a large `bigint`, a `decimal` with
 * more digits than a double) becomes its digits as a string instead of a
 * rounded number — the form `parseInt64` and `reviveResponse` read.
 *
 * Needs `JSON.parse` source text access (the reviver's third argument; Deno,
 * Node 21+, current browsers). Where it is missing, numbers parse as usual.
 */
export function parseResponseJson(text: string): unknown {
  const reviver: SourceReviver = (_key, value, context) => {
    if (typeof value === "number" && context?.source !== undefined && !isExactNumber(context.source, value)) {
      return context.source;
    }
    return value;
  };
  return (JSON.parse as (text: string, reviver: SourceReviver) => unknown)(text, reviver);
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
 * Revive a typed query builder's result from its `TypeInfo`, into the TS types
 * codegen declares: every field cast `<bytes>` becomes a `Uint8Array`,
 * `<int64>` and `<bigint>` a `bigint`, `<decimal>` a string of its digits and
 * `<datetime>` a `Date` — inside arrays, tuples and named tuples too, and
 * element by element for a multi property — recursing through `links`, and
 * reading a link's `@name` keys by its `linkProperties`. The `cal::` types and
 * `duration` stay the strings they arrive as. A single link arrives as a
 * one-element array of rows (as codegen declares it), a multi link as a longer one; a plain
 * object works too. A value already revived is kept. Returns a new structure —
 * input is not mutated.
 */
export function reviveTyped<T>(data: T, typeInfo: TypeInfo): T {
  return reviveTypedValue(data, typeInfo) as T;
}

function reviveTypedValue(value: unknown, typeInfo: TypeInfo, linkCasts?: Record<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map(item => reviveTypedValue(item, typeInfo, linkCasts));
  }
  if (value === null || typeof value !== "object" || value instanceof Uint8Array || value instanceof Date) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    const cast = key.startsWith("@") ? linkCasts?.[key.slice(1)] : typeInfo.casts[key];
    const link = typeInfo.links[key];
    if (cast !== undefined) {
      const type = cast.slice(1, -1);
      out[key] = typeInfo.multi?.includes(key) && Array.isArray(field) ? field.map(item => reviveAs(item, type)) : reviveAs(field, type);
    } else if (link) {
      out[key] = reviveTypedValue(field, link(), typeInfo.linkProperties?.[key]);
    } else {
      out[key] = field;
    }
  }
  return out;
}

/*** A wire value as the TS type codegen declares for the EdgeQL type `type` (`int64`, `array<datetime>`, `tuple<n: int64, s: str>`, …). ***/
function reviveAs(value: unknown, type: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const element = collectionParams(type, "array");
  if (element !== undefined) {
    return Array.isArray(value) ? value.map(item => reviveAs(item, element)) : value;
  }
  const tuple = collectionParams(type, "tuple");
  if (tuple !== undefined) {
    return reviveTuple(value, splitTupleParams(tuple));
  }
  switch (type) {
    case "bytes":
      return reviveBytes(value);
    case "bigint":
    case "int64":
      return reviveBigint(value);
    case "decimal":
      return reviveDecimal(value);
    case "datetime":
      return reviveDateTime(value);
    default:
      return value;
  }
}

/*** A positional tuple (a JSON array) element by element, a named one (a JSON object) field by field. ***/
function reviveTuple(value: unknown, params: TupleParam[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => params[i] ? reviveAs(item, params[i].type) : item);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const types = new Map(params.map(param => [param.name, param.type]));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, types.has(key) ? reviveAs(item, types.get(key)!) : item]));
}

/*** The parameter list of `kind<…>` (`array<int64>` → `int64`); undefined when `type` is not one. ***/
function collectionParams(type: string, kind: "array" | "tuple"): string | undefined {
  return type.startsWith(`${kind}<`) && type.endsWith(">") ? type.slice(kind.length + 1, -1) : undefined;
}

interface TupleParam {
  /*** Its label in a named tuple; null in a positional one. ***/
  name: string | null;
  type: string;
}

/*** A tuple's parameters, split on top-level commas (`int64, tuple<a, b>`), each labeled when named (`n: int64`; `cal::local_date` is not a label). ***/
function splitTupleParams(params: string): TupleParam[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < params.length; i++) {
    if (params[i] === "<") {
      depth++;
    } else if (params[i] === ">") {
      depth--;
    } else if (params[i] === "," && depth === 0) {
      parts.push(params.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(params.slice(start));
  return parts.map(part => {
    const match = TUPLE_LABEL_REGEX.exec(part.trim());
    return match ? { name: match[1], type: match[2] } : { name: null, type: part.trim() };
  });
}

/*** A datetime wire string as a `Date`, arrays element-wise; a string that is not an ISO-8601 datetime (`infinity`) is returned as is. ***/
function reviveDateTime(value: unknown): unknown {
  if (typeof value === "string") {
    return parseDateTime(value) ?? value;
  }
  return Array.isArray(value) ? value.map(reviveDateTime) : value;
}

/*** A bytes wire string, or an array of them (`array<bytes>`, or the same field across rows). Anything else is returned as is. ***/
function reviveBytes(value: unknown): unknown {
  if (typeof value === "string") {
    return parseBytes(value) ?? value;
  }
  return Array.isArray(value) ? value.map(reviveBytes) : value;
}

/*** A bigint or int64 wire value — a number, or a numeric string past 2^53 — as a `bigint`; arrays element-wise. Anything else is returned as is. ***/
function reviveBigint(value: unknown): unknown {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string") {
    return parseInt64(value) ?? value;
  }
  return Array.isArray(value) ? value.map(reviveBigint) : value;
}

/*** A decimal wire value as a string of its digits (a number holds them exactly, so it prints them); arrays element-wise. ***/
function reviveDecimal(value: unknown): unknown {
  if (typeof value === "number") {
    return String(value);
  }
  return Array.isArray(value) ? value.map(reviveDecimal) : value;
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

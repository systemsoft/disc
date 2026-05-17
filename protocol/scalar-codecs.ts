/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Scalar codecs for the Gel binary wire protocol.
 *
 * Each codec encodes a JS value into raw bytes (no length prefix — the
 * caller frames the value with [u32 reserved][i32 elemLen][bytes...]) and
 * decodes raw bytes back to a JS value. The byte layouts mirror the
 * upstream Gel Python and JS clients, so values round-trip with both.
 *
 * Type → wire format:
 *   std::str          → UTF-8 bytes
 *   std::int16        → 2 bytes BE
 *   std::int32        → 4 bytes BE
 *   std::int64        → 8 bytes BE
 *   std::float32      → 4 bytes IEEE-754 BE
 *   std::float64      → 8 bytes IEEE-754 BE
 *   std::bool         → 1 byte (0 / 1)
 *   std::uuid         → 16 raw bytes
 *   std::datetime     → 8 bytes BE i64 microseconds since 2000-01-01 UTC
 *   std::bytes        → raw bytes
 *   std::json         → [u8 format=1][UTF-8 bytes]
 */

import { uuidToBytes } from "./types.ts";

// 2000-01-01T00:00:00Z in epoch milliseconds; Gel datetime is microseconds
// since this epoch.
const GEL_DATETIME_EPOCH_MS = 946684800000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Resolve a (possibly short) EdgeQL scalar type name to the canonical
 * `std::*` form used by the codec table. Falls back to the input string.
 */
export function canonicalScalarName(name: string): string {
  if (name.includes("::")) {
    return name;
  }
  // Common short names — keep aligned with WELL_KNOWN_TYPES in typedesc.ts.
  const map: Record<string, string> = {
    bigint: "std::bigint",
    bool: "std::bool",
    bytes: "std::bytes",
    datetime: "std::datetime",
    decimal: "std::decimal",
    duration: "std::duration",
    float32: "std::float32",
    float64: "std::float64",
    int16: "std::int16",
    int32: "std::int32",
    int64: "std::int64",
    json: "std::json",
    str: "std::str",
    uuid: "std::uuid"
  };
  return map[name] ?? name;
}

// ---------------------------------------------------------------------------
// Encode helpers — return the raw scalar bytes (no length prefix)
// ---------------------------------------------------------------------------

function encodeStr(value: unknown): Uint8Array {
  if (typeof value !== "string") {
    throw new TypeError(`expected string, got ${typeof value}`);
  }
  return textEncoder.encode(value);
}

function encodeInt16(value: unknown): Uint8Array {
  const n = Number(value);
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setInt16(0, n, false);
  return buf;
}

function encodeInt32(value: unknown): Uint8Array {
  const n = Number(value);
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setInt32(0, n, false);
  return buf;
}

function encodeInt64(value: unknown): Uint8Array {
  const n = typeof value === "bigint" ?
    value :
    BigInt(Math.trunc(Number(value)));
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, n, false);
  return buf;
}

function encodeFloat32(value: unknown): Uint8Array {
  const n = Number(value);
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, n, false);
  return buf;
}

function encodeFloat64(value: unknown): Uint8Array {
  const n = Number(value);
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, n, false);
  return buf;
}

function encodeBool(value: unknown): Uint8Array {
  return new Uint8Array([value ? 1 : 0]);
}

function encodeUuid(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 16) {
      throw new TypeError(
        `uuid Uint8Array must be 16 bytes, got ${value.length}`
      );
    }
    return new Uint8Array(value);
  }
  if (typeof value !== "string") {
    throw new TypeError(`expected uuid string, got ${typeof value}`);
  }
  return uuidToBytes(value);
}

function encodeDatetime(value: unknown): Uint8Array {
  let ms: number;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === "string") {
    ms = new Date(value).getTime();
  } else if (typeof value === "number") {
    ms = value;
  } else {
    throw new TypeError(
      `expected Date|string|number for datetime, got ${typeof value}`
    );
  }
  const us = BigInt(ms - GEL_DATETIME_EPOCH_MS) * 1000n;
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigInt64(0, us, false);
  return buf;
}

function encodeBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (typeof value === "string") {
    return textEncoder.encode(value);
  }
  throw new TypeError(
    `expected Uint8Array|string for bytes, got ${typeof value}`
  );
}

function encodeJson(value: unknown): Uint8Array {
  // Gel JSON wire: [u8 format=1][UTF-8 bytes of JSON]
  const json = typeof value === "string" ? value : JSON.stringify(value);
  const body = textEncoder.encode(json);
  const out = new Uint8Array(body.length + 1);
  out[0] = 1;
  out.set(body, 1);
  return out;
}

// ---------------------------------------------------------------------------
// Decode helpers — consume the raw scalar bytes (no length prefix)
// ---------------------------------------------------------------------------

function decodeStr(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

function decodeInt16(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getInt16(0, false);
}

function decodeInt32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getInt32(0, false);
}

function decodeInt64(bytes: Uint8Array): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getBigInt64(0, false);
}

function decodeFloat32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getFloat32(0, false);
}

function decodeFloat64(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getFloat64(0, false);
}

function decodeBool(bytes: Uint8Array): boolean {
  return bytes[0] !== 0;
}

function decodeUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error(`uuid bytes must be 16, got ${bytes.length}`);
  }
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(
    ""
  );
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ]
    .join("-");
}

function decodeDatetime(bytes: Uint8Array): Date {
  const us = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getBigInt64(0, false);
  const ms = Number(us / 1000n) + GEL_DATETIME_EPOCH_MS;
  return new Date(ms);
}

function decodeBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function decodeJson(bytes: Uint8Array): unknown {
  // Skip the format byte.
  const body = bytes.slice(1);
  const text = textDecoder.decode(body);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------------

export type ScalarEncoder = (value: unknown) => Uint8Array;
export type ScalarDecoder = (bytes: Uint8Array) => unknown;

const ENCODERS: Record<string, ScalarEncoder> = {
  "std::bool": encodeBool,
  "std::bytes": encodeBytes,
  "std::datetime": encodeDatetime,
  "std::float32": encodeFloat32,
  "std::float64": encodeFloat64,
  "std::int16": encodeInt16,
  "std::int32": encodeInt32,
  "std::int64": encodeInt64,
  "std::json": encodeJson,
  "std::str": encodeStr,
  "std::uuid": encodeUuid
};

const DECODERS: Record<string, ScalarDecoder> = {
  "std::bool": decodeBool,
  "std::bytes": decodeBytes,
  "std::datetime": decodeDatetime,
  "std::float32": decodeFloat32,
  "std::float64": decodeFloat64,
  "std::int16": decodeInt16,
  "std::int32": decodeInt32,
  "std::int64": decodeInt64,
  "std::json": decodeJson,
  "std::str": decodeStr,
  "std::uuid": decodeUuid
};

/** Encode `value` as the Gel-wire raw bytes for `eqlType`. */
export function encodeScalar(eqlType: string, value: unknown): Uint8Array {
  const enc = ENCODERS[canonicalScalarName(eqlType)];
  if (!enc) {
    throw new Error(`no scalar encoder for type "${eqlType}"`);
  }
  return enc(value);
}

/** Decode raw bytes for `eqlType` to a JS value. */
export function decodeScalar(eqlType: string, bytes: Uint8Array): unknown {
  const dec = DECODERS[canonicalScalarName(eqlType)];
  if (!dec) {
    throw new Error(`no scalar decoder for type "${eqlType}"`);
  }
  return dec(bytes);
}

/** Whether the given EdgeQL scalar type has a known wire codec. */
export function hasScalarCodec(eqlType: string): boolean {
  return canonicalScalarName(eqlType) in ENCODERS;
}

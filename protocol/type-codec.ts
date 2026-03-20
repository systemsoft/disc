/**
 * Type codecs for encoding/decoding EdgeQL values in binary format.
 *
 * Used to serialize query results in Data messages and deserialize
 * parameter values from client Execute messages.
 *
 * Scalar encoding rules follow Gel's binary protocol specification:
 * - All multi-byte integers are big-endian (network byte order)
 * - The Gel datetime epoch is 2000-01-01T00:00:00Z
 *   (946684800000 ms / 946684800000000 us after Unix epoch)
 * - JSON values have a 1-byte format version prefix (0x01)
 * - bigint/decimal use PostgreSQL numeric wire format
 */

import { BufferReader, BufferWriter } from "./buffer.ts";
import type { ObjectShapeDescriptor, TypeDescriptor } from "./typedesc.ts";
import { DescriptorTag } from "./typedesc.ts";
import { bytesToUuid } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Microseconds between Unix epoch (1970-01-01) and Gel epoch (2000-01-01).
 * 946684800 seconds * 1_000_000 us/s
 */
const GEL_EPOCH_OFFSET_US = 946684800000000n;

/**
 * Milliseconds between Unix epoch and Gel epoch.
 */
const GEL_EPOCH_OFFSET_MS = 946684800000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Scalar encoding
// ---------------------------------------------------------------------------

/**
 * Encode a scalar value to its binary wire representation.
 *
 * @param typeName - The EdgeQL type name (short form like "str" or qualified like "std::str")
 * @param value - The JavaScript value to encode
 * @returns Binary representation of the value
 */
export function encodeScalarValue(
  typeName: string,
  value: unknown,
): Uint8Array {
  const normalized = normalizeTypeName(typeName);

  switch (normalized) {
    case "str":
      return textEncoder.encode(value as string);

    case "bytes":
      return value as Uint8Array;

    case "bool": {
      const buf = new Uint8Array(1);
      buf[0] = value ? 0x01 : 0x00;
      return buf;
    }

    case "int16": {
      const buf = new Uint8Array(2);
      new DataView(buf.buffer).setInt16(0, value as number, false);
      return buf;
    }

    case "int32": {
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setInt32(0, value as number, false);
      return buf;
    }

    case "int64": {
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigInt64(
        0,
        typeof value === "bigint" ? value : BigInt(value as number),
        false,
      );
      return buf;
    }

    case "float32": {
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setFloat32(0, value as number, false);
      return buf;
    }

    case "float64": {
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setFloat64(0, value as number, false);
      return buf;
    }

    case "uuid": {
      if (value instanceof Uint8Array) {
        if (value.length !== 16) {
          throw new Error(`UUID must be 16 bytes, got ${value.length}`);
        }
        return new Uint8Array(value);
      }
      // Parse UUID string "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      return uuidStringToBytes(value as string);
    }

    case "datetime": {
      // Value is a Date or number (ms since Unix epoch).
      // Wire format: int64 microseconds since 2000-01-01 UTC.
      const msUnix = value instanceof Date
        ? value.getTime()
        : value as number;
      const usGel = BigInt(msUnix) * 1000n - GEL_EPOCH_OFFSET_US;
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigInt64(0, usGel, false);
      return buf;
    }

    case "local_datetime": {
      // Same encoding as datetime (int64 us since 2000-01-01) but no timezone
      const msUnix = value instanceof Date
        ? value.getTime()
        : value as number;
      const usGel = BigInt(msUnix) * 1000n - GEL_EPOCH_OFFSET_US;
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigInt64(0, usGel, false);
      return buf;
    }

    case "local_date": {
      // int32 days since 2000-01-01
      const msUnix = value instanceof Date
        ? value.getTime()
        : value as number;
      const daysSinceGelEpoch = Math.floor(
        (msUnix - GEL_EPOCH_OFFSET_MS) / 86400000,
      );
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setInt32(0, daysSinceGelEpoch, false);
      return buf;
    }

    case "local_time": {
      // int64 microseconds since midnight
      // Value is number of microseconds, or a Date (extract time-of-day)
      let us: bigint;
      if (value instanceof Date) {
        const midnight = new Date(value);
        midnight.setHours(0, 0, 0, 0);
        us = BigInt(value.getTime() - midnight.getTime()) * 1000n;
      } else if (typeof value === "bigint") {
        us = value;
      } else {
        us = BigInt(value as number);
      }
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigInt64(0, us, false);
      return buf;
    }

    case "duration": {
      // int64 microseconds
      let us: bigint;
      if (typeof value === "bigint") {
        us = value;
      } else {
        us = BigInt(value as number);
      }
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigInt64(0, us, false);
      return buf;
    }

    case "json": {
      // 1-byte format version prefix (0x01) + UTF-8 JSON string
      const jsonStr = typeof value === "string"
        ? value
        : JSON.stringify(value);
      const jsonBytes = textEncoder.encode(jsonStr);
      const buf = new Uint8Array(1 + jsonBytes.length);
      buf[0] = 0x01;
      buf.set(jsonBytes, 1);
      return buf;
    }

    case "bigint":
      return encodeBigInt(value as bigint);

    case "decimal":
      return encodeDecimal(value as string | number);

    default:
      throw new Error(`Unsupported scalar type for encoding: ${typeName}`);
  }
}

// ---------------------------------------------------------------------------
// Scalar decoding
// ---------------------------------------------------------------------------

/**
 * Decode a scalar value from its binary wire representation.
 *
 * @param typeName - The EdgeQL type name
 * @param data - The binary data to decode
 * @returns The decoded JavaScript value
 */
export function decodeScalarValue(
  typeName: string,
  data: Uint8Array,
): unknown {
  const normalized = normalizeTypeName(typeName);

  switch (normalized) {
    case "str":
      return textDecoder.decode(data);

    case "bytes":
      return new Uint8Array(data);

    case "bool":
      return data[0] !== 0x00;

    case "int16":
      return new DataView(data.buffer, data.byteOffset).getInt16(0, false);

    case "int32":
      return new DataView(data.buffer, data.byteOffset).getInt32(0, false);

    case "int64":
      return new DataView(data.buffer, data.byteOffset).getBigInt64(0, false);

    case "float32":
      return new DataView(data.buffer, data.byteOffset).getFloat32(0, false);

    case "float64":
      return new DataView(data.buffer, data.byteOffset).getFloat64(0, false);

    case "uuid":
      return bytesToUuid(data);

    case "datetime": {
      const usGel = new DataView(data.buffer, data.byteOffset).getBigInt64(
        0,
        false,
      );
      const msUnix = Number((usGel + GEL_EPOCH_OFFSET_US) / 1000n);
      return new Date(msUnix);
    }

    case "local_datetime": {
      const usGel = new DataView(data.buffer, data.byteOffset).getBigInt64(
        0,
        false,
      );
      const msUnix = Number((usGel + GEL_EPOCH_OFFSET_US) / 1000n);
      return new Date(msUnix);
    }

    case "local_date": {
      const days = new DataView(data.buffer, data.byteOffset).getInt32(
        0,
        false,
      );
      const msUnix = days * 86400000 + GEL_EPOCH_OFFSET_MS;
      return new Date(msUnix);
    }

    case "local_time": {
      // Return microseconds since midnight as bigint
      return new DataView(data.buffer, data.byteOffset).getBigInt64(0, false);
    }

    case "duration": {
      // Return microseconds as bigint
      return new DataView(data.buffer, data.byteOffset).getBigInt64(0, false);
    }

    case "json": {
      // Skip 1-byte format version prefix
      const jsonStr = textDecoder.decode(data.slice(1));
      return JSON.parse(jsonStr);
    }

    case "bigint":
      return decodeBigInt(data);

    case "decimal":
      return decodeDecimal(data);

    default:
      throw new Error(`Unsupported scalar type for decoding: ${typeName}`);
  }
}

// ---------------------------------------------------------------------------
// Object value encoding
// ---------------------------------------------------------------------------

/**
 * Encode an object (row) to binary using its shape descriptor.
 *
 * The wire format for an object is:
 *   nelements: int32 (number of shape elements)
 *   For each element:
 *     reserved: int32 (always 0)
 *     data_length: int32 (-1 for null, otherwise byte count)
 *     data: bytes[data_length] (if data_length >= 0)
 *
 * @param shape - The ObjectShapeDescriptor describing the shape
 * @param values - Key-value pairs for the object fields
 * @param descriptorMap - Map from UUID hex string to TypeDescriptor
 * @returns Binary encoded object
 */
export function encodeObjectValue(
  shape: ObjectShapeDescriptor,
  values: Record<string, unknown>,
  descriptorMap: Map<string, TypeDescriptor>,
): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt32(shape.elements.length);

  for (const element of shape.elements) {
    // Reserved field
    w.writeUInt32(0);

    const val = values[element.name];
    if (val === null || val === undefined) {
      // -1 as int32 for null
      const nullBuf = new Uint8Array(4);
      new DataView(nullBuf.buffer).setInt32(0, -1, false);
      w.writeBytes(nullBuf);
    } else {
      // Look up the element type descriptor to determine encoding
      const typeIdHex = bytesToUuid(element.typeId);
      const typeDesc = descriptorMap.get(typeIdHex);

      let encoded: Uint8Array;
      if (typeDesc && typeDesc.tag === DescriptorTag.BASE_SCALAR) {
        // Resolve scalar type name from UUID
        const typeName = resolveTypeNameFromId(element.typeId);
        encoded = encodeScalarValue(typeName, val);
      } else if (typeDesc && typeDesc.tag === DescriptorTag.OBJECT_SHAPE) {
        // Nested object
        encoded = encodeObjectValue(
          typeDesc as ObjectShapeDescriptor,
          val as Record<string, unknown>,
          descriptorMap,
        );
      } else {
        // Fallback: try to encode as string
        encoded = textEncoder.encode(String(val));
      }

      // Write length + data
      w.writeUInt32(encoded.length);
      w.writeBytes(encoded);
    }
  }

  return w.toBytes();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip module prefix from a type name.
 * "std::str" -> "str", "cal::local_date" -> "local_date", "str" -> "str"
 */
function normalizeTypeName(name: string): string {
  const idx = name.lastIndexOf("::");
  if (idx >= 0) return name.substring(idx + 2);
  return name;
}

/**
 * Convert a UUID string to 16 bytes.
 */
function uuidStringToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID string: ${uuid}`);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Resolve a type UUID back to its short name for codec dispatch.
 * Falls back to "bytes" if unknown.
 */
function resolveTypeNameFromId(id: Uint8Array): string {
  const uuid = bytesToUuid(id);
  // Check well-known UUIDs
  const knownTypes: Array<[string, string]> = [
    ["00000000-0000-0000-0000-000000000100", "uuid"],
    ["00000000-0000-0000-0000-000000000101", "str"],
    ["00000000-0000-0000-0000-000000000102", "bytes"],
    ["00000000-0000-0000-0000-000000000103", "int16"],
    ["00000000-0000-0000-0000-000000000104", "int32"],
    ["00000000-0000-0000-0000-000000000105", "int64"],
    ["00000000-0000-0000-0000-000000000106", "float32"],
    ["00000000-0000-0000-0000-000000000107", "float64"],
    ["00000000-0000-0000-0000-000000000108", "decimal"],
    ["00000000-0000-0000-0000-000000000109", "bool"],
    ["00000000-0000-0000-0000-00000000010a", "datetime"],
    ["00000000-0000-0000-0000-00000000010b", "local_datetime"],
    ["00000000-0000-0000-0000-00000000010c", "local_date"],
    ["00000000-0000-0000-0000-00000000010d", "local_time"],
    ["00000000-0000-0000-0000-00000000010e", "duration"],
    ["00000000-0000-0000-0000-00000000010f", "json"],
    ["00000000-0000-0000-0000-000000000110", "bigint"],
    ["00000000-0000-0000-0000-000000000130", "memory"],
  ];
  for (const [knownUuid, name] of knownTypes) {
    if (uuid === knownUuid) return name;
  }
  return "bytes";
}

// ---------------------------------------------------------------------------
// BigInt / Decimal encoding (PostgreSQL numeric wire format)
// ---------------------------------------------------------------------------

/**
 * Encode a bigint value in PostgreSQL numeric wire format.
 *
 * Format:
 *   ndigits: uint16 (number of base-10000 digit groups)
 *   weight:  int16  (weight of first digit group, 0-based from most significant)
 *   sign:    uint16 (0x0000 = positive, 0x4000 = negative)
 *   dscale:  uint16 (number of digits after decimal point, 0 for bigint)
 *   digits:  ndigits * uint16 (each digit group is 0..9999)
 */
function encodeBigInt(value: bigint): Uint8Array {
  if (value === 0n) {
    // Special case: zero has ndigits=0, weight=0, sign=positive, dscale=0
    const buf = new Uint8Array(8);
    // All zeros is correct: ndigits=0, weight=0, sign=0, dscale=0
    return buf;
  }

  const sign = value < 0n ? 0x4000 : 0x0000;
  let abs = value < 0n ? -value : value;

  // Break into base-10000 digit groups
  const digitGroups: number[] = [];
  while (abs > 0n) {
    digitGroups.push(Number(abs % 10000n));
    abs = abs / 10000n;
  }
  digitGroups.reverse();

  const ndigits = digitGroups.length;
  const weight = ndigits - 1; // Weight of the most significant digit group

  const buf = new Uint8Array(8 + ndigits * 2);
  const view = new DataView(buf.buffer);
  view.setUint16(0, ndigits, false);
  view.setInt16(2, weight, false);
  view.setUint16(4, sign, false);
  view.setUint16(6, 0, false); // dscale = 0 for bigint

  for (let i = 0; i < ndigits; i++) {
    view.setUint16(8 + i * 2, digitGroups[i], false);
  }

  return buf;
}

/**
 * Decode a bigint from PostgreSQL numeric wire format.
 */
function decodeBigInt(data: Uint8Array): bigint {
  const view = new DataView(data.buffer, data.byteOffset);
  const ndigits = view.getUint16(0, false);
  const _weight = view.getInt16(2, false);
  const sign = view.getUint16(4, false);
  // dscale at offset 6 (not used for bigint)

  if (ndigits === 0) return 0n;

  let result = 0n;
  for (let i = 0; i < ndigits; i++) {
    const digit = view.getUint16(8 + i * 2, false);
    result = result * 10000n + BigInt(digit);
  }

  return sign === 0x4000 ? -result : result;
}

/**
 * Encode a decimal value in PostgreSQL numeric wire format.
 *
 * Accepts a string like "123.45" or a number.
 * Same format as bigint but with non-zero dscale.
 */
function encodeDecimal(value: string | number): Uint8Array {
  const str = typeof value === "number" ? value.toString() : value;

  // Handle zero
  if (str === "0" || str === "0.0") {
    const buf = new Uint8Array(8);
    return buf;
  }

  const isNegative = str.startsWith("-");
  const abs = isNegative ? str.substring(1) : str;

  // Split into integer and fractional parts
  const dotIdx = abs.indexOf(".");
  const intPart = dotIdx >= 0 ? abs.substring(0, dotIdx) : abs;
  const fracPart = dotIdx >= 0 ? abs.substring(dotIdx + 1) : "";

  // Calculate dscale (number of fractional digits)
  const dscale = fracPart.length;

  // Combine into full digit string padded to multiple of 4
  let fullDigits = intPart + fracPart;

  // Pad the integer part on the left so total groups align
  // We need the integer part to be a multiple of 4 digits
  const intLen = intPart.length;
  const intPadLen = intLen % 4 === 0 ? 0 : 4 - (intLen % 4);
  const paddedInt = "0".repeat(intPadLen) + intPart;

  // Pad fractional part on the right to multiple of 4
  const fracPadLen = fracPart.length % 4 === 0
    ? 0
    : 4 - (fracPart.length % 4);
  const paddedFrac = fracPart + "0".repeat(fracPadLen);

  fullDigits = paddedInt + paddedFrac;

  // Split into groups of 4
  const digitGroups: number[] = [];
  for (let i = 0; i < fullDigits.length; i += 4) {
    digitGroups.push(parseInt(fullDigits.substring(i, i + 4), 10));
  }

  // Remove trailing zero groups from fractional part (optimization)
  // but keep at least enough to represent dscale
  // Actually, the wire format requires all groups, so we keep them.

  // Remove leading zero groups
  while (digitGroups.length > 1 && digitGroups[0] === 0) {
    digitGroups.shift();
  }

  const ndigits = digitGroups.length;
  // Weight: position of most significant group relative to decimal point
  // Number of integer digit groups
  const intGroupCount = paddedInt.length / 4;
  // After removing leading zeros, figure out how many were removed
  let leadingZeroGroups = 0;
  const origGroups = [];
  for (let i = 0; i < paddedInt.length; i += 4) {
    origGroups.push(parseInt(paddedInt.substring(i, i + 4), 10));
  }
  for (const g of origGroups) {
    if (g === 0) leadingZeroGroups++;
    else break;
  }
  const weight = intGroupCount - 1 - leadingZeroGroups;

  const sign = isNegative ? 0x4000 : 0x0000;

  const buf = new Uint8Array(8 + ndigits * 2);
  const view = new DataView(buf.buffer);
  view.setUint16(0, ndigits, false);
  view.setInt16(2, weight, false);
  view.setUint16(4, sign, false);
  view.setUint16(6, dscale, false);

  for (let i = 0; i < ndigits; i++) {
    view.setUint16(8 + i * 2, digitGroups[i], false);
  }

  return buf;
}

/**
 * Decode a decimal from PostgreSQL numeric wire format.
 * Returns a string representation to preserve precision.
 */
function decodeDecimal(data: Uint8Array): string {
  const view = new DataView(data.buffer, data.byteOffset);
  const ndigits = view.getUint16(0, false);
  const weight = view.getInt16(2, false);
  const sign = view.getUint16(4, false);
  const dscale = view.getUint16(6, false);

  if (ndigits === 0) {
    return dscale > 0 ? "0." + "0".repeat(dscale) : "0";
  }

  const digitGroups: number[] = [];
  for (let i = 0; i < ndigits; i++) {
    digitGroups.push(view.getUint16(8 + i * 2, false));
  }

  // Reconstruct the number string
  // weight indicates the power-of-10000 of the first digit group
  // e.g., weight=1 means first group represents 10000^1
  let intGroupCount = weight + 1;
  if (intGroupCount < 0) intGroupCount = 0;

  let intStr = "";
  for (let i = 0; i < intGroupCount; i++) {
    const d = i < ndigits ? digitGroups[i] : 0;
    if (i === 0) {
      intStr += d.toString();
    } else {
      intStr += d.toString().padStart(4, "0");
    }
  }
  if (intStr === "") intStr = "0";

  let fracStr = "";
  for (let i = intGroupCount; i < ndigits; i++) {
    if (i < 0) {
      fracStr += "0000";
    } else {
      const d = digitGroups[i];
      fracStr += d.toString().padStart(4, "0");
    }
  }

  // If weight is negative, we need leading zeros in the fractional part
  if (weight < 0) {
    const leadingZeroGroups = -(weight + 1);
    fracStr = "0000".repeat(leadingZeroGroups) + fracStr;
  }

  // Trim or pad fractional part to match dscale
  if (dscale > 0) {
    if (fracStr.length > dscale) {
      fracStr = fracStr.substring(0, dscale);
    } else {
      fracStr = fracStr.padEnd(dscale, "0");
    }
  }

  const prefix = sign === 0x4000 ? "-" : "";
  if (dscale > 0 && fracStr.length > 0) {
    return `${prefix}${intStr}.${fracStr}`;
  }
  return `${prefix}${intStr}`;
}

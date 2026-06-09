/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Type descriptor encoding/decoding for Gel binary protocol.
 *
 * Type descriptors describe the shape of query results so clients
 * can decode binary Data payloads. Each descriptor is identified by
 * a 16-byte UUID and begins with a uint8 tag indicating its kind.
 *
 * The descriptor block sent in CommandDataDescription messages is a
 * flat sequence of individually length-prefixed descriptors. The
 * ordering matters: descriptors may reference earlier descriptors by
 * UUID.
 */

import type { TypeDef } from "../compiler/context.ts";
import { sha256 } from "../lib/crypto.ts";
import { BufferReader, BufferWriter } from "./buffer.ts";
import { Cardinality } from "./enums.ts";
import { bytesToUuid, uuidToBytes } from "./types.ts";

// ---------------------------------------------------------------------------
// Descriptor tag constants
// ---------------------------------------------------------------------------

export const DescriptorTag = {
  SET: 0x00,
  OBJECT_SHAPE: 0x01,
  BASE_SCALAR: 0x02,
  ENUM: 0x03,
  ARRAY: 0x04,
  TUPLE: 0x05,
  NAMED_TUPLE: 0x06,
  RANGE: 0x07,
  OBJECT_INPUT: 0x08,
  COMPOUND: 0x09,
  MULTI_RANGE: 0x0a,
  TYPE_ANNOTATION: 0xff
} as const;

export type DescriptorTagValue = (typeof DescriptorTag)[keyof typeof DescriptorTag];

// ---------------------------------------------------------------------------
// Well-known type UUIDs
// ---------------------------------------------------------------------------

const WELL_KNOWN_ENTRIES: Array<[string, string]> = [
  ["std::uuid", "00000000-0000-0000-0000-000000000100"],
  ["std::str", "00000000-0000-0000-0000-000000000101"],
  ["std::bytes", "00000000-0000-0000-0000-000000000102"],
  ["std::int16", "00000000-0000-0000-0000-000000000103"],
  ["std::int32", "00000000-0000-0000-0000-000000000104"],
  ["std::int64", "00000000-0000-0000-0000-000000000105"],
  ["std::float32", "00000000-0000-0000-0000-000000000106"],
  ["std::float64", "00000000-0000-0000-0000-000000000107"],
  ["std::decimal", "00000000-0000-0000-0000-000000000108"],
  ["std::bool", "00000000-0000-0000-0000-000000000109"],
  ["std::datetime", "00000000-0000-0000-0000-00000000010a"],
  ["cal::local_datetime", "00000000-0000-0000-0000-00000000010b"],
  ["cal::local_date", "00000000-0000-0000-0000-00000000010c"],
  ["cal::local_time", "00000000-0000-0000-0000-00000000010d"],
  ["std::duration", "00000000-0000-0000-0000-00000000010e"],
  ["std::json", "00000000-0000-0000-0000-00000000010f"],
  ["std::bigint", "00000000-0000-0000-0000-000000000110"],
  ["cal::relative_duration", "00000000-0000-0000-0000-000000000111"],
  ["cal::date_duration", "00000000-0000-0000-0000-000000000112"],
  ["std::memory", "00000000-0000-0000-0000-000000000130"],
  ["cfg::memory", "00000000-0000-0000-0000-000000000130"]
];

/** Map from qualified type name to 16-byte UUID. */
export const WELL_KNOWN_TYPES: Map<string, Uint8Array> = new Map(
  WELL_KNOWN_ENTRIES.map(([name, uuid]) => [name, uuidToBytes(uuid)])
);

/** Reverse map from UUID hex string to qualified type name. */
export const UUID_TO_TYPE: Map<string, string> = new Map(
  WELL_KNOWN_ENTRIES.map(([name, uuid]) => [uuid, name])
);

/**
 * Short-name aliases so callers can look up "str" instead of "std::str".
 */
const SHORT_NAME_MAP: Map<string, string> = new Map([
  ["uuid", "std::uuid"],
  ["str", "std::str"],
  ["bytes", "std::bytes"],
  ["int16", "std::int16"],
  ["int32", "std::int32"],
  ["int64", "std::int64"],
  ["float32", "std::float32"],
  ["float64", "std::float64"],
  ["decimal", "std::decimal"],
  ["bool", "std::bool"],
  ["datetime", "std::datetime"],
  ["duration", "std::duration"],
  ["json", "std::json"],
  ["bigint", "std::bigint"],
  ["memory", "std::memory"],
  ["local_datetime", "cal::local_datetime"],
  ["local_date", "cal::local_date"],
  ["local_time", "cal::local_time"],
  ["relative_duration", "cal::relative_duration"],
  ["date_duration", "cal::date_duration"]
]);

/**
 * Resolve a type name (short or qualified) to its well-known UUID bytes.
 * Returns undefined if not a well-known type.
 */
export function resolveWellKnownType(name: string): Uint8Array | undefined {
  const direct = WELL_KNOWN_TYPES.get(name);
  if (direct) {
    return direct;
  }
  const qualified = SHORT_NAME_MAP.get(name);
  if (qualified) {
    return WELL_KNOWN_TYPES.get(qualified);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Descriptor interfaces
// ---------------------------------------------------------------------------

export interface BaseScalarDescriptor {
  tag: typeof DescriptorTag.BASE_SCALAR;
  id: Uint8Array; // 16-byte UUID
}

export interface SetDescriptor {
  tag: typeof DescriptorTag.SET;
  id: Uint8Array;
  elementTypeId: Uint8Array;
}

export interface ObjectShapeElement {
  flags: number; // uint32: bit 0 = implicit, bit 1 = link property, bit 2 = link
  cardinality: number; // Cardinality enum value
  name: string;
  typeId: Uint8Array;
}

export interface ObjectShapeDescriptor {
  tag: typeof DescriptorTag.OBJECT_SHAPE;
  id: Uint8Array;
  elements: ObjectShapeElement[];
}

export interface EnumDescriptor {
  tag: typeof DescriptorTag.ENUM;
  id: Uint8Array;
  members: string[];
}

export interface ArrayDescriptor {
  tag: typeof DescriptorTag.ARRAY;
  id: Uint8Array;
  elementTypeId: Uint8Array;
  dimensions: number; // number of dimensions (1 for 1-D arrays)
}

export interface TupleDescriptor {
  tag: typeof DescriptorTag.TUPLE;
  id: Uint8Array;
  elementTypeIds: Uint8Array[];
}

export interface NamedTupleDescriptor {
  tag: typeof DescriptorTag.NAMED_TUPLE;
  id: Uint8Array;
  elements: Array<{ name: string; typeId: Uint8Array; }>;
}

export interface RangeDescriptor {
  tag: typeof DescriptorTag.RANGE;
  id: Uint8Array;
  elementTypeId: Uint8Array;
}

export interface MultiRangeDescriptor {
  tag: typeof DescriptorTag.MULTI_RANGE;
  id: Uint8Array;
  elementTypeId: Uint8Array;
}

export type TypeDescriptor =
  | BaseScalarDescriptor
  | SetDescriptor
  | ObjectShapeDescriptor
  | EnumDescriptor
  | ArrayDescriptor
  | TupleDescriptor
  | NamedTupleDescriptor
  | RangeDescriptor
  | MultiRangeDescriptor;

// ---------------------------------------------------------------------------
// Encoding helpers (single descriptor → bytes)
// ---------------------------------------------------------------------------

function encodeBaseScalar(d: BaseScalarDescriptor): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(d.tag);
  w.writeUUID(d.id);
  return w.toBytes();
}

function encodeSet(d: SetDescriptor): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(d.tag);
  w.writeUUID(d.id);
  w.writeUUID(d.elementTypeId);
  return w.toBytes();
}

function encodeObjectShape(d: ObjectShapeDescriptor): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(d.tag);
  w.writeUUID(d.id);
  w.writeUInt16(d.elements.length);
  for (const el of d.elements) {
    w.writeUInt32(el.flags);
    w.writeUInt8(el.cardinality);
    w.writeString(el.name);
    w.writeUUID(el.typeId);
  }
  return w.toBytes();
}

function encodeEnum(d: EnumDescriptor): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(d.tag);
  w.writeUUID(d.id);
  w.writeUInt16(d.members.length);
  for (const m of d.members) {
    w.writeString(m);
  }
  return w.toBytes();
}

function encodeArray(d: ArrayDescriptor): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(d.tag);
  w.writeUUID(d.id);
  w.writeUUID(d.elementTypeId);
  w.writeUInt16(d.dimensions);
  // Each dimension has a lower bound (int32). Default to 1.
  for (let i = 0; i < d.dimensions; i++) {
    w.writeUInt32(1);
  }
  return w.toBytes();
}

function encodeTuple(d: TupleDescriptor): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(d.tag);
  w.writeUUID(d.id);
  w.writeUInt16(d.elementTypeIds.length);
  for (const tid of d.elementTypeIds) {
    w.writeUUID(tid);
  }
  return w.toBytes();
}

function encodeNamedTuple(d: NamedTupleDescriptor): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(d.tag);
  w.writeUUID(d.id);
  w.writeUInt16(d.elements.length);
  for (const el of d.elements) {
    w.writeString(el.name);
    w.writeUUID(el.typeId);
  }
  return w.toBytes();
}

function encodeRange(d: RangeDescriptor): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(d.tag);
  w.writeUUID(d.id);
  w.writeUUID(d.elementTypeId);
  return w.toBytes();
}

function encodeMultiRange(d: MultiRangeDescriptor): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(d.tag);
  w.writeUUID(d.id);
  w.writeUUID(d.elementTypeId);
  return w.toBytes();
}

function encodeSingleDescriptor(d: TypeDescriptor): Uint8Array {
  switch (d.tag) {
    case DescriptorTag.BASE_SCALAR:
      return encodeBaseScalar(d);
    case DescriptorTag.SET:
      return encodeSet(d);
    case DescriptorTag.OBJECT_SHAPE:
      return encodeObjectShape(d);
    case DescriptorTag.ENUM:
      return encodeEnum(d);
    case DescriptorTag.ARRAY:
      return encodeArray(d);
    case DescriptorTag.TUPLE:
      return encodeTuple(d);
    case DescriptorTag.NAMED_TUPLE:
      return encodeNamedTuple(d);
    case DescriptorTag.RANGE:
      return encodeRange(d);
    case DescriptorTag.MULTI_RANGE:
      return encodeMultiRange(d);
    default:
      throw new Error(
        `Unknown descriptor tag: 0x${(d as TypeDescriptor).tag.toString(16)}`
      );
  }
}

// ---------------------------------------------------------------------------
// Public: encode / decode descriptor blocks
// ---------------------------------------------------------------------------

/**
 * Encode a list of type descriptors into a binary block.
 *
 * Each descriptor is individually length-prefixed (uint32 byte count)
 * so the decoder can step through them sequentially.
 */
export function encodeTypeDescriptors(
  descriptors: TypeDescriptor[]
): Uint8Array {
  const w = new BufferWriter();
  for (const d of descriptors) {
    const encoded = encodeSingleDescriptor(d);
    w.writeLenPrefixedBytes(encoded);
  }
  return w.toBytes();
}

/**
 * Decode a binary block into a list of type descriptors.
 */
export function decodeTypeDescriptors(data: Uint8Array): TypeDescriptor[] {
  const descriptors: TypeDescriptor[] = [];
  const r = new BufferReader(data);

  while (r.remaining > 0) {
    const descBytes = r.readLenPrefixedBytes();
    const dr = new BufferReader(descBytes);
    const tag = dr.readUInt8();

    switch (tag) {
      case DescriptorTag.BASE_SCALAR: {
        const id = dr.readUUID();
        descriptors.push({ tag: DescriptorTag.BASE_SCALAR, id });
        break;
      }
      case DescriptorTag.SET: {
        const id = dr.readUUID();
        const elementTypeId = dr.readUUID();
        descriptors.push({ tag: DescriptorTag.SET, id, elementTypeId });
        break;
      }
      case DescriptorTag.OBJECT_SHAPE: {
        const id = dr.readUUID();
        const count = dr.readUInt16();
        const elements: ObjectShapeElement[] = [];
        for (let i = 0; i < count; i++) {
          const flags = dr.readUInt32();
          const cardinality = dr.readUInt8();
          const name = dr.readString();
          const typeId = dr.readUUID();
          elements.push({ flags, cardinality, name, typeId });
        }
        descriptors.push({ tag: DescriptorTag.OBJECT_SHAPE, id, elements });
        break;
      }
      case DescriptorTag.ENUM: {
        const id = dr.readUUID();
        const count = dr.readUInt16();
        const members: string[] = [];
        for (let i = 0; i < count; i++) {
          members.push(dr.readString());
        }
        descriptors.push({ tag: DescriptorTag.ENUM, id, members });
        break;
      }
      case DescriptorTag.ARRAY: {
        const id = dr.readUUID();
        const elementTypeId = dr.readUUID();
        const dimensions = dr.readUInt16();
        // Skip lower-bound values (one int32 per dimension)
        for (let i = 0; i < dimensions; i++) {
          dr.readUInt32();
        }
        descriptors.push({
          tag: DescriptorTag.ARRAY,
          id,
          elementTypeId,
          dimensions
        });
        break;
      }
      case DescriptorTag.TUPLE: {
        const id = dr.readUUID();
        const count = dr.readUInt16();
        const elementTypeIds: Uint8Array[] = [];
        for (let i = 0; i < count; i++) {
          elementTypeIds.push(dr.readUUID());
        }
        descriptors.push({ tag: DescriptorTag.TUPLE, id, elementTypeIds });
        break;
      }
      case DescriptorTag.NAMED_TUPLE: {
        const id = dr.readUUID();
        const count = dr.readUInt16();
        const elements: Array<{ name: string; typeId: Uint8Array; }> = [];
        for (let i = 0; i < count; i++) {
          const name = dr.readString();
          const typeId = dr.readUUID();
          elements.push({ name, typeId });
        }
        descriptors.push({ tag: DescriptorTag.NAMED_TUPLE, id, elements });
        break;
      }
      case DescriptorTag.RANGE: {
        const id = dr.readUUID();
        const elementTypeId = dr.readUUID();
        descriptors.push({ tag: DescriptorTag.RANGE, id, elementTypeId });
        break;
      }
      case DescriptorTag.MULTI_RANGE: {
        const id = dr.readUUID();
        const elementTypeId = dr.readUUID();
        descriptors.push({ tag: DescriptorTag.MULTI_RANGE, id, elementTypeId });
        break;
      }
      default:
        throw new Error(
          `Unknown descriptor tag during decode: 0x${tag.toString(16)}`
        );
    }
  }

  return descriptors;
}

// ---------------------------------------------------------------------------
// Generate a content-based UUID for a descriptor
// ---------------------------------------------------------------------------

/**
 * Generate a 16-byte descriptor UUID by SHA-256 hashing the content
 * and taking the first 16 bytes. The result is deterministic for the
 * same content.
 */
export async function generateDescriptorId(
  content: Uint8Array
): Promise<Uint8Array> {
  const hash = await sha256(content);
  return hash.slice(0, 16);
}

/**
 * Synchronous version using a simple FNV-1a-like hash for cases where
 * async is inconvenient (e.g., in tests). Produces a deterministic
 * 16-byte value.
 */
export function generateDescriptorIdSync(content: Uint8Array): Uint8Array {
  // FNV-1a 128-bit approximation via two 64-bit halves
  let h1 = 0xcbf29ce484222325n;
  let h2 = 0x100000001b3n;
  const prime = 0x01000000000000000000013bn;

  for (let i = 0; i < content.length; i++) {
    const b = BigInt(content[i]);
    h1 ^= b;
    h1 = BigInt.asUintN(64, h1 * 0x100000001b3n);
    h2 ^= b;
    h2 = BigInt.asUintN(64, h2 * prime);
  }

  const result = new Uint8Array(16);
  const view = new DataView(result.buffer);
  view.setBigUint64(0, h1, false);
  view.setBigUint64(8, h2, false);
  return result;
}

// ---------------------------------------------------------------------------
// Build descriptors from a TypeDef and shape
// ---------------------------------------------------------------------------

/** Flags for ObjectShapeElement */
export const ShapeElementFlags = {
  IMPLICIT: 1 << 0,
  LINK_PROPERTY: 1 << 1,
  LINK: 1 << 2
} as const;

/**
 * Build a type descriptor block for an EdgeQL result shape.
 *
 * Given a TypeDef and a list of shape field names, this produces:
 * 1. BaseScalar descriptors for each scalar type referenced
 * 2. An ObjectShape descriptor for the root result shape
 * 3. A Set descriptor wrapping the root shape
 *
 * For link fields, nested ObjectShape descriptors are created
 * referencing the target type.
 *
 * Returns the full descriptor list and the root (Set) descriptor UUID.
 */
export function buildResultDescriptors(
  typeDef: TypeDef,
  shapeFields: string[],
  schema?: Map<string, TypeDef>
): { descriptors: TypeDescriptor[]; rootId: Uint8Array; } {
  const descriptors: TypeDescriptor[] = [];
  const emittedIds = new Set<string>();

  function emitScalar(edgeqlType: string): Uint8Array {
    const typeId = resolveWellKnownType(edgeqlType);
    if (!typeId) {
      throw new Error(`Unknown scalar type: ${edgeqlType}`);
    }
    const idHex = bytesToUuid(typeId);
    if (!emittedIds.has(idHex)) {
      emittedIds.add(idHex);
      descriptors.push({
        tag: DescriptorTag.BASE_SCALAR,
        id: typeId
      });
    }
    return typeId;
  }

  function buildShapeForType(
    td: TypeDef,
    fields: string[]
  ): Uint8Array {
    const elements: ObjectShapeElement[] = [];

    for (const fieldName of fields) {
      const prop = td.properties.get(fieldName);
      if (prop) {
        const scalarType = prop.edgeqlType ?? prop.type;
        const typeId = emitScalar(scalarType);
        const cardinality = prop.required ?
          Cardinality.ONE :
          Cardinality.AT_MOST_ONE;
        const flags = prop.hasDefault ? ShapeElementFlags.IMPLICIT : 0;
        elements.push({ flags, cardinality, name: fieldName, typeId });
        continue;
      }

      const link = td.links.get(fieldName);
      if (link) {
        // For link fields, build a nested shape with all properties
        // of the target type if schema is available
        let linkTypeId: Uint8Array;
        if (schema) {
          const targetDef = schema.get(link.target);
          if (targetDef) {
            const targetFields = Array.from(targetDef.properties.keys());
            linkTypeId = buildShapeForType(targetDef, targetFields);
          } else {
            // Fallback: emit a uuid scalar for the link id
            linkTypeId = emitScalar("uuid");
          }
        } else {
          linkTypeId = emitScalar("uuid");
        }

        const cardinality = link.multi ?
          Cardinality.MANY :
          (link.required ? Cardinality.ONE : Cardinality.AT_MOST_ONE);
        elements.push({
          flags: ShapeElementFlags.LINK,
          cardinality,
          name: fieldName,
          typeId: linkTypeId
        });
        continue;
      }
    }

    // Build content for deterministic ID
    const idContent = new BufferWriter();
    idContent.writeUInt8(DescriptorTag.OBJECT_SHAPE);
    const textEncoder = new TextEncoder();
    const nameBytes = textEncoder.encode(td.name);
    idContent.writeUInt32(nameBytes.length);
    idContent.writeBytes(nameBytes);
    for (const el of elements) {
      const elNameBytes = textEncoder.encode(el.name);
      idContent.writeUInt32(elNameBytes.length);
      idContent.writeBytes(elNameBytes);
      idContent.writeUUID(el.typeId);
    }
    const shapeId = generateDescriptorIdSync(idContent.toBytes());

    const shapeIdHex = bytesToUuid(shapeId);
    if (!emittedIds.has(shapeIdHex)) {
      emittedIds.add(shapeIdHex);
      descriptors.push({
        tag: DescriptorTag.OBJECT_SHAPE,
        id: shapeId,
        elements
      });
    }

    return shapeId;
  }

  const shapeId = buildShapeForType(typeDef, shapeFields);

  // Wrap in a Set descriptor
  const setIdContent = new BufferWriter();
  setIdContent.writeUInt8(DescriptorTag.SET);
  setIdContent.writeUUID(shapeId);
  const setId = generateDescriptorIdSync(setIdContent.toBytes());

  descriptors.push({
    tag: DescriptorTag.SET,
    id: setId,
    elementTypeId: shapeId
  });

  return { descriptors, rootId: setId };
}

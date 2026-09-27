/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Arrays and tuples on the Gel binary protocol (v2): their type
 * descriptors, and their values' wire formats, over the scalar codecs.
 *
 * A type is named the way Gel spells it: `int64`, `array<str>`,
 * `tuple<int64, str>`, `tuple<a: int64, b: str>`, nested freely.
 *
 * Descriptors (each u32-length-prefixed in the typedesc block, inner types
 * referenced by their position in it):
 *
 *   SET         (=0): [u8 t][16 tid][u16 element pos]
 *   BASE_SCALAR (=2): [u8 t][16 tid]
 *   TUPLE       (=4): [u8 t][16 tid][str name][u8 schema_defined=0]
 *                     [u16 ancestors=0][u16 count][u16 pos]*count
 *   NAMEDTUPLE  (=5): [u8 t][16 tid][str name][u8 schema_defined=0]
 *                     [u16 ancestors=0][u16 count][str name, u16 pos]*count
 *   ARRAY       (=6): [u8 t][16 tid][str name][u8 schema_defined=0]
 *                     [u16 ancestors=0][u16 element pos][u16 dims=1]
 *                     [i32 dim len=-1]
 *
 * Values (elements NULL as length -1):
 *
 *   array: [i32 ndims=1][i32 flags=0][i32 reserved=0][i32 len][i32 lower=1]
 *          then [i32 len][bytes] per element; empty: [i32 0][i32 0][i32 0]
 *   set:   as an array (see `encodeSetValue` for a set of arrays)
 *   tuple: [i32 count] then [i32 reserved=0][i32 len][bytes] per element
 */

import { BufferReader, BufferWriter } from "./buffer.ts";
import { canonicalScalarName, decodeScalar, encodeScalar, hasScalarCodec } from "./scalar-codecs.ts";
import { generateDescriptorIdSync, resolveWellKnownType } from "./typedesc.ts";

/** A wire type: a base scalar, or an array or tuple of wire types. */
export type WireType =
  | { element: WireType; kind: "array"; }
  | { kind: "scalar"; name: string; }
  | { elements: { name?: string; type: WireType; }[]; kind: "tuple"; };

const NULL_LENGTH = 0xffffffff;

/** Split `text` at the commas outside any `<…>`. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "<") {
      depth++;
    } else if (text[i] === ">") {
      depth--;
    } else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim());
}

/** Parse a type name: `array<str>` → an array of str scalars. */
export function parseWireType(name: string): WireType {
  const open = name.indexOf("<");
  if (open === -1 || !name.endsWith(">")) {
    return { kind: "scalar", name: name.trim() };
  }
  const head = name.slice(0, open).trim();
  const params = splitTopLevel(name.slice(open + 1, -1));
  if (head === "array") {
    return { element: parseWireType(params[0]), kind: "array" };
  }
  if (head === "tuple") {
    return {
      elements: params.map(param => {
        // A named element is `name: type`; `::` is a module separator.
        const named = /^(\w+)\s*:(?!:)(.*)$/s.exec(param);
        return named ? { name: named[1], type: parseWireType(named[2]) } : { type: parseWireType(param) };
      }),
      kind: "tuple"
    };
  }
  return { kind: "scalar", name: name.trim() };
}

/** Render a wire type as its name, each scalar named by `scalarName`. */
function formatWireType(type: WireType, scalarName: (name: string) => string): string {
  switch (type.kind) {
    case "array":
      return `array<${formatWireType(type.element, scalarName)}>`;
    case "scalar":
      return scalarName(type.name);
    case "tuple":
      return `tuple<${type.elements.map(el => (el.name ? `${el.name}: ` : "") + formatWireType(el.type, scalarName)).join(", ")}>`;
  }
}

/** A type name with each scalar in it replaced: `array<Count>` → `array<int64>`. */
export function mapWireTypeScalars(name: string, scalarName: (name: string) => string): string {
  return formatWireType(parseWireType(name), scalarName);
}

/** Whether every scalar in the type has a wire codec. */
export function hasWireCodec(name: string): boolean {
  const type = parseWireType(name);
  const check = (t: WireType): boolean =>
    t.kind === "scalar" ? hasScalarCodec(t.name) : t.kind === "array" ? check(t.element) : t.elements.every(el => check(el.type));
  return check(type);
}

/** A typedesc block being built: descriptors, and each type's position in it. */
export interface TypeDescriptorList {
  descriptors: Array<{ bytes: Uint8Array; id: Uint8Array; }>;
  positions: Map<string, number>;
}

/**
 * Append the descriptors `name` needs (inner types first) to `list`, once
 * per type, and return its position. An unknown scalar is described as a
 * uuid, as before collections were described.
 */
export function appendTypeDescriptor(list: TypeDescriptorList, name: string): number {
  return appendType(list, parseWireType(name));
}

function appendType(list: TypeDescriptorList, type: WireType): number {
  const key = formatWireType(type, name => name);
  const known = list.positions.get(key);
  if (known !== undefined) {
    return known;
  }
  const w = new BufferWriter();
  let id: Uint8Array;
  if (type.kind === "scalar") {
    id = resolveWellKnownType(type.name) ?? resolveWellKnownType("uuid")!;
    w.writeUInt8(2);
    w.writeUUID(id);
  } else {
    const inner = type.kind === "array" ? [appendType(list, type.element)] : type.elements.map(el => appendType(list, el.type));
    const typeName = formatWireType(type, canonicalScalarName);
    const named = type.kind === "tuple" && type.elements.some(el => el.name !== undefined);
    id = generateDescriptorIdSync(new TextEncoder().encode(`disc:type:${typeName}`));
    w.writeUInt8(type.kind === "array" ? 6 : named ? 5 : 4);
    w.writeUUID(id);
    w.writeString(typeName);
    w.writeUInt8(0); // schema_defined
    w.writeUInt16(0); // ancestors
    if (type.kind === "array") {
      w.writeUInt16(inner[0]);
      w.writeUInt16(1); // dimensions
      w.writeUInt32(NULL_LENGTH); // dimension length: -1, unbounded
    } else {
      w.writeUInt16(type.elements.length);
      type.elements.forEach((el, i) => {
        if (named) {
          w.writeString(el.name ?? String(i));
        }
        w.writeUInt16(inner[i]);
      });
    }
  }
  const position = list.descriptors.length;
  list.descriptors.push({ bytes: w.toBytes(), id });
  list.positions.set(key, position);
  return position;
}

/**
 * Append a SET descriptor of the type at `elementPos` (once per element
 * type) and return its position: how a multi link, multi property or other
 * set in an object shape is described (Gel's `_describe_set`).
 */
export function appendSetDescriptor(list: TypeDescriptorList, elementPos: number): number {
  const key = `set:${elementPos}`;
  const known = list.positions.get(key);
  if (known !== undefined) {
    return known;
  }
  const elementId = Array.from(list.descriptors[elementPos].id, b => b.toString(16).padStart(2, "0")).join("");
  const id = generateDescriptorIdSync(new TextEncoder().encode(`disc:set:${elementId}`));
  const w = new BufferWriter();
  w.writeUInt8(0);
  w.writeUUID(id);
  w.writeUInt16(elementPos);
  const position = list.descriptors.length;
  list.descriptors.push({ bytes: w.toBytes(), id });
  list.positions.set(key, position);
  return position;
}

/**
 * A set's value from its encoded elements (null for NULL), in Gel's array
 * format. An element that is itself an array goes in a one-element record
 * envelope, `[i32 count=1][i32 reserved=0][i32 len][bytes]`, as the clients'
 * set codecs read it.
 */
export function encodeSetValue(elements: (Uint8Array | null)[], arrayElements: boolean): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt32(elements.length === 0 ? 0 : 1); // ndims
  w.writeUInt32(0); // flags
  w.writeUInt32(0); // reserved
  if (elements.length === 0) {
    return w.toBytes();
  }
  w.writeUInt32(elements.length);
  w.writeUInt32(1); // lower bound
  for (const element of elements) {
    if (element === null) {
      w.writeUInt32(NULL_LENGTH);
    } else if (arrayElements) {
      const envelope = new BufferWriter();
      envelope.writeUInt32(1); // count
      envelope.writeUInt32(0); // reserved
      envelope.writeLenPrefixedBytes(element);
      w.writeLenPrefixedBytes(envelope.toBytes());
    } else {
      w.writeLenPrefixedBytes(element);
    }
  }
  return w.toBytes();
}

/** Write `value` as `[i32 len][bytes]`, or `[i32 -1]` for NULL. */
function writeElement(w: BufferWriter, type: WireType, value: unknown): void {
  if (value === null || value === undefined) {
    w.writeUInt32(NULL_LENGTH);
    return;
  }
  w.writeLenPrefixedBytes(encodeValue(type, value));
}

function encodeValue(type: WireType, value: unknown): Uint8Array {
  if (type.kind === "scalar") {
    return encodeScalar(type.name, value);
  }
  const w = new BufferWriter();
  if (type.kind === "array") {
    const items = value as unknown[];
    if (!Array.isArray(items)) {
      throw new TypeError(`expected an array, got ${typeof value}`);
    }
    w.writeUInt32(items.length === 0 ? 0 : 1); // ndims
    w.writeUInt32(0); // flags
    w.writeUInt32(0); // reserved
    if (items.length > 0) {
      w.writeUInt32(items.length);
      w.writeUInt32(1); // lower bound
      for (const item of items) {
        writeElement(w, type.element, item);
      }
    }
    return w.toBytes();
  }
  // A tuple arrives as a JSON array; a named one as an object by name.
  if (!value || typeof value !== "object") {
    throw new TypeError(`expected a tuple, got ${typeof value}`);
  }
  w.writeUInt32(type.elements.length);
  type.elements.forEach((el, i) => {
    w.writeUInt32(0); // reserved
    writeElement(w, el.type, Array.isArray(value) ? value[i] : (value as Record<string, unknown>)[el.name ?? String(i)]);
  });
  return w.toBytes();
}

/** Encode `value` as the Gel-wire bytes of the type `name` (no length prefix). */
export function encodeWireValue(name: string, value: unknown): Uint8Array {
  return encodeValue(parseWireType(name), value);
}

/** Read a signed i32 length: -1 is NULL. */
function readLength(r: BufferReader): number {
  const length = r.readUInt32();
  return length === NULL_LENGTH ? -1 : length;
}

function decodeValue(type: WireType, bytes: Uint8Array): unknown {
  if (type.kind === "scalar") {
    return decodeScalar(type.name, bytes);
  }
  const r = new BufferReader(bytes);
  const element = (t: WireType): unknown => {
    const length = readLength(r);
    return length === -1 ? null : decodeValue(t, r.readBytes(length));
  };
  if (type.kind === "array") {
    const ndims = r.readUInt32();
    r.readUInt32(); // flags
    r.readUInt32(); // reserved
    if (ndims === 0) {
      return [];
    }
    const length = r.readUInt32();
    r.readUInt32(); // lower bound
    return Array.from({ length }, () => element(type.element));
  }
  r.readUInt32(); // count
  const values = type.elements.map(el => {
    r.readUInt32(); // reserved
    return element(el.type);
  });
  const named = type.elements.some(el => el.name !== undefined);
  return named ? Object.fromEntries(type.elements.map((el, i) => [el.name ?? String(i), values[i]])) : values;
}

/** Decode Gel-wire bytes of the type `name` to a JS value (tuples as arrays, named tuples as objects). */
export function decodeWireValue(name: string, bytes: Uint8Array): unknown {
  return decodeValue(parseWireType(name), bytes);
}

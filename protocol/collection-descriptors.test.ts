/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Arrays and tuples over the binary protocol: a selected array, tuple or
 * named tuple (a literal, a cast, an array or tuple property, `array_agg`,
 * `enumerate`) is described by Gel's array / tuple / named-tuple type
 * descriptors, and its values are encoded in Gel's array and tuple wire
 * formats. Each of these used to fall back to the `Object { id }`
 * descriptor.
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { buildOutputDescriptor, inferOutputShape } from "./binary-server.ts";
import { BufferReader } from "./buffer.ts";
import { decodeWireValue, encodeWireValue } from "./collection-codecs.ts";
import { Cardinality } from "./enums.ts";
import { bytesToUuid } from "./types.ts";

const schema = {
  scalars: new Map([["Count", "int64"]]),
  types: new Map([
    ["Item", {
      links: new Map(),
      properties: new Map([
        ["counts", { edgeqlType: "array<Count>", multi: false, required: false, type: "bigint[]" }],
        ["named", { edgeqlType: "tuple<a: int64, b: str>", multi: false, required: false, type: "jsonb" }],
        ["pair", { edgeqlType: "tuple<int64, str>", multi: false, required: true, type: "jsonb" }],
        ["tags", { edgeqlType: "array<str>", multi: false, required: false, type: "text[]" }]
      ])
    }]
  ])
};

/*** Type and cardinality of a selected expression. ***/
function described(query: string): { cardinality?: number; isScalar?: boolean; type: string; } {
  const shape = inferOutputShape(new EdgeQLParser(query).parse(), schema);
  return { cardinality: shape.cardinality, isScalar: shape.isScalar, type: shape.fields[0].edgeqlType };
}

Deno.test("selected arrays and tuples are described by their collection type", () => {
  const { AT_LEAST_ONE, MANY, ONE } = Cardinality;
  const cases: [string, string, number][] = [
    ["select [1, 2]", "array<int64>", ONE],
    ["select [1, 2.5]", "array<float64>", ONE],
    ["select ['a', <str>$x]", "array<str>", ONE],
    ["select <array<str>>$x", "array<str>", ONE],
    ["select <array<Count>>[]", "array<int64>", ONE],
    ["select (1, 'a')", "tuple<int64, str>", ONE],
    ["select (a := 1, b := 'x')", "tuple<a: int64, b: str>", ONE],
    ["select ([1], ('a', true))", "tuple<array<int64>, tuple<str, bool>>", ONE],
    ["select [(1, 'a')]", "array<tuple<int64, str>>", ONE],
    ["select array_agg({1, 2})", "array<int64>", ONE],
    ["select array_agg(Item.pair)", "array<tuple<int64, str>>", ONE],
    ["select enumerate({'a', 'b'})", "tuple<int64, str>", AT_LEAST_ONE],
    ["select Item.tags", "array<str>", MANY],
    ["select Item.counts", "array<int64>", MANY],
    ["select Item.pair", "tuple<int64, str>", MANY],
    ["select Item.named", "tuple<a: int64, b: str>", MANY]
  ];
  for (const [query, type, cardinality] of cases) {
    assertEquals(described(query), { cardinality, isScalar: true, type }, query);
  }
  const shape = inferOutputShape(new EdgeQLParser("select Item { tags, counts, pair, named }").parse(), schema);
  assertEquals(shape.fields.map(f => [f.name, f.edgeqlType]), [
    ["tags", "array<str>"],
    ["counts", "array<int64>"],
    ["pair", "tuple<int64, str>"],
    ["named", "tuple<a: int64, b: str>"]
  ]);
});

Deno.test("indexes, slices, tuple elements and united tuples are described by Gel's types", () => {
  const { AT_LEAST_ONE, MANY, ONE } = Cardinality;
  const cases: [string, string, number][] = [
    ["select [10, 20, 30][1:3]", "array<int64>", ONE],
    ["select [10, 20, 30][0]", "int64", ONE],
    ["select 'hello'[1:-1]", "str", ONE],
    ["select 'abc'[1]", "str", ONE],
    ["select b'abc'[1:]", "bytes", ONE],
    ["select Item.tags[0]", "str", MANY],
    ["select (a := 1).a", "int64", ONE],
    ["select (1, 'x').1", "str", ONE],
    ["select [(n := 1)][0].n", "int64", ONE],
    ["select Item.named.1", "str", MANY],
    // Gel unites tuples of different names as unnamed ones.
    ["select [(a := 1)] ++ [(2,)]", "array<tuple<int64>>", ONE],
    ["select [(a := 1)] ++ [(a := 2)]", "array<tuple<a: int64>>", ONE],
    ["select [(a := 1), (b := 2)]", "array<tuple<int64>>", ONE],
    ["select {(a := 1), (2,)}", "tuple<int64>", AT_LEAST_ONE],
    ["select (a := 1) union (a := 2)", "tuple<a: int64>", AT_LEAST_ONE],
    // Arrays of arrays are query values.
    ["select [[1, 2], [3]]", "array<array<int64>>", ONE],
    ["select [[1, 2], [3]][0]", "array<int64>", ONE],
    ["select array_agg([1, 2])", "array<array<int64>>", ONE]
  ];
  for (const [query, type, cardinality] of cases) {
    assertEquals(described(query), { cardinality, isScalar: true, type }, query);
  }
});

/*** A descriptor block split into its descriptors, decoded into readable form. ***/
function descriptors(block: Uint8Array): unknown[] {
  const out: unknown[] = [];
  const blockReader = new BufferReader(block);
  while (blockReader.remaining > 0) {
    const r = new BufferReader(blockReader.readLenPrefixedBytes());
    const tag = r.readUInt8();
    const id = bytesToUuid(r.readBytes(16));
    if (tag === 2) {
      out.push({ id, tag });
      continue;
    }
    if (tag === 1) {
      r.readUInt8();
      r.readUInt16();
      const count = r.readUInt16();
      const fields: unknown[] = [];
      for (let i = 0; i < count; i++) {
        r.readUInt32();
        r.readUInt8();
        fields.push([r.readString(), r.readUInt16()]);
        r.readUInt16();
      }
      out.push({ fields, tag });
      continue;
    }
    const name = r.readString();
    const schemaDefined = r.readUInt8();
    const ancestors = r.readUInt16();
    if (tag === 6) {
      const element = r.readUInt16();
      out.push({ ancestors, dimensions: [r.readUInt16(), r.readUInt32()], element, name, schemaDefined, tag });
      continue;
    }
    const count = r.readUInt16();
    const elements: unknown[] = [];
    for (let i = 0; i < count; i++) {
      elements.push(tag === 5 ? [r.readString(), r.readUInt16()] : r.readUInt16());
    }
    out.push({ ancestors, elements, name, schemaDefined, tag });
  }
  return out;
}

const INT64 = { id: "00000000-0000-0000-0000-000000000105", tag: 2 };
const STR = { id: "00000000-0000-0000-0000-000000000101", tag: 2 };

Deno.test("array, tuple and named-tuple descriptors follow Gel's v2 layouts", () => {
  const scalarRoot = (type: string): unknown[] =>
    descriptors(buildOutputDescriptor({ fields: [{ cardinality: Cardinality.ONE, edgeqlType: type, name: "_value" }], isScalar: true, typeName: type }).data);

  // [u8 6][id][str name][u8 schema_defined][u16 ancestors][u16 element pos][u16 dims][i32 dim len = -1]
  const [elementDim, element] = [1, 0];
  assertEquals(scalarRoot("array<int64>"), [INT64, {
    ancestors: 0,
    dimensions: [elementDim, 0xffffffff],
    element,
    name: "array<std::int64>",
    schemaDefined: 0,
    tag: 6
  }]);
  // [u8 4][id][str name][u8 schema_defined][u16 ancestors][u16 count][u16 pos...]
  assertEquals(scalarRoot("tuple<int64, str, int64>"), [INT64, STR, {
    ancestors: 0,
    elements: [0, 1, 0],
    name: "tuple<std::int64, std::str, std::int64>",
    schemaDefined: 0,
    tag: 4
  }]);
  // [u8 5][id][str name][u8 schema_defined][u16 ancestors][u16 count][(str name, u16 pos)...]
  assertEquals(scalarRoot("tuple<a: int64, b: str>"), [INT64, STR, {
    ancestors: 0,
    elements: [["a", 0], ["b", 1]],
    name: "tuple<a: std::int64, b: std::str>",
    schemaDefined: 0,
    tag: 5
  }]);
  // Nested collections reference their inner descriptors by position.
  assertEquals(scalarRoot("array<tuple<int64, str>>"), [INT64, STR, {
    ancestors: 0,
    elements: [0, 1],
    name: "tuple<std::int64, std::str>",
    schemaDefined: 0,
    tag: 4
  }, { ancestors: 0, dimensions: [1, 0xffffffff], element: 2, name: "array<tuple<std::int64, std::str>>", schemaDefined: 0, tag: 6 }]);

  // An object shape's collection field points at the collection descriptor.
  const shape = inferOutputShape(new EdgeQLParser("select Item { tags, pair }").parse(), schema);
  const block = descriptors(buildOutputDescriptor(shape).data);
  assertEquals(block[block.length - 1], { fields: [["tags", 1], ["pair", 3]], tag: 1 });
  assertEquals((block[1] as { name: string; }).name, "array<std::str>");
  assertEquals((block[3] as { name: string; }).name, "tuple<std::int64, std::str>");
});

Deno.test("array and tuple values round-trip through Gel's wire formats", () => {
  const cases: [string, unknown, unknown][] = [
    ["array<int64>", [1, 2n, "3"], [1n, 2n, 3n]],
    ["array<str>", ["a", null, "c"], ["a", null, "c"]],
    ["array<str>", [], []],
    ["tuple<int64, str>", [1, "a"], [1n, "a"]],
    ["tuple<a: int64, b: str>", { a: 1, b: "x" }, { a: 1n, b: "x" }],
    ["tuple<a: int64, b: str>", [2, "y"], { a: 2n, b: "y" }],
    ["array<tuple<int64, str>>", [[1, "a"], [2, "b"]], [[1n, "a"], [2n, "b"]]],
    ["tuple<array<float64>, bool>", [["1.5", 2], true], [[1.5, 2], true]]
  ];
  for (const [type, value, decoded] of cases) {
    assertEquals(decodeWireValue(type, encodeWireValue(type, value)), decoded, type);
  }

  // Gel's layouts: an array is [i32 ndims=1][i32 flags=0][i32 reserved=0]
  // [i32 len][i32 lower=1] then [i32 len][bytes] per element; an empty one
  // is just [i32 ndims=0][i32 0][i32 0]. A tuple is [i32 count] then
  // [i32 reserved=0][i32 len][bytes] per element.
  assertEquals([...encodeWireValue("array<str>", [])], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assertEquals([...encodeWireValue("array<str>", ["a"])], [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 97]);
  assertEquals([...encodeWireValue("tuple<str>", ["a"])], [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 97]);
});

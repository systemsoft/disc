/**
 * Tests for type descriptor encoding/decoding.
 */

import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import { Cardinality } from "./enums.ts";
import { bytesToUuid, uuidToBytes } from "./types.ts";
import {
  type ArrayDescriptor,
  type BaseScalarDescriptor,
  buildResultDescriptors,
  decodeTypeDescriptors,
  DescriptorTag,
  encodeTypeDescriptors,
  type EnumDescriptor,
  generateDescriptorId,
  generateDescriptorIdSync,
  type MultiRangeDescriptor,
  type NamedTupleDescriptor,
  type ObjectShapeDescriptor,
  type RangeDescriptor,
  resolveWellKnownType,
  type SetDescriptor,
  ShapeElementFlags,
  type TupleDescriptor,
  type TypeDescriptor,
  UUID_TO_TYPE,
  WELL_KNOWN_TYPES,
} from "./typedesc.ts";
import type { TypeDef } from "../compiler/context.ts";

// ---------------------------------------------------------------------------
// Well-known type UUID lookups
// ---------------------------------------------------------------------------

Deno.test("WELL_KNOWN_TYPES - contains std::str", () => {
  const strId = WELL_KNOWN_TYPES.get("std::str");
  assertEquals(strId !== undefined, true);
  assertEquals(bytesToUuid(strId!), "00000000-0000-0000-0000-000000000101");
});

Deno.test("WELL_KNOWN_TYPES - contains std::int64", () => {
  const id = WELL_KNOWN_TYPES.get("std::int64");
  assertEquals(id !== undefined, true);
  assertEquals(bytesToUuid(id!), "00000000-0000-0000-0000-000000000105");
});

Deno.test("WELL_KNOWN_TYPES - contains cal::local_date", () => {
  const id = WELL_KNOWN_TYPES.get("cal::local_date");
  assertEquals(id !== undefined, true);
  assertEquals(bytesToUuid(id!), "00000000-0000-0000-0000-00000000010c");
});

Deno.test("UUID_TO_TYPE - reverse lookup works", () => {
  const name = UUID_TO_TYPE.get("00000000-0000-0000-0000-000000000101");
  assertEquals(name, "std::str");
});

Deno.test("resolveWellKnownType - short name lookup", () => {
  const id = resolveWellKnownType("str");
  assertEquals(id !== undefined, true);
  assertEquals(bytesToUuid(id!), "00000000-0000-0000-0000-000000000101");
});

Deno.test("resolveWellKnownType - qualified name lookup", () => {
  const id = resolveWellKnownType("std::datetime");
  assertEquals(id !== undefined, true);
  assertEquals(bytesToUuid(id!), "00000000-0000-0000-0000-00000000010a");
});

Deno.test("resolveWellKnownType - returns undefined for unknown", () => {
  assertEquals(resolveWellKnownType("not_a_type"), undefined);
});

// ---------------------------------------------------------------------------
// BaseScalar encode/decode round-trip
// ---------------------------------------------------------------------------

Deno.test("BaseScalar - encode/decode round-trip", () => {
  const desc: BaseScalarDescriptor = {
    tag: DescriptorTag.BASE_SCALAR,
    id: uuidToBytes("00000000-0000-0000-0000-000000000101"),
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  assertEquals(decoded[0].tag, DescriptorTag.BASE_SCALAR);
  assertEquals(
    bytesToUuid((decoded[0] as BaseScalarDescriptor).id),
    "00000000-0000-0000-0000-000000000101",
  );
});

// ---------------------------------------------------------------------------
// ObjectShape encode/decode with elements
// ---------------------------------------------------------------------------

Deno.test("ObjectShape - encode/decode with elements", () => {
  const shapeId = uuidToBytes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  const strTypeId = uuidToBytes("00000000-0000-0000-0000-000000000101");
  const intTypeId = uuidToBytes("00000000-0000-0000-0000-000000000104");

  const desc: ObjectShapeDescriptor = {
    tag: DescriptorTag.OBJECT_SHAPE,
    id: shapeId,
    elements: [
      {
        flags: 0,
        cardinality: Cardinality.ONE,
        name: "name",
        typeId: strTypeId,
      },
      {
        flags: ShapeElementFlags.IMPLICIT,
        cardinality: Cardinality.AT_MOST_ONE,
        name: "age",
        typeId: intTypeId,
      },
    ],
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  const d = decoded[0] as ObjectShapeDescriptor;
  assertEquals(d.tag, DescriptorTag.OBJECT_SHAPE);
  assertEquals(bytesToUuid(d.id), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assertEquals(d.elements.length, 2);
  assertEquals(d.elements[0].name, "name");
  assertEquals(d.elements[0].flags, 0);
  assertEquals(d.elements[0].cardinality, Cardinality.ONE);
  assertEquals(bytesToUuid(d.elements[0].typeId), bytesToUuid(strTypeId));
  assertEquals(d.elements[1].name, "age");
  assertEquals(d.elements[1].flags, ShapeElementFlags.IMPLICIT);
  assertEquals(d.elements[1].cardinality, Cardinality.AT_MOST_ONE);
});

// ---------------------------------------------------------------------------
// Enum descriptor encode/decode
// ---------------------------------------------------------------------------

Deno.test("Enum - encode/decode round-trip", () => {
  const desc: EnumDescriptor = {
    tag: DescriptorTag.ENUM,
    id: uuidToBytes("11111111-2222-3333-4444-555555555555"),
    members: ["active", "inactive", "pending"],
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  const d = decoded[0] as EnumDescriptor;
  assertEquals(d.tag, DescriptorTag.ENUM);
  assertEquals(d.members, ["active", "inactive", "pending"]);
});

// ---------------------------------------------------------------------------
// Array descriptor encode/decode
// ---------------------------------------------------------------------------

Deno.test("Array - encode/decode round-trip", () => {
  const desc: ArrayDescriptor = {
    tag: DescriptorTag.ARRAY,
    id: uuidToBytes("22222222-3333-4444-5555-666666666666"),
    elementTypeId: uuidToBytes("00000000-0000-0000-0000-000000000101"),
    dimensions: 1,
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  const d = decoded[0] as ArrayDescriptor;
  assertEquals(d.tag, DescriptorTag.ARRAY);
  assertEquals(d.dimensions, 1);
  assertEquals(
    bytesToUuid(d.elementTypeId),
    "00000000-0000-0000-0000-000000000101",
  );
});

Deno.test("Array - multi-dimensional encode/decode", () => {
  const desc: ArrayDescriptor = {
    tag: DescriptorTag.ARRAY,
    id: uuidToBytes("33333333-4444-5555-6666-777777777777"),
    elementTypeId: uuidToBytes("00000000-0000-0000-0000-000000000104"),
    dimensions: 3,
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  const d = decoded[0] as ArrayDescriptor;
  assertEquals(d.dimensions, 3);
});

// ---------------------------------------------------------------------------
// Tuple descriptor encode/decode
// ---------------------------------------------------------------------------

Deno.test("Tuple - encode/decode round-trip", () => {
  const strId = uuidToBytes("00000000-0000-0000-0000-000000000101");
  const intId = uuidToBytes("00000000-0000-0000-0000-000000000104");
  const boolId = uuidToBytes("00000000-0000-0000-0000-000000000109");

  const desc: TupleDescriptor = {
    tag: DescriptorTag.TUPLE,
    id: uuidToBytes("44444444-5555-6666-7777-888888888888"),
    elementTypeIds: [strId, intId, boolId],
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  const d = decoded[0] as TupleDescriptor;
  assertEquals(d.tag, DescriptorTag.TUPLE);
  assertEquals(d.elementTypeIds.length, 3);
  assertEquals(bytesToUuid(d.elementTypeIds[0]), bytesToUuid(strId));
  assertEquals(bytesToUuid(d.elementTypeIds[1]), bytesToUuid(intId));
  assertEquals(bytesToUuid(d.elementTypeIds[2]), bytesToUuid(boolId));
});

// ---------------------------------------------------------------------------
// NamedTuple descriptor encode/decode
// ---------------------------------------------------------------------------

Deno.test("NamedTuple - encode/decode round-trip", () => {
  const strId = uuidToBytes("00000000-0000-0000-0000-000000000101");
  const intId = uuidToBytes("00000000-0000-0000-0000-000000000104");

  const desc: NamedTupleDescriptor = {
    tag: DescriptorTag.NAMED_TUPLE,
    id: uuidToBytes("55555555-6666-7777-8888-999999999999"),
    elements: [
      { name: "first_name", typeId: strId },
      { name: "age", typeId: intId },
    ],
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  const d = decoded[0] as NamedTupleDescriptor;
  assertEquals(d.tag, DescriptorTag.NAMED_TUPLE);
  assertEquals(d.elements.length, 2);
  assertEquals(d.elements[0].name, "first_name");
  assertEquals(d.elements[1].name, "age");
  assertEquals(bytesToUuid(d.elements[0].typeId), bytesToUuid(strId));
  assertEquals(bytesToUuid(d.elements[1].typeId), bytesToUuid(intId));
});

// ---------------------------------------------------------------------------
// Range / MultiRange encode/decode
// ---------------------------------------------------------------------------

Deno.test("Range - encode/decode round-trip", () => {
  const desc: RangeDescriptor = {
    tag: DescriptorTag.RANGE,
    id: uuidToBytes("66666666-7777-8888-9999-aaaaaaaaaaaa"),
    elementTypeId: uuidToBytes("00000000-0000-0000-0000-000000000104"),
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  const d = decoded[0] as RangeDescriptor;
  assertEquals(d.tag, DescriptorTag.RANGE);
  assertEquals(
    bytesToUuid(d.elementTypeId),
    "00000000-0000-0000-0000-000000000104",
  );
});

Deno.test("MultiRange - encode/decode round-trip", () => {
  const desc: MultiRangeDescriptor = {
    tag: DescriptorTag.MULTI_RANGE,
    id: uuidToBytes("77777777-8888-9999-aaaa-bbbbbbbbbbbb"),
    elementTypeId: uuidToBytes("00000000-0000-0000-0000-000000000105"),
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  const d = decoded[0] as MultiRangeDescriptor;
  assertEquals(d.tag, DescriptorTag.MULTI_RANGE);
  assertEquals(
    bytesToUuid(d.elementTypeId),
    "00000000-0000-0000-0000-000000000105",
  );
});

// ---------------------------------------------------------------------------
// Multiple descriptors in sequence
// ---------------------------------------------------------------------------

Deno.test("multiple descriptors - encode/decode sequence", () => {
  const strScalar: BaseScalarDescriptor = {
    tag: DescriptorTag.BASE_SCALAR,
    id: uuidToBytes("00000000-0000-0000-0000-000000000101"),
  };

  const intScalar: BaseScalarDescriptor = {
    tag: DescriptorTag.BASE_SCALAR,
    id: uuidToBytes("00000000-0000-0000-0000-000000000104"),
  };

  const shape: ObjectShapeDescriptor = {
    tag: DescriptorTag.OBJECT_SHAPE,
    id: uuidToBytes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    elements: [
      {
        flags: 0,
        cardinality: Cardinality.ONE,
        name: "name",
        typeId: strScalar.id,
      },
      {
        flags: 0,
        cardinality: Cardinality.AT_MOST_ONE,
        name: "count",
        typeId: intScalar.id,
      },
    ],
  };

  const setDesc: SetDescriptor = {
    tag: DescriptorTag.SET,
    id: uuidToBytes("bbbbbbbb-cccc-dddd-eeee-ffffffffffff"),
    elementTypeId: shape.id,
  };

  const descriptors: TypeDescriptor[] = [strScalar, intScalar, shape, setDesc];
  const encoded = encodeTypeDescriptors(descriptors);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 4);
  assertEquals(decoded[0].tag, DescriptorTag.BASE_SCALAR);
  assertEquals(decoded[1].tag, DescriptorTag.BASE_SCALAR);
  assertEquals(decoded[2].tag, DescriptorTag.OBJECT_SHAPE);
  assertEquals(decoded[3].tag, DescriptorTag.SET);

  const decodedSet = decoded[3] as SetDescriptor;
  assertEquals(
    bytesToUuid(decodedSet.elementTypeId),
    "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  );
});

// ---------------------------------------------------------------------------
// Set descriptor encode/decode
// ---------------------------------------------------------------------------

Deno.test("Set - encode/decode round-trip", () => {
  const desc: SetDescriptor = {
    tag: DescriptorTag.SET,
    id: uuidToBytes("88888888-9999-aaaa-bbbb-cccccccccccc"),
    elementTypeId: uuidToBytes("00000000-0000-0000-0000-000000000101"),
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  const d = decoded[0] as SetDescriptor;
  assertEquals(d.tag, DescriptorTag.SET);
  assertEquals(
    bytesToUuid(d.elementTypeId),
    "00000000-0000-0000-0000-000000000101",
  );
});

// ---------------------------------------------------------------------------
// buildResultDescriptors from TypeDef
// ---------------------------------------------------------------------------

Deno.test("buildResultDescriptors - simple object", () => {
  const userType: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
      }],
    ]),
    links: new Map(),
  };

  const result = buildResultDescriptors(userType, ["name", "email"]);

  // Should have: 1 BaseScalar for str (deduplicated), 1 ObjectShape, 1 Set
  assertEquals(result.descriptors.length, 3);

  // First is the str scalar
  assertEquals(result.descriptors[0].tag, DescriptorTag.BASE_SCALAR);
  assertEquals(
    bytesToUuid(result.descriptors[0].id),
    "00000000-0000-0000-0000-000000000101",
  );

  // Second is the object shape
  assertEquals(result.descriptors[1].tag, DescriptorTag.OBJECT_SHAPE);
  const shape = result.descriptors[1] as ObjectShapeDescriptor;
  assertEquals(shape.elements.length, 2);
  assertEquals(shape.elements[0].name, "name");
  assertEquals(shape.elements[1].name, "email");

  // Third is the set wrapper
  assertEquals(result.descriptors[2].tag, DescriptorTag.SET);
  const set = result.descriptors[2] as SetDescriptor;
  assertEquals(bytesToUuid(set.elementTypeId), bytesToUuid(shape.id));

  // Root ID should match the set descriptor
  assertEquals(bytesToUuid(result.rootId), bytesToUuid(set.id));
});

Deno.test("buildResultDescriptors - empty shape", () => {
  const emptyType: TypeDef = {
    name: "Empty",
    kind: "object",
    tableName: "empty",
    properties: new Map(),
    links: new Map(),
  };

  const result = buildResultDescriptors(emptyType, []);

  // ObjectShape with 0 elements + Set
  assertEquals(result.descriptors.length, 2);
  assertEquals(result.descriptors[0].tag, DescriptorTag.OBJECT_SHAPE);
  assertEquals(
    (result.descriptors[0] as ObjectShapeDescriptor).elements.length,
    0,
  );
  assertEquals(result.descriptors[1].tag, DescriptorTag.SET);
});

Deno.test("buildResultDescriptors - mixed scalar types", () => {
  const type: TypeDef = {
    name: "Mixed",
    kind: "object",
    tableName: "mixed",
    properties: new Map([
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
      }],
      ["age", {
        name: "age",
        type: "int32",
        required: false,
        multi: false,
        columnName: "age",
        edgeqlType: "int32",
      }],
      ["active", {
        name: "active",
        type: "bool",
        required: true,
        multi: false,
        columnName: "active",
        edgeqlType: "bool",
      }],
    ]),
    links: new Map(),
  };

  const result = buildResultDescriptors(type, ["name", "age", "active"]);

  // 3 base scalars (str, int32, bool) + 1 object shape + 1 set
  assertEquals(result.descriptors.length, 5);

  const scalars = result.descriptors.filter(
    (d) => d.tag === DescriptorTag.BASE_SCALAR,
  );
  assertEquals(scalars.length, 3);
});

// ---------------------------------------------------------------------------
// buildResultDescriptors - nested shape (object with links)
// ---------------------------------------------------------------------------

Deno.test("buildResultDescriptors - nested shape with links", () => {
  const postType: TypeDef = {
    name: "Post",
    kind: "object",
    tableName: "posts",
    properties: new Map([
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
        edgeqlType: "str",
      }],
    ]),
    links: new Map(),
  };

  const userType: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    properties: new Map([
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str",
      }],
    ]),
    links: new Map([
      ["posts", {
        name: "posts",
        target: "Post",
        required: false,
        multi: true,
        backlink: "author",
      }],
    ]),
  };

  const schema = new Map<string, TypeDef>([
    ["User", userType],
    ["Post", postType],
  ]);

  const result = buildResultDescriptors(
    userType,
    ["name", "posts"],
    schema,
  );

  // Should include: str scalar, Post ObjectShape, User ObjectShape, Set
  // str is used by both name and title (deduplicated)
  const shapes = result.descriptors.filter(
    (d) => d.tag === DescriptorTag.OBJECT_SHAPE,
  );
  assertEquals(shapes.length, 2); // Post shape + User shape

  // User shape should have a link element
  const userShape = shapes.find((s) => {
    const os = s as ObjectShapeDescriptor;
    return os.elements.some((e) => e.name === "name");
  }) as ObjectShapeDescriptor;
  assertEquals(userShape !== undefined, true);
  const postsEl = userShape.elements.find((e) => e.name === "posts");
  assertEquals(postsEl !== undefined, true);
  assertEquals(postsEl!.flags, ShapeElementFlags.LINK);
  assertEquals(postsEl!.cardinality, Cardinality.MANY);
});

// ---------------------------------------------------------------------------
// generateDescriptorId
// ---------------------------------------------------------------------------

Deno.test("generateDescriptorId - deterministic for same content", async () => {
  const content = new Uint8Array([1, 2, 3, 4, 5]);
  const id1 = await generateDescriptorId(content);
  const id2 = await generateDescriptorId(content);
  assertEquals(bytesToUuid(id1), bytesToUuid(id2));
});

Deno.test("generateDescriptorId - different for different content", async () => {
  const id1 = await generateDescriptorId(new Uint8Array([1, 2, 3]));
  const id2 = await generateDescriptorId(new Uint8Array([4, 5, 6]));
  assertNotEquals(bytesToUuid(id1), bytesToUuid(id2));
});

Deno.test("generateDescriptorIdSync - deterministic", () => {
  const content = new Uint8Array([10, 20, 30, 40]);
  const id1 = generateDescriptorIdSync(content);
  const id2 = generateDescriptorIdSync(content);
  assertEquals(bytesToUuid(id1), bytesToUuid(id2));
  assertEquals(id1.length, 16);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("ObjectShape - empty elements", () => {
  const desc: ObjectShapeDescriptor = {
    tag: DescriptorTag.OBJECT_SHAPE,
    id: uuidToBytes("99999999-aaaa-bbbb-cccc-dddddddddddd"),
    elements: [],
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  assertEquals(
    (decoded[0] as ObjectShapeDescriptor).elements.length,
    0,
  );
});

Deno.test("Enum - empty members", () => {
  const desc: EnumDescriptor = {
    tag: DescriptorTag.ENUM,
    id: uuidToBytes("aabbccdd-1122-3344-5566-778899aabbcc"),
    members: [],
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  assertEquals((decoded[0] as EnumDescriptor).members.length, 0);
});

Deno.test("Tuple - empty elements", () => {
  const desc: TupleDescriptor = {
    tag: DescriptorTag.TUPLE,
    id: uuidToBytes("dddddddd-eeee-ffff-0000-111111111111"),
    elementTypeIds: [],
  };

  const encoded = encodeTypeDescriptors([desc]);
  const decoded = decodeTypeDescriptors(encoded);

  assertEquals(decoded.length, 1);
  assertEquals(
    (decoded[0] as TupleDescriptor).elementTypeIds.length,
    0,
  );
});

Deno.test("empty descriptor block - decode returns empty array", () => {
  const decoded = decodeTypeDescriptors(new Uint8Array(0));
  assertEquals(decoded.length, 0);
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for type codec encoding/decoding.
 */

import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import { Cardinality } from "./enums.ts";
import {
  decodeScalarValue,
  encodeObjectValue,
  encodeScalarValue
} from "./type-codec.ts";
import {
  DescriptorTag,
  type ObjectShapeDescriptor,
  type TypeDescriptor
} from "./typedesc.ts";
import { bytesToUuid, uuidToBytes } from "./types.ts";

// ---------------------------------------------------------------------------
// str encode/decode
// ---------------------------------------------------------------------------

Deno.test("str - encode/decode round-trip", () => {
  const encoded = encodeScalarValue("str", "hello world");
  const decoded = decodeScalarValue("str", encoded);
  assertEquals(decoded, "hello world");
});

Deno.test("str - empty string", () => {
  const encoded = encodeScalarValue("str", "");
  assertEquals(encoded.length, 0);
  const decoded = decodeScalarValue("str", encoded);
  assertEquals(decoded, "");
});

Deno.test("str - unicode", () => {
  const encoded = encodeScalarValue("str", "cafe\u0301");
  const decoded = decodeScalarValue("str", encoded);
  assertEquals(decoded, "cafe\u0301");
});

Deno.test("str - qualified name std::str works", () => {
  const encoded = encodeScalarValue("std::str", "test");
  const decoded = decodeScalarValue("std::str", encoded);
  assertEquals(decoded, "test");
});

// ---------------------------------------------------------------------------
// int16 encode/decode
// ---------------------------------------------------------------------------

Deno.test("int16 - encode/decode round-trip positive", () => {
  const encoded = encodeScalarValue("int16", 12345);
  assertEquals(encoded.length, 2);
  const decoded = decodeScalarValue("int16", encoded);
  assertEquals(decoded, 12345);
});

Deno.test("int16 - encode/decode negative", () => {
  const encoded = encodeScalarValue("int16", -1234);
  const decoded = decodeScalarValue("int16", encoded);
  assertEquals(decoded, -1234);
});

Deno.test("int16 - zero", () => {
  const encoded = encodeScalarValue("int16", 0);
  const decoded = decodeScalarValue("int16", encoded);
  assertEquals(decoded, 0);
});

// ---------------------------------------------------------------------------
// int32 encode/decode
// ---------------------------------------------------------------------------

Deno.test("int32 - encode/decode round-trip", () => {
  const encoded = encodeScalarValue("int32", 123456789);
  assertEquals(encoded.length, 4);
  const decoded = decodeScalarValue("int32", encoded);
  assertEquals(decoded, 123456789);
});

Deno.test("int32 - negative value", () => {
  const encoded = encodeScalarValue("int32", -987654321);
  const decoded = decodeScalarValue("int32", encoded);
  assertEquals(decoded, -987654321);
});

// ---------------------------------------------------------------------------
// int64 encode/decode
// ---------------------------------------------------------------------------

Deno.test("int64 - encode/decode round-trip with bigint", () => {
  const encoded = encodeScalarValue("int64", 9007199254740993n);
  assertEquals(encoded.length, 8);
  const decoded = decodeScalarValue("int64", encoded);
  assertEquals(decoded, 9007199254740993n);
});

Deno.test("int64 - negative bigint", () => {
  const encoded = encodeScalarValue("int64", -42n);
  const decoded = decodeScalarValue("int64", encoded);
  assertEquals(decoded, -42n);
});

Deno.test("int64 - zero", () => {
  const encoded = encodeScalarValue("int64", 0n);
  const decoded = decodeScalarValue("int64", encoded);
  assertEquals(decoded, 0n);
});

// ---------------------------------------------------------------------------
// float32 encode/decode
// ---------------------------------------------------------------------------

Deno.test("float32 - encode/decode round-trip", () => {
  const encoded = encodeScalarValue("float32", 3.14);
  assertEquals(encoded.length, 4);
  const decoded = decodeScalarValue("float32", encoded) as number;
  assertAlmostEquals(decoded, 3.14, 0.001);
});

Deno.test("float32 - negative value", () => {
  const encoded = encodeScalarValue("float32", -2.5);
  const decoded = decodeScalarValue("float32", encoded) as number;
  assertAlmostEquals(decoded, -2.5, 0.001);
});

// ---------------------------------------------------------------------------
// float64 encode/decode
// ---------------------------------------------------------------------------

Deno.test("float64 - encode/decode round-trip", () => {
  const encoded = encodeScalarValue("float64", 3.141592653589793);
  assertEquals(encoded.length, 8);
  const decoded = decodeScalarValue("float64", encoded);
  assertEquals(decoded, 3.141592653589793);
});

Deno.test("float64 - very small value", () => {
  const encoded = encodeScalarValue("float64", 1e-300);
  const decoded = decodeScalarValue("float64", encoded);
  assertEquals(decoded, 1e-300);
});

// ---------------------------------------------------------------------------
// bool encode/decode
// ---------------------------------------------------------------------------

Deno.test("bool - encode/decode true", () => {
  const encoded = encodeScalarValue("bool", true);
  assertEquals(encoded.length, 1);
  assertEquals(encoded[0], 0x01);
  const decoded = decodeScalarValue("bool", encoded);
  assertEquals(decoded, true);
});

Deno.test("bool - encode/decode false", () => {
  const encoded = encodeScalarValue("bool", false);
  assertEquals(encoded[0], 0x00);
  const decoded = decodeScalarValue("bool", encoded);
  assertEquals(decoded, false);
});

// ---------------------------------------------------------------------------
// uuid encode/decode
// ---------------------------------------------------------------------------

Deno.test("uuid - encode/decode string round-trip", () => {
  const uuid = "12345678-1234-5678-9abc-def012345678";
  const encoded = encodeScalarValue("uuid", uuid);
  assertEquals(encoded.length, 16);
  const decoded = decodeScalarValue("uuid", encoded);
  assertEquals(decoded, uuid);
});

Deno.test("uuid - encode/decode Uint8Array round-trip", () => {
  const bytes = uuidToBytes("abcdef01-2345-6789-abcd-ef0123456789");
  const encoded = encodeScalarValue("uuid", bytes);
  assertEquals(encoded.length, 16);
  const decoded = decodeScalarValue("uuid", encoded);
  assertEquals(decoded, "abcdef01-2345-6789-abcd-ef0123456789");
});

// ---------------------------------------------------------------------------
// datetime encode/decode (Gel epoch)
// ---------------------------------------------------------------------------

Deno.test("datetime - encode/decode Date round-trip", () => {
  // 2024-01-15T12:30:00.000Z
  const date = new Date("2024-01-15T12:30:00.000Z");
  const encoded = encodeScalarValue("datetime", date);
  assertEquals(encoded.length, 8);
  const decoded = decodeScalarValue("datetime", encoded) as Date;
  assertEquals(decoded.getTime(), date.getTime());
});

Deno.test("datetime - Gel epoch itself encodes to zero", () => {
  // 2000-01-01T00:00:00.000Z is the Gel epoch
  const gelEpoch = new Date("2000-01-01T00:00:00.000Z");
  const encoded = encodeScalarValue("datetime", gelEpoch);
  const view = new DataView(encoded.buffer);
  assertEquals(view.getBigInt64(0, false), 0n);
});

Deno.test("datetime - before Gel epoch encodes to negative", () => {
  // 1999-06-15T00:00:00.000Z is before Gel epoch
  const date = new Date("1999-06-15T00:00:00.000Z");
  const encoded = encodeScalarValue("datetime", date);
  const view = new DataView(encoded.buffer);
  const usGel = view.getBigInt64(0, false);
  assertEquals(usGel < 0n, true);
});

// ---------------------------------------------------------------------------
// duration encode/decode
// ---------------------------------------------------------------------------

Deno.test("duration - encode/decode microseconds", () => {
  // 1 second = 1_000_000 microseconds
  const encoded = encodeScalarValue("duration", 1000000n);
  assertEquals(encoded.length, 8);
  const decoded = decodeScalarValue("duration", encoded);
  assertEquals(decoded, 1000000n);
});

Deno.test("duration - negative duration", () => {
  const encoded = encodeScalarValue("duration", -500000n);
  const decoded = decodeScalarValue("duration", encoded);
  assertEquals(decoded, -500000n);
});

// ---------------------------------------------------------------------------
// json encode/decode (with format prefix)
// ---------------------------------------------------------------------------

Deno.test("json - encode/decode string value", () => {
  const encoded = encodeScalarValue("json", "{\"key\":\"value\"}");
  // First byte should be format version 0x01
  assertEquals(encoded[0], 0x01);
  const decoded = decodeScalarValue("json", encoded);
  assertEquals(decoded, { key: "value" });
});

Deno.test("json - encode/decode object value", () => {
  const obj = { name: "test", count: 42, nested: { a: true } };
  const encoded = encodeScalarValue("json", obj);
  assertEquals(encoded[0], 0x01);
  const decoded = decodeScalarValue("json", encoded);
  assertEquals(decoded, obj);
});

Deno.test("json - encode/decode array", () => {
  const arr = [1, "two", false];
  const encoded = encodeScalarValue("json", arr);
  const decoded = decodeScalarValue("json", encoded);
  assertEquals(decoded, arr);
});

// ---------------------------------------------------------------------------
// bytes encode/decode
// ---------------------------------------------------------------------------

Deno.test("bytes - encode/decode round-trip", () => {
  const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const encoded = encodeScalarValue("bytes", data);
  assertEquals(encoded.length, 4);
  const decoded = decodeScalarValue("bytes", encoded) as Uint8Array;
  assertEquals(decoded, data);
});

Deno.test("bytes - empty", () => {
  const data = new Uint8Array(0);
  const encoded = encodeScalarValue("bytes", data);
  assertEquals(encoded.length, 0);
  const decoded = decodeScalarValue("bytes", encoded) as Uint8Array;
  assertEquals(decoded.length, 0);
});

// ---------------------------------------------------------------------------
// local_date encode/decode
// ---------------------------------------------------------------------------

Deno.test("local_date - encode/decode round-trip", () => {
  // 2024-06-15 = some days after Gel epoch
  const date = new Date("2024-06-15T00:00:00.000Z");
  const encoded = encodeScalarValue("local_date", date);
  assertEquals(encoded.length, 4);
  const decoded = decodeScalarValue("local_date", encoded) as Date;
  assertEquals(decoded.toISOString().substring(0, 10), "2024-06-15");
});

Deno.test("local_date - Gel epoch encodes to zero days", () => {
  const gelEpoch = new Date("2000-01-01T00:00:00.000Z");
  const encoded = encodeScalarValue("local_date", gelEpoch);
  const view = new DataView(encoded.buffer);
  assertEquals(view.getInt32(0, false), 0);
});

// ---------------------------------------------------------------------------
// local_time encode/decode
// ---------------------------------------------------------------------------

Deno.test("local_time - encode/decode microseconds", () => {
  // 12:30:00 = 12*3600 + 30*60 = 45000 seconds = 45000000000 microseconds
  const usec = 45000000000n;
  const encoded = encodeScalarValue("local_time", usec);
  assertEquals(encoded.length, 8);
  const decoded = decodeScalarValue("local_time", encoded);
  assertEquals(decoded, usec);
});

// ---------------------------------------------------------------------------
// local_datetime encode/decode
// ---------------------------------------------------------------------------

Deno.test("local_datetime - encode/decode round-trip", () => {
  const dt = new Date("2024-03-20T15:30:00.000Z");
  const encoded = encodeScalarValue("local_datetime", dt);
  assertEquals(encoded.length, 8);
  const decoded = decodeScalarValue("local_datetime", encoded) as Date;
  assertEquals(decoded.getTime(), dt.getTime());
});

// ---------------------------------------------------------------------------
// bigint encode/decode
// ---------------------------------------------------------------------------

Deno.test("bigint - encode/decode positive", () => {
  const encoded = encodeScalarValue("bigint", 123456789012345n);
  const decoded = decodeScalarValue("bigint", encoded);
  assertEquals(decoded, 123456789012345n);
});

Deno.test("bigint - encode/decode negative", () => {
  const encoded = encodeScalarValue("bigint", -99999n);
  const decoded = decodeScalarValue("bigint", encoded);
  assertEquals(decoded, -99999n);
});

Deno.test("bigint - encode/decode zero", () => {
  const encoded = encodeScalarValue("bigint", 0n);
  const decoded = decodeScalarValue("bigint", encoded);
  assertEquals(decoded, 0n);
});

Deno.test("bigint - encode/decode large value", () => {
  const big = 999999999999999999999999999999n;
  const encoded = encodeScalarValue("bigint", big);
  const decoded = decodeScalarValue("bigint", encoded);
  assertEquals(decoded, big);
});

// ---------------------------------------------------------------------------
// decimal encode/decode
// ---------------------------------------------------------------------------

Deno.test("decimal - encode/decode simple", () => {
  const encoded = encodeScalarValue("decimal", "123.45");
  const decoded = decodeScalarValue("decimal", encoded);
  assertEquals(decoded, "123.45");
});

Deno.test("decimal - encode/decode integer-like", () => {
  const encoded = encodeScalarValue("decimal", "42");
  const decoded = decodeScalarValue("decimal", encoded);
  assertEquals(decoded, "42");
});

Deno.test("decimal - encode/decode zero", () => {
  const encoded = encodeScalarValue("decimal", "0");
  const decoded = decodeScalarValue("decimal", encoded);
  assertEquals(decoded, "0");
});

// ---------------------------------------------------------------------------
// Unsupported types
// ---------------------------------------------------------------------------

Deno.test("encode - throws for unknown type", () => {
  assertThrows(
    () => encodeScalarValue("not_a_type", "hello"),
    Error,
    "Unsupported scalar type"
  );
});

Deno.test("decode - throws for unknown type", () => {
  assertThrows(
    () => decodeScalarValue("not_a_type", new Uint8Array(4)),
    Error,
    "Unsupported scalar type"
  );
});

// ---------------------------------------------------------------------------
// Object value encoding
// ---------------------------------------------------------------------------

Deno.test("encodeObjectValue - simple object", () => {
  const strTypeId = uuidToBytes("00000000-0000-0000-0000-000000000101");
  const int32TypeId = uuidToBytes("00000000-0000-0000-0000-000000000104");
  const shapeId = uuidToBytes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

  const shape: ObjectShapeDescriptor = {
    tag: DescriptorTag.OBJECT_SHAPE,
    id: shapeId,
    elements: [
      {
        flags: 0,
        cardinality: Cardinality.ONE,
        name: "name",
        typeId: strTypeId
      },
      {
        flags: 0,
        cardinality: Cardinality.AT_MOST_ONE,
        name: "age",
        typeId: int32TypeId
      }
    ]
  };

  const descriptorMap = new Map<string, TypeDescriptor>([
    [bytesToUuid(strTypeId), {
      tag: DescriptorTag.BASE_SCALAR,
      id: strTypeId
    }],
    [bytesToUuid(int32TypeId), {
      tag: DescriptorTag.BASE_SCALAR,
      id: int32TypeId
    }]
  ]);

  const encoded = encodeObjectValue(
    shape,
    { name: "Ada", age: 30 },
    descriptorMap
  );

  // Verify structure: nelements(4) + per element: reserved(4) + len(4) + data
  const view = new DataView(encoded.buffer, encoded.byteOffset);
  assertEquals(view.getUint32(0, false), 2); // 2 elements
});

Deno.test("encodeObjectValue - with null field", () => {
  const strTypeId = uuidToBytes("00000000-0000-0000-0000-000000000101");
  const shapeId = uuidToBytes("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");

  const shape: ObjectShapeDescriptor = {
    tag: DescriptorTag.OBJECT_SHAPE,
    id: shapeId,
    elements: [
      {
        flags: 0,
        cardinality: Cardinality.AT_MOST_ONE,
        name: "name",
        typeId: strTypeId
      }
    ]
  };

  const descriptorMap = new Map<string, TypeDescriptor>([
    [bytesToUuid(strTypeId), {
      tag: DescriptorTag.BASE_SCALAR,
      id: strTypeId
    }]
  ]);

  const encoded = encodeObjectValue(
    shape,
    { name: null },
    descriptorMap
  );

  const view = new DataView(encoded.buffer, encoded.byteOffset);
  assertEquals(view.getUint32(0, false), 1); // 1 element
  assertEquals(view.getUint32(4, false), 0); // reserved
  assertEquals(view.getInt32(8, false), -1); // null indicator
});

Deno.test("encodeObjectValue - with undefined field treated as null", () => {
  const boolTypeId = uuidToBytes("00000000-0000-0000-0000-000000000109");
  const shapeId = uuidToBytes("bbbbbbbb-cccc-dddd-eeee-ffffffffffff");

  const shape: ObjectShapeDescriptor = {
    tag: DescriptorTag.OBJECT_SHAPE,
    id: shapeId,
    elements: [
      {
        flags: 0,
        cardinality: Cardinality.AT_MOST_ONE,
        name: "active",
        typeId: boolTypeId
      }
    ]
  };

  const descriptorMap = new Map<string, TypeDescriptor>([
    [bytesToUuid(boolTypeId), {
      tag: DescriptorTag.BASE_SCALAR,
      id: boolTypeId
    }]
  ]);

  const encoded = encodeObjectValue(
    shape,
    {},
    descriptorMap
  );

  const view = new DataView(encoded.buffer, encoded.byteOffset);
  assertEquals(view.getUint32(0, false), 1); // 1 element
  assertEquals(view.getInt32(8, false), -1); // null indicator
});

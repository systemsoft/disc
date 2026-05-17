/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for BufferWriter and BufferReader.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { BufferReader, BufferWriter } from "./buffer.ts";

// ---------------------------------------------------------------------------
// UInt8
// ---------------------------------------------------------------------------

Deno.test("BufferWriter/Reader - round-trip uint8", () => {
  const w = new BufferWriter();
  w.writeUInt8(0);
  w.writeUInt8(127);
  w.writeUInt8(255);

  const r = new BufferReader(w.toBytes());
  assertEquals(r.readUInt8(), 0);
  assertEquals(r.readUInt8(), 127);
  assertEquals(r.readUInt8(), 255);
  assertEquals(r.remaining, 0);
});

// ---------------------------------------------------------------------------
// UInt16
// ---------------------------------------------------------------------------

Deno.test("BufferWriter/Reader - round-trip uint16", () => {
  const w = new BufferWriter();
  w.writeUInt16(0);
  w.writeUInt16(256);
  w.writeUInt16(65535);

  const r = new BufferReader(w.toBytes());
  assertEquals(r.readUInt16(), 0);
  assertEquals(r.readUInt16(), 256);
  assertEquals(r.readUInt16(), 65535);
  assertEquals(r.remaining, 0);
});

Deno.test(
  "BufferWriter/Reader - uint16 big-endian byte order",
  () => {
    const w = new BufferWriter();
    w.writeUInt16(0x0102);
    const bytes = w.toBytes();
    assertEquals(bytes[0], 0x01);
    assertEquals(bytes[1], 0x02);
  }
);

// ---------------------------------------------------------------------------
// UInt32
// ---------------------------------------------------------------------------

Deno.test("BufferWriter/Reader - round-trip uint32", () => {
  const w = new BufferWriter();
  w.writeUInt32(0);
  w.writeUInt32(1);
  w.writeUInt32(0xffffffff);
  w.writeUInt32(0x12345678);

  const r = new BufferReader(w.toBytes());
  assertEquals(r.readUInt32(), 0);
  assertEquals(r.readUInt32(), 1);
  assertEquals(r.readUInt32(), 0xffffffff);
  assertEquals(r.readUInt32(), 0x12345678);
  assertEquals(r.remaining, 0);
});

Deno.test(
  "BufferWriter/Reader - uint32 big-endian byte order",
  () => {
    const w = new BufferWriter();
    w.writeUInt32(0x01020304);
    const bytes = w.toBytes();
    assertEquals(bytes[0], 0x01);
    assertEquals(bytes[1], 0x02);
    assertEquals(bytes[2], 0x03);
    assertEquals(bytes[3], 0x04);
  }
);

// ---------------------------------------------------------------------------
// UInt64
// ---------------------------------------------------------------------------

Deno.test("BufferWriter/Reader - round-trip uint64", () => {
  const w = new BufferWriter();
  w.writeUInt64(0n);
  w.writeUInt64(1n);
  w.writeUInt64(0xffffffffffffffffn);
  w.writeUInt64(0x0102030405060708n);

  const r = new BufferReader(w.toBytes());
  assertEquals(r.readUInt64(), 0n);
  assertEquals(r.readUInt64(), 1n);
  assertEquals(r.readUInt64(), 0xffffffffffffffffn);
  assertEquals(r.readUInt64(), 0x0102030405060708n);
  assertEquals(r.remaining, 0);
});

// ---------------------------------------------------------------------------
// String
// ---------------------------------------------------------------------------

Deno.test("BufferWriter/Reader - round-trip empty string", () => {
  const w = new BufferWriter();
  w.writeString("");

  const r = new BufferReader(w.toBytes());
  assertEquals(r.readString(), "");
  assertEquals(r.remaining, 0);
});

Deno.test("BufferWriter/Reader - round-trip ASCII string", () => {
  const w = new BufferWriter();
  w.writeString("hello world");

  const r = new BufferReader(w.toBytes());
  assertEquals(r.readString(), "hello world");
  assertEquals(r.remaining, 0);
});

Deno.test(
  "BufferWriter/Reader - round-trip Unicode string",
  () => {
    const w = new BufferWriter();
    const text = "Hello, \u4e16\u754c! \u{1f600}"; // "Hello, 世界! 😀"
    w.writeString(text);

    const r = new BufferReader(w.toBytes());
    assertEquals(r.readString(), text);
    assertEquals(r.remaining, 0);
  }
);

Deno.test(
  "BufferWriter/Reader - string length is byte count not char count",
  () => {
    const w = new BufferWriter();
    // 3 chars, but > 3 UTF-8 bytes
    w.writeString("\u4e16\u754c\u{1f600}");

    const bytes = w.toBytes();
    const r = new BufferReader(bytes);
    // Read the length prefix
    const byteLen = r.readUInt32();
    // 世 = 3 bytes, 界 = 3 bytes, 😀 = 4 bytes => 10 bytes
    assertEquals(byteLen, 10);
  }
);

// ---------------------------------------------------------------------------
// UUID
// ---------------------------------------------------------------------------

Deno.test("BufferWriter/Reader - round-trip UUID", () => {
  const uuid = new Uint8Array([
    0x01,
    0x02,
    0x03,
    0x04,
    0x05,
    0x06,
    0x07,
    0x08,
    0x09,
    0x0a,
    0x0b,
    0x0c,
    0x0d,
    0x0e,
    0x0f,
    0x10
  ]);

  const w = new BufferWriter();
  w.writeUUID(uuid);

  const r = new BufferReader(w.toBytes());
  const result = r.readUUID();
  assertEquals(result, uuid);
  assertEquals(r.remaining, 0);
});

Deno.test(
  "BufferWriter - writeUUID rejects non-16-byte input",
  () => {
    const w = new BufferWriter();
    assertThrows(
      () => w.writeUUID(new Uint8Array(15)),
      Error,
      "UUID must be exactly 16 bytes"
    );
    assertThrows(
      () => w.writeUUID(new Uint8Array(17)),
      Error,
      "UUID must be exactly 16 bytes"
    );
  }
);

// ---------------------------------------------------------------------------
// LenPrefixedBytes
// ---------------------------------------------------------------------------

Deno.test(
  "BufferWriter/Reader - round-trip len-prefixed bytes",
  () => {
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    const w = new BufferWriter();
    w.writeLenPrefixedBytes(data);

    const r = new BufferReader(w.toBytes());
    const result = r.readLenPrefixedBytes();
    assertEquals(result, data);
    assertEquals(r.remaining, 0);
  }
);

Deno.test(
  "BufferWriter/Reader - round-trip empty len-prefixed bytes",
  () => {
    const w = new BufferWriter();
    w.writeLenPrefixedBytes(new Uint8Array(0));

    const r = new BufferReader(w.toBytes());
    const result = r.readLenPrefixedBytes();
    assertEquals(result.length, 0);
    assertEquals(r.remaining, 0);
  }
);

// ---------------------------------------------------------------------------
// Multiple values in sequence
// ---------------------------------------------------------------------------

Deno.test(
  "BufferWriter/Reader - mixed types in sequence",
  () => {
    const w = new BufferWriter();
    w.writeUInt8(0x42);
    w.writeUInt16(1000);
    w.writeString("test");
    w.writeUInt32(99999);
    w.writeUInt64(0xdeadbeefcafebaben);
    w.writeLenPrefixedBytes(new Uint8Array([1, 2, 3]));

    const uuid = new Uint8Array(16);
    uuid[0] = 0xaa;
    uuid[15] = 0xbb;
    w.writeUUID(uuid);

    const r = new BufferReader(w.toBytes());
    assertEquals(r.readUInt8(), 0x42);
    assertEquals(r.readUInt16(), 1000);
    assertEquals(r.readString(), "test");
    assertEquals(r.readUInt32(), 99999);
    assertEquals(r.readUInt64(), 0xdeadbeefcafebaben);
    assertEquals(r.readLenPrefixedBytes(), new Uint8Array([1, 2, 3]));
    const readUuid = r.readUUID();
    assertEquals(readUuid[0], 0xaa);
    assertEquals(readUuid[15], 0xbb);
    assertEquals(r.remaining, 0);
  }
);

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("BufferReader - underflow throws on readUInt8", () => {
  const r = new BufferReader(new Uint8Array(0));
  assertThrows(() => r.readUInt8(), Error, "Buffer underflow");
});

Deno.test("BufferReader - underflow throws on readUInt32", () => {
  const r = new BufferReader(new Uint8Array(3));
  assertThrows(() => r.readUInt32(), Error, "Buffer underflow");
});

Deno.test("BufferReader - underflow throws on readUInt64", () => {
  const r = new BufferReader(new Uint8Array(7));
  assertThrows(() => r.readUInt64(), Error, "Buffer underflow");
});

Deno.test("BufferReader - position tracks correctly", () => {
  const w = new BufferWriter();
  w.writeUInt8(1);
  w.writeUInt16(2);
  w.writeUInt32(3);

  const r = new BufferReader(w.toBytes());
  assertEquals(r.position, 0);
  r.readUInt8();
  assertEquals(r.position, 1);
  r.readUInt16();
  assertEquals(r.position, 3);
  r.readUInt32();
  assertEquals(r.position, 7);
  assertEquals(r.remaining, 0);
});

Deno.test(
  "BufferWriter - length property reflects total written",
  () => {
    const w = new BufferWriter();
    assertEquals(w.length, 0);
    w.writeUInt8(1);
    assertEquals(w.length, 1);
    w.writeUInt32(42);
    assertEquals(w.length, 5);
    w.writeString("hi");
    // 4 bytes length prefix + 2 bytes for "hi"
    assertEquals(w.length, 11);
  }
);

Deno.test(
  "BufferReader - can be constructed with initial offset",
  () => {
    const w = new BufferWriter();
    w.writeUInt8(0xff);
    w.writeUInt16(12345);
    const bytes = w.toBytes();

    // Skip the first byte, start reading at offset 1
    const r = new BufferReader(bytes, 1);
    assertEquals(r.readUInt16(), 12345);
    assertEquals(r.remaining, 0);
  }
);

Deno.test("BufferWriter - writeBytes copies data", () => {
  const original = new Uint8Array([1, 2, 3]);
  const w = new BufferWriter();
  w.writeBytes(original);

  // Mutate original — writer should not be affected
  original[0] = 99;
  const output = w.toBytes();
  assertEquals(output[0], 1);
});

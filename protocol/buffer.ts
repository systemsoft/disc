/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Binary buffer utilities for Gel wire protocol.
 * All multi-byte integers are big-endian (network byte order).
 *
 * BufferWriter accumulates data into chunks and produces a single
 * Uint8Array via toBytes(). BufferReader wraps an existing buffer
 * and reads values sequentially.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Accumulates binary data for protocol message encoding.
 */
export class BufferWriter {
  private chunks: Uint8Array[] = [];
  private totalLength = 0;

  /**
   * Write an unsigned 8-bit integer.
   */
  writeUInt8(val: number): void {
    const buf = new Uint8Array(1);
    buf[0] = val & 0xff;
    this.chunks.push(buf);
    this.totalLength += 1;
  }

  /**
   * Write an unsigned 16-bit integer in big-endian byte order.
   */
  writeUInt16(val: number): void {
    const buf = new Uint8Array(2);
    const view = new DataView(buf.buffer);
    view.setUint16(0, val, false);
    this.chunks.push(buf);
    this.totalLength += 2;
  }

  /**
   * Write an unsigned 32-bit integer in big-endian byte order.
   */
  writeUInt32(val: number): void {
    const buf = new Uint8Array(4);
    const view = new DataView(buf.buffer);
    view.setUint32(0, val, false);
    this.chunks.push(buf);
    this.totalLength += 4;
  }

  /**
   * Write an unsigned 64-bit integer in big-endian byte order.
   */
  writeUInt64(val: bigint): void {
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setUint32(0, Number((val >> 32n) & 0xffffffffn), false);
    view.setUint32(4, Number(val & 0xffffffffn), false);
    this.chunks.push(buf);
    this.totalLength += 8;
  }

  /**
   * Write raw bytes without any length prefix.
   */
  writeBytes(data: Uint8Array): void {
    const copy = new Uint8Array(data.length);
    copy.set(data);
    this.chunks.push(copy);
    this.totalLength += data.length;
  }

  /**
   * Write bytes with a uint32 length prefix.
   */
  writeLenPrefixedBytes(data: Uint8Array): void {
    this.writeUInt32(data.length);
    this.writeBytes(data);
  }

  /**
   * Write a UTF-8 string with a uint32 length prefix (length in bytes).
   */
  writeString(val: string): void {
    const bytes = textEncoder.encode(val);
    this.writeUInt32(bytes.length);
    this.chunks.push(bytes);
    this.totalLength += bytes.length;
  }

  /**
   * Write a UUID as 16 raw bytes.
   */
  writeUUID(uuid: Uint8Array): void {
    if (uuid.length !== 16) {
      throw new Error(
        `UUID must be exactly 16 bytes, got ${uuid.length}`
      );
    }
    const copy = new Uint8Array(16);
    copy.set(uuid);
    this.chunks.push(copy);
    this.totalLength += 16;
  }

  /**
   * Concatenate all chunks into a single Uint8Array.
   */
  toBytes(): Uint8Array {
    const result = new Uint8Array(this.totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /**
   * Total number of bytes written so far.
   */
  get length(): number {
    return this.totalLength;
  }
}

/**
 * Reads binary data sequentially from an existing buffer.
 */
export class BufferReader {
  private buf: Uint8Array;
  private view: DataView;
  private pos: number;

  constructor(buf: Uint8Array, pos = 0) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset);
    this.pos = pos;
  }

  /**
   * Read an unsigned 8-bit integer.
   */
  readUInt8(): number {
    this.ensureAvailable(1);
    const val = this.buf[this.pos];
    this.pos += 1;
    return val;
  }

  /**
   * Read an unsigned 16-bit integer in big-endian byte order.
   */
  readUInt16(): number {
    this.ensureAvailable(2);
    const val = this.view.getUint16(this.pos, false);
    this.pos += 2;
    return val;
  }

  /**
   * Read an unsigned 32-bit integer in big-endian byte order.
   */
  readUInt32(): number {
    this.ensureAvailable(4);
    const val = this.view.getUint32(this.pos, false);
    this.pos += 4;
    return val;
  }

  /**
   * Read an unsigned 64-bit integer in big-endian byte order.
   */
  readUInt64(): bigint {
    this.ensureAvailable(8);
    const high = this.view.getUint32(this.pos, false);
    const low = this.view.getUint32(this.pos + 4, false);
    this.pos += 8;
    return (BigInt(high) << 32n) | BigInt(low);
  }

  /**
   * Read exactly `len` raw bytes.
   */
  readBytes(len: number): Uint8Array {
    this.ensureAvailable(len);
    const slice = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return slice;
  }

  /**
   * Read bytes with a uint32 length prefix.
   */
  readLenPrefixedBytes(): Uint8Array {
    const len = this.readUInt32();
    return this.readBytes(len);
  }

  /**
   * Read a UTF-8 string with a uint32 length prefix (length in bytes).
   */
  readString(): string {
    const bytes = this.readLenPrefixedBytes();
    return textDecoder.decode(bytes);
  }

  /**
   * Read a UUID as 16 raw bytes.
   */
  readUUID(): Uint8Array {
    return this.readBytes(16);
  }

  /**
   * Number of bytes remaining in the buffer.
   */
  get remaining(): number {
    return this.buf.length - this.pos;
  }

  /**
   * Current read position in the buffer.
   */
  get position(): number {
    return this.pos;
  }

  /**
   * Ensure at least `n` bytes are available for reading.
   */
  private ensureAvailable(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error(
        `Buffer underflow: need ${n} bytes at position ${this.pos}, ` +
          `but only ${this.buf.length - this.pos} bytes remain`
      );
    }
  }
}

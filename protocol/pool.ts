/**
 * Message pooling and buffer management for performance optimization
 * Reduces GC pressure by reusing message objects and buffers
 */

import * as Types from "./types.ts";

/**
 * Object pool for reusing message instances
 */
export class MessagePool<T> {
  private pool: T[] = [];
  private factory: () => T;
  private reset: (obj: T) => void;
  private maxSize: number;

  constructor(
    factory: () => T,
    reset: (obj: T) => void,
    maxSize = 100,
  ) {
    this.factory = factory;
    this.reset = reset;
    this.maxSize = maxSize;
  }

  acquire(): T {
    const obj = this.pool.pop();
    return obj ?? this.factory();
  }

  release(obj: T): void {
    if (this.pool.length < this.maxSize) {
      this.reset(obj);
      this.pool.push(obj);
    }
  }

  clear(): void {
    this.pool.length = 0;
  }

  get size(): number {
    return this.pool.length;
  }
}

/**
 * Buffer pool for reusing byte arrays
 */
export class BufferPool {
  private pools: Map<number, Uint8Array[]> = new Map();
  private maxPoolSize = 50;

  // Common buffer sizes
  private readonly sizes = [
    64,
    128,
    256,
    512,
    1024,
    2048,
    4096,
    8192,
    16384,
    32768,
    65536,
  ];

  acquire(minSize: number): Uint8Array {
    // Find the smallest buffer size that fits
    const size = this.sizes.find((s) => s >= minSize) ?? minSize;

    const pool = this.pools.get(size);
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }

    return new Uint8Array(size);
  }

  release(buffer: Uint8Array): void {
    const size = buffer.length;

    // Only pool common sizes
    if (!this.sizes.includes(size)) {
      return;
    }

    let pool = this.pools.get(size);
    if (!pool) {
      pool = [];
      this.pools.set(size, pool);
    }

    if (pool.length < this.maxPoolSize) {
      // Clear the buffer before returning to pool
      buffer.fill(0);
      pool.push(buffer);
    }
  }

  clear(): void {
    this.pools.clear();
  }

  stats(): { size: number; count: number }[] {
    const stats: { size: number; count: number }[] = [];
    for (const [size, pool] of this.pools) {
      stats.push({ size, count: pool.length });
    }
    return stats;
  }
}

/**
 * Cached message builder that reuses buffers
 */
export class CachedMessageBuilder {
  private bufferPool = new BufferPool();
  private currentBuffer: Uint8Array | null = null;
  private offset = 0;
  private chunks: Uint8Array[] = [];

  reset(): void {
    if (this.currentBuffer) {
      this.bufferPool.release(this.currentBuffer);
      this.currentBuffer = null;
    }

    for (const chunk of this.chunks) {
      this.bufferPool.release(chunk);
    }
    this.chunks.length = 0;
    this.offset = 0;
  }

  ensureCapacity(size: number): void {
    if (!this.currentBuffer || this.offset + size > this.currentBuffer.length) {
      if (this.currentBuffer) {
        // Save current buffer as a chunk
        const used = this.currentBuffer.subarray(0, this.offset);
        const chunk = this.bufferPool.acquire(used.length);
        chunk.set(used);
        this.chunks.push(chunk);
      }

      this.currentBuffer = this.bufferPool.acquire(Math.max(size, 4096));
      this.offset = 0;
    }
  }

  writeUInt8(value: number): void {
    this.ensureCapacity(1);
    this.currentBuffer![this.offset++] = value;
  }

  writeUInt16(value: number): void {
    this.ensureCapacity(2);
    const view = new DataView(
      this.currentBuffer!.buffer,
      this.currentBuffer!.byteOffset + this.offset,
    );
    view.setUint16(0, value, false); // Big-endian
    this.offset += 2;
  }

  writeUInt32(value: number): void {
    this.ensureCapacity(4);
    const view = new DataView(
      this.currentBuffer!.buffer,
      this.currentBuffer!.byteOffset + this.offset,
    );
    view.setUint32(0, value, false); // Big-endian
    this.offset += 4;
  }

  writeUInt64(value: bigint): void {
    this.ensureCapacity(8);
    const view = new DataView(
      this.currentBuffer!.buffer,
      this.currentBuffer!.byteOffset + this.offset,
    );
    view.setUint32(0, Number(value >> 32n), false);
    view.setUint32(4, Number(value & 0xffffffffn), false);
    this.offset += 8;
  }

  writeBytes(value: Uint8Array): void {
    this.writeUInt32(value.length);
    this.ensureCapacity(value.length);
    this.currentBuffer!.set(value, this.offset);
    this.offset += value.length;
  }

  writeFixedBytes(value: Uint8Array): void {
    this.ensureCapacity(value.length);
    this.currentBuffer!.set(value, this.offset);
    this.offset += value.length;
  }

  writeString(value: string): void {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(value);
    this.writeBytes(bytes);
  }

  build(): Uint8Array {
    // Calculate total size
    let totalSize = this.offset;
    for (const chunk of this.chunks) {
      totalSize += chunk.length;
    }

    // Combine all chunks
    const result = this.bufferPool.acquire(totalSize);
    let pos = 0;

    for (const chunk of this.chunks) {
      result.set(chunk, pos);
      pos += chunk.length;
    }

    if (this.currentBuffer) {
      result.set(this.currentBuffer.subarray(0, this.offset), pos);
    }

    return result.subarray(0, totalSize);
  }
}

/**
 * Message cache for frequently used messages
 */
export class MessageCache {
  private cache = new Map<string, Uint8Array>();
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  get(key: string): Uint8Array | null {
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      // Move to end (LRU)
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    this.misses++;
    return null;
  }

  set(key: string, value: Uint8Array): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats(): { hits: number; misses: number; hitRate: number; size: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
      size: this.cache.size,
    };
  }
}

/**
 * Connection-specific message pools
 */
export class ConnectionPools {
  readonly parseMessagePool: MessagePool<Types.ParseMessage>;
  readonly executeMessagePool: MessagePool<Types.ExecuteMessage>;
  readonly dataMessagePool: MessagePool<Types.DataMessage>;
  readonly errorResponsePool: MessagePool<Types.ErrorResponse>;
  readonly bufferPool = new BufferPool();
  readonly messageCache = new MessageCache();

  constructor() {
    this.parseMessagePool = new MessagePool<Types.ParseMessage>(
      () => ({
        type: Types.MessageType.Parse,
        length: 0,
        annotations: [] as Types.Annotation[],
        allowedCapabilities: 0n,
        compilationFlags: 0n,
        implicitLimit: 0n,
        inputLanguage: Types.InputLanguage.EdgeQL,
        outputFormat: Types.OutputFormat.JSON,
        expectedCardinality: Types.Cardinality.Many,
        commandText: "",
      }),
      (msg) => {
        msg.annotations.length = 0;
        msg.allowedCapabilities = 0n;
        msg.compilationFlags = 0n;
        msg.implicitLimit = 0n;
        msg.commandText = "";
      },
    );

    this.executeMessagePool = new MessagePool<Types.ExecuteMessage>(
      () => ({
        type: Types.MessageType.Execute,
        length: 0,
        annotations: [] as Types.Annotation[],
        allowedCapabilities: 0n,
        compilationFlags: 0n,
        implicitLimit: 0n,
        inputLanguage: Types.InputLanguage.EdgeQL,
        outputFormat: Types.OutputFormat.JSON,
        expectedCardinality: Types.Cardinality.Many,
        commandText: "",
        stateDataDescriptorId: new Uint8Array(16),
        encodedStateData: new Uint8Array(0),
        argumentDataDescriptorId: new Uint8Array(16),
        argumentData: new Uint8Array(0),
        outputDataDescriptorId: new Uint8Array(16),
      }),
      (msg) => {
        msg.annotations.length = 0;
        msg.allowedCapabilities = 0n;
        msg.compilationFlags = 0n;
        msg.implicitLimit = 0n;
        msg.commandText = "";
        msg.stateDataDescriptorId.fill(0);
        msg.encodedStateData = new Uint8Array(0);
        msg.argumentDataDescriptorId.fill(0);
        msg.argumentData = new Uint8Array(0);
        msg.outputDataDescriptorId.fill(0);
      },
    );

    this.dataMessagePool = new MessagePool<Types.DataMessage>(
      () => ({
        type: Types.MessageType.Data,
        length: 0,
        dataElements: [] as Types.DataElement[],
      }),
      (msg) => {
        msg.dataElements.length = 0;
      },
    );

    this.errorResponsePool = new MessagePool<Types.ErrorResponse>(
      () => ({
        type: Types.MessageType.ErrorResponse,
        length: 0,
        severity: Types.ErrorSeverity.Error,
        errorCode: 0,
        message: "",
        attributes: new Map<Types.ErrorAttribute, string>(),
      }),
      (msg) => {
        msg.severity = Types.ErrorSeverity.Error;
        msg.errorCode = 0;
        msg.message = "";
        msg.attributes.clear();
      },
    );
  }

  clear(): void {
    this.parseMessagePool.clear();
    this.executeMessagePool.clear();
    this.dataMessagePool.clear();
    this.errorResponsePool.clear();
    this.bufferPool.clear();
    this.messageCache.clear();
  }
}

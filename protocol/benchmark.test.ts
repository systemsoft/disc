// deno-lint-ignore-file no-console
/**
 * Performance benchmarks for binary protocol implementation
 */

import { ProtocolParser } from "./parser.ts";
import { ProtocolBuilder } from "./builder.ts";
import { BufferPool, CachedMessageBuilder, MessagePool } from "./pool.ts";
import * as Types from "./types.ts";

// Benchmark utilities
function benchmark(name: string, fn: () => void, iterations = 10000): void {
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = performance.now();
  const time = end - start;
  const opsPerSecond = (iterations / (time / 1000)).toFixed(0);
  console.log(
    `${name}: ${
      time.toFixed(2)
    }ms for ${iterations} iterations (${opsPerSecond} ops/sec)`,
  );
}

// async function benchmarkAsync(name: string, fn: () => Promise<void>, iterations = 10000): Promise<void> {
//   const start = performance.now();
//   for (let i = 0; i < iterations; i++) {
//     await fn();
//   }
//   const end = performance.now();
//   const time = end - start;
//   const opsPerSecond = (iterations / (time / 1000)).toFixed(0);
//   console.log(`${name}: ${time.toFixed(2)}ms for ${iterations} iterations (${opsPerSecond} ops/sec)`);
// }

Deno.test("Benchmark - Message parsing", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  // Build test messages
  const parseMessage: Types.ParseMessage = {
    type: Types.MessageType.Parse,
    length: 0,
    annotations: [
      { name: "query_id", value: "test-123" },
      { name: "timestamp", value: Date.now().toString() },
    ],
    allowedCapabilities: 0xffffn,
    compilationFlags: 0x1234n,
    implicitLimit: 1000n,
    inputLanguage: Types.InputLanguage.EdgeQL,
    outputFormat: Types.OutputFormat.JSON,
    expectedCardinality: Types.Cardinality.Many,
    commandText:
      "SELECT User { id, name, email, posts: { title, content } } FILTER .active = true ORDER BY .createdAt DESC LIMIT 100",
  };

  const message = builder.buildMessage(parseMessage);

  console.log("\n=== Message Parsing Performance ===");

  benchmark("Parse single message", () => {
    parser.append(message);
    parser.parseMessage();
  });

  // Test parsing multiple messages
  const multiMessage = new Uint8Array(message.length * 3);
  multiMessage.set(message, 0);
  multiMessage.set(message, message.length);
  multiMessage.set(message, message.length * 2);

  benchmark("Parse 3 messages in batch", () => {
    parser.append(multiMessage);
    parser.parseMessage();
    parser.parseMessage();
    parser.parseMessage();
  });
});

Deno.test("Benchmark - Message building", () => {
  const builder = new ProtocolBuilder();

  const dataMessage: Types.DataMessage = {
    type: Types.MessageType.Data,
    length: 0,
    dataElements: [
      {
        data: new TextEncoder().encode(
          '{"id": 1, "name": "Ada", "email": "ada@example.com"}',
        ),
      },
      {
        data: new TextEncoder().encode(
          '{"id": 2, "name": "Billie", "email": "billie@example.com"}',
        ),
      },
      {
        data: new TextEncoder().encode(
          '{"id": 3, "name": "Cher", "email": "cher@example.com"}',
        ),
      },
    ],
  };

  console.log("\n=== Message Building Performance ===");

  benchmark("Build data message", () => {
    builder.buildMessage(dataMessage);
  });

  const errorMessage: Types.ErrorResponse = {
    type: Types.MessageType.ErrorResponse,
    length: 0,
    severity: Types.ErrorSeverity.Error,
    errorCode: 42000,
    message: "Syntax error at position 42: unexpected token 'SELECT'",
    attributes: new Map([
      [Types.ErrorAttribute.Hint, "Check your query syntax"],
      [Types.ErrorAttribute.LineStart, "1"],
      [Types.ErrorAttribute.ColumnStart, "42"],
      [
        Types.ErrorAttribute.Details,
        "The query parser encountered an unexpected token",
      ],
    ]),
  };

  benchmark("Build error message", () => {
    builder.buildMessage(errorMessage);
  });
});

Deno.test("Benchmark - Buffer pooling", () => {
  const pool = new BufferPool();

  console.log("\n=== Buffer Pool Performance ===");

  benchmark("Acquire and release 1KB buffers", () => {
    const buffer = pool.acquire(1024);
    pool.release(buffer);
  });

  benchmark("Acquire and release 64KB buffers", () => {
    const buffer = pool.acquire(65536);
    pool.release(buffer);
  });

  // Test with no pooling for comparison
  benchmark("Allocate new 1KB buffers (no pool)", () => {
    new Uint8Array(1024);
  });

  benchmark("Allocate new 64KB buffers (no pool)", () => {
    new Uint8Array(65536);
  });

  const stats = pool.stats();
  console.log("Pool stats after benchmark:", stats);
});

Deno.test("Benchmark - Message pooling", () => {
  interface TestMessage {
    id: number;
    data: string;
    timestamp: number;
  }

  const pool = new MessagePool<TestMessage>(
    () => ({ id: 0, data: "", timestamp: 0 }),
    (msg) => {
      msg.id = 0;
      msg.data = "";
      msg.timestamp = 0;
    },
  );

  console.log("\n=== Message Pool Performance ===");

  benchmark("Acquire and release messages", () => {
    const msg = pool.acquire();
    msg.id = Math.random();
    msg.data = "test data";
    msg.timestamp = Date.now();
    pool.release(msg);
  });

  // Compare with creating new objects
  benchmark("Create new message objects (no pool)", () => {
    void { id: Math.random(), data: "test data", timestamp: Date.now() };
  });

  console.log("Pool size after benchmark:", pool.size);
});

Deno.test("Benchmark - Cached message builder", () => {
  const builder = new CachedMessageBuilder();

  console.log("\n=== Cached Message Builder Performance ===");

  benchmark("Build message with cached builder", () => {
    builder.reset();
    builder.writeUInt8(Types.MessageType.Parse);
    builder.writeUInt32(100);
    builder.writeUInt16(2); // annotations
    builder.writeString("key1");
    builder.writeString("value1");
    builder.writeString("key2");
    builder.writeString("value2");
    builder.writeUInt64(0xffffn);
    builder.writeString("SELECT * FROM users WHERE active = true");
    builder.build();
  });

  // Compare with regular builder
  const regularBuilder = new ProtocolBuilder();
  const message: Types.ParseMessage = {
    type: Types.MessageType.Parse,
    length: 0,
    annotations: [
      { name: "key1", value: "value1" },
      { name: "key2", value: "value2" },
    ],
    allowedCapabilities: 0xffffn,
    compilationFlags: 0n,
    implicitLimit: 0n,
    inputLanguage: Types.InputLanguage.EdgeQL,
    outputFormat: Types.OutputFormat.JSON,
    expectedCardinality: Types.Cardinality.Many,
    commandText: "SELECT * FROM users WHERE active = true",
  };

  benchmark("Build message with regular builder", () => {
    regularBuilder.buildMessage(message);
  });
});

Deno.test("Benchmark - UUID conversion", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const bytes = Types.uuidToBytes(uuid);

  console.log("\n=== UUID Conversion Performance ===");

  benchmark("UUID string to bytes", () => {
    Types.uuidToBytes(uuid);
  });

  benchmark("Bytes to UUID string", () => {
    Types.bytesToUuid(bytes);
  });
});

Deno.test("Benchmark - End-to-end message roundtrip", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  const executeMessage: Types.ExecuteMessage = {
    type: Types.MessageType.Execute,
    length: 0,
    annotations: [
      { name: "query_id", value: "exec-123" },
      { name: "userId", value: "user-456" },
    ],
    allowedCapabilities: 0xffffn,
    compilationFlags: 0x5678n,
    implicitLimit: 100n,
    inputLanguage: Types.InputLanguage.EdgeQL,
    outputFormat: Types.OutputFormat.Binary,
    expectedCardinality: Types.Cardinality.Many,
    commandText:
      "SELECT User { id, name, email, profile: { bio, avatar_url }, posts: { id, title, content, tags, createdAt } } FILTER .id = <uuid>$0",
    stateDataDescriptorId: Types.uuidToBytes(
      "11111111-2222-3333-4444-555555555555",
    ),
    encodedStateData: new Uint8Array(100).fill(42),
    argumentDataDescriptorId: Types.uuidToBytes(
      "66666666-7777-8888-9999-aaaaaaaaaaaa",
    ),
    argumentData: new Uint8Array(50).fill(7),
    outputDataDescriptorId: Types.uuidToBytes(
      "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    ),
  };

  console.log("\n=== End-to-End Roundtrip Performance ===");

  benchmark("Complete message roundtrip", () => {
    const binary = builder.buildMessage(executeMessage);
    parser.append(binary);
    parser.parseMessage();
  });

  // Test with smaller messages
  const syncMessage = {
    type: Types.MessageType.Sync,
    length: 4,
  };

  benchmark("Simple message roundtrip (Sync)", () => {
    const binary = builder.buildMessage(syncMessage);
    parser.append(binary);
    parser.parseMessage();
  });
});

// Run benchmarks
if (import.meta.main) {
  console.log("Running protocol performance benchmarks...\n");
}

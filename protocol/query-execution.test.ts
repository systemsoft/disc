/**
 * Tests for Phase 4: Enhanced Query Execution
 *
 * Tests cover:
 *   - Output format handling (JSON, BINARY, JSON_ELEMENTS, NONE)
 *   - Prepared statement cache (Parse reuse)
 *   - Error code mapping
 *   - Command status detection
 *   - State synchronization
 *   - Connection state across multiple queries
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  BinaryConnection,
  BinaryProtocolServer,
  GEL_ERROR_CODES,
  mapErrorToGelCode,
} from "./binary-server.ts";
import {
  type ClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  type ServerMessage,
} from "./messages.ts";
import {
  Cardinality,
  InputLanguage,
  OutputFormat,
  PROTOCOL_MAJOR_VERSION,
  PROTOCOL_MINOR_VERSION,
  TransactionState,
} from "./enums.ts";
import { createTestSchema } from "../compiler/context.ts";
import {
  CompilationError,
  ConnectionError,
  DatabaseExecutionError,
  InternalError,
  QueryError,
  QueryTimeoutError,
  SchemaError,
  SyntaxError,
  ValidationError,
} from "../lib/errors.ts";

// ---------------------------------------------------------------------------
// Helpers (shared with binary-server.test.ts pattern)
// ---------------------------------------------------------------------------

function createSchema() {
  return createTestSchema();
}

const ZERO_UUID = new Uint8Array(16);

async function readMessage(
  conn: Deno.TcpConn,
): Promise<{ mtype: number; payload: Uint8Array } | null> {
  const header = new Uint8Array(5);
  const headerRead = await readExact(conn, header);
  if (!headerRead) return null;

  const mtype = header[0];
  const view = new DataView(header.buffer, header.byteOffset);
  const messageLength = view.getUint32(1, false);
  const payloadLength = messageLength - 4;

  const payload = new Uint8Array(payloadLength);
  if (payloadLength > 0) {
    const ok = await readExact(conn, payload);
    if (!ok) return null;
  }

  return { mtype, payload };
}

async function readExact(
  conn: Deno.TcpConn,
  buf: Uint8Array,
): Promise<boolean> {
  let offset = 0;
  while (offset < buf.length) {
    const n = await conn.read(buf.subarray(offset));
    if (n === null) return false;
    offset += n;
  }
  return true;
}

function decode(raw: { mtype: number; payload: Uint8Array }): ServerMessage {
  return decodeServerMessage(raw.mtype, raw.payload);
}

async function sendMessage(
  conn: Deno.TcpConn,
  msg: ClientMessage,
): Promise<void> {
  const bytes = encodeClientMessage(msg);
  let offset = 0;
  while (offset < bytes.length) {
    const n = await conn.write(bytes.subarray(offset));
    offset += n;
  }
}

function clientHandshake(): ClientMessage {
  return {
    kind: "ClientHandshake",
    majorVersion: PROTOCOL_MAJOR_VERSION,
    minorVersion: PROTOCOL_MINOR_VERSION,
    params: [{ name: "user", value: "test" }, {
      name: "database",
      value: "testdb",
    }],
    extensions: [],
  };
}

function executeMsgWithFormat(
  query: string,
  outputFormat: number,
): ClientMessage {
  return {
    kind: "Execute",
    annotations: [],
    allowedCapabilities: 0xffffffffffffffffn,
    compilationFlags: 0n,
    implicitLimit: 0n,
    inputLanguage: InputLanguage.EDGEQL,
    outputFormat,
    expectedCardinality: Cardinality.MANY,
    commandText: query,
    stateTypedescId: ZERO_UUID,
    stateData: new Uint8Array(0),
    inputTypedescId: ZERO_UUID,
    outputTypedescId: ZERO_UUID,
    arguments: new Uint8Array(0),
  };
}

function executeMsg(query: string): ClientMessage {
  return executeMsgWithFormat(query, OutputFormat.BINARY);
}

function parseMsg(query: string): ClientMessage {
  return {
    kind: "Parse",
    annotations: [],
    allowedCapabilities: 0xffffffffffffffffn,
    compilationFlags: 0n,
    implicitLimit: 0n,
    inputLanguage: InputLanguage.EDGEQL,
    outputFormat: OutputFormat.BINARY,
    expectedCardinality: Cardinality.MANY,
    commandText: query,
    stateTypedescId: ZERO_UUID,
    stateData: new Uint8Array(0),
  };
}

async function performNoAuthHandshake(
  conn: Deno.TcpConn,
): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];

  await sendMessage(conn, clientHandshake());

  const raw1 = await readMessage(conn);
  if (raw1) messages.push(decode(raw1));
  const raw2 = await readMessage(conn);
  if (raw2) messages.push(decode(raw2));
  const raw3 = await readMessage(conn);
  if (raw3) messages.push(decode(raw3));

  for (let i = 0; i < 3; i++) {
    const raw = await readMessage(conn);
    if (raw) messages.push(decode(raw));
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Phase 4.1: Error code mapping tests (unit tests, no TCP)
// ---------------------------------------------------------------------------

Deno.test("query-execution - mapErrorToGelCode: SyntaxError -> EdgeQLSyntaxError", () => {
  const err = new SyntaxError("unexpected token");
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.EdgeQLSyntaxError);
});

Deno.test("query-execution - mapErrorToGelCode: SchemaError -> SchemaDefinitionError", () => {
  const err = new SchemaError("invalid schema");
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.SchemaDefinitionError);
});

Deno.test("query-execution - mapErrorToGelCode: CompilationError -> QueryError", () => {
  const err = new CompilationError("compilation failed");
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.QueryError);
});

Deno.test("query-execution - mapErrorToGelCode: QueryError -> QueryError", () => {
  const err = new QueryError("query failed");
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.QueryError);
});

Deno.test("query-execution - mapErrorToGelCode: ValidationError -> InvalidValueError", () => {
  const err = new ValidationError("invalid value");
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.InvalidValueError);
});

Deno.test("query-execution - mapErrorToGelCode: DatabaseExecutionError -> IntegrityError", () => {
  const err = new DatabaseExecutionError(
    "execution failed",
    "SELECT 1",
    new Error("pg error"),
  );
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.IntegrityError);
});

Deno.test("query-execution - mapErrorToGelCode: DatabaseExecutionError with constraint -> ConstraintViolationError", () => {
  const err = new DatabaseExecutionError(
    "constraint violation",
    "INSERT INTO ...",
    new Error("pg constraint error"),
  );
  assertEquals(
    mapErrorToGelCode(err),
    GEL_ERROR_CODES.ConstraintViolationError,
  );
});

Deno.test("query-execution - mapErrorToGelCode: QueryTimeoutError -> AvailabilityError", () => {
  const err = new QueryTimeoutError("SELECT 1", 5000);
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.AvailabilityError);
});

Deno.test("query-execution - mapErrorToGelCode: ConnectionError -> AvailabilityError", () => {
  const err = new ConnectionError("connection refused");
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.AvailabilityError);
});

Deno.test("query-execution - mapErrorToGelCode: InternalError -> InternalServerError", () => {
  const err = new InternalError("internal failure");
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.InternalServerError);
});

Deno.test("query-execution - mapErrorToGelCode: unknown Error -> InternalServerError", () => {
  const err = new Error("unknown error");
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.InternalServerError);
});

// ---------------------------------------------------------------------------
// Phase 4.3: Execute with JSON output format
// ---------------------------------------------------------------------------

Deno.test("query-execution - Execute with JSON output format returns JSON data", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Execute with JSON output format
  await sendMessage(
    conn,
    executeMsgWithFormat("select User { name }", OutputFormat.JSON),
  );

  // Read CommandDataDescription
  const rawDesc = await readMessage(conn);
  assertEquals(decode(rawDesc!).kind, "CommandDataDescription");

  // Read Data — should have JSON-encoded results
  const rawData = await readMessage(conn);
  const data = decode(rawData!);
  assertEquals(data.kind, "Data");
  if (data.kind === "Data") {
    // JSON format should return at least one element (the JSON array)
    assertEquals(data.data.length, 1);
    const jsonStr = new TextDecoder().decode(data.data[0]);
    // Should be valid JSON
    const parsed = JSON.parse(jsonStr);
    assertEquals(Array.isArray(parsed), true);
  }

  // Read CommandComplete
  const rawComplete = await readMessage(conn);
  assertEquals(decode(rawComplete!).kind, "CommandComplete");

  // Read ReadyForCommand
  const rawReady = await readMessage(conn);
  assertEquals(decode(rawReady!).kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// Phase 4.3: Execute with BINARY output format
// ---------------------------------------------------------------------------

Deno.test("query-execution - Execute with BINARY output format returns binary data", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Execute with BINARY output format
  await sendMessage(
    conn,
    executeMsgWithFormat("select User { name }", OutputFormat.BINARY),
  );

  // Read CommandDataDescription
  const rawDesc = await readMessage(conn);
  assertEquals(decode(rawDesc!).kind, "CommandDataDescription");

  // Read Data — binary format returns empty without real PG
  const rawData = await readMessage(conn);
  const data = decode(rawData!);
  assertEquals(data.kind, "Data");

  // Read CommandComplete
  const rawComplete = await readMessage(conn);
  const complete = decode(rawComplete!);
  assertEquals(complete.kind, "CommandComplete");
  if (complete.kind === "CommandComplete") {
    assertEquals(complete.status, "SELECT");
  }

  // Read ReadyForCommand
  const rawReady = await readMessage(conn);
  assertEquals(decode(rawReady!).kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// Phase 4.2: Parse caches compilation result
// ---------------------------------------------------------------------------

Deno.test("query-execution - Parse caches compilation, second Parse reuses cache", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  const query = "select User { name, email }";

  // First Parse
  await sendMessage(conn, parseMsg(query));
  const rawDesc1 = await readMessage(conn);
  const desc1 = decode(rawDesc1!);
  assertEquals(desc1.kind, "CommandDataDescription");

  // Second Parse of the same query — should reuse cache
  await sendMessage(conn, parseMsg(query));
  const rawDesc2 = await readMessage(conn);
  const desc2 = decode(rawDesc2!);
  assertEquals(desc2.kind, "CommandDataDescription");

  // Both should produce the same descriptor IDs
  if (
    desc1.kind === "CommandDataDescription" &&
    desc2.kind === "CommandDataDescription"
  ) {
    assertEquals(desc1.inputTypedescId, desc2.inputTypedescId);
    assertEquals(desc1.outputTypedescId, desc2.outputTypedescId);
  }

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// Phase 4.2: Execute with cached Parse result
// ---------------------------------------------------------------------------

Deno.test("query-execution - Execute reuses cached Parse result", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  const query = "select User { name }";

  // First: Parse to populate cache
  await sendMessage(conn, parseMsg(query));
  const rawParseDesc = await readMessage(conn);
  const parseDesc = decode(rawParseDesc!);
  assertEquals(parseDesc.kind, "CommandDataDescription");

  // Second: Execute same query — should use cached descriptors
  await sendMessage(conn, executeMsg(query));

  // Read CommandDataDescription (should match cached)
  const rawExecDesc = await readMessage(conn);
  const execDesc = decode(rawExecDesc!);
  assertEquals(execDesc.kind, "CommandDataDescription");

  if (
    parseDesc.kind === "CommandDataDescription" &&
    execDesc.kind === "CommandDataDescription"
  ) {
    assertEquals(parseDesc.inputTypedescId, execDesc.inputTypedescId);
    assertEquals(parseDesc.outputTypedescId, execDesc.outputTypedescId);
  }

  // Read Data
  const rawData = await readMessage(conn);
  assertEquals(decode(rawData!).kind, "Data");

  // Read CommandComplete
  const rawComplete = await readMessage(conn);
  assertEquals(decode(rawComplete!).kind, "CommandComplete");

  // Read ReadyForCommand
  const rawReady = await readMessage(conn);
  assertEquals(decode(rawReady!).kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// Phase 4.3: Execute with NONE output format (DDL-like)
// ---------------------------------------------------------------------------

Deno.test("query-execution - Execute with NONE output format skips Data message", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Execute a DDL-like query with NONE format
  await sendMessage(
    conn,
    executeMsgWithFormat(
      "create type Foo { required name: str }",
      OutputFormat.NONE,
    ),
  );

  // Read CommandDataDescription
  const rawDesc = await readMessage(conn);
  assertEquals(decode(rawDesc!).kind, "CommandDataDescription");

  // Should get CommandComplete directly (no Data message with NONE format)
  const rawComplete = await readMessage(conn);
  const complete = decode(rawComplete!);
  assertEquals(complete.kind, "CommandComplete");
  if (complete.kind === "CommandComplete") {
    assertEquals(complete.status, "CREATE");
  }

  // Read ReadyForCommand
  const rawReady = await readMessage(conn);
  assertEquals(decode(rawReady!).kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// Phase 4: Execute CONFIGURE query
// ---------------------------------------------------------------------------

Deno.test("query-execution - Execute CONFIGURE query returns CONFIGURE status", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  await sendMessage(
    conn,
    executeMsgWithFormat(
      "configure session set module := 'default'",
      OutputFormat.NONE,
    ),
  );

  // Read CommandDataDescription
  const rawDesc = await readMessage(conn);
  assertEquals(decode(rawDesc!).kind, "CommandDataDescription");

  // Should get CommandComplete (no Data for NONE format + configure)
  const rawComplete = await readMessage(conn);
  const complete = decode(rawComplete!);
  assertEquals(complete.kind, "CommandComplete");
  if (complete.kind === "CommandComplete") {
    assertEquals(complete.status, "CONFIGURE");
  }

  // ReadyForCommand
  const rawReady = await readMessage(conn);
  assertEquals(decode(rawReady!).kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// Phase 4: Execute INSERT/UPDATE/DELETE command status
// ---------------------------------------------------------------------------

Deno.test("query-execution - Execute INSERT returns INSERT status", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  await sendMessage(
    conn,
    executeMsg("insert User { name := 'Ada', email := 'ada@example.com' }"),
  );

  // CommandDataDescription
  await readMessage(conn);
  // Data
  await readMessage(conn);
  // CommandComplete
  const rawComplete = await readMessage(conn);
  const complete = decode(rawComplete!);
  assertEquals(complete.kind, "CommandComplete");
  if (complete.kind === "CommandComplete") {
    assertEquals(complete.status, "INSERT");
  }

  // ReadyForCommand
  await readMessage(conn);

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// Phase 4: Multiple queries in sequence maintain connection state
// ---------------------------------------------------------------------------

Deno.test("query-execution - multiple queries in sequence maintain connection state", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Query 1: SELECT
  await sendMessage(conn, executeMsg("select User { name }"));
  const rawDesc1 = await readMessage(conn); // CommandDataDescription
  assertEquals(decode(rawDesc1!).kind, "CommandDataDescription");
  await readMessage(conn); // Data
  const rawComplete1 = await readMessage(conn); // CommandComplete
  const complete1 = decode(rawComplete1!);
  assertEquals(complete1.kind, "CommandComplete");
  if (complete1.kind === "CommandComplete") {
    assertEquals(complete1.status, "SELECT");
    // Verify state data is present (zero UUID for now)
    assertEquals(complete1.stateTypedescId.length, 16);
  }
  const rawReady1 = await readMessage(conn);
  assertEquals(decode(rawReady1!).kind, "ReadyForCommand");

  // Query 2: INSERT
  await sendMessage(
    conn,
    executeMsg("insert User { name := 'Billie', email := 'billie@example.com' }"),
  );
  await readMessage(conn); // CommandDataDescription
  await readMessage(conn); // Data
  const rawComplete2 = await readMessage(conn);
  const complete2 = decode(rawComplete2!);
  assertEquals(complete2.kind, "CommandComplete");
  if (complete2.kind === "CommandComplete") {
    assertEquals(complete2.status, "INSERT");
  }
  const rawReady2 = await readMessage(conn);
  assertEquals(decode(rawReady2!).kind, "ReadyForCommand");

  // Query 3: DELETE
  await sendMessage(
    conn,
    executeMsg("delete User filter .name = 'Billie'"),
  );
  await readMessage(conn); // CommandDataDescription
  await readMessage(conn); // Data
  const rawComplete3 = await readMessage(conn);
  const complete3 = decode(rawComplete3!);
  assertEquals(complete3.kind, "CommandComplete");
  if (complete3.kind === "CommandComplete") {
    assertEquals(complete3.status, "DELETE");
  }
  const rawReady3 = await readMessage(conn);
  const ready3 = decode(rawReady3!);
  assertEquals(ready3.kind, "ReadyForCommand");
  if (ready3.kind === "ReadyForCommand") {
    assertEquals(
      ready3.transactionState,
      TransactionState.NOT_IN_TRANSACTION,
    );
  }

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// Phase 4: Execute DESCRIBE TYPE query
// ---------------------------------------------------------------------------

Deno.test("query-execution - Execute DESCRIBE TYPE returns DESCRIBE status", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  await sendMessage(
    conn,
    executeMsg("describe type User"),
  );

  // CommandDataDescription
  const rawDesc = await readMessage(conn);
  assertEquals(decode(rawDesc!).kind, "CommandDataDescription");

  // Data
  await readMessage(conn);

  // CommandComplete
  const rawComplete = await readMessage(conn);
  const complete = decode(rawComplete!);
  assertEquals(complete.kind, "CommandComplete");
  if (complete.kind === "CommandComplete") {
    assertEquals(complete.status, "DESCRIBE");
  }

  // ReadyForCommand
  const rawReady = await readMessage(conn);
  assertEquals(decode(rawReady!).kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// Phase 4.3: Execute with JSON_ELEMENTS output format
// ---------------------------------------------------------------------------

Deno.test("query-execution - Execute with JSON_ELEMENTS output format", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  await sendMessage(
    conn,
    executeMsgWithFormat("select User { name }", OutputFormat.JSON_ELEMENTS),
  );

  // CommandDataDescription
  const rawDesc = await readMessage(conn);
  assertEquals(decode(rawDesc!).kind, "CommandDataDescription");

  // Data
  const rawData = await readMessage(conn);
  const data = decode(rawData!);
  assertEquals(data.kind, "Data");

  // CommandComplete
  const rawComplete = await readMessage(conn);
  assertEquals(decode(rawComplete!).kind, "CommandComplete");

  // ReadyForCommand
  const rawReady = await readMessage(conn);
  assertEquals(decode(rawReady!).kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

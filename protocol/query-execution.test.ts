/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file
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

import { assertEquals } from "@std/assert";
import { createTestSchema } from "../compiler/context.ts";
import {
  CompilationError,
  ConnectionError,
  DatabaseExecutionError,
  InternalError,
  InvalidReferenceError,
  QueryError,
  QueryTimeoutError,
  SchemaError,
  SyntaxError,
  ValidationError
} from "../lib/errors.ts";
import {
  BinaryProtocolServer,
  GEL_ERROR_CODES,
  mapErrorToGelCode
} from "./binary-server.ts";
import {
  Cardinality,
  InputLanguage,
  OutputFormat,
  PROTOCOL_MAJOR_VERSION,
  PROTOCOL_MINOR_VERSION,
  TransactionState
} from "./enums.ts";
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage
} from "./messages.ts";

// ---------------------------------------------------------------------------
// Helpers (shared with binary-server.test.ts pattern)
// ---------------------------------------------------------------------------

function createSchema() {
  return createTestSchema();
}

const ZERO_UUID = new Uint8Array(16);

async function readMessage(
  conn: Deno.TcpConn
): Promise<{ mtype: number; payload: Uint8Array; } | null> {
  const header = new Uint8Array(5);
  const headerRead = await readExact(conn, header);
  if (!headerRead) {
    return null;
  }

  const mtype = header[0];
  const view = new DataView(header.buffer, header.byteOffset);
  const messageLength = view.getUint32(1, false);
  const payloadLength = messageLength - 4;

  const payload = new Uint8Array(payloadLength);
  if (payloadLength > 0) {
    const ok = await readExact(conn, payload);
    if (!ok) {
      return null;
    }
  }

  return { mtype, payload };
}

async function readExact(
  conn: Deno.TcpConn,
  buf: Uint8Array
): Promise<boolean> {
  let offset = 0;
  while (offset < buf.length) {
    const n = await conn.read(buf.subarray(offset));
    if (n === null) {
      return false;
    }
    offset += n;
  }
  return true;
}

function decode(raw: { mtype: number; payload: Uint8Array; }): ServerMessage {
  return decodeServerMessage(raw.mtype, raw.payload);
}

async function sendMessage(
  conn: Deno.TcpConn,
  msg: ClientMessage
): Promise<void> {
  const bytes = encodeClientMessage(msg);
  let offset = 0;
  while (offset < bytes.length) {
    const n = await conn.write(bytes.subarray(offset));
    offset += n;
  }
  // Per the Gel protocol, Execute is always paired with Sync — Sync is
  // what produces ReadyForCommand. Auto-send Sync for these tests so
  // each `sendMessage(executeMsg(...))` call sees the same response
  // sequence (CDD + Data + CC + RFC) the tests already assert.
  if (msg.kind === "Execute") {
    const syncBytes = encodeClientMessage({ kind: "Sync" });
    let so = 0;
    while (so < syncBytes.length) {
      so += await conn.write(syncBytes.subarray(so));
    }
  }
}

function clientHandshake(): ClientMessage {
  return {
    kind: "ClientHandshake",
    majorVersion: PROTOCOL_MAJOR_VERSION,
    minorVersion: PROTOCOL_MINOR_VERSION,
    params: [{ name: "user", value: "test" }, {
      name: "database",
      value: "testdb"
    }],
    extensions: []
  };
}

function executeMsgWithFormat(
  query: string,
  outputFormat: number
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
    arguments: new Uint8Array(0)
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
    stateData: new Uint8Array(0)
  };
}

async function performNoAuthHandshake(
  conn: Deno.TcpConn
): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];

  await sendMessage(conn, clientHandshake());

  const raw1 = await readMessage(conn);
  if (raw1) {
    messages.push(decode(raw1));
  }
  const raw2 = await readMessage(conn);
  if (raw2) {
    messages.push(decode(raw2));
  }
  const raw3 = await readMessage(conn);
  if (raw3) {
    messages.push(decode(raw3));
  }

  // 2x ParameterStatus + StateDataDescription + ReadyForCommand
  for (let i = 0; i < 4; i++) {
    const raw = await readMessage(conn);
    if (raw) {
      messages.push(decode(raw));
    }
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

Deno.test("query-execution - GEL_ERROR_CODES match Gel's edb/api/errors.txt", () => {
  // Real Gel clients pick the error class (and whether to retry) from these codes.
  assertEquals(GEL_ERROR_CODES.InternalServerError, 0x01000000);
  assertEquals(GEL_ERROR_CODES.UnsupportedFeatureError, 0x02000000);
  assertEquals(GEL_ERROR_CODES.ProtocolError, 0x03000000);
  assertEquals(GEL_ERROR_CODES.QueryError, 0x04000000);
  assertEquals(GEL_ERROR_CODES.InvalidSyntaxError, 0x04010000);
  assertEquals(GEL_ERROR_CODES.EdgeQLSyntaxError, 0x04010100);
  assertEquals(GEL_ERROR_CODES.SchemaSyntaxError, 0x04010200);
  assertEquals(GEL_ERROR_CODES.InvalidTypeError, 0x04020000);
  assertEquals(GEL_ERROR_CODES.InvalidTargetError, 0x04020100);
  assertEquals(GEL_ERROR_CODES.InvalidLinkTargetError, 0x04020101);
  assertEquals(GEL_ERROR_CODES.InvalidReferenceError, 0x04030000);
  assertEquals(GEL_ERROR_CODES.UnknownModuleError, 0x04030001);
  assertEquals(GEL_ERROR_CODES.UnknownDatabaseError, 0x04030005);
  assertEquals(GEL_ERROR_CODES.SchemaError, 0x04040000);
  assertEquals(GEL_ERROR_CODES.SchemaDefinitionError, 0x04050000);
  assertEquals(GEL_ERROR_CODES.InvalidConstraintDefinitionError, 0x04050109);
  assertEquals(GEL_ERROR_CODES.DuplicateDatabaseDefinitionError, 0x04050205);
  assertEquals(GEL_ERROR_CODES.IdleSessionTimeoutError, 0x04060100);
  assertEquals(GEL_ERROR_CODES.QueryTimeoutError, 0x04060200);
  assertEquals(GEL_ERROR_CODES.IdleTransactionTimeoutError, 0x04060a01);
  assertEquals(GEL_ERROR_CODES.ExecutionError, 0x05000000);
  assertEquals(GEL_ERROR_CODES.InvalidValueError, 0x05010000);
  assertEquals(GEL_ERROR_CODES.DivisionByZeroError, 0x05010001);
  assertEquals(GEL_ERROR_CODES.NumericOutOfRangeError, 0x05010002);
  assertEquals(GEL_ERROR_CODES.AccessPolicyError, 0x05010003);
  assertEquals(GEL_ERROR_CODES.IntegrityError, 0x05020000);
  assertEquals(GEL_ERROR_CODES.ConstraintViolationError, 0x05020001);
  assertEquals(GEL_ERROR_CODES.CardinalityViolationError, 0x05020002);
  assertEquals(GEL_ERROR_CODES.MissingRequiredError, 0x05020003);
  assertEquals(GEL_ERROR_CODES.TransactionError, 0x05030000);
  assertEquals(GEL_ERROR_CODES.TransactionSerializationError, 0x05030101);
  assertEquals(GEL_ERROR_CODES.TransactionDeadlockError, 0x05030102);
  assertEquals(GEL_ERROR_CODES.AccessError, 0x07000000);
  assertEquals(GEL_ERROR_CODES.AuthenticationError, 0x07010000);
  assertEquals(GEL_ERROR_CODES.AvailabilityError, 0x08000000);
  assertEquals(GEL_ERROR_CODES.BackendUnavailableError, 0x08000001);
  assertEquals(GEL_ERROR_CODES.UnsupportedBackendFeatureError, 0x09000100);
});

/*** A PostgreSQL error as the driver raises it: the SQLSTATE in `fields.code`. ***/
function pgError(code: string): Error {
  return Object.assign(new Error(`pg error ${code}`), { fields: { code } });
}

Deno.test("query-execution - mapErrorToGelCode: PostgreSQL errors map by SQLSTATE as Gel's errormech does", () => {
  const cases: Array<[string, number]> = [
    ["23000", GEL_ERROR_CODES.ConstraintViolationError], // integrity_constraint_violation
    ["23001", GEL_ERROR_CODES.ConstraintViolationError], // restrict_violation
    ["23502", GEL_ERROR_CODES.MissingRequiredError], // not_null_violation
    ["23503", GEL_ERROR_CODES.ConstraintViolationError], // foreign_key_violation
    ["23505", GEL_ERROR_CODES.ConstraintViolationError], // unique_violation (exclusive)
    ["23514", GEL_ERROR_CODES.ConstraintViolationError], // check_violation
    ["23P01", GEL_ERROR_CODES.ConstraintViolationError], // exclusion_violation
    ["21000", GEL_ERROR_CODES.CardinalityViolationError], // cardinality_violation
    ["40001", GEL_ERROR_CODES.TransactionSerializationError], // serialization_failure
    ["40P01", GEL_ERROR_CODES.TransactionDeadlockError], // deadlock_detected
    ["25006", GEL_ERROR_CODES.TransactionError], // read_only_sql_transaction
    ["25P02", GEL_ERROR_CODES.TransactionError], // in_failed_sql_transaction
    ["57014", GEL_ERROR_CODES.QueryTimeoutError], // query_canceled (statement_timeout)
    ["25P03", GEL_ERROR_CODES.IdleTransactionTimeoutError], // idle_in_transaction_session_timeout
    ["57P05", GEL_ERROR_CODES.IdleSessionTimeoutError], // idle_session_timeout
    ["22012", GEL_ERROR_CODES.DivisionByZeroError], // division_by_zero
    ["22003", GEL_ERROR_CODES.NumericOutOfRangeError], // numeric_value_out_of_range
    ["22015", GEL_ERROR_CODES.NumericOutOfRangeError], // interval_field_overflow
    ["22P02", GEL_ERROR_CODES.InvalidValueError], // invalid_text_representation
    ["22007", GEL_ERROR_CODES.InvalidValueError], // invalid_datetime_format
    ["2201B", GEL_ERROR_CODES.InvalidValueError], // invalid_regular_expression
    ["54000", GEL_ERROR_CODES.InvalidValueError], // program_limit_exceeded
    ["42501", GEL_ERROR_CODES.AccessPolicyError], // insufficient_privilege
    ["55006", GEL_ERROR_CODES.ExecutionError], // object_in_use
    ["3D000", GEL_ERROR_CODES.UnknownDatabaseError], // invalid_catalog_name
    ["42P04", GEL_ERROR_CODES.DuplicateDatabaseDefinitionError], // duplicate_database
    ["0A000", GEL_ERROR_CODES.UnsupportedBackendFeatureError], // feature_not_supported
    ["08006", GEL_ERROR_CODES.BackendUnavailableError], // connection_failure
    ["57P01", GEL_ERROR_CODES.BackendUnavailableError], // admin_shutdown
    ["57P03", GEL_ERROR_CODES.BackendUnavailableError], // cannot_connect_now
    ["42P01", GEL_ERROR_CODES.InternalServerError] // undefined_table: a Disc bug, as in Gel
  ];
  for (const [sqlState, code] of cases) {
    assertEquals(mapErrorToGelCode(pgError(sqlState)), code, `SQLSTATE ${sqlState}`);
    // The handlers wrap the driver's error; the SQLSTATE is read through `cause`.
    const wrapped = new DatabaseExecutionError(`Database query failed: ${sqlState}`, "SELECT 1", pgError(sqlState));
    assertEquals(mapErrorToGelCode(wrapped), code, `wrapped SQLSTATE ${sqlState}`);
  }
});

Deno.test("query-execution - mapErrorToGelCode: an access policy violation (SQLSTATE 42501) -> AccessPolicyError", () => {
  // As PostgreSQL raises it from disc_access_check: the driver's error, with the SQLSTATE in `fields`.
  const pgError = Object.assign(new Error("access policy violation on insert of default::Doc"), { fields: { code: "42501" } });
  assertEquals(GEL_ERROR_CODES.AccessPolicyError, 0x05010003);
  assertEquals(mapErrorToGelCode(pgError), GEL_ERROR_CODES.AccessPolicyError);
  assertEquals(mapErrorToGelCode(new DatabaseExecutionError(pgError.message, "INSERT …", pgError)), GEL_ERROR_CODES.AccessPolicyError);
});

Deno.test("query-execution - mapErrorToGelCode: DatabaseExecutionError wrapping a compile error maps the compile error", () => {
  const compile = new DatabaseExecutionError("bad query", "select 1", new CompilationError("bad query"));
  assertEquals(mapErrorToGelCode(compile), GEL_ERROR_CODES.QueryError);
  const reference = new DatabaseExecutionError("Type 'Nope' not found", "select Nope", new InvalidReferenceError("Type 'Nope' not found"));
  assertEquals(mapErrorToGelCode(reference), GEL_ERROR_CODES.InvalidReferenceError);
});

Deno.test("query-execution - mapErrorToGelCode: InvalidReferenceError -> InvalidReferenceError", () => {
  assertEquals(mapErrorToGelCode(new InvalidReferenceError("Type 'Nope' not found")), GEL_ERROR_CODES.InvalidReferenceError);
});

Deno.test("query-execution - mapErrorToGelCode: DatabaseExecutionError without a SQLSTATE -> InternalServerError", () => {
  // Not IntegrityError: nothing says an integrity constraint failed; Gel reports unrecognized backend errors as internal.
  const err = new DatabaseExecutionError("constraint violation", "INSERT INTO ...", new Error("pg constraint error"));
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.InternalServerError);
});

Deno.test("query-execution - mapErrorToGelCode: QueryTimeoutError -> QueryTimeoutError", () => {
  const err = new QueryTimeoutError("SELECT 1", 5000);
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.QueryTimeoutError);
});

Deno.test("query-execution - mapErrorToGelCode: ConnectionError -> BackendUnavailableError", () => {
  const err = new ConnectionError("connection refused");
  assertEquals(mapErrorToGelCode(err), GEL_ERROR_CODES.BackendUnavailableError);
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
  });
  await performNoAuthHandshake(conn);

  // Execute with JSON output format
  await sendMessage(
    conn,
    executeMsgWithFormat("select User { name }", OutputFormat.JSON)
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
  });
  await performNoAuthHandshake(conn);

  // Execute with BINARY output format
  await sendMessage(
    conn,
    executeMsgWithFormat("select User { name }", OutputFormat.BINARY)
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
  });
  await performNoAuthHandshake(conn);

  // Execute a DDL-like query with NONE format
  await sendMessage(
    conn,
    executeMsgWithFormat(
      "create type Foo { required name: str }",
      OutputFormat.NONE
    )
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
  });
  await performNoAuthHandshake(conn);

  await sendMessage(
    conn,
    executeMsgWithFormat(
      "configure session set module := 'default'",
      OutputFormat.NONE
    )
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
  });
  await performNoAuthHandshake(conn);

  await sendMessage(
    conn,
    executeMsg("insert User { name := 'Ada', email := 'ada@example.com' }")
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
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
    executeMsg(
      "insert User { name := 'Billie', email := 'billie@example.com' }"
    )
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
    executeMsg("delete User filter .name = 'Billie'")
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
      TransactionState.NOT_IN_TRANSACTION
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
  });
  await performNoAuthHandshake(conn);

  await sendMessage(
    conn,
    executeMsg("describe type User")
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
    schema: createSchema()
  });
  server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port
  });
  await performNoAuthHandshake(conn);

  await sendMessage(
    conn,
    executeMsgWithFormat("select User { name }", OutputFormat.JSON_ELEMENTS)
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

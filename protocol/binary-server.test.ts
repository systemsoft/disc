/**
 * Tests for the binary protocol TCP server (protocol/binary-server.ts).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { BinaryProtocolServer } from "./binary-server.ts";
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
import { buildClientFinalMessage, buildClientFirstMessage } from "./scram.ts";

const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSchema() {
  return createTestSchema();
}

const ZERO_UUID = new Uint8Array(16);

/**
 * Read a single protocol message from a TCP connection.
 * Returns { mtype, payload } or null if connection closed.
 */
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

/**
 * Read exactly buf.length bytes into buf. Returns false if connection closed.
 */
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

/**
 * Decode a raw protocol message into a ServerMessage.
 */
function decode(raw: { mtype: number; payload: Uint8Array }): ServerMessage {
  return decodeServerMessage(raw.mtype, raw.payload);
}

/**
 * Send a client message over a TCP connection.
 */
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
  // Auto-send Sync after Execute. Real Gel clients always pair the two
  // (Execute does the work, Sync produces ReadyForCommand) and the
  // existing tests assert RFC arrives, so the helper bakes it in.
  if (msg.kind === "Execute") {
    const syncBytes = encodeClientMessage({ kind: "Sync" });
    let so = 0;
    while (so < syncBytes.length) {
      so += await conn.write(syncBytes.subarray(so));
    }
  }
}

/**
 * Build a standard ClientHandshake message.
 */
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

/**
 * Build a standard Execute message for a simple query.
 */
function executeMsg(query: string): ClientMessage {
  return {
    kind: "Execute",
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
    inputTypedescId: ZERO_UUID,
    outputTypedescId: ZERO_UUID,
    arguments: new Uint8Array(0),
  };
}

/**
 * Build a Parse message for a simple query.
 */
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

/**
 * Perform no-auth handshake and read through to ReadyForCommand.
 * Returns all received messages.
 */
async function performNoAuthHandshake(
  conn: Deno.TcpConn,
): Promise<ServerMessage[]> {
  const messages: ServerMessage[] = [];

  // Send ClientHandshake
  await sendMessage(conn, clientHandshake());

  // Read ServerHandshake
  const raw1 = await readMessage(conn);
  if (raw1) messages.push(decode(raw1));

  // Read AuthenticationOK
  const raw2 = await readMessage(conn);
  if (raw2) messages.push(decode(raw2));

  // Read ServerKeyData
  const raw3 = await readMessage(conn);
  if (raw3) messages.push(decode(raw3));

  // Read 2 ParameterStatus + StateDataDescription + ReadyForCommand.
  for (let i = 0; i < 4; i++) {
    const raw = await readMessage(conn);
    if (raw) messages.push(decode(raw));
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("binary-server - starts and accepts TCP connection", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();
  assertNotEquals(server.port, 0);

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  conn.close();
  await server.stop();
});

Deno.test("binary-server - no-auth handshake returns correct sequence", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });

  const messages = await performNoAuthHandshake(conn);

  // Verify message sequence
  assertEquals(messages[0].kind, "ServerHandshake");
  if (messages[0].kind === "ServerHandshake") {
    assertEquals(messages[0].majorVersion, PROTOCOL_MAJOR_VERSION);
    assertEquals(messages[0].minorVersion, PROTOCOL_MINOR_VERSION);
  }

  assertEquals(messages[1].kind, "AuthenticationOK");

  assertEquals(messages[2].kind, "ServerKeyData");
  if (messages[2].kind === "ServerKeyData") {
    assertEquals(messages[2].data.length, 32);
  }

  assertEquals(messages[3].kind, "ParameterStatus");
  assertEquals(messages[4].kind, "ParameterStatus");
  assertEquals(messages[5].kind, "StateDataDescription");

  assertEquals(messages[6].kind, "ReadyForCommand");
  if (messages[6].kind === "ReadyForCommand") {
    assertEquals(
      messages[6].transactionState,
      TransactionState.NOT_IN_TRANSACTION,
    );
  }

  conn.close();
  await server.stop();
});

Deno.test("binary-server - auth handshake with SCRAM-SHA-256", async () => {
  const password = "testpassword";
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
    password,
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });

  // 1. Send ClientHandshake
  await sendMessage(conn, clientHandshake());

  // 2. Read ServerHandshake
  const rawSH = await readMessage(conn);
  const sh = decode(rawSH!);
  assertEquals(sh.kind, "ServerHandshake");

  // 3. Read AuthenticationRequiredSASL
  const rawAuth = await readMessage(conn);
  const authReq = decode(rawAuth!);
  assertEquals(authReq.kind, "AuthenticationRequiredSASL");
  if (authReq.kind === "AuthenticationRequiredSASL") {
    assertEquals(authReq.methods, ["SCRAM-SHA-256"]);
  }

  // 4. Client sends SASL initial response (client-first-message)
  const clientNonce = "test-nonce-12345";
  const { message: clientFirstMsg, clientFirstMessageBare } =
    buildClientFirstMessage("test", clientNonce);

  await sendMessage(conn, {
    kind: "AuthenticationSASLInitialResponse",
    method: "SCRAM-SHA-256",
    saslData: clientFirstMsg,
  });

  // 5. Read AuthenticationSASLContinue (server-first-message)
  const rawCont = await readMessage(conn);
  const saslCont = decode(rawCont!);
  assertEquals(saslCont.kind, "AuthenticationSASLContinue");

  let serverFirstMessage = "";
  if (saslCont.kind === "AuthenticationSASLContinue") {
    serverFirstMessage = textDecoder.decode(saslCont.saslData);
  }

  // 6. Client builds client-final-message
  const clientFinalMsg = await buildClientFinalMessage(
    password,
    clientNonce,
    clientFirstMessageBare,
    serverFirstMessage,
  );

  await sendMessage(conn, {
    kind: "AuthenticationSASLResponse",
    saslData: clientFinalMsg,
  });

  // 7. Read AuthenticationSASLFinal
  const rawFinal = await readMessage(conn);
  const saslFinal = decode(rawFinal!);
  assertEquals(saslFinal.kind, "AuthenticationSASLFinal");
  if (saslFinal.kind === "AuthenticationSASLFinal") {
    const serverFinal = textDecoder.decode(saslFinal.saslData);
    assertEquals(serverFinal.startsWith("v="), true);
  }

  // 8. Read AuthenticationOK
  const rawOK = await readMessage(conn);
  const authOK = decode(rawOK!);
  assertEquals(authOK.kind, "AuthenticationOK");

  // 9. Read ServerKeyData
  const rawKey = await readMessage(conn);
  const keyData = decode(rawKey!);
  assertEquals(keyData.kind, "ServerKeyData");

  // 10. Read 2x ParameterStatus + StateDataDescription + ReadyForCommand
  const rawPS1 = await readMessage(conn);
  assertEquals(decode(rawPS1!).kind, "ParameterStatus");
  const rawPS2 = await readMessage(conn);
  assertEquals(decode(rawPS2!).kind, "ParameterStatus");
  const rawState = await readMessage(conn);
  assertEquals(decode(rawState!).kind, "StateDataDescription");
  const rawReady = await readMessage(conn);
  const ready = decode(rawReady!);
  assertEquals(ready.kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

Deno.test("binary-server - wrong password during SCRAM auth", async () => {
  const password = "correct-password";
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
    password,
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });

  // Handshake
  await sendMessage(conn, clientHandshake());
  await readMessage(conn); // ServerHandshake
  await readMessage(conn); // AuthenticationRequiredSASL

  // SASL initial response
  const clientNonce = "nonce-wrong";
  const { message: clientFirstMsg, clientFirstMessageBare } =
    buildClientFirstMessage("test", clientNonce);
  await sendMessage(conn, {
    kind: "AuthenticationSASLInitialResponse",
    method: "SCRAM-SHA-256",
    saslData: clientFirstMsg,
  });

  // Read server-first
  const rawCont = await readMessage(conn);
  const saslCont = decode(rawCont!);
  assertEquals(saslCont.kind, "AuthenticationSASLContinue");

  let serverFirstMessage = "";
  if (saslCont.kind === "AuthenticationSASLContinue") {
    serverFirstMessage = textDecoder.decode(saslCont.saslData);
  }

  // Build client-final with WRONG password
  const clientFinalMsg = await buildClientFinalMessage(
    "wrong-password",
    clientNonce,
    clientFirstMessageBare,
    serverFirstMessage,
  );
  await sendMessage(conn, {
    kind: "AuthenticationSASLResponse",
    saslData: clientFinalMsg,
  });

  // Should get ErrorResponse
  const rawErr = await readMessage(conn);
  const errMsg = decode(rawErr!);
  assertEquals(errMsg.kind, "ErrorResponse");
  if (errMsg.kind === "ErrorResponse") {
    assertEquals(errMsg.message.includes("invalid credentials"), true);
  }

  // Connection should be closed by server
  // Try reading — should get null
  const next = await readMessage(conn);
  assertEquals(next, null);

  conn.close();
  await server.stop();
});

Deno.test("binary-server - Parse message returns CommandDataDescription", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Send Parse
  await sendMessage(conn, parseMsg("select User { name }"));

  // Read CommandDataDescription
  const raw = await readMessage(conn);
  const desc = decode(raw!);
  assertEquals(desc.kind, "CommandDataDescription");
  if (desc.kind === "CommandDataDescription") {
    assertEquals(desc.inputTypedescId.length, 16);
    assertEquals(desc.outputTypedescId.length, 16);
  }

  conn.close();
  await server.stop();
});

Deno.test("binary-server - Execute simple query returns Data + CommandComplete + ReadyForCommand", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Send Execute (the helper auto-pairs it with Sync — see sendMessage).
  await sendMessage(conn, executeMsg("select User { name }"));

  // Read CommandDataDescription
  const rawDesc = await readMessage(conn);
  const desc = decode(rawDesc!);
  assertEquals(desc.kind, "CommandDataDescription");

  // Read Data
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

  // Read ReadyForCommand (in response to Sync)
  const rawReady = await readMessage(conn);
  const ready = decode(rawReady!);
  assertEquals(ready.kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

Deno.test("binary-server - Sync message returns ReadyForCommand", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Send Sync
  await sendMessage(conn, { kind: "Sync" });

  // Read ReadyForCommand
  const raw = await readMessage(conn);
  const ready = decode(raw!);
  assertEquals(ready.kind, "ReadyForCommand");
  if (ready.kind === "ReadyForCommand") {
    assertEquals(
      ready.transactionState,
      TransactionState.NOT_IN_TRANSACTION,
    );
  }

  conn.close();
  await server.stop();
});

Deno.test("binary-server - Terminate closes connection gracefully", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Send Terminate
  await sendMessage(conn, { kind: "Terminate" });

  // Wait a moment for the server to process
  await new Promise((r) => setTimeout(r, 50));

  // Trying to read should get null (connection closed)
  const raw = await readMessage(conn);
  assertEquals(raw, null);

  conn.close();
  await server.stop();
});

Deno.test("binary-server - Flush is a no-op", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Send Flush — should not produce a response by itself
  await sendMessage(conn, { kind: "Flush" });

  // Send Sync after to verify connection is still alive
  await sendMessage(conn, { kind: "Sync" });

  const raw = await readMessage(conn);
  const msg = decode(raw!);
  assertEquals(msg.kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

Deno.test("binary-server - multiple sequential queries on same connection", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Execute first query
  await sendMessage(conn, executeMsg("select User { name }"));
  await readMessage(conn); // CommandDataDescription
  await readMessage(conn); // Data
  await readMessage(conn); // CommandComplete
  const raw1 = await readMessage(conn); // ReadyForCommand
  assertEquals(decode(raw1!).kind, "ReadyForCommand");

  // Execute second query
  await sendMessage(conn, executeMsg("select Post { title }"));
  await readMessage(conn); // CommandDataDescription
  await readMessage(conn); // Data
  await readMessage(conn); // CommandComplete
  const raw2 = await readMessage(conn); // ReadyForCommand
  assertEquals(decode(raw2!).kind, "ReadyForCommand");

  // Execute third query
  await sendMessage(conn, executeMsg("select User { email }"));
  await readMessage(conn); // CommandDataDescription
  await readMessage(conn); // Data
  await readMessage(conn); // CommandComplete
  const raw3 = await readMessage(conn); // ReadyForCommand
  assertEquals(decode(raw3!).kind, "ReadyForCommand");

  conn.close();
  await server.stop();
});

Deno.test("binary-server - connectionCount tracks active connections", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();
  assertEquals(server.connectionCount, 0);

  const conn1 = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn1);

  // Give the server a moment to register
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(server.connectionCount, 1);

  const conn2 = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn2);

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(server.connectionCount, 2);

  // Close one connection
  await sendMessage(conn1, { kind: "Terminate" });
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(server.connectionCount, 1);

  conn1.close();
  conn2.close();
  await server.stop();
});

Deno.test("binary-server - onConnection and onDisconnect callbacks", async () => {
  let connected = 0;
  let disconnected = 0;

  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
    onConnection: () => {
      connected++;
    },
    onDisconnect: () => {
      disconnected++;
    },
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  await new Promise((r) => setTimeout(r, 20));
  assertEquals(connected, 1);

  // Terminate
  await sendMessage(conn, { kind: "Terminate" });
  await new Promise((r) => setTimeout(r, 50));
  assertEquals(disconnected, 1);

  conn.close();
  await server.stop();
});

Deno.test("binary-server - server stop closes all connections", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });
  await performNoAuthHandshake(conn);

  // Stop the server — should close all connections
  await server.stop();

  // Connection should be closed
  const raw = await readMessage(conn);
  assertEquals(raw, null);

  conn.close();
});

// ---------------------------------------------------------------------------
// P0-08: DoS — oversized message allocation must be rejected before allocation
// ---------------------------------------------------------------------------

Deno.test("binary-server - rejects oversized messages with ErrorResponse (P0-08)", async () => {
  const server = new BinaryProtocolServer({
    port: 0,
    schema: createSchema(),
  });
  await server.start();

  const conn = await Deno.connect({
    hostname: "127.0.0.1",
    port: server.port,
  });

  // Fabricate a header whose length field claims a 1 GB payload. A vulnerable
  // server would allocate a 1 GB Uint8Array before reading any bytes. Our
  // guard must notice this before allocation and respond with an error.
  const header = new Uint8Array(5);
  header[0] = 0x50; // arbitrary mtype
  const oversize = 1_000_000_000; // ~1 GB payload
  new DataView(header.buffer).setUint32(1, oversize + 4, false);
  await conn.write(header);

  // Expect an ErrorResponse, not a crash or silent hang
  const raw = await readMessage(conn);
  assertNotEquals(raw, null);
  const msg = decode(raw!);
  assertEquals(msg.kind, "ErrorResponse");
  if (msg.kind === "ErrorResponse") {
    assertEquals(msg.errorCode, 0x03000000); // ProtocolError
  }

  conn.close();
  await server.stop();
});

// ---------------------------------------------------------------------------
// P0-09: Prepared statement cache must be bounded (LRU eviction)
// ---------------------------------------------------------------------------

Deno.test("binary-server - BinaryConnection stmt cache is bounded (P0-09)", async () => {
  // We can't easily drive 1000+ queries through the server without a full
  // schema, so exercise the cache directly via the BinaryConnection.
  const { BinaryConnection, MAX_STATEMENT_CACHE_SIZE } = await import(
    "./binary-server.ts"
  );
  const fakeConn = {
    close() {},
    read() {
      return Promise.resolve(null);
    },
    write() {
      return Promise.resolve(0);
    },
  };
  // deno-lint-ignore no-explicit-any
  const bc = new BinaryConnection(fakeConn as any, createSchema());

  // Fill past the cap to force eviction
  const cap = MAX_STATEMENT_CACHE_SIZE;
  for (let i = 0; i < cap + 10; i++) {
    // deno-lint-ignore no-explicit-any
    (bc as any).stmtCache.set(`query_${i}`, {
      commandText: `query_${i}`,
      inputDescId: ZERO_UUID,
      outputDescId: ZERO_UUID,
      inputDesc: new Uint8Array(0),
      outputDesc: new Uint8Array(0),
      outputFormat: 0,
      resultCardinality: Cardinality.MANY,
      commandStatus: "SELECT",
      params: [],
      outputShape: { kind: "scalar", isScalar: true },
    });
  }

  assertEquals(
    bc.getCacheSize() <= cap,
    true,
    `Cache must stay within ${cap} entries after inserting ${cap + 10}`,
  );
});

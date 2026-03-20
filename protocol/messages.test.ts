/**
 * Tests for protocol message encode/decode round-trips.
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  type AuthenticationOKMsg,
  type AuthenticationRequiredSASLMsg,
  type AuthenticationSASLContinueMsg,
  type AuthenticationSASLFinalMsg,
  type AuthenticationSASLInitialResponseMsg,
  type AuthenticationSASLResponseMsg,
  Cardinality,
  type ClientHandshakeMsg,
  type ClientMessage,
  ClientMessageType,
  type CommandCompleteMsg,
  type CommandDataDescriptionMsg,
  CompilationFlag,
  type DataMsg,
  decodeClientMessage,
  decodeServerMessage,
  encodeClientMessage,
  encodeServerMessage,
  type ErrorResponseMsg,
  ErrorSeverity,
  type ExecuteMsg,
  type FlushMsg,
  InputLanguage,
  type LogMessageMsg,
  OutputFormat,
  type ParameterStatusMsg,
  type ParseMsg,
  type ReadyForCommandMsg,
  type ServerHandshakeMsg,
  type ServerKeyDataMsg,
  type ServerMessage,
  ServerMessageType,
  splitWireMessage,
  type SyncMsg,
  type TerminateMsg,
  TransactionState,
} from "./messages.ts";

// ---------------------------------------------------------------------------
// Helper: round-trip a client message through encode → split → decode
// ---------------------------------------------------------------------------

function roundTripClient(msg: ClientMessage): ClientMessage {
  const wire = encodeClientMessage(msg);
  const split = splitWireMessage(wire);
  if (!split) throw new Error("splitWireMessage returned null");
  return decodeClientMessage(split.mtype, split.payload);
}

function roundTripServer(msg: ServerMessage): ServerMessage {
  const wire = encodeServerMessage(msg);
  const split = splitWireMessage(wire);
  if (!split) throw new Error("splitWireMessage returned null");
  return decodeServerMessage(split.mtype, split.payload);
}

// ---------------------------------------------------------------------------
// Helper: create a 16-byte UUID
// ---------------------------------------------------------------------------

function makeUUID(seed: number): Uint8Array {
  const uuid = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    uuid[i] = (seed + i) & 0xff;
  }
  return uuid;
}

// ===================================================================
// CLIENT MESSAGES
// ===================================================================

Deno.test("ClientHandshake - round-trip", () => {
  const msg: ClientHandshakeMsg = {
    kind: "ClientHandshake",
    majorVersion: 2,
    minorVersion: 0,
    params: [
      { name: "database", value: "testdb" },
      { name: "user", value: "edgedb" },
    ],
    extensions: [
      {
        name: "ext1",
        annotations: [{ name: "key", value: "val" }],
      },
    ],
  };

  const result = roundTripClient(msg) as ClientHandshakeMsg;
  assertEquals(result.kind, "ClientHandshake");
  assertEquals(result.majorVersion, 2);
  assertEquals(result.minorVersion, 0);
  assertEquals(result.params.length, 2);
  assertEquals(result.params[0].name, "database");
  assertEquals(result.params[0].value, "testdb");
  assertEquals(result.params[1].name, "user");
  assertEquals(result.params[1].value, "edgedb");
  assertEquals(result.extensions.length, 1);
  assertEquals(result.extensions[0].name, "ext1");
  assertEquals(result.extensions[0].annotations.length, 1);
  assertEquals(result.extensions[0].annotations[0].name, "key");
  assertEquals(result.extensions[0].annotations[0].value, "val");
});

Deno.test(
  "ClientHandshake - empty params and extensions",
  () => {
    const msg: ClientHandshakeMsg = {
      kind: "ClientHandshake",
      majorVersion: 1,
      minorVersion: 0,
      params: [],
      extensions: [],
    };

    const result = roundTripClient(msg) as ClientHandshakeMsg;
    assertEquals(result.kind, "ClientHandshake");
    assertEquals(result.params.length, 0);
    assertEquals(result.extensions.length, 0);
  },
);

Deno.test(
  "AuthenticationSASLInitialResponse - round-trip",
  () => {
    const msg: AuthenticationSASLInitialResponseMsg = {
      kind: "AuthenticationSASLInitialResponse",
      method: "SCRAM-SHA-256",
      saslData: new Uint8Array([1, 2, 3, 4, 5]),
    };

    const result = roundTripClient(msg) as AuthenticationSASLInitialResponseMsg;
    assertEquals(result.kind, "AuthenticationSASLInitialResponse");
    assertEquals(result.method, "SCRAM-SHA-256");
    assertEquals(result.saslData, new Uint8Array([1, 2, 3, 4, 5]));
  },
);

Deno.test(
  "AuthenticationSASLResponse - round-trip",
  () => {
    const msg: AuthenticationSASLResponseMsg = {
      kind: "AuthenticationSASLResponse",
      saslData: new Uint8Array([10, 20, 30]),
    };

    const result = roundTripClient(msg) as AuthenticationSASLResponseMsg;
    assertEquals(result.kind, "AuthenticationSASLResponse");
    assertEquals(result.saslData, new Uint8Array([10, 20, 30]));
  },
);

Deno.test("Parse message - round-trip", () => {
  const stateId = makeUUID(0x10);
  const msg: ParseMsg = {
    kind: "Parse",
    annotations: [{ name: "query_id", value: "abc123" }],
    allowedCapabilities: 0xffn,
    compilationFlags: CompilationFlag.INJECT_OUTPUT_TYPE_IDS |
      CompilationFlag.INJECT_OUTPUT_TYPE_NAMES,
    implicitLimit: 100n,
    inputLanguage: InputLanguage.EDGEQL,
    outputFormat: OutputFormat.JSON,
    expectedCardinality: Cardinality.MANY,
    commandText: "SELECT User { name, email }",
    stateTypedescId: stateId,
    stateData: new Uint8Array([7, 8, 9]),
  };

  const result = roundTripClient(msg) as ParseMsg;
  assertEquals(result.kind, "Parse");
  assertEquals(result.annotations.length, 1);
  assertEquals(result.annotations[0].name, "query_id");
  assertEquals(result.annotations[0].value, "abc123");
  assertEquals(result.allowedCapabilities, 0xffn);
  assertEquals(
    result.compilationFlags,
    CompilationFlag.INJECT_OUTPUT_TYPE_IDS |
      CompilationFlag.INJECT_OUTPUT_TYPE_NAMES,
  );
  assertEquals(result.implicitLimit, 100n);
  assertEquals(result.inputLanguage, InputLanguage.EDGEQL);
  assertEquals(result.outputFormat, OutputFormat.JSON);
  assertEquals(result.expectedCardinality, Cardinality.MANY);
  assertEquals(result.commandText, "SELECT User { name, email }");
  assertEquals(result.stateTypedescId, stateId);
  assertEquals(result.stateData, new Uint8Array([7, 8, 9]));
});

Deno.test("Parse message - SQL input language", () => {
  const msg: ParseMsg = {
    kind: "Parse",
    annotations: [],
    allowedCapabilities: 0n,
    compilationFlags: 0n,
    implicitLimit: 0n,
    inputLanguage: InputLanguage.SQL,
    outputFormat: OutputFormat.BINARY,
    expectedCardinality: Cardinality.ONE,
    commandText: "SELECT 1",
    stateTypedescId: new Uint8Array(16),
    stateData: new Uint8Array(0),
  };

  const result = roundTripClient(msg) as ParseMsg;
  assertEquals(result.inputLanguage, InputLanguage.SQL);
  assertEquals(result.outputFormat, OutputFormat.BINARY);
  assertEquals(result.expectedCardinality, Cardinality.ONE);
});

Deno.test("Execute message - round-trip", () => {
  const stateId = makeUUID(0x20);
  const inputId = makeUUID(0x30);
  const outputId = makeUUID(0x40);

  const msg: ExecuteMsg = {
    kind: "Execute",
    annotations: [],
    allowedCapabilities: 0xffffffffffffffffn,
    compilationFlags: 0n,
    implicitLimit: 0n,
    inputLanguage: InputLanguage.EDGEQL,
    outputFormat: OutputFormat.JSON,
    expectedCardinality: Cardinality.AT_MOST_ONE,
    commandText: "SELECT User FILTER .id = <uuid>$0",
    stateTypedescId: stateId,
    stateData: new Uint8Array(0),
    inputTypedescId: inputId,
    outputTypedescId: outputId,
    arguments: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  };

  const result = roundTripClient(msg) as ExecuteMsg;
  assertEquals(result.kind, "Execute");
  assertEquals(result.allowedCapabilities, 0xffffffffffffffffn);
  assertEquals(
    result.commandText,
    "SELECT User FILTER .id = <uuid>$0",
  );
  assertEquals(result.stateTypedescId, stateId);
  assertEquals(result.inputTypedescId, inputId);
  assertEquals(result.outputTypedescId, outputId);
  assertEquals(
    result.arguments,
    new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
  );
});

Deno.test("Sync message - round-trip", () => {
  const msg: SyncMsg = { kind: "Sync" };
  const result = roundTripClient(msg) as SyncMsg;
  assertEquals(result.kind, "Sync");
});

Deno.test("Flush message - round-trip", () => {
  const msg: FlushMsg = { kind: "Flush" };
  const result = roundTripClient(msg) as FlushMsg;
  assertEquals(result.kind, "Flush");
});

Deno.test("Terminate message - round-trip", () => {
  const msg: TerminateMsg = { kind: "Terminate" };
  const result = roundTripClient(msg) as TerminateMsg;
  assertEquals(result.kind, "Terminate");
});

// ===================================================================
// SERVER MESSAGES
// ===================================================================

Deno.test("ServerHandshake - round-trip", () => {
  const msg: ServerHandshakeMsg = {
    kind: "ServerHandshake",
    majorVersion: 2,
    minorVersion: 0,
    extensions: [
      {
        name: "auth",
        annotations: [
          { name: "type", value: "SCRAM-SHA-256" },
        ],
      },
    ],
  };

  const result = roundTripServer(msg) as ServerHandshakeMsg;
  assertEquals(result.kind, "ServerHandshake");
  assertEquals(result.majorVersion, 2);
  assertEquals(result.minorVersion, 0);
  assertEquals(result.extensions.length, 1);
  assertEquals(result.extensions[0].name, "auth");
  assertEquals(result.extensions[0].annotations[0].value, "SCRAM-SHA-256");
});

Deno.test(
  "ServerHandshake - no extensions",
  () => {
    const msg: ServerHandshakeMsg = {
      kind: "ServerHandshake",
      majorVersion: 1,
      minorVersion: 0,
      extensions: [],
    };

    const result = roundTripServer(msg) as ServerHandshakeMsg;
    assertEquals(result.extensions.length, 0);
  },
);

Deno.test("AuthenticationOK - round-trip", () => {
  const msg: AuthenticationOKMsg = { kind: "AuthenticationOK" };
  const result = roundTripServer(msg) as AuthenticationOKMsg;
  assertEquals(result.kind, "AuthenticationOK");
});

Deno.test(
  "AuthenticationRequiredSASL - round-trip",
  () => {
    const msg: AuthenticationRequiredSASLMsg = {
      kind: "AuthenticationRequiredSASL",
      methods: ["SCRAM-SHA-256", "SCRAM-SHA-256-PLUS"],
    };

    const result = roundTripServer(msg) as AuthenticationRequiredSASLMsg;
    assertEquals(result.kind, "AuthenticationRequiredSASL");
    assertEquals(result.methods.length, 2);
    assertEquals(result.methods[0], "SCRAM-SHA-256");
    assertEquals(result.methods[1], "SCRAM-SHA-256-PLUS");
  },
);

Deno.test(
  "AuthenticationSASLContinue - round-trip",
  () => {
    const msg: AuthenticationSASLContinueMsg = {
      kind: "AuthenticationSASLContinue",
      saslData: new Uint8Array([0xca, 0xfe]),
    };

    const result = roundTripServer(msg) as AuthenticationSASLContinueMsg;
    assertEquals(result.kind, "AuthenticationSASLContinue");
    assertEquals(result.saslData, new Uint8Array([0xca, 0xfe]));
  },
);

Deno.test(
  "AuthenticationSASLFinal - round-trip",
  () => {
    const msg: AuthenticationSASLFinalMsg = {
      kind: "AuthenticationSASLFinal",
      saslData: new Uint8Array([0xde, 0xad]),
    };

    const result = roundTripServer(msg) as AuthenticationSASLFinalMsg;
    assertEquals(result.kind, "AuthenticationSASLFinal");
    assertEquals(result.saslData, new Uint8Array([0xde, 0xad]));
  },
);

Deno.test("ReadyForCommand - NOT_IN_TRANSACTION", () => {
  const msg: ReadyForCommandMsg = {
    kind: "ReadyForCommand",
    annotations: [],
    transactionState: TransactionState.NOT_IN_TRANSACTION,
  };

  const result = roundTripServer(msg) as ReadyForCommandMsg;
  assertEquals(result.kind, "ReadyForCommand");
  assertEquals(
    result.transactionState,
    TransactionState.NOT_IN_TRANSACTION,
  );
  assertEquals(result.annotations.length, 0);
});

Deno.test("ReadyForCommand - IN_TRANSACTION with annotations", () => {
  const msg: ReadyForCommandMsg = {
    kind: "ReadyForCommand",
    annotations: [{ name: "hint", value: "use COMMIT" }],
    transactionState: TransactionState.IN_TRANSACTION,
  };

  const result = roundTripServer(msg) as ReadyForCommandMsg;
  assertEquals(
    result.transactionState,
    TransactionState.IN_TRANSACTION,
  );
  assertEquals(result.annotations.length, 1);
  assertEquals(result.annotations[0].value, "use COMMIT");
});

Deno.test("ReadyForCommand - IN_FAILED_TRANSACTION", () => {
  const msg: ReadyForCommandMsg = {
    kind: "ReadyForCommand",
    annotations: [],
    transactionState: TransactionState.IN_FAILED_TRANSACTION,
  };

  const result = roundTripServer(msg) as ReadyForCommandMsg;
  assertEquals(
    result.transactionState,
    TransactionState.IN_FAILED_TRANSACTION,
  );
});

Deno.test("CommandComplete - round-trip", () => {
  const stateId = makeUUID(0x50);
  const msg: CommandCompleteMsg = {
    kind: "CommandComplete",
    annotations: [{ name: "elapsed", value: "12ms" }],
    capabilities: 0x0fn,
    status: "SELECT",
    stateTypedescId: stateId,
    stateData: new Uint8Array([1, 2]),
  };

  const result = roundTripServer(msg) as CommandCompleteMsg;
  assertEquals(result.kind, "CommandComplete");
  assertEquals(result.annotations[0].name, "elapsed");
  assertEquals(result.capabilities, 0x0fn);
  assertEquals(result.status, "SELECT");
  assertEquals(result.stateTypedescId, stateId);
  assertEquals(result.stateData, new Uint8Array([1, 2]));
});

Deno.test("CommandDataDescription - round-trip", () => {
  const inputId = makeUUID(0x60);
  const outputId = makeUUID(0x70);

  const msg: CommandDataDescriptionMsg = {
    kind: "CommandDataDescription",
    annotations: [],
    capabilities: 0n,
    resultCardinality: Cardinality.MANY,
    inputTypedescId: inputId,
    inputTypedesc: new Uint8Array([0xaa, 0xbb]),
    outputTypedescId: outputId,
    outputTypedesc: new Uint8Array([0xcc, 0xdd, 0xee]),
  };

  const result = roundTripServer(msg) as CommandDataDescriptionMsg;
  assertEquals(result.kind, "CommandDataDescription");
  assertEquals(result.resultCardinality, Cardinality.MANY);
  assertEquals(result.inputTypedescId, inputId);
  assertEquals(result.inputTypedesc, new Uint8Array([0xaa, 0xbb]));
  assertEquals(result.outputTypedescId, outputId);
  assertEquals(
    result.outputTypedesc,
    new Uint8Array([0xcc, 0xdd, 0xee]),
  );
});

Deno.test("Data message - single element", () => {
  const encoder = new TextEncoder();
  const msg: DataMsg = {
    kind: "Data",
    data: [encoder.encode('{"name":"Alice"}')],
  };

  const result = roundTripServer(msg) as DataMsg;
  assertEquals(result.kind, "Data");
  assertEquals(result.data.length, 1);
  const decoder = new TextDecoder();
  assertEquals(decoder.decode(result.data[0]), '{"name":"Alice"}');
});

Deno.test("Data message - multiple elements", () => {
  const encoder = new TextEncoder();
  const msg: DataMsg = {
    kind: "Data",
    data: [
      encoder.encode('{"id":1}'),
      encoder.encode('{"id":2}'),
      encoder.encode('{"id":3}'),
    ],
  };

  const result = roundTripServer(msg) as DataMsg;
  assertEquals(result.data.length, 3);
});

Deno.test("Data message - empty", () => {
  const msg: DataMsg = { kind: "Data", data: [] };
  const result = roundTripServer(msg) as DataMsg;
  assertEquals(result.data.length, 0);
});

Deno.test("ErrorResponse - round-trip", () => {
  const encoder = new TextEncoder();
  const msg: ErrorResponseMsg = {
    kind: "ErrorResponse",
    severity: ErrorSeverity.ERROR,
    errorCode: 0x01000000,
    message: "Syntax error at or near 'SELCT'",
    attributes: [
      { code: 0x0001, value: encoder.encode("Did you mean SELECT?") },
      { code: 0xfff3, value: encoder.encode("1") },
      { code: 0xfff4, value: encoder.encode("0") },
    ],
  };

  const result = roundTripServer(msg) as ErrorResponseMsg;
  assertEquals(result.kind, "ErrorResponse");
  assertEquals(result.severity, ErrorSeverity.ERROR);
  assertEquals(result.errorCode, 0x01000000);
  assertEquals(result.message, "Syntax error at or near 'SELCT'");
  assertEquals(result.attributes.length, 3);
  assertEquals(result.attributes[0].code, 0x0001);
  const decoder = new TextDecoder();
  assertEquals(
    decoder.decode(result.attributes[0].value),
    "Did you mean SELECT?",
  );
});

Deno.test("ErrorResponse - FATAL severity", () => {
  const msg: ErrorResponseMsg = {
    kind: "ErrorResponse",
    severity: ErrorSeverity.FATAL,
    errorCode: 0xff000000,
    message: "Server shutting down",
    attributes: [],
  };

  const result = roundTripServer(msg) as ErrorResponseMsg;
  assertEquals(result.severity, ErrorSeverity.FATAL);
});

Deno.test("ErrorResponse - PANIC severity", () => {
  const msg: ErrorResponseMsg = {
    kind: "ErrorResponse",
    severity: ErrorSeverity.PANIC,
    errorCode: 0xff000001,
    message: "Unrecoverable error",
    attributes: [],
  };

  const result = roundTripServer(msg) as ErrorResponseMsg;
  assertEquals(result.severity, ErrorSeverity.PANIC);
});

Deno.test("ParameterStatus - round-trip", () => {
  const encoder = new TextEncoder();
  const msg: ParameterStatusMsg = {
    kind: "ParameterStatus",
    name: encoder.encode("server_version"),
    value: encoder.encode("2.0"),
  };

  const result = roundTripServer(msg) as ParameterStatusMsg;
  assertEquals(result.kind, "ParameterStatus");
  const decoder = new TextDecoder();
  assertEquals(decoder.decode(result.name), "server_version");
  assertEquals(decoder.decode(result.value), "2.0");
});

Deno.test("ServerKeyData - round-trip", () => {
  const keyData = new Uint8Array(32);
  for (let i = 0; i < 32; i++) keyData[i] = i;

  const msg: ServerKeyDataMsg = {
    kind: "ServerKeyData",
    data: keyData,
  };

  const result = roundTripServer(msg) as ServerKeyDataMsg;
  assertEquals(result.kind, "ServerKeyData");
  assertEquals(result.data, keyData);
});

Deno.test("ServerKeyData - rejects wrong size", () => {
  const msg: ServerKeyDataMsg = {
    kind: "ServerKeyData",
    data: new Uint8Array(16), // wrong size
  };

  assertThrows(
    () => encodeServerMessage(msg),
    Error,
    "ServerKeyData must be exactly 32 bytes",
  );
});

Deno.test("LogMessage - round-trip", () => {
  const msg: LogMessageMsg = {
    kind: "LogMessage",
    severity: ErrorSeverity.ERROR,
    code: 42000,
    text: "Something went wrong",
    annotations: [
      { name: "detail", value: "Check your input" },
    ],
  };

  const result = roundTripServer(msg) as LogMessageMsg;
  assertEquals(result.kind, "LogMessage");
  assertEquals(result.severity, ErrorSeverity.ERROR);
  assertEquals(result.code, 42000);
  assertEquals(result.text, "Something went wrong");
  assertEquals(result.annotations.length, 1);
  assertEquals(result.annotations[0].name, "detail");
});

// ===================================================================
// WIRE FORMAT CORRECTNESS
// ===================================================================

Deno.test("wire format - mtype byte is correct for Sync", () => {
  const wire = encodeClientMessage({ kind: "Sync" });
  assertEquals(wire[0], ClientMessageType.Sync); // 0x53 = 'S'
  assertEquals(wire[0], 0x53);
});

Deno.test("wire format - mtype byte is correct for Flush", () => {
  const wire = encodeClientMessage({ kind: "Flush" });
  assertEquals(wire[0], ClientMessageType.Flush); // 0x48 = 'H'
});

Deno.test("wire format - mtype byte is correct for Terminate", () => {
  const wire = encodeClientMessage({ kind: "Terminate" });
  assertEquals(wire[0], ClientMessageType.Terminate); // 0x58 = 'X'
});

Deno.test(
  "wire format - empty payload messages have length 4",
  () => {
    const wire = encodeClientMessage({ kind: "Sync" });
    // mtype(1) + length(4) = 5 bytes total
    assertEquals(wire.length, 5);
    const view = new DataView(wire.buffer, wire.byteOffset);
    // message_length includes the 4-byte length field itself
    assertEquals(view.getUint32(1, false), 4);
  },
);

Deno.test(
  "wire format - Authentication mtype is 0x52 for all auth subtypes",
  () => {
    const ok = encodeServerMessage({ kind: "AuthenticationOK" });
    assertEquals(ok[0], 0x52);

    const sasl = encodeServerMessage({
      kind: "AuthenticationRequiredSASL",
      methods: ["SCRAM-SHA-256"],
    });
    assertEquals(sasl[0], 0x52);

    const cont = encodeServerMessage({
      kind: "AuthenticationSASLContinue",
      saslData: new Uint8Array(0),
    });
    assertEquals(cont[0], 0x52);

    const final = encodeServerMessage({
      kind: "AuthenticationSASLFinal",
      saslData: new Uint8Array(0),
    });
    assertEquals(final[0], 0x52);
  },
);

// ===================================================================
// splitWireMessage
// ===================================================================

Deno.test("splitWireMessage - returns null for short buffer", () => {
  assertEquals(splitWireMessage(new Uint8Array(4)), null);
});

Deno.test(
  "splitWireMessage - returns null for incomplete message",
  () => {
    const wire = encodeClientMessage({ kind: "Sync" });
    // Truncate to 4 bytes (missing payload end)
    assertEquals(splitWireMessage(wire.subarray(0, 4)), null);
  },
);

Deno.test("splitWireMessage - parses complete message", () => {
  const wire = encodeClientMessage({ kind: "Sync" });
  const result = splitWireMessage(wire);
  assertEquals(result !== null, true);
  assertEquals(result!.mtype, ClientMessageType.Sync);
  assertEquals(result!.payload.length, 0);
});

// ===================================================================
// ERROR CASES
// ===================================================================

Deno.test(
  "decodeClientMessage - unknown mtype throws",
  () => {
    assertThrows(
      () => decodeClientMessage(0xff, new Uint8Array(0)),
      Error,
      "Unknown client message type",
    );
  },
);

Deno.test(
  "decodeServerMessage - unknown mtype throws",
  () => {
    assertThrows(
      () => decodeServerMessage(0x01, new Uint8Array(0)),
      Error,
      "Unknown server message type",
    );
  },
);

// ===================================================================
// ENUM VALUE SERIALIZATION
// ===================================================================

Deno.test("Cardinality values serialize correctly", () => {
  assertEquals(Cardinality.NO_RESULT, 0x6e);
  assertEquals(Cardinality.AT_MOST_ONE, 0x6f);
  assertEquals(Cardinality.ONE, 0x41);
  assertEquals(Cardinality.MANY, 0x6d);
  assertEquals(Cardinality.AT_LEAST_ONE, 0x4d);
});

Deno.test("TransactionState values serialize correctly", () => {
  assertEquals(TransactionState.NOT_IN_TRANSACTION, 0x49);
  assertEquals(TransactionState.IN_TRANSACTION, 0x54);
  assertEquals(TransactionState.IN_FAILED_TRANSACTION, 0x45);
});

Deno.test("InputLanguage values serialize correctly", () => {
  assertEquals(InputLanguage.EDGEQL, 0x45);
  assertEquals(InputLanguage.SQL, 0x53);
});

Deno.test("OutputFormat values serialize correctly", () => {
  assertEquals(OutputFormat.BINARY, 0x62);
  assertEquals(OutputFormat.JSON, 0x6a);
  assertEquals(OutputFormat.JSON_ELEMENTS, 0x4a);
  assertEquals(OutputFormat.NONE, 0x6e);
});

Deno.test("ErrorSeverity values serialize correctly", () => {
  assertEquals(ErrorSeverity.ERROR, 120);
  assertEquals(ErrorSeverity.FATAL, 200);
  assertEquals(ErrorSeverity.PANIC, 255);
});

Deno.test("ClientMessageType values are correct", () => {
  assertEquals(ClientMessageType.ClientHandshake, 0x56);
  assertEquals(
    ClientMessageType.AuthenticationSASLInitialResponse,
    0x70,
  );
  assertEquals(ClientMessageType.AuthenticationSASLResponse, 0x72);
  assertEquals(ClientMessageType.Parse, 0x50);
  assertEquals(ClientMessageType.Execute, 0x4f);
  assertEquals(ClientMessageType.Sync, 0x53);
  assertEquals(ClientMessageType.Flush, 0x48);
  assertEquals(ClientMessageType.Terminate, 0x58);
});

Deno.test("ServerMessageType values are correct", () => {
  assertEquals(ServerMessageType.ServerHandshake, 0x76);
  assertEquals(ServerMessageType.Authentication, 0x52);
  assertEquals(ServerMessageType.ReadyForCommand, 0x5a);
  assertEquals(ServerMessageType.CommandComplete, 0x43);
  assertEquals(ServerMessageType.CommandDataDescription, 0x54);
  assertEquals(ServerMessageType.Data, 0x44);
  assertEquals(ServerMessageType.ErrorResponse, 0x45);
  assertEquals(ServerMessageType.ParameterStatus, 0x53);
  assertEquals(ServerMessageType.ServerKeyData, 0x4b);
  assertEquals(ServerMessageType.LogMessage, 0x4c);
});

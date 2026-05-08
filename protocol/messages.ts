/**
 * Binary protocol message types and encode/decode functions.
 *
 * Every message type has:
 *   - An interface with a `kind` discriminator string
 *   - An encode function that produces a Uint8Array (with mtype + length header)
 *   - A decode function that reads from a BufferReader (payload only, after header)
 *
 * Top-level entry points:
 *   - encodeServerMessage(msg) — encode any ServerMessage
 *   - decodeClientMessage(mtype, payload) — decode a client message from raw payload
 *   - encodeClientMessage(msg) — encode any ClientMessage (for testing / client use)
 *   - decodeServerMessage(mtype, payload) — decode a server message from raw payload
 */

import { BufferReader, BufferWriter } from "./buffer.ts";
import {
  AuthStatus,
  Cardinality,
  ClientMessageType,
  CompilationFlag,
  ErrorSeverity,
  InputLanguage,
  OutputFormat,
  ServerMessageType,
  TransactionState
} from "./enums.ts";

// Re-export enums for convenience
export { AuthStatus, Cardinality, ClientMessageType, CompilationFlag, ErrorSeverity, InputLanguage, OutputFormat, ServerMessageType, TransactionState };

// ---------------------------------------------------------------------------
// Shared sub-structures
// ---------------------------------------------------------------------------

export interface Annotation {
  name: string;
  value: string;
}

export interface ProtocolExtension {
  name: string;
  annotations: Annotation[];
}

export interface ErrorAttribute {
  code: number;
  value: Uint8Array;
}

// ---------------------------------------------------------------------------
// Client message interfaces
// ---------------------------------------------------------------------------

export interface ClientHandshakeMsg {
  kind: "ClientHandshake";
  majorVersion: number;
  minorVersion: number;
  params: Array<{ name: string; value: string; }>;
  extensions: ProtocolExtension[];
}

export interface AuthenticationSASLInitialResponseMsg {
  kind: "AuthenticationSASLInitialResponse";
  method: string;
  saslData: Uint8Array;
}

export interface AuthenticationSASLResponseMsg {
  kind: "AuthenticationSASLResponse";
  saslData: Uint8Array;
}

export interface ParseMsg {
  kind: "Parse";
  annotations: Annotation[];
  allowedCapabilities: bigint;
  compilationFlags: bigint;
  implicitLimit: bigint;
  inputLanguage: number;
  outputFormat: number;
  expectedCardinality: number;
  commandText: string;
  stateTypedescId: Uint8Array;
  stateData: Uint8Array;
}

export interface ExecuteMsg {
  kind: "Execute";
  annotations: Annotation[];
  allowedCapabilities: bigint;
  compilationFlags: bigint;
  implicitLimit: bigint;
  inputLanguage: number;
  outputFormat: number;
  expectedCardinality: number;
  commandText: string;
  stateTypedescId: Uint8Array;
  stateData: Uint8Array;
  inputTypedescId: Uint8Array;
  outputTypedescId: Uint8Array;
  arguments: Uint8Array;
}

export interface SyncMsg {
  kind: "Sync";
}

export interface FlushMsg {
  kind: "Flush";
}

export interface TerminateMsg {
  kind: "Terminate";
}

export type ClientMessage =
  | ClientHandshakeMsg
  | AuthenticationSASLInitialResponseMsg
  | AuthenticationSASLResponseMsg
  | ParseMsg
  | ExecuteMsg
  | SyncMsg
  | FlushMsg
  | TerminateMsg;

// ---------------------------------------------------------------------------
// Server message interfaces
// ---------------------------------------------------------------------------

export interface ServerHandshakeMsg {
  kind: "ServerHandshake";
  majorVersion: number;
  minorVersion: number;
  extensions: ProtocolExtension[];
}

export interface AuthenticationOKMsg {
  kind: "AuthenticationOK";
}

export interface AuthenticationRequiredSASLMsg {
  kind: "AuthenticationRequiredSASL";
  methods: string[];
}

export interface AuthenticationSASLContinueMsg {
  kind: "AuthenticationSASLContinue";
  saslData: Uint8Array;
}

export interface AuthenticationSASLFinalMsg {
  kind: "AuthenticationSASLFinal";
  saslData: Uint8Array;
}

export interface ReadyForCommandMsg {
  kind: "ReadyForCommand";
  annotations: Annotation[];
  transactionState: number;
}

export interface CommandCompleteMsg {
  kind: "CommandComplete";
  annotations: Annotation[];
  capabilities: bigint;
  status: string;
  stateTypedescId: Uint8Array;
  stateData: Uint8Array;
}

export interface CommandDataDescriptionMsg {
  kind: "CommandDataDescription";
  annotations: Annotation[];
  capabilities: bigint;
  resultCardinality: number;
  inputTypedescId: Uint8Array;
  inputTypedesc: Uint8Array;
  outputTypedescId: Uint8Array;
  outputTypedesc: Uint8Array;
}

export interface DataMsg {
  kind: "Data";
  data: Uint8Array[];
}

export interface ErrorResponseMsg {
  kind: "ErrorResponse";
  severity: number;
  errorCode: number;
  message: string;
  attributes: ErrorAttribute[];
}

export interface ParameterStatusMsg {
  kind: "ParameterStatus";
  name: Uint8Array;
  value: Uint8Array;
}

export interface ServerKeyDataMsg {
  kind: "ServerKeyData";
  data: Uint8Array;
}

export interface LogMessageMsg {
  kind: "LogMessage";
  severity: number;
  code: number;
  text: string;
  annotations: Annotation[];
}

/**
 * StateDataDescription — server tells the client how to encode/decode the
 * connection-state input shape. Required by both the upstream Gel Python
 * and JS clients before they will encode connection state on Parse/Execute.
 */
export interface StateDataDescriptionMsg {
  kind: "StateDataDescription";
  typedescId: Uint8Array;
  typedesc: Uint8Array;
}

export type ServerMessage =
  | ServerHandshakeMsg
  | AuthenticationOKMsg
  | AuthenticationRequiredSASLMsg
  | AuthenticationSASLContinueMsg
  | AuthenticationSASLFinalMsg
  | ReadyForCommandMsg
  | CommandCompleteMsg
  | CommandDataDescriptionMsg
  | DataMsg
  | ErrorResponseMsg
  | ParameterStatusMsg
  | ServerKeyDataMsg
  | LogMessageMsg
  | StateDataDescriptionMsg;

// ---------------------------------------------------------------------------
// Annotation helpers (shared encode/decode)
// ---------------------------------------------------------------------------

function writeAnnotations(w: BufferWriter, annotations: Annotation[]): void {
  w.writeUInt16(annotations.length);
  for (const ann of annotations) {
    w.writeString(ann.name);
    w.writeString(ann.value);
  }
}

function readAnnotations(r: BufferReader): Annotation[] {
  const count = r.readUInt16();
  const annotations: Annotation[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.readString();
    const value = r.readString();
    annotations.push({ name, value });
  }
  return annotations;
}

// ---------------------------------------------------------------------------
// Extension helpers
// ---------------------------------------------------------------------------

function writeExtensions(
  w: BufferWriter,
  extensions: ProtocolExtension[]
): void {
  w.writeUInt16(extensions.length);
  for (const ext of extensions) {
    w.writeString(ext.name);
    writeAnnotations(w, ext.annotations);
  }
}

function readExtensions(r: BufferReader): ProtocolExtension[] {
  const count = r.readUInt16();
  const extensions: ProtocolExtension[] = [];
  for (let i = 0; i < count; i++) {
    const name = r.readString();
    const annotations = readAnnotations(r);
    extensions.push({ name, annotations });
  }
  return extensions;
}

// ---------------------------------------------------------------------------
// Wrapping: prepend mtype (1 byte) + message_length (4 bytes, includes self)
// ---------------------------------------------------------------------------

function wrapMessage(mtype: number, payload: Uint8Array): Uint8Array {
  const total = 1 + 4 + payload.length;
  const out = new Uint8Array(total);
  out[0] = mtype;
  const view = new DataView(out.buffer);
  view.setUint32(1, 4 + payload.length, false); // length includes the 4-byte length field
  out.set(payload, 5);
  return out;
}

// ===================================================================
// CLIENT MESSAGE ENCODING
// ===================================================================

function encodeClientHandshake(msg: ClientHandshakeMsg): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt16(msg.majorVersion);
  w.writeUInt16(msg.minorVersion);
  // params
  w.writeUInt16(msg.params.length);
  for (const p of msg.params) {
    w.writeString(p.name);
    w.writeString(p.value);
  }
  // extensions
  writeExtensions(w, msg.extensions);
  return wrapMessage(ClientMessageType.ClientHandshake, w.toBytes());
}

function encodeSASLInitialResponse(
  msg: AuthenticationSASLInitialResponseMsg
): Uint8Array {
  const w = new BufferWriter();
  w.writeString(msg.method);
  w.writeLenPrefixedBytes(msg.saslData);
  return wrapMessage(
    ClientMessageType.AuthenticationSASLInitialResponse,
    w.toBytes()
  );
}

function encodeSASLResponse(
  msg: AuthenticationSASLResponseMsg
): Uint8Array {
  const w = new BufferWriter();
  w.writeLenPrefixedBytes(msg.saslData);
  return wrapMessage(
    ClientMessageType.AuthenticationSASLResponse,
    w.toBytes()
  );
}

function encodeParse(msg: ParseMsg): Uint8Array {
  // inputLanguage is a v3.0+ field — disc speaks v2.0 so it is omitted
  // from the wire format. Kept on the typed message for ergonomics.
  const w = new BufferWriter();
  writeAnnotations(w, msg.annotations);
  w.writeUInt64(msg.allowedCapabilities);
  w.writeUInt64(msg.compilationFlags);
  w.writeUInt64(msg.implicitLimit);
  w.writeUInt8(msg.outputFormat);
  w.writeUInt8(msg.expectedCardinality);
  w.writeString(msg.commandText);
  w.writeUUID(msg.stateTypedescId);
  w.writeLenPrefixedBytes(msg.stateData);
  return wrapMessage(ClientMessageType.Parse, w.toBytes());
}

function encodeExecute(msg: ExecuteMsg): Uint8Array {
  // inputLanguage is a v3.0+ field — disc speaks v2.0 so it is omitted.
  const w = new BufferWriter();
  writeAnnotations(w, msg.annotations);
  w.writeUInt64(msg.allowedCapabilities);
  w.writeUInt64(msg.compilationFlags);
  w.writeUInt64(msg.implicitLimit);
  w.writeUInt8(msg.outputFormat);
  w.writeUInt8(msg.expectedCardinality);
  w.writeString(msg.commandText);
  w.writeUUID(msg.stateTypedescId);
  w.writeLenPrefixedBytes(msg.stateData);
  w.writeUUID(msg.inputTypedescId);
  w.writeUUID(msg.outputTypedescId);
  w.writeLenPrefixedBytes(msg.arguments);
  return wrapMessage(ClientMessageType.Execute, w.toBytes());
}

function encodeSync(): Uint8Array {
  return wrapMessage(ClientMessageType.Sync, new Uint8Array(0));
}

function encodeFlush(): Uint8Array {
  return wrapMessage(ClientMessageType.Flush, new Uint8Array(0));
}

function encodeTerminate(): Uint8Array {
  return wrapMessage(ClientMessageType.Terminate, new Uint8Array(0));
}

/** Encode any ClientMessage into a wire-format Uint8Array. */
export function encodeClientMessage(msg: ClientMessage): Uint8Array {
  switch (msg.kind) {
    case "ClientHandshake":
      return encodeClientHandshake(msg);
    case "AuthenticationSASLInitialResponse":
      return encodeSASLInitialResponse(msg);
    case "AuthenticationSASLResponse":
      return encodeSASLResponse(msg);
    case "Parse":
      return encodeParse(msg);
    case "Execute":
      return encodeExecute(msg);
    case "Sync":
      return encodeSync();
    case "Flush":
      return encodeFlush();
    case "Terminate":
      return encodeTerminate();
  }
}

// ===================================================================
// CLIENT MESSAGE DECODING
// ===================================================================

function decodeClientHandshake(r: BufferReader): ClientHandshakeMsg {
  const majorVersion = r.readUInt16();
  const minorVersion = r.readUInt16();
  const paramCount = r.readUInt16();
  const params: Array<{ name: string; value: string; }> = [];
  for (let i = 0; i < paramCount; i++) {
    const name = r.readString();
    const value = r.readString();
    params.push({ name, value });
  }
  const extensions = readExtensions(r);
  return {
    kind: "ClientHandshake",
    majorVersion,
    minorVersion,
    params,
    extensions
  };
}

function decodeSASLInitialResponse(
  r: BufferReader
): AuthenticationSASLInitialResponseMsg {
  const method = r.readString();
  const saslData = r.readLenPrefixedBytes();
  return { kind: "AuthenticationSASLInitialResponse", method, saslData };
}

function decodeSASLResponse(
  r: BufferReader
): AuthenticationSASLResponseMsg {
  const saslData = r.readLenPrefixedBytes();
  return { kind: "AuthenticationSASLResponse", saslData };
}

function decodeParse(r: BufferReader): ParseMsg {
  // inputLanguage is a v3.0+ field — disc speaks v2.0 so it is not on the
  // wire. Default to EDGEQL for the typed shape.
  const annotations = readAnnotations(r);
  const allowedCapabilities = r.readUInt64();
  const compilationFlags = r.readUInt64();
  const implicitLimit = r.readUInt64();
  const inputLanguage = InputLanguage.EDGEQL;
  const outputFormat = r.readUInt8();
  const expectedCardinality = r.readUInt8();
  const commandText = r.readString();
  const stateTypedescId = r.readUUID();
  const stateData = r.readLenPrefixedBytes();
  return {
    kind: "Parse",
    annotations,
    allowedCapabilities,
    compilationFlags,
    implicitLimit,
    inputLanguage,
    outputFormat,
    expectedCardinality,
    commandText,
    stateTypedescId,
    stateData
  };
}

function decodeExecute(r: BufferReader): ExecuteMsg {
  // The `inputLanguage` field was added in protocol v3.0; v2.0 clients
  // (which is what disc currently handshakes as) do not send it. Including
  // it in the read order shifts every subsequent field by one byte and
  // causes the rest of the message to be misinterpreted, surfacing as a
  // huge bogus length on the next length-prefixed read.
  const annotations = readAnnotations(r);
  const allowedCapabilities = r.readUInt64();
  const compilationFlags = r.readUInt64();
  const implicitLimit = r.readUInt64();
  const inputLanguage = InputLanguage.EDGEQL;
  const outputFormat = r.readUInt8();
  const expectedCardinality = r.readUInt8();
  const commandText = r.readString();
  const stateTypedescId = r.readUUID();
  const stateData = r.readLenPrefixedBytes();
  const inputTypedescId = r.readUUID();
  const outputTypedescId = r.readUUID();
  const arguments_ = r.readLenPrefixedBytes();
  return {
    kind: "Execute",
    annotations,
    allowedCapabilities,
    compilationFlags,
    implicitLimit,
    inputLanguage,
    outputFormat,
    expectedCardinality,
    commandText,
    stateTypedescId,
    stateData,
    inputTypedescId,
    outputTypedescId,
    arguments: arguments_
  };
}

/**
 * Decode a client message from its mtype byte and raw payload bytes.
 * The caller is responsible for reading the mtype (1 byte) and
 * message_length (4 bytes) and providing just the payload.
 */
export function decodeClientMessage(
  mtype: number,
  payload: Uint8Array
): ClientMessage {
  const r = new BufferReader(payload);
  switch (mtype) {
    case ClientMessageType.ClientHandshake:
      return decodeClientHandshake(r);
    case ClientMessageType.AuthenticationSASLInitialResponse:
      return decodeSASLInitialResponse(r);
    case ClientMessageType.AuthenticationSASLResponse:
      return decodeSASLResponse(r);
    case ClientMessageType.Parse:
      return decodeParse(r);
    case ClientMessageType.Execute:
      return decodeExecute(r);
    case ClientMessageType.Sync:
      return { kind: "Sync" };
    case ClientMessageType.Flush:
      return { kind: "Flush" };
    case ClientMessageType.Terminate:
      return { kind: "Terminate" };
    default:
      throw new Error(
        `Unknown client message type: 0x${mtype.toString(16)}`
      );
  }
}

// ===================================================================
// SERVER MESSAGE ENCODING
// ===================================================================

function encodeServerHandshake(msg: ServerHandshakeMsg): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt16(msg.majorVersion);
  w.writeUInt16(msg.minorVersion);
  writeExtensions(w, msg.extensions);
  return wrapMessage(ServerMessageType.ServerHandshake, w.toBytes());
}

function encodeAuthenticationOK(): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt32(AuthStatus.OK);
  return wrapMessage(ServerMessageType.Authentication, w.toBytes());
}

function encodeAuthenticationRequiredSASL(
  msg: AuthenticationRequiredSASLMsg
): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt32(AuthStatus.RequiredSASL);
  w.writeUInt32(msg.methods.length);
  for (const m of msg.methods) {
    w.writeString(m);
  }
  return wrapMessage(ServerMessageType.Authentication, w.toBytes());
}

function encodeAuthenticationSASLContinue(
  msg: AuthenticationSASLContinueMsg
): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt32(AuthStatus.SASLContinue);
  w.writeLenPrefixedBytes(msg.saslData);
  return wrapMessage(ServerMessageType.Authentication, w.toBytes());
}

function encodeAuthenticationSASLFinal(
  msg: AuthenticationSASLFinalMsg
): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt32(AuthStatus.SASLFinal);
  w.writeLenPrefixedBytes(msg.saslData);
  return wrapMessage(ServerMessageType.Authentication, w.toBytes());
}

function encodeReadyForCommand(msg: ReadyForCommandMsg): Uint8Array {
  const w = new BufferWriter();
  writeAnnotations(w, msg.annotations);
  w.writeUInt8(msg.transactionState);
  return wrapMessage(ServerMessageType.ReadyForCommand, w.toBytes());
}

function encodeCommandComplete(msg: CommandCompleteMsg): Uint8Array {
  const w = new BufferWriter();
  writeAnnotations(w, msg.annotations);
  w.writeUInt64(msg.capabilities);
  w.writeString(msg.status);
  w.writeUUID(msg.stateTypedescId);
  w.writeLenPrefixedBytes(msg.stateData);
  return wrapMessage(ServerMessageType.CommandComplete, w.toBytes());
}

function encodeCommandDataDescription(
  msg: CommandDataDescriptionMsg
): Uint8Array {
  const w = new BufferWriter();
  writeAnnotations(w, msg.annotations);
  w.writeUInt64(msg.capabilities);
  w.writeUInt8(msg.resultCardinality);
  w.writeUUID(msg.inputTypedescId);
  w.writeLenPrefixedBytes(msg.inputTypedesc);
  w.writeUUID(msg.outputTypedescId);
  w.writeLenPrefixedBytes(msg.outputTypedesc);
  return wrapMessage(
    ServerMessageType.CommandDataDescription,
    w.toBytes()
  );
}

function encodeData(msg: DataMsg): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt16(msg.data.length);
  for (const element of msg.data) {
    w.writeLenPrefixedBytes(element);
  }
  return wrapMessage(ServerMessageType.Data, w.toBytes());
}

function encodeErrorResponse(msg: ErrorResponseMsg): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(msg.severity);
  w.writeUInt32(msg.errorCode);
  w.writeString(msg.message);
  w.writeUInt16(msg.attributes.length);
  for (const attr of msg.attributes) {
    w.writeUInt16(attr.code);
    w.writeLenPrefixedBytes(attr.value);
  }
  return wrapMessage(ServerMessageType.ErrorResponse, w.toBytes());
}

function encodeParameterStatus(msg: ParameterStatusMsg): Uint8Array {
  const w = new BufferWriter();
  w.writeLenPrefixedBytes(msg.name);
  w.writeLenPrefixedBytes(msg.value);
  return wrapMessage(ServerMessageType.ParameterStatus, w.toBytes());
}

function encodeServerKeyData(msg: ServerKeyDataMsg): Uint8Array {
  if (msg.data.length !== 32) {
    throw new Error(
      `ServerKeyData must be exactly 32 bytes, got ${msg.data.length}`
    );
  }
  const w = new BufferWriter();
  w.writeBytes(msg.data);
  return wrapMessage(ServerMessageType.ServerKeyData, w.toBytes());
}

function encodeLogMessage(msg: LogMessageMsg): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(msg.severity);
  w.writeUInt32(msg.code);
  w.writeString(msg.text);
  writeAnnotations(w, msg.annotations);
  return wrapMessage(ServerMessageType.LogMessage, w.toBytes());
}

function encodeStateDataDescription(
  msg: StateDataDescriptionMsg
): Uint8Array {
  const w = new BufferWriter();
  w.writeUUID(msg.typedescId);
  w.writeLenPrefixedBytes(msg.typedesc);
  return wrapMessage(ServerMessageType.StateDataDescription, w.toBytes());
}

/** Encode any ServerMessage into a wire-format Uint8Array. */
export function encodeServerMessage(msg: ServerMessage): Uint8Array {
  switch (msg.kind) {
    case "ServerHandshake":
      return encodeServerHandshake(msg);
    case "AuthenticationOK":
      return encodeAuthenticationOK();
    case "AuthenticationRequiredSASL":
      return encodeAuthenticationRequiredSASL(msg);
    case "AuthenticationSASLContinue":
      return encodeAuthenticationSASLContinue(msg);
    case "AuthenticationSASLFinal":
      return encodeAuthenticationSASLFinal(msg);
    case "ReadyForCommand":
      return encodeReadyForCommand(msg);
    case "CommandComplete":
      return encodeCommandComplete(msg);
    case "CommandDataDescription":
      return encodeCommandDataDescription(msg);
    case "Data":
      return encodeData(msg);
    case "ErrorResponse":
      return encodeErrorResponse(msg);
    case "ParameterStatus":
      return encodeParameterStatus(msg);
    case "ServerKeyData":
      return encodeServerKeyData(msg);
    case "LogMessage":
      return encodeLogMessage(msg);
    case "StateDataDescription":
      return encodeStateDataDescription(msg);
  }
}

// ===================================================================
// SERVER MESSAGE DECODING
// ===================================================================

function decodeServerHandshake(r: BufferReader): ServerHandshakeMsg {
  const majorVersion = r.readUInt16();
  const minorVersion = r.readUInt16();
  const extensions = readExtensions(r);
  return { kind: "ServerHandshake", majorVersion, minorVersion, extensions };
}

function decodeAuthentication(
  r: BufferReader
):
  | AuthenticationOKMsg
  | AuthenticationRequiredSASLMsg
  | AuthenticationSASLContinueMsg
  | AuthenticationSASLFinalMsg {
  const authStatus = r.readUInt32();
  switch (authStatus) {
    case AuthStatus.OK:
      return { kind: "AuthenticationOK" };
    case AuthStatus.RequiredSASL: {
      const methodCount = r.readUInt32();
      const methods: string[] = [];
      for (let i = 0; i < methodCount; i++) {
        methods.push(r.readString());
      }
      return { kind: "AuthenticationRequiredSASL", methods };
    }
    case AuthStatus.SASLContinue: {
      const saslData = r.readLenPrefixedBytes();
      return { kind: "AuthenticationSASLContinue", saslData };
    }
    case AuthStatus.SASLFinal: {
      const saslData = r.readLenPrefixedBytes();
      return { kind: "AuthenticationSASLFinal", saslData };
    }
    default:
      throw new Error(
        `Unknown auth status: 0x${authStatus.toString(16)}`
      );
  }
}

function decodeReadyForCommand(r: BufferReader): ReadyForCommandMsg {
  const annotations = readAnnotations(r);
  const transactionState = r.readUInt8();
  return { kind: "ReadyForCommand", annotations, transactionState };
}

function decodeCommandComplete(r: BufferReader): CommandCompleteMsg {
  const annotations = readAnnotations(r);
  const capabilities = r.readUInt64();
  const status = r.readString();
  const stateTypedescId = r.readUUID();
  const stateData = r.readLenPrefixedBytes();
  return {
    kind: "CommandComplete",
    annotations,
    capabilities,
    status,
    stateTypedescId,
    stateData
  };
}

function decodeCommandDataDescription(
  r: BufferReader
): CommandDataDescriptionMsg {
  const annotations = readAnnotations(r);
  const capabilities = r.readUInt64();
  const resultCardinality = r.readUInt8();
  const inputTypedescId = r.readUUID();
  const inputTypedesc = r.readLenPrefixedBytes();
  const outputTypedescId = r.readUUID();
  const outputTypedesc = r.readLenPrefixedBytes();
  return {
    kind: "CommandDataDescription",
    annotations,
    capabilities,
    resultCardinality,
    inputTypedescId,
    inputTypedesc,
    outputTypedescId,
    outputTypedesc
  };
}

function decodeData(r: BufferReader): DataMsg {
  const count = r.readUInt16();
  const data: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    data.push(r.readLenPrefixedBytes());
  }
  return { kind: "Data", data };
}

function decodeErrorResponse(r: BufferReader): ErrorResponseMsg {
  const severity = r.readUInt8();
  const errorCode = r.readUInt32();
  const message = r.readString();
  const attrCount = r.readUInt16();
  const attributes: ErrorAttribute[] = [];
  for (let i = 0; i < attrCount; i++) {
    const code = r.readUInt16();
    const value = r.readLenPrefixedBytes();
    attributes.push({ code, value });
  }
  return { kind: "ErrorResponse", severity, errorCode, message, attributes };
}

function decodeParameterStatus(r: BufferReader): ParameterStatusMsg {
  const name = r.readLenPrefixedBytes();
  const value = r.readLenPrefixedBytes();
  return { kind: "ParameterStatus", name, value };
}

function decodeServerKeyData(r: BufferReader): ServerKeyDataMsg {
  const data = r.readBytes(32);
  return { kind: "ServerKeyData", data };
}

function decodeLogMessage(r: BufferReader): LogMessageMsg {
  const severity = r.readUInt8();
  const code = r.readUInt32();
  const text = r.readString();
  const annotations = readAnnotations(r);
  return { kind: "LogMessage", severity, code, text, annotations };
}

function decodeStateDataDescription(
  r: BufferReader
): StateDataDescriptionMsg {
  const typedescId = r.readUUID();
  const typedesc = r.readLenPrefixedBytes();
  return { kind: "StateDataDescription", typedescId, typedesc };
}

/**
 * Decode a server message from its mtype byte and raw payload bytes.
 * The caller is responsible for reading the mtype (1 byte) and
 * message_length (4 bytes) and providing just the payload.
 */
export function decodeServerMessage(
  mtype: number,
  payload: Uint8Array
): ServerMessage {
  const r = new BufferReader(payload);
  switch (mtype) {
    case ServerMessageType.ServerHandshake:
      return decodeServerHandshake(r);
    case ServerMessageType.Authentication:
      return decodeAuthentication(r);
    case ServerMessageType.ReadyForCommand:
      return decodeReadyForCommand(r);
    case ServerMessageType.CommandComplete:
      return decodeCommandComplete(r);
    case ServerMessageType.CommandDataDescription:
      return decodeCommandDataDescription(r);
    case ServerMessageType.Data:
      return decodeData(r);
    case ServerMessageType.ErrorResponse:
      return decodeErrorResponse(r);
    case ServerMessageType.ParameterStatus:
      return decodeParameterStatus(r);
    case ServerMessageType.ServerKeyData:
      return decodeServerKeyData(r);
    case ServerMessageType.LogMessage:
      return decodeLogMessage(r);
    case ServerMessageType.StateDataDescription:
      return decodeStateDataDescription(r);
    default:
      throw new Error(
        `Unknown server message type: 0x${mtype.toString(16)}`
      );
  }
}

// ---------------------------------------------------------------------------
// Utility: extract mtype and payload from raw wire bytes
// ---------------------------------------------------------------------------

/**
 * Given a complete wire message (mtype + length + payload), split it
 * into the mtype byte and the payload. Returns null if the buffer is
 * too short.
 */
export function splitWireMessage(
  data: Uint8Array
): { mtype: number; payload: Uint8Array; } | null {
  if (data.length < 5)
    return null;
  const mtype = data[0];
  const view = new DataView(data.buffer, data.byteOffset);
  const messageLength = view.getUint32(1, false); // includes the 4-byte length field
  const payloadLength = messageLength - 4;
  if (data.length < 1 + messageLength)
    return null;
  const payload = data.slice(5, 5 + payloadLength);
  return { mtype, payload };
}

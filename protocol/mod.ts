/**
 * Gel binary wire protocol — public API.
 *
 * Re-exports everything needed to encode, decode, and inspect
 * protocol messages.
 */

// Buffer primitives
export { BufferReader, BufferWriter } from "./buffer.ts";

// Protocol enumerations
export {
  AuthStatus,
  Capability,
  Cardinality,
  ClientMessageType,
  CompilationFlag,
  ErrorSeverity,
  InputLanguage,
  OutputFormat,
  PROTOCOL_MAJOR_VERSION,
  PROTOCOL_MINOR_VERSION,
  ServerMessageType,
  TransactionState,
} from "./enums.ts";

// Message types and codec
export type {
  Annotation,
  AuthenticationOKMsg,
  AuthenticationRequiredSASLMsg,
  AuthenticationSASLContinueMsg,
  AuthenticationSASLFinalMsg,
  AuthenticationSASLInitialResponseMsg,
  AuthenticationSASLResponseMsg,
  ClientHandshakeMsg,
  ClientMessage,
  CommandCompleteMsg,
  CommandDataDescriptionMsg,
  DataMsg,
  ErrorAttribute,
  ErrorResponseMsg,
  ExecuteMsg,
  FlushMsg,
  LogMessageMsg,
  ParameterStatusMsg,
  ParseMsg,
  ProtocolExtension,
  ReadyForCommandMsg,
  ServerHandshakeMsg,
  ServerKeyDataMsg,
  ServerMessage,
  SyncMsg,
  TerminateMsg,
} from "./messages.ts";

export { decodeClientMessage, decodeServerMessage, encodeClientMessage, encodeServerMessage, splitWireMessage } from "./messages.ts";

// Type descriptors
export {
  buildResultDescriptors,
  decodeTypeDescriptors,
  DescriptorTag,
  encodeTypeDescriptors,
  generateDescriptorId,
  generateDescriptorIdSync,
  resolveWellKnownType,
  ShapeElementFlags,
  UUID_TO_TYPE,
  WELL_KNOWN_TYPES,
} from "./typedesc.ts";

export type {
  ArrayDescriptor,
  BaseScalarDescriptor,
  EnumDescriptor,
  MultiRangeDescriptor,
  NamedTupleDescriptor,
  ObjectShapeDescriptor,
  ObjectShapeElement,
  RangeDescriptor,
  SetDescriptor,
  TupleDescriptor,
  TypeDescriptor,
} from "./typedesc.ts";

// Type codecs
export { decodeScalarValue, encodeObjectValue, encodeScalarValue } from "./type-codec.ts";

// SCRAM-SHA-256 authentication
export {
  buildClientFinalMessage,
  buildClientFirstMessage,
  deriveKeys,
  generateServerFirstMessage,
  parseClientFirstMessage,
  verifyClientFinalMessage,
} from "./scram.ts";

export type { ScramServerState } from "./scram.ts";

// Binary protocol TCP server
export { BinaryConnection, BinaryProtocolServer } from "./binary-server.ts";

export type { BinaryServerOptions } from "./binary-server.ts";

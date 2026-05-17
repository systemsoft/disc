/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Binary protocol type definitions for Gel/EdgeDB compatibility
 * Based on EdgeDB binary protocol specification
 */

// Message type identifiers (single byte)
export enum MessageType {
  // Client messages
  ClientHandshake = 0x56, // 'V'
  AuthenticationSASLInitialResponse = 0x70, // 'p'
  AuthenticationSASLResponse = 0x72, // 'r'
  Parse = 0x50, // 'P'
  Execute = 0x4f, // 'O'
  Sync = 0x53, // 'S'
  Flush = 0x48, // 'H'
  Terminate = 0x58, // 'X'
  // Server messages
  ServerHandshake = 0x76, // 'v'
  AuthenticationOK = 0x52, // 'R'
  AuthenticationSASL = 0x0a,
  AuthenticationSASLContinue = 0x0b,
  AuthenticationSASLFinal = 0x0c,
  CommandComplete = 0x43, // 'C'
  Data = 0x44, // 'D'
  ErrorResponse = 0x45, // 'E'
  ReadyForCommand = 0x5a, // 'Z'
  StateDataDescription = 0x73, // 's'
  CommandDataDescription = 0x54, // 'T'
  LogMessage = 0x4c, // 'L'
  ParameterStatus = 0x53, // 'S'
  ServerKeyData = 0x4b // 'K'
}

// Protocol version
export const PROTOCOL_VERSION = {
  major: 1,
  minor: 0
};

// Cardinality values
export enum Cardinality {
  NoResult = 0x6e, // 'n'
  AtMostOne = 0x6f, // 'o'
  One = 0x41, // 'A'
  Many = 0x6d, // 'm'
  AtLeastOne = 0x4d // 'M'
}

// Output format
export enum OutputFormat {
  Binary = 0x62, // 'b'
  JSON = 0x6a, // 'j'
  JSONElements = 0x4a, // 'J'
  None = 0x6e // 'n'
}

// Input language
export enum InputLanguage {
  EdgeQL = 0x00,
  SQL = 0x01
}

// Error severity
export enum ErrorSeverity {
  Error = 0x78, // 'x'
  Fatal = 0xc8, // 'È'
  Panic = 0xff // 'ÿ'
}

// Error attribute codes
export enum ErrorAttribute {
  Hint = 0x0001,
  Details = 0x0002,
  ServerTraceback = 0x0101,
  PositionStart = 0xfff1,
  PositionEnd = 0xfff2,
  LineStart = 0xfff3,
  ColumnStart = 0xfff4,
  UTF16ColumnStart = 0xfff5
}

// Base message interface
export interface Message {
  type: MessageType;
  length: number;
}

// Client messages
export interface ClientHandshake extends Message {
  type: MessageType.ClientHandshake;
  majorVersion: number;
  minorVersion: number;
  extensions: ProtocolExtension[];
  parameters: ConnectionParameter[];
}

export interface ProtocolExtension {
  name: string;
  headers: Map<string, Uint8Array>;
}

export interface ConnectionParameter {
  name: string;
  value: string;
}

export interface AuthenticationSASLInitialResponse extends Message {
  type: MessageType.AuthenticationSASLInitialResponse;
  mechanism: string;
  initialResponse: Uint8Array;
}

export interface AuthenticationSASLResponse extends Message {
  type: MessageType.AuthenticationSASLResponse;
  response: Uint8Array;
}

export interface ParseMessage extends Message {
  type: MessageType.Parse;
  annotations: Annotation[];
  allowedCapabilities: bigint;
  compilationFlags: bigint;
  implicitLimit: bigint;
  inputLanguage: InputLanguage;
  outputFormat: OutputFormat;
  expectedCardinality: Cardinality;
  commandText: string;
}

export interface ExecuteMessage extends Message {
  type: MessageType.Execute;
  annotations: Annotation[];
  allowedCapabilities: bigint;
  compilationFlags: bigint;
  implicitLimit: bigint;
  inputLanguage: InputLanguage;
  outputFormat: OutputFormat;
  expectedCardinality: Cardinality;
  commandText: string;
  stateDataDescriptorId: Uint8Array; // UUID
  encodedStateData: Uint8Array;
  argumentDataDescriptorId: Uint8Array; // UUID
  argumentData: Uint8Array;
  outputDataDescriptorId: Uint8Array; // UUID
}

export interface Annotation {
  name: string;
  value: string;
}

// Server messages
export interface ServerHandshake extends Message {
  type: MessageType.ServerHandshake;
  majorVersion: number;
  minorVersion: number;
  extensions: ProtocolExtension[];
}

export interface AuthenticationOK extends Message {
  type: MessageType.AuthenticationOK;
  authStatus: number;
}

export interface AuthenticationSASL extends Message {
  type: MessageType.AuthenticationSASL;
  authStatus: number;
  mechanisms: string[];
}

export interface AuthenticationSASLContinue extends Message {
  type: MessageType.AuthenticationSASLContinue;
  authStatus: number;
  saslData: Uint8Array;
}

export interface AuthenticationSASLFinal extends Message {
  type: MessageType.AuthenticationSASLFinal;
  authStatus: number;
  saslData: Uint8Array;
}

export interface CommandComplete extends Message {
  type: MessageType.CommandComplete;
  annotations: Annotation[];
  capabilities: bigint;
  commandStatus: string;
  stateTypeDescriptorId: Uint8Array; // UUID
  encodedStateData: Uint8Array;
}

export interface DataMessage extends Message {
  type: MessageType.Data;
  dataElements: DataElement[];
}

export interface DataElement {
  data: Uint8Array;
}

export interface ErrorResponse extends Message {
  type: MessageType.ErrorResponse;
  severity: ErrorSeverity;
  errorCode: number;
  message: string;
  attributes: Map<ErrorAttribute, string>;
}

export interface ReadyForCommand extends Message {
  type: MessageType.ReadyForCommand;
  transactionState: TransactionState;
  annotations: Annotation[];
}

export enum TransactionState {
  Idle = 0x49, // 'I'
  InTransaction = 0x54, // 'T'
  Error = 0x45 // 'E'
}

// Fundamental type UUIDs as strings (will be converted to bytes)
export const FUNDAMENTAL_TYPE_IDS = {
  uuid: "00000000-0000-0000-0000-000000000100",
  str: "00000000-0000-0000-0000-000000000101",
  bytes: "00000000-0000-0000-0000-000000000102",
  int16: "00000000-0000-0000-0000-000000000103",
  int32: "00000000-0000-0000-0000-000000000104",
  int64: "00000000-0000-0000-0000-000000000105",
  float32: "00000000-0000-0000-0000-000000000106",
  float64: "00000000-0000-0000-0000-000000000107",
  decimal: "00000000-0000-0000-0000-000000000108",
  bool: "00000000-0000-0000-0000-000000000109",
  datetime: "00000000-0000-0000-0000-00000000010a",
  duration: "00000000-0000-0000-0000-00000000010e",
  json: "00000000-0000-0000-0000-00000000010f",
  bigint: "00000000-0000-0000-0000-000000000110"
};

// Type descriptor types
export interface TypeDescriptor {
  tag: number;
  id: Uint8Array; // UUID
}

export interface ScalarTypeDescriptor extends TypeDescriptor {
  tag: 3;
  name: string;
  schemaName?: string;
  schemaDefined: boolean;
  ancestors: number[];
}

export interface ObjectTypeDescriptor extends TypeDescriptor {
  tag: 0;
  name: string;
  schemaName?: string;
  schemaDefined: boolean;
  elements: ShapeElement[];
}

export interface ShapeElement {
  name: string;
  typePos: number;
  cardinality: Cardinality;
}

export interface ArrayTypeDescriptor extends TypeDescriptor {
  tag: 5;
  elementTypePos: number;
  dimensions: number[];
}

export interface TupleTypeDescriptor extends TypeDescriptor {
  tag: 7;
  elementTypes: number[];
}

export interface NamedTupleTypeDescriptor extends TypeDescriptor {
  tag: 9;
  elements: NamedTupleElement[];
}

export interface NamedTupleElement {
  name: string;
  typePos: number;
}

// Utility function to convert UUID string to bytes
export function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// Utility function to convert bytes to UUID string
export function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array
    .from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
  ]
    .join("-");
}

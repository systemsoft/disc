/**
 * Protocol enumerations for the Gel binary wire protocol.
 *
 * Values match the Gel/EdgeDB binary protocol specification.
 * Each enum uses `as const` objects so the values are literal types
 * that can be used both as runtime values and as type discriminators.
 */

// ---------------------------------------------------------------------------
// Message type bytes (mtype — the first byte of every message)
// ---------------------------------------------------------------------------

/** Client-to-server message type identifiers. */
export const ClientMessageType = {
  ClientHandshake: 0x56, // 'V'
  AuthenticationSASLInitialResponse: 0x70, // 'p'
  AuthenticationSASLResponse: 0x72, // 'r'
  Parse: 0x50, // 'P'
  Execute: 0x4f, // 'O'
  Sync: 0x53, // 'S'
  Flush: 0x48, // 'H'
  Terminate: 0x58 // 'X'
} as const;

export type ClientMessageType = (typeof ClientMessageType)[keyof typeof ClientMessageType];

/** Server-to-client message type identifiers. */
export const ServerMessageType = {
  ServerHandshake: 0x76, // 'v'
  Authentication: 0x52, // 'R' — auth_status discriminates subtypes
  ReadyForCommand: 0x5a, // 'Z'
  CommandComplete: 0x43, // 'C'
  CommandDataDescription: 0x54, // 'T'
  Data: 0x44, // 'D'
  ErrorResponse: 0x45, // 'E'
  ParameterStatus: 0x53, // 'S'
  ServerKeyData: 0x4b, // 'K'
  LogMessage: 0x4c, // 'L'
  StateDataDescription: 0x73 // 's'
} as const;

export type ServerMessageType = (typeof ServerMessageType)[keyof typeof ServerMessageType];

// ---------------------------------------------------------------------------
// Authentication sub-status values (inside mtype 'R' messages)
// ---------------------------------------------------------------------------

export const AuthStatus = {
  OK: 0x00,
  RequiredSASL: 0x0a,
  SASLContinue: 0x0b,
  SASLFinal: 0x0c
} as const;

export type AuthStatus = (typeof AuthStatus)[keyof typeof AuthStatus];

// ---------------------------------------------------------------------------
// Cardinality
// ---------------------------------------------------------------------------

export const Cardinality = {
  NO_RESULT: 0x6e, // 'n'
  AT_MOST_ONE: 0x6f, // 'o'
  ONE: 0x41, // 'A'
  MANY: 0x6d, // 'm'
  AT_LEAST_ONE: 0x4d // 'M'
} as const;

export type Cardinality = (typeof Cardinality)[keyof typeof Cardinality];

// ---------------------------------------------------------------------------
// Transaction state (inside ReadyForCommand)
// ---------------------------------------------------------------------------

export const TransactionState = {
  NOT_IN_TRANSACTION: 0x49, // 'I'
  IN_TRANSACTION: 0x54, // 'T'
  IN_FAILED_TRANSACTION: 0x45 // 'E'
} as const;

export type TransactionState = (typeof TransactionState)[keyof typeof TransactionState];

// ---------------------------------------------------------------------------
// Input language
// ---------------------------------------------------------------------------

export const InputLanguage = {
  EDGEQL: 0x45, // 'E'
  SQL: 0x53 // 'S'
} as const;

export type InputLanguage = (typeof InputLanguage)[keyof typeof InputLanguage];

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

export const OutputFormat = {
  BINARY: 0x62, // 'b'
  JSON: 0x6a, // 'j'
  JSON_ELEMENTS: 0x4a, // 'J'
  NONE: 0x6e // 'n'
} as const;

export type OutputFormat = (typeof OutputFormat)[keyof typeof OutputFormat];

// ---------------------------------------------------------------------------
// Capabilities (bitmask — uint64)
// ---------------------------------------------------------------------------

export const Capability = {
  MODIFICATIONS: 1n << 0n,
  SESSION_CONFIG: 1n << 1n,
  TRANSACTION: 1n << 2n,
  DDL: 1n << 3n,
  PERSISTENT_CONFIG: 1n << 4n,
  ALL: 0xffffffffffffffffn
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

// ---------------------------------------------------------------------------
// Compilation flags (bitmask — uint64)
// ---------------------------------------------------------------------------

export const CompilationFlag = {
  INJECT_OUTPUT_TYPE_IDS: 1n << 0n,
  INJECT_OUTPUT_TYPE_NAMES: 1n << 1n,
  INJECT_OUTPUT_OBJECT_IDS: 1n << 2n
} as const;

export type CompilationFlag = (typeof CompilationFlag)[keyof typeof CompilationFlag];

// ---------------------------------------------------------------------------
// Error severity
// ---------------------------------------------------------------------------

export const ErrorSeverity = {
  ERROR: 120, // 0x78
  FATAL: 200, // 0xc8
  PANIC: 255 // 0xff
} as const;

export type ErrorSeverity = (typeof ErrorSeverity)[keyof typeof ErrorSeverity];

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

export const PROTOCOL_MAJOR_VERSION = 2;
export const PROTOCOL_MINOR_VERSION = 0;

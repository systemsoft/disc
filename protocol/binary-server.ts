/**
 * TCP server for Gel binary wire protocol.
 *
 * Handles the full connection lifecycle:
 *   handshake -> auth (optional SCRAM-SHA-256) -> query loop -> terminate
 *
 * The server listens on a TCP port and dispatches each connection
 * to a BinaryConnection instance that drives the protocol state machine.
 *
 * Phase 4 enhancements:
 *   - State synchronization (module context per connection)
 *   - Prepared statement cache (Parse results reused on Execute)
 *   - Output format handling (JSON, BINARY, JSON_ELEMENTS, NONE)
 *   - Error code mapping (Disc errors -> Gel protocol error codes)
 */

import {
  type ClientMessage,
  decodeClientMessage,
  encodeServerMessage,
  type ServerMessage,
} from "./messages.ts";
import {
  Cardinality,
  ErrorSeverity,
  OutputFormat,
  PROTOCOL_MAJOR_VERSION,
  PROTOCOL_MINOR_VERSION,
  TransactionState,
} from "./enums.ts";
import { generateDescriptorIdSync } from "./typedesc.ts";
import type { Schema } from "../compiler/context.ts";
import {
  deriveKeys,
  generateServerFirstMessage,
  parseClientFirstMessage,
  type ScramServerState,
  verifyClientFinalMessage,
} from "./scram.ts";
import { encodeScalarValue } from "./type-codec.ts";
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
// Gel protocol error codes
// ---------------------------------------------------------------------------

export const GEL_ERROR_CODES = {
  InternalServerError: 0x01000000,
  QueryError: 0x04000000,
  InvalidSyntaxError: 0x04010000,
  EdgeQLSyntaxError: 0x04010100,
  SchemaSyntaxError: 0x04010200,
  SchemaDefinitionError: 0x04020000,
  InvalidTypeError: 0x04020100,
  InvalidTargetError: 0x04020200,
  InvalidLinkTargetError: 0x04020201,
  InvalidReferenceError: 0x04030000,
  UnknownModuleError: 0x04030100,
  InvalidConstraintDefinitionError: 0x04040000,
  InvalidValueError: 0x05010000,
  DivisionByZeroError: 0x05010001,
  IntegrityError: 0x05030000,
  ConstraintViolationError: 0x05030100,
  CardinalityViolationError: 0x05030200,
  MissingRequiredError: 0x05030300,
  AuthenticationError: 0x06000000,
  AvailabilityError: 0x07000000,
  AccessError: 0x08000000,
  AccessPolicyError: 0x08000100,
} as const;

/**
 * Map a Disc error to the appropriate Gel protocol error code.
 *
 * The mapping is based on the Disc error class hierarchy:
 * - SyntaxError -> EdgeQLSyntaxError
 * - SchemaError -> SchemaDefinitionError
 * - CompilationError -> QueryError
 * - QueryError -> QueryError
 * - ValidationError -> InvalidValueError
 * - DatabaseExecutionError -> IntegrityError
 * - QueryTimeoutError -> AvailabilityError
 * - ConnectionError -> AvailabilityError
 * - InternalError -> InternalServerError
 * - Unknown -> InternalServerError
 */
export function mapErrorToGelCode(error: Error): number {
  if (error instanceof SyntaxError) {
    return GEL_ERROR_CODES.EdgeQLSyntaxError;
  }
  if (error instanceof SchemaError) {
    return GEL_ERROR_CODES.SchemaDefinitionError;
  }
  if (error instanceof CompilationError) {
    return GEL_ERROR_CODES.QueryError;
  }
  if (error instanceof QueryError) {
    return GEL_ERROR_CODES.QueryError;
  }
  if (error instanceof ValidationError) {
    return GEL_ERROR_CODES.InvalidValueError;
  }
  if (error instanceof DatabaseExecutionError) {
    // Check for constraint-related messages
    if (error.message.includes("constraint")) {
      return GEL_ERROR_CODES.ConstraintViolationError;
    }
    if (error.message.includes("cardinality")) {
      return GEL_ERROR_CODES.CardinalityViolationError;
    }
    return GEL_ERROR_CODES.IntegrityError;
  }
  if (error instanceof QueryTimeoutError) {
    return GEL_ERROR_CODES.AvailabilityError;
  }
  if (error instanceof ConnectionError) {
    return GEL_ERROR_CODES.AvailabilityError;
  }
  if (error instanceof InternalError) {
    return GEL_ERROR_CODES.InternalServerError;
  }
  return GEL_ERROR_CODES.InternalServerError;
}

// ---------------------------------------------------------------------------
// Prepared statement cache entry
// ---------------------------------------------------------------------------

interface CachedStatement {
  commandText: string;
  inputDescId: Uint8Array;
  outputDescId: Uint8Array;
  inputDesc: Uint8Array;
  outputDesc: Uint8Array;
  outputFormat: number;
  resultCardinality: number;
  commandStatus: string;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface ConnectionState {
  /** Current module context, defaults to "default" */
  module: string;
  /** Session aliases (e.g., module aliases) */
  aliases: Map<string, string>;
  /** Session config values */
  config: Map<string, unknown>;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BinaryServerOptions {
  hostname?: string;
  port: number;
  schema: Schema;
  password?: string;
  onConnection?: (conn: BinaryConnection) => void;
  onDisconnect?: (conn: BinaryConnection) => void;
}

// ---------------------------------------------------------------------------
// BinaryProtocolServer
// ---------------------------------------------------------------------------

export class BinaryProtocolServer {
  private listener?: Deno.TcpListener;
  private connections = new Set<BinaryConnection>();
  private _port = 0;
  private running = false;

  constructor(private options: BinaryServerOptions) {}

  /**
   * Start listening for TCP connections.
   * If options.port is 0, the OS assigns an ephemeral port.
   */
  start(): void {
    this.listener = Deno.listen({
      hostname: this.options.hostname ?? "127.0.0.1",
      port: this.options.port,
      transport: "tcp",
    });
    this._port = (this.listener.addr as Deno.NetAddr).port;
    this.running = true;
    this.acceptLoop();
  }

  /**
   * Stop the server and close all active connections.
   */
  async stop(): Promise<void> {
    this.running = false;
    try {
      this.listener?.close();
    } catch {
      // listener may already be closed
    }
    for (const conn of this.connections) {
      conn.close();
    }
    this.connections.clear();
    // Give a brief moment for resources to settle
    await new Promise((r) => setTimeout(r, 10));
  }

  /** The port the server is actually listening on. */
  get port(): number {
    return this._port;
  }

  /** Number of currently active connections. */
  get connectionCount(): number {
    return this.connections.size;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async acceptLoop(): Promise<void> {
    while (this.running) {
      try {
        const tcpConn = await this.listener!.accept();
        const conn = new BinaryConnection(
          tcpConn,
          this.options.schema,
          this.options.password,
        );
        this.connections.add(conn);
        this.options.onConnection?.(conn);

        // Run the connection in the background
        conn.run().catch(() => {}).finally(() => {
          this.connections.delete(conn);
          this.options.onDisconnect?.(conn);
        });
      } catch {
        // listener closed or accept error — stop loop if not running
        if (!this.running) break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BinaryConnection
// ---------------------------------------------------------------------------

export class BinaryConnection {
  private state:
    | "handshake"
    | "authenticating"
    | "ready"
    | "closed" = "handshake";
  private transactionState: number = TransactionState.NOT_IN_TRANSACTION;
  private scramState?: ScramServerState;
  private scramStoredKey?: Uint8Array;
  private scramServerKey?: Uint8Array;
  private closed = false;

  // Phase 4.1: Session state
  private sessionState: ConnectionState = {
    module: "default",
    aliases: new Map(),
    config: new Map(),
  };

  // Phase 4.2: Prepared statement cache
  private stmtCache = new Map<string, CachedStatement>();

  constructor(
    private conn: Deno.TcpConn,
    private schema: Schema,
    private password?: string,
  ) {}

  /** Get the current session module context. */
  getModule(): string {
    return this.sessionState.module;
  }

  /** Get the prepared statement cache size (for testing). */
  getCacheSize(): number {
    return this.stmtCache.size;
  }

  /**
   * Main read loop — drives the protocol state machine.
   */
  async run(): Promise<void> {
    try {
      while (!this.closed) {
        // Read header: 1 byte mtype + 4 bytes message_length
        const header = await this.readExact(5);
        if (!header) {
          // Connection closed by client
          break;
        }

        const mtype = header[0];
        const view = new DataView(
          header.buffer,
          header.byteOffset,
        );
        const messageLength = view.getUint32(1, false);
        const payloadLength = messageLength - 4;

        // Read payload
        let payload = new Uint8Array(0);
        if (payloadLength > 0) {
          const p = await this.readExact(payloadLength);
          if (!p) break;
          payload = p;
        }

        // Decode and dispatch
        try {
          const msg = decodeClientMessage(mtype, payload);
          await this.dispatch(msg);
        } catch (err) {
          // Send error and continue (unless closed)
          if (!this.closed) {
            const errorCode = err instanceof Error
              ? mapErrorToGelCode(err)
              : GEL_ERROR_CODES.InternalServerError;
            await this.sendErrorWithCode(
              err instanceof Error ? err.message : String(err),
              errorCode,
            );
            // After error, send ReadyForCommand if in ready state
            if (this.state === "ready") {
              await this.sendReadyForCommand();
            }
          }
        }
      }
    } catch {
      // Connection broken — just clean up
    } finally {
      this.close();
    }
  }

  /** Close the underlying TCP connection. */
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.state = "closed";
      try {
        this.conn.close();
      } catch {
        // already closed
      }
    }
  }

  // -----------------------------------------------------------------------
  // Message dispatch
  // -----------------------------------------------------------------------

  private async dispatch(msg: ClientMessage): Promise<void> {
    switch (msg.kind) {
      case "ClientHandshake":
        await this.handleHandshake(msg);
        break;

      case "AuthenticationSASLInitialResponse":
        await this.handleSASLInitialResponse(msg);
        break;

      case "AuthenticationSASLResponse":
        await this.handleSASLResponse(msg);
        break;

      case "Parse":
        if (this.state !== "ready") {
          await this.sendError("Not ready for queries");
          return;
        }
        await this.handleParse(msg);
        break;

      case "Execute":
        if (this.state !== "ready") {
          await this.sendError("Not ready for queries");
          return;
        }
        await this.handleExecute(msg);
        break;

      case "Sync":
        await this.handleSync();
        break;

      case "Flush":
        // No-op — we send immediately
        break;

      case "Terminate":
        this.close();
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Handshake
  // -----------------------------------------------------------------------

  private async handleHandshake(
    _msg: ClientMessage & { kind: "ClientHandshake" },
  ): Promise<void> {
    // Send ServerHandshake with our protocol version
    await this.sendMessage({
      kind: "ServerHandshake",
      majorVersion: PROTOCOL_MAJOR_VERSION,
      minorVersion: PROTOCOL_MINOR_VERSION,
      extensions: [],
    });

    if (this.password) {
      // Derive SCRAM keys from password
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
      const iterations = 4096;
      const { storedKey, serverKey } = await deriveKeys(
        this.password,
        salt,
        iterations,
      );
      this.scramStoredKey = storedKey;
      this.scramServerKey = serverKey;

      // Store salt and iterations for the SCRAM state (will be set fully in handleSASLInitialResponse)
      this.scramState = {
        username: "",
        clientNonce: "",
        serverNonce: "",
        salt,
        iterations,
        clientFirstMessageBare: "",
        serverFirstMessage: "",
      };

      // Send AuthenticationRequiredSASL
      this.state = "authenticating";
      await this.sendMessage({
        kind: "AuthenticationRequiredSASL",
        methods: ["SCRAM-SHA-256"],
      });
    } else {
      // No auth required — go directly to ready
      await this.sendAuthOKSequence();
    }
  }

  // -----------------------------------------------------------------------
  // SCRAM-SHA-256 auth
  // -----------------------------------------------------------------------

  private async handleSASLInitialResponse(
    msg: ClientMessage & { kind: "AuthenticationSASLInitialResponse" },
  ): Promise<void> {
    if (this.state !== "authenticating" || !this.scramState) {
      await this.sendError("Unexpected SASL initial response");
      this.close();
      return;
    }

    try {
      // Parse client-first-message
      const parsed = parseClientFirstMessage(msg.saslData);

      // Generate server-first-message using stored salt/iterations
      const { serverNonce, serverFirstMessage } = generateServerFirstMessage(
        parsed.clientNonce,
        this.scramState.salt,
        this.scramState.iterations,
      );

      // Update SCRAM state
      this.scramState.username = parsed.username;
      this.scramState.clientNonce = parsed.clientNonce;
      this.scramState.serverNonce = serverNonce;
      this.scramState.clientFirstMessageBare = parsed.clientFirstMessageBare;
      this.scramState.serverFirstMessage = serverFirstMessage;

      // Send AuthenticationSASLContinue with server-first-message
      const encoder = new TextEncoder();
      await this.sendMessage({
        kind: "AuthenticationSASLContinue",
        saslData: encoder.encode(serverFirstMessage),
      });
    } catch (err) {
      await this.sendError(
        `SCRAM auth failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.close();
    }
  }

  private async handleSASLResponse(
    msg: ClientMessage & { kind: "AuthenticationSASLResponse" },
  ): Promise<void> {
    if (
      this.state !== "authenticating" || !this.scramState ||
      !this.scramStoredKey || !this.scramServerKey
    ) {
      await this.sendError("Unexpected SASL response");
      this.close();
      return;
    }

    try {
      const { valid, serverSignature } = await verifyClientFinalMessage(
        msg.saslData,
        this.scramState,
        this.scramStoredKey,
        this.scramServerKey,
      );

      if (!valid) {
        await this.sendError("Authentication failed: invalid credentials");
        this.close();
        return;
      }

      // Send AuthenticationSASLFinal with server signature
      const encoder = new TextEncoder();
      await this.sendMessage({
        kind: "AuthenticationSASLFinal",
        saslData: encoder.encode(`v=${serverSignature}`),
      });

      // Send AuthenticationOK + setup messages
      await this.sendAuthOKSequence();
    } catch (err) {
      await this.sendError(
        `SCRAM verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.close();
    }
  }

  // -----------------------------------------------------------------------
  // State synchronization (Phase 4.1)
  // -----------------------------------------------------------------------

  /**
   * Parse state data from a client message if present.
   * State data contains session configuration like current module,
   * aliases, and config values.
   */
  private parseStateData(
    stateTypedescId: Uint8Array,
    stateData: Uint8Array,
  ): void {
    // Zero UUID means no state data
    const isZero = stateTypedescId.every((b) => b === 0);
    if (isZero || stateData.length === 0) {
      return;
    }

    // State data is encoded as a named tuple. For now, we do basic
    // extraction by looking for known config keys in the binary data.
    // A full implementation would decode against the state type descriptor.
    // For now, just note that state was present (keep current state).
  }

  /**
   * Build the state type descriptor ID and state data for responses.
   * Returns the current session state encoded for CommandComplete.
   */
  private buildStateResponse(): {
    stateTypedescId: Uint8Array;
    stateData: Uint8Array;
  } {
    // For now, return zero UUID and empty data (no state changes to report)
    return {
      stateTypedescId: new Uint8Array(16),
      stateData: new Uint8Array(0),
    };
  }

  // -----------------------------------------------------------------------
  // Query operations (enhanced with cache, output format, error codes)
  // -----------------------------------------------------------------------

  private async handleParse(
    msg: ClientMessage & { kind: "Parse" },
  ): Promise<void> {
    try {
      // Phase 4.1: Parse state data if present
      this.parseStateData(msg.stateTypedescId, msg.stateData);

      // Phase 4.2: Check cache first
      const cached = this.stmtCache.get(msg.commandText);
      if (cached) {
        // Cache hit — send cached descriptors
        await this.sendMessage({
          kind: "CommandDataDescription",
          annotations: [],
          capabilities: 0n,
          resultCardinality: msg.expectedCardinality || Cardinality.MANY,
          inputTypedescId: cached.inputDescId,
          inputTypedesc: cached.inputDesc,
          outputTypedescId: cached.outputDescId,
          outputTypedesc: cached.outputDesc,
        });
        return;
      }

      // Cache miss — compile and build type descriptors
      const { inputDesc, outputDesc } = this.buildDescriptors(
        msg.commandText,
      );

      const commandStatus = this.detectCommandStatus(msg.commandText);

      // Store in cache
      this.stmtCache.set(msg.commandText, {
        commandText: msg.commandText,
        inputDescId: inputDesc.id,
        outputDescId: outputDesc.id,
        inputDesc: inputDesc.data,
        outputDesc: outputDesc.data,
        outputFormat: msg.outputFormat,
        resultCardinality: msg.expectedCardinality || Cardinality.MANY,
        commandStatus,
      });

      await this.sendMessage({
        kind: "CommandDataDescription",
        annotations: [],
        capabilities: 0n,
        resultCardinality: msg.expectedCardinality ||
          Cardinality.MANY,
        inputTypedescId: inputDesc.id,
        inputTypedesc: inputDesc.data,
        outputTypedescId: outputDesc.id,
        outputTypedesc: outputDesc.data,
      });
    } catch (err) {
      const errorCode = err instanceof Error
        ? mapErrorToGelCode(err)
        : GEL_ERROR_CODES.InternalServerError;
      await this.sendErrorWithCode(
        err instanceof Error ? err.message : String(err),
        errorCode,
      );
      await this.sendReadyForCommand();
    }
  }

  private async handleExecute(
    msg: ClientMessage & { kind: "Execute" },
  ): Promise<void> {
    try {
      // Phase 4.1: Parse state data if present
      this.parseStateData(msg.stateTypedescId, msg.stateData);

      // Phase 4.2: Check cache for previously parsed statements
      let inputDesc: { id: Uint8Array; data: Uint8Array };
      let outputDesc: { id: Uint8Array; data: Uint8Array };
      let commandStatus: string;

      const cached = this.stmtCache.get(msg.commandText);
      if (cached) {
        // Cache hit — reuse descriptors
        inputDesc = { id: cached.inputDescId, data: cached.inputDesc };
        outputDesc = { id: cached.outputDescId, data: cached.outputDesc };
        commandStatus = cached.commandStatus;
      } else {
        // Cache miss — build descriptors
        const descs = this.buildDescriptors(msg.commandText);
        inputDesc = descs.inputDesc;
        outputDesc = descs.outputDesc;
        commandStatus = this.detectCommandStatus(msg.commandText);

        // Store in cache for future use
        this.stmtCache.set(msg.commandText, {
          commandText: msg.commandText,
          inputDescId: inputDesc.id,
          outputDescId: outputDesc.id,
          inputDesc: inputDesc.data,
          outputDesc: outputDesc.data,
          outputFormat: msg.outputFormat,
          resultCardinality: msg.expectedCardinality || Cardinality.MANY,
          commandStatus,
        });
      }

      // Send CommandDataDescription first
      await this.sendMessage({
        kind: "CommandDataDescription",
        annotations: [],
        capabilities: 0n,
        resultCardinality: msg.expectedCardinality ||
          Cardinality.MANY,
        inputTypedescId: inputDesc.id,
        inputTypedesc: inputDesc.data,
        outputTypedescId: outputDesc.id,
        outputTypedesc: outputDesc.data,
      });

      // Phase 4.3: Output format handling
      const dataElements = this.formatOutputData(
        msg.commandText,
        msg.outputFormat,
      );

      // Send Data (unless NONE output format)
      if (msg.outputFormat !== OutputFormat.NONE) {
        await this.sendMessage({
          kind: "Data",
          data: dataElements,
        });
      }

      // Phase 4.1: Build state response
      const stateResp = this.buildStateResponse();

      // Send CommandComplete
      await this.sendMessage({
        kind: "CommandComplete",
        annotations: [],
        capabilities: 0n,
        status: commandStatus,
        stateTypedescId: stateResp.stateTypedescId,
        stateData: stateResp.stateData,
      });

      // Send ReadyForCommand
      await this.sendReadyForCommand();
    } catch (err) {
      const errorCode = err instanceof Error
        ? mapErrorToGelCode(err)
        : GEL_ERROR_CODES.InternalServerError;
      await this.sendErrorWithCode(
        err instanceof Error ? err.message : String(err),
        errorCode,
      );
      await this.sendReadyForCommand();
    }
  }

  private async handleSync(): Promise<void> {
    await this.sendReadyForCommand();
  }

  // -----------------------------------------------------------------------
  // Output format handling (Phase 4.3)
  // -----------------------------------------------------------------------

  /**
   * Format output data based on the requested output format.
   *
   * Without a real PG connection, we generate simulated data
   * based on the query text and format.
   */
  private formatOutputData(
    commandText: string,
    outputFormat: number,
  ): Uint8Array[] {
    // For DDL/DML queries without result sets, return empty
    const cmd = commandText.trim().toLowerCase();
    if (
      cmd.startsWith("create ") || cmd.startsWith("alter ") ||
      cmd.startsWith("drop ") || cmd.startsWith("configure ")
    ) {
      return [];
    }

    switch (outputFormat) {
      case OutputFormat.JSON: {
        // Encode results as a single JSON string
        const encoder = new TextEncoder();
        const jsonResult = JSON.stringify([]);
        return [encoder.encode(jsonResult)];
      }

      case OutputFormat.BINARY: {
        // Binary format: return binary-encoded elements
        // Without real data, return empty array
        return [];
      }

      case OutputFormat.JSON_ELEMENTS: {
        // Each element as a separate JSON string
        // Without real data, return empty
        return [];
      }

      case OutputFormat.NONE: {
        // No output data
        return [];
      }

      default:
        // Fallback: empty data
        return [];
    }
  }

  // -----------------------------------------------------------------------
  // Command status detection
  // -----------------------------------------------------------------------

  /**
   * Detect the command status string from the query text.
   * Maps common EdgeQL command prefixes to status strings.
   */
  private detectCommandStatus(commandText: string): string {
    const cmd = commandText.trim().toLowerCase();

    if (cmd.startsWith("select ") || cmd.startsWith("select{")) {
      return "SELECT";
    }
    if (cmd.startsWith("insert ")) {
      return "INSERT";
    }
    if (cmd.startsWith("update ")) {
      return "UPDATE";
    }
    if (cmd.startsWith("delete ")) {
      return "DELETE";
    }
    if (cmd.startsWith("create ")) {
      return "CREATE";
    }
    if (cmd.startsWith("alter ")) {
      return "ALTER";
    }
    if (cmd.startsWith("drop ")) {
      return "DROP";
    }
    if (cmd.startsWith("configure ")) {
      return "CONFIGURE";
    }
    if (cmd.startsWith("describe ")) {
      return "DESCRIBE";
    }
    if (cmd.startsWith("with ")) {
      // WITH clause prefix — look for the actual command after WITH block
      // Simple heuristic: check for SELECT, INSERT, etc. after WITH
      if (cmd.includes(" select ")) return "SELECT";
      if (cmd.includes(" insert ")) return "INSERT";
      if (cmd.includes(" update ")) return "UPDATE";
      if (cmd.includes(" delete ")) return "DELETE";
    }

    return "SELECT";
  }

  // -----------------------------------------------------------------------
  // Descriptor building
  // -----------------------------------------------------------------------

  private buildDescriptors(
    _commandText: string,
  ): {
    inputDesc: { id: Uint8Array; data: Uint8Array };
    outputDesc: { id: Uint8Array; data: Uint8Array };
  } {
    // For now, build empty/simple descriptors.
    // A full implementation would parse the EdgeQL, compile it,
    // and derive proper input/output type descriptors.

    // Empty input descriptor (no parameters)
    const emptyData = new Uint8Array(0);
    const emptyId = generateDescriptorIdSync(emptyData);

    // Try to extract a type name from the command and build
    // output descriptors from the schema. For now, use empty.
    const outputData = emptyData;
    const outputId = emptyId;

    return {
      inputDesc: { id: emptyId, data: emptyData },
      outputDesc: { id: outputId, data: outputData },
    };
  }

  // -----------------------------------------------------------------------
  // Auth OK sequence (sent after successful auth or when no auth needed)
  // -----------------------------------------------------------------------

  private async sendAuthOKSequence(): Promise<void> {
    // AuthenticationOK
    await this.sendMessage({ kind: "AuthenticationOK" });

    // ServerKeyData (32 random bytes)
    const keyData = new Uint8Array(32);
    crypto.getRandomValues(keyData);
    await this.sendMessage({
      kind: "ServerKeyData",
      data: keyData,
    });

    // ParameterStatus messages
    const encoder = new TextEncoder();
    await this.sendMessage({
      kind: "ParameterStatus",
      name: encoder.encode("suggested_pool_concurrency"),
      value: encoder.encode("4"),
    });
    await this.sendMessage({
      kind: "ParameterStatus",
      name: encoder.encode("system_config"),
      value: encoder.encode("{}"),
    });

    // Mark ready
    this.state = "ready";
    await this.sendReadyForCommand();
  }

  // -----------------------------------------------------------------------
  // Low-level send/receive helpers
  // -----------------------------------------------------------------------

  private async sendMessage(msg: ServerMessage): Promise<void> {
    if (this.closed) return;
    const bytes = encodeServerMessage(msg);
    await this.writeAll(bytes);
  }

  private async sendError(message: string): Promise<void> {
    await this.sendErrorWithCode(message, GEL_ERROR_CODES.InternalServerError);
  }

  /**
   * Send an ErrorResponse with a specific Gel error code.
   */
  private async sendErrorWithCode(
    message: string,
    errorCode: number,
  ): Promise<void> {
    await this.sendMessage({
      kind: "ErrorResponse",
      severity: ErrorSeverity.ERROR,
      errorCode,
      message,
      attributes: [],
    });
  }

  private async sendReadyForCommand(): Promise<void> {
    await this.sendMessage({
      kind: "ReadyForCommand",
      annotations: [],
      transactionState: this.transactionState,
    });
  }

  /**
   * Read exactly `n` bytes from the TCP connection.
   * Returns null if the connection was closed before all bytes could be read.
   */
  private async readExact(n: number): Promise<Uint8Array | null> {
    const buf = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const nread = await this.conn.read(buf.subarray(offset));
      if (nread === null) return null;
      offset += nread;
    }
    return buf;
  }

  /**
   * Write all bytes to the TCP connection.
   */
  private async writeAll(data: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < data.length) {
      const nwritten = await this.conn.write(data.subarray(offset));
      offset += nwritten;
    }
  }
}

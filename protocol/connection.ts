/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Protocol connection state machine
 * Manages the lifecycle of a binary protocol connection
 */

import { ProtocolBuilder } from "./builder.ts";
import { ProtocolParser } from "./parser.ts";
import { ConnectionPools } from "./pool.ts";
import { ScramServer } from "./scram.ts";
import * as Types from "./types.ts";

export enum ConnectionState {
  AwaitingHandshake,
  AwaitingAuthentication,
  AwaitingSASLInitial,
  AwaitingSASLResponse,
  Ready,
  InTransaction,
  Error,
  Terminated
}

export interface ConnectionOptions {
  maxMessageSize?: number;
  authenticationTimeout?: number;
  idleTimeout?: number;
  enableCompression?: boolean;
}

export interface AuthenticationCredentials {
  username: string;
  storedKey: Uint8Array;
  serverKey: Uint8Array;
  salt: Uint8Array;
  iterations: number;
}

export class ProtocolConnection {
  private state = ConnectionState.AwaitingHandshake;
  private parser = new ProtocolParser();
  private builder = new ProtocolBuilder();
  private pools = new ConnectionPools();
  private scramServer: ScramServer | null = null;
  private credentials: AuthenticationCredentials | null = null;
  private options: Required<ConnectionOptions>;
  private lastActivity = Date.now();
  private transactionDepth = 0;

  // Connection metadata
  private clientVersion = { major: 0, minor: 0 };
  private connectionParameters = new Map<string, string>();

  constructor(
    credentials: AuthenticationCredentials,
    options: ConnectionOptions = {}
  ) {
    this.credentials = credentials;
    this.options = {
      maxMessageSize: options.maxMessageSize ?? 16 * 1024 * 1024, // 16MB
      authenticationTimeout: options.authenticationTimeout ?? 60000, // 60s
      idleTimeout: options.idleTimeout ?? 600000, // 10 minutes
      enableCompression: options.enableCompression ?? false
    };
  }

  /**
   * Process incoming data from the client
   */
  async processData(data: Uint8Array): Promise<Uint8Array[]> {
    this.lastActivity = Date.now();
    this.parser.append(data);

    const responses: Uint8Array[] = [];

    while (this.parser.hasCompleteMessage()) {
      const message = this.parser.parseMessage();
      if (!message) {
        break;
      }

      const response = await this.handleMessage(message);
      if (response) {
        responses.push(response);
      }
    }

    return responses;
  }

  /**
   * Handle a single protocol message
   */
  private handleMessage(
    message: Types.Message
  ): Uint8Array | null | Promise<Uint8Array> {
    switch (this.state) {
      case ConnectionState.AwaitingHandshake:
        if (message.type === Types.MessageType.ClientHandshake) {
          return this.handleClientHandshake(message as Types.ClientHandshake);
        }
        break;

      case ConnectionState.AwaitingAuthentication:
        // Initial authentication state, waiting for client to start SASL
        return this.sendAuthenticationRequest();

      case ConnectionState.AwaitingSASLInitial:
        if (
          message.type === Types.MessageType.AuthenticationSASLInitialResponse
        ) {
          return this.handleSASLInitial(
            message as Types.AuthenticationSASLInitialResponse
          );
        }
        break;

      case ConnectionState.AwaitingSASLResponse:
        if (message.type === Types.MessageType.AuthenticationSASLResponse) {
          return this.handleSASLResponse(
            message as Types.AuthenticationSASLResponse
          );
        }
        break;

      case ConnectionState.Ready:
      case ConnectionState.InTransaction:
        return this.handleCommand(message);

      case ConnectionState.Error:
        if (message.type === Types.MessageType.Sync) {
          return this.handleSync();
        }
        break;
    }

    // Unexpected message for current state
    return this.sendError(
      Types.ErrorSeverity.Error,
      0x0801, // protocol_violation
      `Unexpected message type ${message.type} in state ${ConnectionState[this.state]}`
    );
  }

  private handleClientHandshake(handshake: Types.ClientHandshake): Uint8Array {
    this.clientVersion = {
      major: handshake.majorVersion,
      minor: handshake.minorVersion
    };

    // Store connection parameters
    for (const param of handshake.parameters) {
      this.connectionParameters.set(param.name, param.value);
    }

    // Check version compatibility
    if (handshake.majorVersion !== Types.PROTOCOL_VERSION.major) {
      // Send ServerHandshake to negotiate version
      const serverHandshake: Types.ServerHandshake = {
        type: Types.MessageType.ServerHandshake,
        length: 0,
        majorVersion: Types.PROTOCOL_VERSION.major,
        minorVersion: Types.PROTOCOL_VERSION.minor,
        extensions: []
      };

      return this.builder.buildMessage(serverHandshake);
    }

    // Version is compatible, proceed to authentication
    this.state = ConnectionState.AwaitingSASLInitial;
    return this.sendAuthenticationRequest();
  }

  private sendAuthenticationRequest(): Uint8Array {
    const authSasl: Types.AuthenticationSASL = {
      type: Types.MessageType.AuthenticationSASL,
      length: 0,
      authStatus: 10, // SASL authentication
      mechanisms: ["SCRAM-SHA-256"]
    };

    return this.builder.buildMessage(authSasl);
  }

  private handleSASLInitial(
    message: Types.AuthenticationSASLInitialResponse
  ): Uint8Array {
    if (message.mechanism !== "SCRAM-SHA-256") {
      return this.sendError(
        Types.ErrorSeverity.Fatal,
        0x2801, // invalid_password
        `Unsupported SASL mechanism: ${message.mechanism}`
      );
    }

    if (!this.credentials) {
      return this.sendError(
        Types.ErrorSeverity.Fatal,
        0x2801,
        "No authentication credentials configured"
      );
    }

    // Initialize SCRAM server
    this.scramServer = new ScramServer(
      this.credentials.storedKey,
      this.credentials.serverKey,
      this.credentials.salt,
      this.credentials.iterations
    );

    const clientFirst = new TextDecoder().decode(message.initialResponse);
    const serverFirst = this.scramServer.processClientFirst(clientFirst);

    const authContinue: Types.AuthenticationSASLContinue = {
      type: Types.MessageType.AuthenticationSASLContinue,
      length: 0,
      authStatus: 11, // SASL continue
      saslData: new TextEncoder().encode(serverFirst)
    };

    this.state = ConnectionState.AwaitingSASLResponse;
    return this.builder.buildMessage(authContinue);
  }

  private async handleSASLResponse(
    message: Types.AuthenticationSASLResponse
  ): Promise<Uint8Array> {
    if (!this.scramServer) {
      return this.sendError(
        Types.ErrorSeverity.Fatal,
        0x2801,
        "SASL authentication not initialized"
      );
    }

    try {
      const clientFinal = new TextDecoder().decode(message.response);
      const serverFinal = await this.scramServer.processClientFinal(
        clientFinal
      );

      // Send SASL final
      const authFinal: Types.AuthenticationSASLFinal = {
        type: Types.MessageType.AuthenticationSASLFinal,
        length: 0,
        authStatus: 12, // SASL final
        saslData: new TextEncoder().encode(serverFinal)
      };

      const responses: Uint8Array[] = [];
      responses.push(this.builder.buildMessage(authFinal));

      // Send AuthenticationOK
      const authOk: Types.AuthenticationOK = {
        type: Types.MessageType.AuthenticationOK,
        length: 0,
        authStatus: 0 // Success
      };
      responses.push(this.builder.buildMessage(authOk));

      // Send ReadyForCommand
      const ready: Types.ReadyForCommand = {
        type: Types.MessageType.ReadyForCommand,
        length: 0,
        transactionState: Types.TransactionState.Idle,
        annotations: []
      };
      responses.push(this.builder.buildMessage(ready));

      this.state = ConnectionState.Ready;

      // Combine all responses
      const totalLength = responses.reduce((sum, r) => sum + r.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const response of responses) {
        combined.set(response, offset);
        offset += response.length;
      }

      return combined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.sendError(
        Types.ErrorSeverity.Fatal,
        0x2801,
        `Authentication failed: ${message}`
      );
    }
  }

  private handleCommand(
    message: Types.Message
  ): Uint8Array | null {
    switch (message.type) {
      case Types.MessageType.Parse:
        return this.handleParse(message as Types.ParseMessage);

      case Types.MessageType.Execute:
        return this.handleExecute(message as Types.ExecuteMessage);

      case Types.MessageType.Sync:
        return this.handleSync();

      case Types.MessageType.Flush:
        // Flush is a no-op in our implementation
        return null;

      case Types.MessageType.Terminate:
        this.state = ConnectionState.Terminated;
        return null;

      default:
        return this.sendError(
          Types.ErrorSeverity.Error,
          0x0801,
          `Unsupported command: ${message.type}`
        );
    }
  }

  private handleParse(message: Types.ParseMessage): Uint8Array {
    // This is where we would compile the EdgeQL query
    // For now, return a mock response

    const complete: Types.CommandComplete = {
      type: Types.MessageType.CommandComplete,
      length: 0,
      annotations: message.annotations,
      capabilities: 0n,
      commandStatus: "PARSE COMPLETE",
      stateTypeDescriptorId: new Uint8Array(16),
      encodedStateData: new Uint8Array(0)
    };

    const responses: Uint8Array[] = [];
    responses.push(this.builder.buildMessage(complete));

    // Send ReadyForCommand
    const ready: Types.ReadyForCommand = {
      type: Types.MessageType.ReadyForCommand,
      length: 0,
      transactionState: this.transactionDepth > 0 ?
        Types.TransactionState.InTransaction :
        Types.TransactionState.Idle,
      annotations: []
    };
    responses.push(this.builder.buildMessage(ready));

    return this.combineResponses(responses);
  }

  private handleExecute(
    message: Types.ExecuteMessage
  ): Uint8Array {
    // This is where we would execute the compiled query
    // For now, return mock data

    const responses: Uint8Array[] = [];

    // Send mock data
    const data: Types.DataMessage = {
      type: Types.MessageType.Data,
      length: 0,
      dataElements: [
        { data: new TextEncoder().encode("{\"result\": \"mock\"}") }
      ]
    };
    responses.push(this.builder.buildMessage(data));

    // Send CommandComplete
    const complete: Types.CommandComplete = {
      type: Types.MessageType.CommandComplete,
      length: 0,
      annotations: message.annotations,
      capabilities: 0n,
      commandStatus: "SELECT 1",
      stateTypeDescriptorId: message.stateDataDescriptorId,
      encodedStateData: new Uint8Array(0)
    };
    responses.push(this.builder.buildMessage(complete));

    // Send ReadyForCommand
    const ready: Types.ReadyForCommand = {
      type: Types.MessageType.ReadyForCommand,
      length: 0,
      transactionState: this.transactionDepth > 0 ?
        Types.TransactionState.InTransaction :
        Types.TransactionState.Idle,
      annotations: []
    };
    responses.push(this.builder.buildMessage(ready));

    return this.combineResponses(responses);
  }

  private handleSync(): Uint8Array {
    // Reset to ready state
    this.state = ConnectionState.Ready;

    const ready: Types.ReadyForCommand = {
      type: Types.MessageType.ReadyForCommand,
      length: 0,
      transactionState: this.transactionDepth > 0 ?
        Types.TransactionState.InTransaction :
        Types.TransactionState.Idle,
      annotations: []
    };

    return this.builder.buildMessage(ready);
  }

  private sendError(
    severity: Types.ErrorSeverity,
    code: number,
    message: string,
    attributes?: Map<Types.ErrorAttribute, string>
  ): Uint8Array {
    const error: Types.ErrorResponse = {
      type: Types.MessageType.ErrorResponse,
      length: 0,
      severity,
      errorCode: code,
      message,
      attributes: attributes ?? new Map()
    };

    if (severity === Types.ErrorSeverity.Fatal) {
      this.state = ConnectionState.Terminated;
    } else {
      this.state = ConnectionState.Error;
    }

    return this.builder.buildMessage(error);
  }

  private combineResponses(responses: Uint8Array[]): Uint8Array {
    const totalLength = responses.reduce((sum, r) => sum + r.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const response of responses) {
      combined.set(response, offset);
      offset += response.length;
    }
    return combined;
  }

  /**
   * Check if connection has timed out
   */
  isTimedOut(): boolean {
    const now = Date.now();

    if (
      this.state === ConnectionState.AwaitingAuthentication ||
      this.state === ConnectionState.AwaitingSASLInitial ||
      this.state === ConnectionState.AwaitingSASLResponse
    ) {
      return now - this.lastActivity > this.options.authenticationTimeout;
    }

    return now - this.lastActivity > this.options.idleTimeout;
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    state: string;
    lastActivity: number;
    clientVersion: { major: number; minor: number; };
    parameters: Record<string, string>;
    poolStats: {
      bufferPool: { size: number; count: number; }[];
      messageCache: {
        hits: number;
        misses: number;
        hitRate: number;
        size: number;
      };
    };
  } {
    return {
      state: ConnectionState[this.state],
      lastActivity: this.lastActivity,
      clientVersion: this.clientVersion,
      parameters: Object.fromEntries(this.connectionParameters),
      poolStats: {
        bufferPool: this.pools.bufferPool.stats(),
        messageCache: this.pools.messageCache.stats()
      }
    };
  }

  /**
   * Close the connection and cleanup resources
   */
  close(): void {
    this.state = ConnectionState.Terminated;
    this.pools.clear();
  }
}

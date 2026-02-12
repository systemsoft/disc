/**
 * Binary protocol message parser for Gel/EdgeDB compatibility
 * Handles message framing and parsing with big-endian encoding
 */

import * as Types from "./types.ts";

export class ProtocolParser {
  private buffer: Uint8Array;
  private offset: number;

  constructor(buffer: Uint8Array = new Uint8Array(0)) {
    this.buffer = buffer;
    this.offset = 0;
  }

  /**
   * Append data to the internal buffer
   */
  append(data: Uint8Array): void {
    const newBuffer = new Uint8Array(this.buffer.length - this.offset + data.length);
    newBuffer.set(this.buffer.subarray(this.offset));
    newBuffer.set(data, this.buffer.length - this.offset);
    this.buffer = newBuffer;
    this.offset = 0;
  }

  /**
   * Check if a complete message is available
   */
  hasCompleteMessage(): boolean {
    if (this.buffer.length - this.offset < 5) {
      return false; // Need at least type (1) + length (4)
    }

    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset);
    const messageLength = view.getUint32(1, false); // Big-endian
    return this.buffer.length - this.offset >= messageLength + 1;
  }

  /**
   * Parse the next message from the buffer
   */
  parseMessage(): Types.Message | null {
    if (!this.hasCompleteMessage()) {
      return null;
    }

    const messageType = this.buffer[this.offset];
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + this.offset);
    const messageLength = view.getUint32(1, false);
    
    const messageData = this.buffer.subarray(this.offset + 5, this.offset + messageLength + 1);
    const reader = new MessageReader(messageData);

    let message: Types.Message | null = null;

    switch (messageType) {
      case Types.MessageType.ClientHandshake:
        message = this.parseClientHandshake(reader, messageLength);
        break;
      case Types.MessageType.ServerHandshake:
        message = this.parseServerHandshake(reader, messageLength);
        break;
      case Types.MessageType.AuthenticationOK:
        message = this.parseAuthenticationOK(reader, messageLength);
        break;
      case Types.MessageType.AuthenticationSASL:
        message = this.parseAuthenticationSASL(reader, messageLength);
        break;
      case Types.MessageType.AuthenticationSASLContinue:
        message = this.parseAuthenticationSASLContinue(reader, messageLength);
        break;
      case Types.MessageType.AuthenticationSASLFinal:
        message = this.parseAuthenticationSASLFinal(reader, messageLength);
        break;
      case Types.MessageType.AuthenticationSASLInitialResponse:
        message = this.parseAuthenticationSASLInitialResponse(reader, messageLength);
        break;
      case Types.MessageType.AuthenticationSASLResponse:
        message = this.parseAuthenticationSASLResponse(reader, messageLength);
        break;
      case Types.MessageType.Parse:
        message = this.parseParseMessage(reader, messageLength);
        break;
      case Types.MessageType.Execute:
        message = this.parseExecuteMessage(reader, messageLength);
        break;
      case Types.MessageType.CommandComplete:
        message = this.parseCommandComplete(reader, messageLength);
        break;
      case Types.MessageType.Data:
        message = this.parseDataMessage(reader, messageLength);
        break;
      case Types.MessageType.ErrorResponse:
        message = this.parseErrorResponse(reader, messageLength);
        break;
      case Types.MessageType.ReadyForCommand:
        message = this.parseReadyForCommand(reader, messageLength);
        break;
      case Types.MessageType.Sync:
      case Types.MessageType.Flush:
      case Types.MessageType.Terminate:
        // These messages have no body
        message = { type: messageType, length: messageLength };
        break;
      default:
        throw new Error(`Unknown message type: 0x${messageType.toString(16)}`);
    }

    this.offset += messageLength + 1;
    return message;
  }

  private parseClientHandshake(reader: MessageReader, length: number): Types.ClientHandshake {
    const majorVersion = reader.readUInt16();
    const minorVersion = reader.readUInt16();
    const numExtensions = reader.readUInt16();
    
    const extensions: Types.ProtocolExtension[] = [];
    for (let i = 0; i < numExtensions; i++) {
      const name = reader.readString();
      const numHeaders = reader.readUInt16();
      const headers = new Map<string, Uint8Array>();
      
      for (let j = 0; j < numHeaders; j++) {
        const headerName = reader.readString();
        const headerValue = reader.readBytes();
        headers.set(headerName, headerValue);
      }
      
      extensions.push({ name, headers });
    }

    const numParams = reader.readUInt16();
    const parameters: Types.ConnectionParameter[] = [];
    for (let i = 0; i < numParams; i++) {
      const name = reader.readString();
      const value = reader.readString();
      parameters.push({ name, value });
    }

    return {
      type: Types.MessageType.ClientHandshake,
      length,
      majorVersion,
      minorVersion,
      extensions,
      parameters,
    };
  }

  private parseServerHandshake(reader: MessageReader, length: number): Types.ServerHandshake {
    const majorVersion = reader.readUInt16();
    const minorVersion = reader.readUInt16();
    const numExtensions = reader.readUInt16();
    
    const extensions: Types.ProtocolExtension[] = [];
    for (let i = 0; i < numExtensions; i++) {
      const name = reader.readString();
      const numHeaders = reader.readUInt16();
      const headers = new Map<string, Uint8Array>();
      
      for (let j = 0; j < numHeaders; j++) {
        const headerName = reader.readString();
        const headerValue = reader.readBytes();
        headers.set(headerName, headerValue);
      }
      
      extensions.push({ name, headers });
    }

    return {
      type: Types.MessageType.ServerHandshake,
      length,
      majorVersion,
      minorVersion,
      extensions,
    };
  }

  private parseAuthenticationOK(reader: MessageReader, length: number): Types.AuthenticationOK {
    const authStatus = reader.readUInt32();
    return {
      type: Types.MessageType.AuthenticationOK,
      length,
      authStatus,
    };
  }

  private parseAuthenticationSASL(reader: MessageReader, length: number): Types.AuthenticationSASL {
    const authStatus = reader.readUInt32();
    const numMechanisms = reader.readUInt32();
    const mechanisms: string[] = [];
    
    for (let i = 0; i < numMechanisms; i++) {
      mechanisms.push(reader.readString());
    }

    return {
      type: Types.MessageType.AuthenticationSASL,
      length,
      authStatus,
      mechanisms,
    };
  }

  private parseAuthenticationSASLContinue(reader: MessageReader, length: number): Types.AuthenticationSASLContinue {
    const authStatus = reader.readUInt32();
    const saslData = reader.readBytes();
    
    return {
      type: Types.MessageType.AuthenticationSASLContinue,
      length,
      authStatus,
      saslData,
    };
  }

  private parseAuthenticationSASLFinal(reader: MessageReader, length: number): Types.AuthenticationSASLFinal {
    const authStatus = reader.readUInt32();
    const saslData = reader.readBytes();
    
    return {
      type: Types.MessageType.AuthenticationSASLFinal,
      length,
      authStatus,
      saslData,
    };
  }

  private parseAuthenticationSASLInitialResponse(reader: MessageReader, length: number): Types.AuthenticationSASLInitialResponse {
    const mechanism = reader.readString();
    const initialResponse = reader.readBytes();
    
    return {
      type: Types.MessageType.AuthenticationSASLInitialResponse,
      length,
      mechanism,
      initialResponse,
    };
  }

  private parseAuthenticationSASLResponse(reader: MessageReader, length: number): Types.AuthenticationSASLResponse {
    const response = reader.readBytes();
    
    return {
      type: Types.MessageType.AuthenticationSASLResponse,
      length,
      response,
    };
  }

  private parseParseMessage(reader: MessageReader, length: number): Types.ParseMessage {
    const numAnnotations = reader.readUInt16();
    const annotations: Types.Annotation[] = [];
    
    for (let i = 0; i < numAnnotations; i++) {
      const name = reader.readString();
      const value = reader.readString();
      annotations.push({ name, value });
    }

    const allowedCapabilities = reader.readUInt64();
    const compilationFlags = reader.readUInt64();
    const implicitLimit = reader.readUInt64();
    const inputLanguage = reader.readUInt8() as Types.InputLanguage;
    const outputFormat = reader.readUInt8() as Types.OutputFormat;
    const expectedCardinality = reader.readUInt8() as Types.Cardinality;
    const commandText = reader.readString();

    return {
      type: Types.MessageType.Parse,
      length,
      annotations,
      allowedCapabilities,
      compilationFlags,
      implicitLimit,
      inputLanguage,
      outputFormat,
      expectedCardinality,
      commandText,
    };
  }

  private parseExecuteMessage(reader: MessageReader, length: number): Types.ExecuteMessage {
    const numAnnotations = reader.readUInt16();
    const annotations: Types.Annotation[] = [];
    
    for (let i = 0; i < numAnnotations; i++) {
      const name = reader.readString();
      const value = reader.readString();
      annotations.push({ name, value });
    }

    const allowedCapabilities = reader.readUInt64();
    const compilationFlags = reader.readUInt64();
    const implicitLimit = reader.readUInt64();
    const inputLanguage = reader.readUInt8() as Types.InputLanguage;
    const outputFormat = reader.readUInt8() as Types.OutputFormat;
    const expectedCardinality = reader.readUInt8() as Types.Cardinality;
    const commandText = reader.readString();
    const stateDataDescriptorId = reader.readFixedBytes(16); // UUID
    const encodedStateData = reader.readBytes();
    const argumentDataDescriptorId = reader.readFixedBytes(16); // UUID
    const argumentData = reader.readBytes();
    const outputDataDescriptorId = reader.readFixedBytes(16); // UUID

    return {
      type: Types.MessageType.Execute,
      length,
      annotations,
      allowedCapabilities,
      compilationFlags,
      implicitLimit,
      inputLanguage,
      outputFormat,
      expectedCardinality,
      commandText,
      stateDataDescriptorId,
      encodedStateData,
      argumentDataDescriptorId,
      argumentData,
      outputDataDescriptorId,
    };
  }

  private parseCommandComplete(reader: MessageReader, length: number): Types.CommandComplete {
    const numAnnotations = reader.readUInt16();
    const annotations: Types.Annotation[] = [];
    
    for (let i = 0; i < numAnnotations; i++) {
      const name = reader.readString();
      const value = reader.readString();
      annotations.push({ name, value });
    }

    const capabilities = reader.readUInt64();
    const commandStatus = reader.readString();
    const stateTypeDescriptorId = reader.readFixedBytes(16); // UUID
    const encodedStateData = reader.readBytes();

    return {
      type: Types.MessageType.CommandComplete,
      length,
      annotations,
      capabilities,
      commandStatus,
      stateTypeDescriptorId,
      encodedStateData,
    };
  }

  private parseDataMessage(reader: MessageReader, length: number): Types.DataMessage {
    const numElements = reader.readUInt16();
    const dataElements: Types.DataElement[] = [];
    
    for (let i = 0; i < numElements; i++) {
      const data = reader.readBytes();
      dataElements.push({ data });
    }

    return {
      type: Types.MessageType.Data,
      length,
      dataElements,
    };
  }

  private parseErrorResponse(reader: MessageReader, length: number): Types.ErrorResponse {
    const severity = reader.readUInt8() as Types.ErrorSeverity;
    const errorCode = reader.readUInt32();
    const message = reader.readString();
    const numAttributes = reader.readUInt16();
    
    const attributes = new Map<Types.ErrorAttribute, string>();
    for (let i = 0; i < numAttributes; i++) {
      const code = reader.readUInt16() as Types.ErrorAttribute;
      const value = reader.readString();
      attributes.set(code, value);
    }

    return {
      type: Types.MessageType.ErrorResponse,
      length,
      severity,
      errorCode,
      message,
      attributes,
    };
  }

  private parseReadyForCommand(reader: MessageReader, length: number): Types.ReadyForCommand {
    const transactionState = reader.readUInt8() as Types.TransactionState;
    const numAnnotations = reader.readUInt16();
    const annotations: Types.Annotation[] = [];
    
    for (let i = 0; i < numAnnotations; i++) {
      const name = reader.readString();
      const value = reader.readString();
      annotations.push({ name, value });
    }

    return {
      type: Types.MessageType.ReadyForCommand,
      length,
      transactionState,
      annotations,
    };
  }
}

/**
 * Helper class for reading binary data with big-endian encoding
 */
class MessageReader {
  private buffer: Uint8Array;
  private view: DataView;
  private offset: number;

  constructor(buffer: Uint8Array) {
    this.buffer = buffer;
    this.view = new DataView(buffer.buffer, buffer.byteOffset);
    this.offset = 0;
  }

  readUInt8(): number {
    const value = this.buffer[this.offset];
    this.offset++;
    return value;
  }

  readUInt16(): number {
    const value = this.view.getUint16(this.offset, false); // Big-endian
    this.offset += 2;
    return value;
  }

  readUInt32(): number {
    const value = this.view.getUint32(this.offset, false); // Big-endian
    this.offset += 4;
    return value;
  }

  readUInt64(): bigint {
    const high = this.view.getUint32(this.offset, false);
    const low = this.view.getUint32(this.offset + 4, false);
    this.offset += 8;
    return (BigInt(high) << 32n) | BigInt(low);
  }

  readString(): string {
    const length = this.readUInt32();
    const bytes = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return new TextDecoder().decode(bytes);
  }

  readBytes(): Uint8Array {
    const length = this.readUInt32();
    const bytes = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  readFixedBytes(length: number): Uint8Array {
    const bytes = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
}
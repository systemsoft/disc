/**
 * Binary protocol message builder for Gel/EdgeDB compatibility
 * Creates binary messages with big-endian encoding
 */

import * as Types from "./types.ts";

export class ProtocolBuilder {
  /**
   * Build any message into binary format
   */
  buildMessage(message: Types.Message): Uint8Array {
    switch (message.type) {
      case Types.MessageType.ClientHandshake:
        return this.buildClientHandshake(message as Types.ClientHandshake);
      case Types.MessageType.ServerHandshake:
        return this.buildServerHandshake(message as Types.ServerHandshake);
      case Types.MessageType.AuthenticationOK:
        return this.buildAuthenticationOK(message as Types.AuthenticationOK);
      case Types.MessageType.AuthenticationSASL:
        return this.buildAuthenticationSASL(
          message as Types.AuthenticationSASL
        );
      case Types.MessageType.AuthenticationSASLContinue:
        return this.buildAuthenticationSASLContinue(
          message as Types.AuthenticationSASLContinue
        );
      case Types.MessageType.AuthenticationSASLFinal:
        return this.buildAuthenticationSASLFinal(
          message as Types.AuthenticationSASLFinal
        );
      case Types.MessageType.AuthenticationSASLInitialResponse:
        return this.buildAuthenticationSASLInitialResponse(
          message as Types.AuthenticationSASLInitialResponse
        );
      case Types.MessageType.AuthenticationSASLResponse:
        return this.buildAuthenticationSASLResponse(
          message as Types.AuthenticationSASLResponse
        );
      case Types.MessageType.Parse:
        return this.buildParseMessage(message as Types.ParseMessage);
      case Types.MessageType.Execute:
        return this.buildExecuteMessage(message as Types.ExecuteMessage);
      case Types.MessageType.CommandComplete:
        return this.buildCommandComplete(message as Types.CommandComplete);
      case Types.MessageType.Data:
        return this.buildDataMessage(message as Types.DataMessage);
      case Types.MessageType.ErrorResponse:
        return this.buildErrorResponse(message as Types.ErrorResponse);
      case Types.MessageType.ReadyForCommand:
        return this.buildReadyForCommand(message as Types.ReadyForCommand);
      case Types.MessageType.Sync:
      case Types.MessageType.Flush:
      case Types.MessageType.Terminate:
        return this.buildSimpleMessage(message.type);
      default:
        throw new Error(`Unknown message type: ${message.type}`);
    }
  }

  private buildSimpleMessage(type: Types.MessageType): Uint8Array {
    const buffer = new Uint8Array(5);
    buffer[0] = type;
    const view = new DataView(buffer.buffer);
    view.setUint32(1, 4, false); // Length includes itself
    return buffer;
  }

  private buildClientHandshake(message: Types.ClientHandshake): Uint8Array {
    const writer = new MessageWriter();

    writer.writeUInt16(message.majorVersion);
    writer.writeUInt16(message.minorVersion);
    writer.writeUInt16(message.extensions.length);

    for (const ext of message.extensions) {
      writer.writeString(ext.name);
      writer.writeUInt16(ext.headers.size);

      for (const [key, value] of ext.headers) {
        writer.writeString(key);
        writer.writeBytes(value);
      }
    }

    writer.writeUInt16(message.parameters.length);
    for (const param of message.parameters) {
      writer.writeString(param.name);
      writer.writeString(param.value);
    }

    return this.wrapMessage(
      Types.MessageType.ClientHandshake,
      writer.getBuffer()
    );
  }

  private buildServerHandshake(message: Types.ServerHandshake): Uint8Array {
    const writer = new MessageWriter();

    writer.writeUInt16(message.majorVersion);
    writer.writeUInt16(message.minorVersion);
    writer.writeUInt16(message.extensions.length);

    for (const ext of message.extensions) {
      writer.writeString(ext.name);
      writer.writeUInt16(ext.headers.size);

      for (const [key, value] of ext.headers) {
        writer.writeString(key);
        writer.writeBytes(value);
      }
    }

    return this.wrapMessage(
      Types.MessageType.ServerHandshake,
      writer.getBuffer()
    );
  }

  private buildAuthenticationOK(message: Types.AuthenticationOK): Uint8Array {
    const writer = new MessageWriter();
    writer.writeUInt32(message.authStatus);
    return this.wrapMessage(
      Types.MessageType.AuthenticationOK,
      writer.getBuffer()
    );
  }

  private buildAuthenticationSASL(
    message: Types.AuthenticationSASL
  ): Uint8Array {
    const writer = new MessageWriter();
    writer.writeUInt32(message.authStatus);
    writer.writeUInt32(message.mechanisms.length);

    for (const mechanism of message.mechanisms) {
      writer.writeString(mechanism);
    }

    return this.wrapMessage(
      Types.MessageType.AuthenticationSASL,
      writer.getBuffer()
    );
  }

  private buildAuthenticationSASLContinue(
    message: Types.AuthenticationSASLContinue
  ): Uint8Array {
    const writer = new MessageWriter();
    writer.writeUInt32(message.authStatus);
    writer.writeBytes(message.saslData);
    return this.wrapMessage(
      Types.MessageType.AuthenticationSASLContinue,
      writer.getBuffer()
    );
  }

  private buildAuthenticationSASLFinal(
    message: Types.AuthenticationSASLFinal
  ): Uint8Array {
    const writer = new MessageWriter();
    writer.writeUInt32(message.authStatus);
    writer.writeBytes(message.saslData);
    return this.wrapMessage(
      Types.MessageType.AuthenticationSASLFinal,
      writer.getBuffer()
    );
  }

  private buildAuthenticationSASLInitialResponse(
    message: Types.AuthenticationSASLInitialResponse
  ): Uint8Array {
    const writer = new MessageWriter();
    writer.writeString(message.mechanism);
    writer.writeBytes(message.initialResponse);
    return this.wrapMessage(
      Types.MessageType.AuthenticationSASLInitialResponse,
      writer.getBuffer()
    );
  }

  private buildAuthenticationSASLResponse(
    message: Types.AuthenticationSASLResponse
  ): Uint8Array {
    const writer = new MessageWriter();
    writer.writeBytes(message.response);
    return this.wrapMessage(
      Types.MessageType.AuthenticationSASLResponse,
      writer.getBuffer()
    );
  }

  private buildParseMessage(message: Types.ParseMessage): Uint8Array {
    const writer = new MessageWriter();

    writer.writeUInt16(message.annotations.length);
    for (const annotation of message.annotations) {
      writer.writeString(annotation.name);
      writer.writeString(annotation.value);
    }

    writer.writeUInt64(message.allowedCapabilities);
    writer.writeUInt64(message.compilationFlags);
    writer.writeUInt64(message.implicitLimit);
    writer.writeUInt8(message.inputLanguage);
    writer.writeUInt8(message.outputFormat);
    writer.writeUInt8(message.expectedCardinality);
    writer.writeString(message.commandText);

    return this.wrapMessage(Types.MessageType.Parse, writer.getBuffer());
  }

  private buildExecuteMessage(message: Types.ExecuteMessage): Uint8Array {
    const writer = new MessageWriter();

    writer.writeUInt16(message.annotations.length);
    for (const annotation of message.annotations) {
      writer.writeString(annotation.name);
      writer.writeString(annotation.value);
    }

    writer.writeUInt64(message.allowedCapabilities);
    writer.writeUInt64(message.compilationFlags);
    writer.writeUInt64(message.implicitLimit);
    writer.writeUInt8(message.inputLanguage);
    writer.writeUInt8(message.outputFormat);
    writer.writeUInt8(message.expectedCardinality);
    writer.writeString(message.commandText);
    writer.writeFixedBytes(message.stateDataDescriptorId);
    writer.writeBytes(message.encodedStateData);
    writer.writeFixedBytes(message.argumentDataDescriptorId);
    writer.writeBytes(message.argumentData);
    writer.writeFixedBytes(message.outputDataDescriptorId);

    return this.wrapMessage(Types.MessageType.Execute, writer.getBuffer());
  }

  private buildCommandComplete(message: Types.CommandComplete): Uint8Array {
    const writer = new MessageWriter();

    writer.writeUInt16(message.annotations.length);
    for (const annotation of message.annotations) {
      writer.writeString(annotation.name);
      writer.writeString(annotation.value);
    }

    writer.writeUInt64(message.capabilities);
    writer.writeString(message.commandStatus);
    writer.writeFixedBytes(message.stateTypeDescriptorId);
    writer.writeBytes(message.encodedStateData);

    return this.wrapMessage(
      Types.MessageType.CommandComplete,
      writer.getBuffer()
    );
  }

  private buildDataMessage(message: Types.DataMessage): Uint8Array {
    const writer = new MessageWriter();

    writer.writeUInt16(message.dataElements.length);
    for (const element of message.dataElements) {
      writer.writeBytes(element.data);
    }

    return this.wrapMessage(Types.MessageType.Data, writer.getBuffer());
  }

  private buildErrorResponse(message: Types.ErrorResponse): Uint8Array {
    const writer = new MessageWriter();

    writer.writeUInt8(message.severity);
    writer.writeUInt32(message.errorCode);
    writer.writeString(message.message);
    writer.writeUInt16(message.attributes.size);

    for (const [code, value] of message.attributes) {
      writer.writeUInt16(code);
      writer.writeString(value);
    }

    return this.wrapMessage(
      Types.MessageType.ErrorResponse,
      writer.getBuffer()
    );
  }

  private buildReadyForCommand(message: Types.ReadyForCommand): Uint8Array {
    const writer = new MessageWriter();

    writer.writeUInt8(message.transactionState);
    writer.writeUInt16(message.annotations.length);
    for (const annotation of message.annotations) {
      writer.writeString(annotation.name);
      writer.writeString(annotation.value);
    }

    return this.wrapMessage(
      Types.MessageType.ReadyForCommand,
      writer.getBuffer()
    );
  }

  private wrapMessage(type: Types.MessageType, body: Uint8Array): Uint8Array {
    const buffer = new Uint8Array(5 + body.length);
    buffer[0] = type;

    const view = new DataView(buffer.buffer);
    view.setUint32(1, 4 + body.length, false); // Big-endian

    buffer.set(body, 5);
    return buffer;
  }
}

/**
 * Helper class for writing binary data with big-endian encoding
 */
class MessageWriter {
  private buffers: Uint8Array[] = [];
  private totalLength = 0;

  writeUInt8(value: number): void {
    const buffer = new Uint8Array(1);
    buffer[0] = value;
    this.buffers.push(buffer);
    this.totalLength += 1;
  }

  writeUInt16(value: number): void {
    const buffer = new Uint8Array(2);
    const view = new DataView(buffer.buffer);
    view.setUint16(0, value, false); // Big-endian
    this.buffers.push(buffer);
    this.totalLength += 2;
  }

  writeUInt32(value: number): void {
    const buffer = new Uint8Array(4);
    const view = new DataView(buffer.buffer);
    view.setUint32(0, value, false); // Big-endian
    this.buffers.push(buffer);
    this.totalLength += 4;
  }

  writeUInt64(value: bigint): void {
    const buffer = new Uint8Array(8);
    const view = new DataView(buffer.buffer);
    view.setUint32(0, Number(value >> 32n), false);
    view.setUint32(4, Number(value & 0xffffffffn), false);
    this.buffers.push(buffer);
    this.totalLength += 8;
  }

  writeString(value: string): void {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(value);
    this.writeUInt32(bytes.length);
    this.buffers.push(bytes);
    this.totalLength += bytes.length;
  }

  writeBytes(value: Uint8Array): void {
    this.writeUInt32(value.length);
    this.buffers.push(value);
    this.totalLength += value.length;
  }

  writeFixedBytes(value: Uint8Array): void {
    this.buffers.push(value);
    this.totalLength += value.length;
  }

  getBuffer(): Uint8Array {
    const result = new Uint8Array(this.totalLength);
    let offset = 0;

    for (const buffer of this.buffers) {
      result.set(buffer, offset);
      offset += buffer.length;
    }

    return result;
  }
}

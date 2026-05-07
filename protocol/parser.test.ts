/**
 * Tests for binary protocol parser
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ProtocolBuilder } from "./builder.ts";
import { ProtocolParser } from "./parser.ts";
import * as Types from "./types.ts";

Deno.test("ProtocolParser - parse simple messages", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  // Test Sync message
  const syncMessage = builder.buildMessage({
    type: Types.MessageType.Sync,
    length: 4,
  });

  parser.append(syncMessage);
  assertEquals(parser.hasCompleteMessage(), true);

  const parsed = parser.parseMessage();
  assertEquals(parsed?.type, Types.MessageType.Sync);
});

Deno.test("ProtocolParser - parse ClientHandshake", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  const handshake: Types.ClientHandshake = {
    type: Types.MessageType.ClientHandshake,
    length: 0, // Will be calculated
    majorVersion: 1,
    minorVersion: 0,
    extensions: [
      {
        name: "test-ext",
        headers: new Map([["header1", new Uint8Array([1, 2, 3])]]),
      },
    ],
    parameters: [
      { name: "database", value: "testdb" },
      { name: "user", value: "testuser" },
    ],
  };

  const message = builder.buildMessage(handshake);
  parser.append(message);

  const parsed = parser.parseMessage() as Types.ClientHandshake;
  assertEquals(parsed?.type, Types.MessageType.ClientHandshake);
  assertEquals(parsed?.majorVersion, 1);
  assertEquals(parsed?.minorVersion, 0);
  assertEquals(parsed?.extensions.length, 1);
  assertEquals(parsed?.extensions[0].name, "test-ext");
  assertEquals(parsed?.parameters.length, 2);
  assertEquals(parsed?.parameters[0].name, "database");
  assertEquals(parsed?.parameters[0].value, "testdb");
});

Deno.test("ProtocolParser - parse AuthenticationSASL", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  const authSasl: Types.AuthenticationSASL = {
    type: Types.MessageType.AuthenticationSASL,
    length: 0,
    authStatus: 10,
    mechanisms: ["SCRAM-SHA-256", "SCRAM-SHA-256-PLUS"],
  };

  const message = builder.buildMessage(authSasl);
  parser.append(message);

  const parsed = parser.parseMessage() as Types.AuthenticationSASL;
  assertEquals(parsed?.type, Types.MessageType.AuthenticationSASL);
  assertEquals(parsed?.authStatus, 10);
  assertEquals(parsed?.mechanisms.length, 2);
  assertEquals(parsed?.mechanisms[0], "SCRAM-SHA-256");
});

Deno.test("ProtocolParser - parse Parse message", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  const parseMsg: Types.ParseMessage = {
    type: Types.MessageType.Parse,
    length: 0,
    annotations: [
      { name: "query_id", value: "123" },
    ],
    allowedCapabilities: 0n,
    compilationFlags: 0n,
    implicitLimit: 100n,
    inputLanguage: Types.InputLanguage.EdgeQL,
    outputFormat: Types.OutputFormat.JSON,
    expectedCardinality: Types.Cardinality.Many,
    commandText: "SELECT User { name, email }",
  };

  const message = builder.buildMessage(parseMsg);
  parser.append(message);

  const parsed = parser.parseMessage() as Types.ParseMessage;
  assertEquals(parsed?.type, Types.MessageType.Parse);
  assertEquals(parsed?.annotations.length, 1);
  assertEquals(parsed?.annotations[0].name, "query_id");
  assertEquals(parsed?.implicitLimit, 100n);
  assertEquals(parsed?.inputLanguage, Types.InputLanguage.EdgeQL);
  assertEquals(parsed?.outputFormat, Types.OutputFormat.JSON);
  assertEquals(parsed?.expectedCardinality, Types.Cardinality.Many);
  assertEquals(parsed?.commandText, "SELECT User { name, email }");
});

Deno.test("ProtocolParser - parse ErrorResponse", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  const error: Types.ErrorResponse = {
    type: Types.MessageType.ErrorResponse,
    length: 0,
    severity: Types.ErrorSeverity.Error,
    errorCode: 42000,
    message: "Syntax error in query",
    attributes: new Map([
      [Types.ErrorAttribute.Hint, "Check your query syntax"],
      [Types.ErrorAttribute.LineStart, "1"],
      [Types.ErrorAttribute.ColumnStart, "10"],
    ]),
  };

  const message = builder.buildMessage(error);
  parser.append(message);

  const parsed = parser.parseMessage() as Types.ErrorResponse;
  assertEquals(parsed?.type, Types.MessageType.ErrorResponse);
  assertEquals(parsed?.severity, Types.ErrorSeverity.Error);
  assertEquals(parsed?.errorCode, 42000);
  assertEquals(parsed?.message, "Syntax error in query");
  assertEquals(
    parsed?.attributes.get(Types.ErrorAttribute.Hint),
    "Check your query syntax",
  );
  assertEquals(parsed?.attributes.get(Types.ErrorAttribute.LineStart), "1");
});

Deno.test("ProtocolParser - parse Data message", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  const encoder = new TextEncoder();
  const dataMsg: Types.DataMessage = {
    type: Types.MessageType.Data,
    length: 0,
    dataElements: [
      { data: encoder.encode("{\"id\": 1, \"name\": \"Ada\"}") },
      { data: encoder.encode("{\"id\": 2, \"name\": \"Billie\"}") },
    ],
  };

  const message = builder.buildMessage(dataMsg);
  parser.append(message);

  const parsed = parser.parseMessage() as Types.DataMessage;
  assertEquals(parsed?.type, Types.MessageType.Data);
  assertEquals(parsed?.dataElements.length, 2);

  const decoder = new TextDecoder();
  assertEquals(
    decoder.decode(parsed?.dataElements[0].data),
    "{\"id\": 1, \"name\": \"Ada\"}",
  );
  assertEquals(
    decoder.decode(parsed?.dataElements[1].data),
    "{\"id\": 2, \"name\": \"Billie\"}",
  );
});

Deno.test("ProtocolParser - handle fragmented messages", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  const handshake: Types.ClientHandshake = {
    type: Types.MessageType.ClientHandshake,
    length: 0,
    majorVersion: 1,
    minorVersion: 0,
    extensions: [],
    parameters: [{ name: "database", value: "testdb" }],
  };

  const message = builder.buildMessage(handshake);

  // Split message into fragments
  const part1 = message.subarray(0, 10);
  const part2 = message.subarray(10);

  // Append first part - should not have complete message
  parser.append(part1);
  assertEquals(parser.hasCompleteMessage(), false);
  assertEquals(parser.parseMessage(), null);

  // Append second part - should now have complete message
  parser.append(part2);
  assertEquals(parser.hasCompleteMessage(), true);

  const parsed = parser.parseMessage() as Types.ClientHandshake;
  assertEquals(parsed?.type, Types.MessageType.ClientHandshake);
  assertEquals(parsed?.parameters[0].value, "testdb");
});

Deno.test("ProtocolParser - handle multiple messages", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  const sync1 = builder.buildMessage({
    type: Types.MessageType.Sync,
    length: 4,
  });

  const flush = builder.buildMessage({
    type: Types.MessageType.Flush,
    length: 4,
  });

  const sync2 = builder.buildMessage({
    type: Types.MessageType.Sync,
    length: 4,
  });

  // Append all messages at once
  const combined = new Uint8Array(sync1.length + flush.length + sync2.length);
  combined.set(sync1, 0);
  combined.set(flush, sync1.length);
  combined.set(sync2, sync1.length + flush.length);

  parser.append(combined);

  // Should be able to parse all three messages
  assertEquals(parser.hasCompleteMessage(), true);
  assertEquals(parser.parseMessage()?.type, Types.MessageType.Sync);

  assertEquals(parser.hasCompleteMessage(), true);
  assertEquals(parser.parseMessage()?.type, Types.MessageType.Flush);

  assertEquals(parser.hasCompleteMessage(), true);
  assertEquals(parser.parseMessage()?.type, Types.MessageType.Sync);

  // No more messages
  assertEquals(parser.hasCompleteMessage(), false);
  assertEquals(parser.parseMessage(), null);
});

Deno.test("ProtocolParser - UUID conversion", () => {
  const uuid = "00000000-0000-0000-0000-000000000100";
  const bytes = Types.uuidToBytes(uuid);

  assertEquals(bytes.length, 16);
  assertEquals(bytes[15], 0x00);
  assertEquals(bytes[14], 0x01);

  const converted = Types.bytesToUuid(bytes);
  assertEquals(converted, uuid);
});

Deno.test("ProtocolParser - Execute message with UUIDs", () => {
  const builder = new ProtocolBuilder();
  const parser = new ProtocolParser();

  const stateId = Types.uuidToBytes("11111111-2222-3333-4444-555555555555");
  const argId = Types.uuidToBytes("66666666-7777-8888-9999-aaaaaaaaaaaa");
  const outputId = Types.uuidToBytes("bbbbbbbb-cccc-dddd-eeee-ffffffffffff");

  const executeMsg: Types.ExecuteMessage = {
    type: Types.MessageType.Execute,
    length: 0,
    annotations: [],
    allowedCapabilities: 0n,
    compilationFlags: 0n,
    implicitLimit: 0n,
    inputLanguage: Types.InputLanguage.EdgeQL,
    outputFormat: Types.OutputFormat.Binary,
    expectedCardinality: Types.Cardinality.One,
    commandText: "SELECT User FILTER .id = <uuid>$0",
    stateDataDescriptorId: stateId,
    encodedStateData: new Uint8Array([1, 2, 3]),
    argumentDataDescriptorId: argId,
    argumentData: new Uint8Array([4, 5, 6]),
    outputDataDescriptorId: outputId,
  };

  const message = builder.buildMessage(executeMsg);
  parser.append(message);

  const parsed = parser.parseMessage() as Types.ExecuteMessage;
  assertEquals(parsed?.type, Types.MessageType.Execute);
  assertEquals(
    Types.bytesToUuid(parsed.stateDataDescriptorId),
    "11111111-2222-3333-4444-555555555555",
  );
  assertEquals(
    Types.bytesToUuid(parsed.argumentDataDescriptorId),
    "66666666-7777-8888-9999-aaaaaaaaaaaa",
  );
  assertEquals(
    Types.bytesToUuid(parsed.outputDataDescriptorId),
    "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  );
});

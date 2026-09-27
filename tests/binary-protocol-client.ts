/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A minimal Gel binary-protocol client for PG end-to-end tests: sends
 * Parse + Execute for one query and decodes the CommandDataDescription's
 * output descriptor and the Data rows against it. Arrays and tuples are
 * named by their structure (`array<std::str>`), read from the positions
 * their descriptors reference, and checked against the name they carry.
 */

import { assert, assertEquals } from "@std/assert";
import { BufferReader, BufferWriter } from "../protocol/buffer.ts";
import { Cardinality, InputLanguage, OutputFormat } from "../protocol/enums.ts";
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage
} from "../protocol/messages.ts";
import { decodeWireValue, encodeWireValue } from "../protocol/collection-codecs.ts";
import { UUID_TO_TYPE } from "../protocol/typedesc.ts";

const ZERO_UUID = new Uint8Array(16);

/**
 * A decoded output descriptor: a base scalar, an array or tuple (`type`
 * names it, e.g. `tuple<a: std::int64, b: std::str>`), or an object shape.
 */
export type Described =
  | { kind: "array" | "tuple"; type: string; }
  | { kind: "scalar"; type: string; }
  | { fields: { name: string; type: string; }[]; kind: "object"; };

export interface Answer {
  cardinality: number;
  described: Described;
  values: unknown[];
}

function uuidString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/*** Decode a v2 typedesc block (descriptors referenced by position). ***/
function describe(block: Uint8Array): Described {
  const descriptors: Uint8Array[] = [];
  const blockReader = new BufferReader(block);
  while (blockReader.remaining > 0) {
    descriptors.push(blockReader.readLenPrefixedBytes());
  }

  /*** The type at `pos`: a base scalar (2), tuple (4), named tuple (5) or array (6). ***/
  function typeAt(pos: number): string {
    const r = new BufferReader(descriptors[pos]);
    const tag = r.readUInt8();
    const id = r.readBytes(16);
    if (tag === 2) {
      const name = UUID_TO_TYPE.get(uuidString(id));
      assert(name, "unknown base scalar id");
      return name;
    }
    assert(tag === 4 || tag === 5 || tag === 6, `unexpected descriptor tag ${tag}`);
    const name = r.readString();
    assertEquals(r.readUInt8(), 0, "schema_defined");
    assertEquals(r.readUInt16(), 0, "ancestor count");
    let type: string;
    if (tag === 6) {
      const element = typeAt(r.readUInt16());
      assertEquals([r.readUInt16(), r.readUInt32()], [1, 0xffffffff], "one unbounded dimension");
      type = `array<${element}>`;
    } else {
      const count = r.readUInt16();
      const elements: string[] = [];
      for (let i = 0; i < count; i++) {
        const label = tag === 5 ? `${r.readString()}: ` : "";
        elements.push(label + typeAt(r.readUInt16()));
      }
      type = `tuple<${elements.join(", ")}>`;
    }
    assertEquals(name, type, "descriptor type name");
    return type;
  }

  const rootPos = descriptors.length - 1;
  const root = new BufferReader(descriptors[rootPos]);
  const tag = root.readUInt8();
  if (tag === 2) {
    return { kind: "scalar", type: typeAt(rootPos) };
  }
  if (tag === 4 || tag === 5 || tag === 6) {
    return { kind: tag === 6 ? "array" : "tuple", type: typeAt(rootPos) };
  }
  assertEquals(tag, 1, "expected a CTYPE_SHAPE root");
  root.readBytes(16); // tid
  root.readUInt8(); // is_compound
  root.readUInt16(); // ephemeral_free_objects
  const count = root.readUInt16();
  const fields: { name: string; type: string; }[] = [];
  for (let i = 0; i < count; i++) {
    root.readUInt32(); // flags
    root.readUInt8(); // cardinality
    const name = root.readString();
    const pos = root.readUInt16();
    root.readUInt16(); // source_type_pos
    fields.push({ name, type: typeAt(pos) });
  }
  return { fields, kind: "object" };
}

/*** Decode one Data element against its descriptor. ***/
function decodeElement(described: Described, bytes: Uint8Array): unknown {
  if (described.kind !== "object") {
    return decodeWireValue(described.type, bytes);
  }
  const r = new BufferReader(bytes);
  const count = r.readUInt32();
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    r.readUInt32(); // reserved
    const lenU = r.readUInt32();
    const field = described.fields[i];
    out[field.name] = lenU === 0xffffffff ? null : decodeWireValue(field.type, r.readBytes(lenU));
  }
  return out;
}

/*** Encode `<str>$name` (or `<array<str>>$name`) kwargs in their typedesc order. ***/
function encodeStrArgs(args: [string, string | string[]][]): Uint8Array {
  if (args.length === 0) {
    return new Uint8Array(0);
  }
  const w = new BufferWriter();
  w.writeUInt32(args.length);
  for (const [, value] of args) {
    const bytes = encodeWireValue(Array.isArray(value) ? "array<str>" : "str", value);
    w.writeUInt32(0); // reserved
    w.writeUInt32(bytes.length);
    w.writeBytes(bytes);
  }
  return w.toBytes();
}

export class Client {
  private buffered = new Uint8Array(0);

  constructor(private conn: Deno.TcpConn) {}

  async send(msg: ClientMessage): Promise<void> {
    const bytes = encodeClientMessage(msg);
    let offset = 0;
    while (offset < bytes.length) {
      offset += await this.conn.write(bytes.subarray(offset));
    }
  }

  private async fill(n: number): Promise<void> {
    while (this.buffered.length < n) {
      const chunk = new Uint8Array(65536);
      const read = await this.conn.read(chunk);
      assert(read !== null, "connection closed");
      const next = new Uint8Array(this.buffered.length + read);
      next.set(this.buffered);
      next.set(chunk.subarray(0, read), this.buffered.length);
      this.buffered = next;
    }
  }

  async read(): Promise<ServerMessage> {
    await this.fill(5);
    const length = new DataView(this.buffered.buffer, this.buffered.byteOffset).getUint32(1, false);
    await this.fill(1 + length);
    const mtype = this.buffered[0];
    const payload = this.buffered.slice(5, 1 + length);
    this.buffered = this.buffered.slice(1 + length);
    return decodeServerMessage(mtype, payload);
  }

  async readUntilReady(): Promise<ServerMessage[]> {
    const messages: ServerMessage[] = [];
    while (true) {
      const msg = await this.read();
      messages.push(msg);
      if (msg.kind === "ReadyForCommand") {
        return messages;
      }
    }
  }

  async query(commandText: string, args: [string, string | string[]][] = []): Promise<Answer> {
    await this.send({
      allowedCapabilities: 0xffffffffffffffffn,
      annotations: [],
      commandText,
      compilationFlags: 0n,
      expectedCardinality: Cardinality.MANY,
      implicitLimit: 0n,
      inputLanguage: InputLanguage.EDGEQL,
      kind: "Parse",
      outputFormat: OutputFormat.BINARY,
      stateData: new Uint8Array(0),
      stateTypedescId: ZERO_UUID
    });
    await this.send({ kind: "Sync" });
    const parsed = await this.readUntilReady();
    const cdd = parsed.find(m => m.kind === "CommandDataDescription");
    assert(cdd && cdd.kind === "CommandDataDescription", `no description: ${parsed.map(m => m.kind).join(", ")}`);

    await this.send({
      allowedCapabilities: 0xffffffffffffffffn,
      annotations: [],
      arguments: encodeStrArgs(args),
      commandText,
      compilationFlags: 0n,
      expectedCardinality: Cardinality.MANY,
      implicitLimit: 0n,
      inputLanguage: InputLanguage.EDGEQL,
      inputTypedescId: cdd.inputTypedescId,
      kind: "Execute",
      outputFormat: OutputFormat.BINARY,
      outputTypedescId: cdd.outputTypedescId,
      stateData: new Uint8Array(0),
      stateTypedescId: ZERO_UUID
    });
    await this.send({ kind: "Sync" });
    const executed = await this.readUntilReady();
    const error = executed.find(m => m.kind === "ErrorResponse");
    assert(!error, `query failed: ${error?.kind === "ErrorResponse" ? error.message : ""}`);

    const described = describe(cdd.outputTypedesc);
    const values = executed
      .filter(m => m.kind === "Data")
      .map(m => decodeElement(described, (m as ServerMessage & { kind: "Data"; }).data[0]));
    return { cardinality: cdd.resultCardinality, described, values };
  }
}

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
import {
  Cardinality,
  InputLanguage,
  OutputFormat,
  PROTOCOL_MAJOR_VERSION,
  PROTOCOL_MINOR_VERSION
} from "../protocol/enums.ts";
import {
  decodeServerMessage,
  encodeClientMessage,
  type ClientMessage,
  type ServerMessage
} from "../protocol/messages.ts";
import { decodeWireValue, encodeWireValue } from "../protocol/collection-codecs.ts";
import { buildClientFinalMessage, buildClientFirstMessage } from "../protocol/scram.ts";
import { UUID_TO_TYPE } from "../protocol/typedesc.ts";

const ZERO_UUID = new Uint8Array(16);

/**
 * A decoded output descriptor: a base scalar, an array or tuple (`type`
 * names it, e.g. `tuple<a: std::int64, b: std::str>`), an object shape, or
 * none (`null`: the null type id and no descriptors, as for output format
 * NONE).
 */
export type Described =
  | { kind: "array" | "tuple"; type: string; }
  | { kind: "null"; }
  | { kind: "scalar"; type: string; }
  | { fields: DescribedField[]; kind: "object"; };

/**
 * An object's field: its name (a link property's `@name`, as the clients
 * name it), its type name, and the flags Gel sets on it when set:
 * `implicit` (an injected `id`, `__tid__` or `__tname__`), `link` and
 * `linkProperty`.
 */
export interface DescribedField {
  implicit?: true;
  link?: true;
  linkProperty?: true;
  name: string;
  type: string;
}

export interface Answer {
  cardinality: number;
  described: Described;
  values: unknown[];
}

/*** The output format, expected cardinality and compilation flags a query is sent with (binary, MANY and none by default). ***/
export interface QueryOptions {
  compilationFlags?: bigint;
  expectedCardinality?: number;
  outputFormat?: OutputFormat;
}

function uuidString(bytes: Uint8Array): string {
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A decoded descriptor: a base scalar, an array or tuple (named by `type`),
 * a set of an element type, or an object shape (`free` for a free object).
 */
type DescribedNode =
  | { kind: "array" | "scalar" | "tuple"; type: string; }
  | { element: DescribedNode; kind: "set"; }
  | { fields: DescribedNodeField[]; free: boolean; kind: "object"; };

interface DescribedNodeField {
  flags: number;
  name: string;
  node: DescribedNode;
}

/*** Gel's shape element flags (edb/server/compiler/sertypes.py `ShapePointerFlags`). ***/
const IS_IMPLICIT = 1 << 0;
const IS_LINKPROP = 1 << 1;
const IS_LINK = 1 << 2;

/*** A field's name as the clients name it: a link property's `@name`. ***/
function fieldName(field: DescribedNodeField): string {
  return field.flags & IS_LINKPROP ? `@${field.name}` : field.name;
}

/**
 * A node's type name: `std::str`, `set<std::str>`, `{title: std::str}` (a
 * free object `free{…}`), a flagged field named `implicit id`, `link best`
 * or `@rank`.
 */
function typeName(node: DescribedNode): string {
  switch (node.kind) {
    case "object": {
      const label = (f: DescribedNodeField): string => `${f.flags & IS_IMPLICIT ? "implicit " : ""}${f.flags & IS_LINK ? "link " : ""}${fieldName(f)}`;
      return `${node.free ? "free" : ""}{${node.fields.map(f => `${label(f)}: ${typeName(f.node)}`).join(", ")}}`;
    }
    case "set":
      return `set<${typeName(node.element)}>`;
    default:
      return node.type;
  }
}

/*** Decode a v2 typedesc block (descriptors referenced by position) to its root descriptor. ***/
function describeRoot(block: Uint8Array): DescribedNode {
  const descriptors: Uint8Array[] = [];
  const blockReader = new BufferReader(block);
  while (blockReader.remaining > 0) {
    descriptors.push(blockReader.readLenPrefixedBytes());
  }

  /*** The descriptor at `pos`: a set (0), shape (1), base scalar (2), tuple (4), named tuple (5) or array (6). ***/
  function nodeAt(pos: number): DescribedNode {
    const r = new BufferReader(descriptors[pos]);
    const tag = r.readUInt8();
    const id = r.readBytes(16);
    if (tag === 0) {
      return { element: nodeAt(r.readUInt16()), kind: "set" };
    }
    if (tag === 1) {
      const free = r.readUInt8() === 1; // ephemeral_free_shape
      r.readUInt16(); // object type pos
      const count = r.readUInt16();
      const fields: DescribedNodeField[] = [];
      for (let i = 0; i < count; i++) {
        const flags = r.readUInt32();
        r.readUInt8(); // cardinality
        const name = r.readString();
        fields.push({ flags, name, node: nodeAt(r.readUInt16()) });
        r.readUInt16(); // source_type_pos
      }
      return { fields, free, kind: "object" };
    }
    if (tag === 2) {
      const name = UUID_TO_TYPE.get(uuidString(id));
      assert(name, "unknown base scalar id");
      return { kind: "scalar", type: name };
    }
    assert(tag === 4 || tag === 5 || tag === 6, `unexpected descriptor tag ${tag}`);
    const name = r.readString();
    assertEquals(r.readUInt8(), 0, "schema_defined");
    assertEquals(r.readUInt16(), 0, "ancestor count");
    let type: string;
    if (tag === 6) {
      const element = typeName(nodeAt(r.readUInt16()));
      assertEquals([r.readUInt16(), r.readUInt32()], [1, 0xffffffff], "one unbounded dimension");
      type = `array<${element}>`;
    } else {
      const count = r.readUInt16();
      const elements: string[] = [];
      for (let i = 0; i < count; i++) {
        const label = tag === 5 ? `${r.readString()}: ` : "";
        elements.push(label + typeName(nodeAt(r.readUInt16())));
      }
      type = `tuple<${elements.join(", ")}>`;
    }
    assertEquals(name, type, "descriptor type name");
    return { kind: tag === 6 ? "array" : "tuple", type };
  }

  return nodeAt(descriptors.length - 1);
}

/*** The root descriptor as a `Described`: an object's fields named by their type names, with their flags. ***/
function describe(root: DescribedNode): Described {
  if (root.kind === "object") {
    const fields = root.fields.map(f => {
      const field: DescribedField = { name: fieldName(f), type: typeName(f.node) };
      if (f.flags & IS_IMPLICIT) {
        field.implicit = true;
      }
      if (f.flags & IS_LINK) {
        field.link = true;
      }
      if (f.flags & IS_LINKPROP) {
        field.linkProperty = true;
      }
      return field;
    });
    return { fields, kind: "object" };
  }
  assert(root.kind !== "set", "a set is never the root descriptor");
  return root;
}

/**
 * Decode one value against its descriptor: a set in Gel's array format (an
 * array element in a one-element record envelope), an object as its
 * elements, anything else by the collection codecs.
 */
function decodeNode(node: DescribedNode, bytes: Uint8Array): unknown {
  if (node.kind !== "object" && node.kind !== "set") {
    return decodeWireValue(node.type, bytes);
  }
  const r = new BufferReader(bytes);
  const element = (inner: DescribedNode): unknown => {
    const lenU = r.readUInt32();
    return lenU === 0xffffffff ? null : decodeNode(inner, r.readBytes(lenU));
  };
  if (node.kind === "set") {
    const ndims = r.readUInt32();
    r.readUInt32(); // flags
    r.readUInt32(); // reserved
    if (ndims === 0) {
      return [];
    }
    const length = r.readUInt32();
    r.readUInt32(); // lower bound
    return Array.from({ length }, () => {
      if (node.element.kind === "array") {
        r.readUInt32(); // envelope length
        assertEquals(r.readUInt32(), 1, "one-element envelope");
        r.readUInt32(); // reserved
      }
      return element(node.element);
    });
  }
  assertEquals(r.readUInt32(), node.fields.length, "object element count");
  const out: Record<string, unknown> = {};
  for (const field of node.fields) {
    r.readUInt32(); // reserved
    out[fieldName(field)] = element(field.node);
  }
  assertEquals(r.remaining, 0, "no trailing bytes after the object");
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

  /**
   * Handshake, then authenticate with SCRAM-SHA-256 when the server has a
   * password (`DISC_BINARY_PASSWORD`), up to the first ReadyForCommand.
   * Throws on an authentication error.
   */
  async connect(password?: string): Promise<void> {
    await this.send({
      extensions: [],
      kind: "ClientHandshake",
      majorVersion: PROTOCOL_MAJOR_VERSION,
      minorVersion: PROTOCOL_MINOR_VERSION,
      params: [{ name: "user", value: "admin" }, { name: "database", value: "main" }]
    });
    if (password === undefined) {
      await this.readUntilReady();
      return;
    }

    assertEquals((await this.read()).kind, "ServerHandshake");
    assertEquals((await this.read()).kind, "AuthenticationRequiredSASL");
    const clientNonce = crypto.randomUUID();
    const first = buildClientFirstMessage("admin", clientNonce);
    await this.send({ kind: "AuthenticationSASLInitialResponse", method: "SCRAM-SHA-256", saslData: first.message });
    const cont = await this.read();
    assert(cont.kind === "AuthenticationSASLContinue", `expected SASL continue, got ${cont.kind}`);
    const serverFirst = new TextDecoder().decode(cont.saslData);
    const final = await buildClientFinalMessage(password, clientNonce, first.clientFirstMessageBare, serverFirst);
    await this.send({ kind: "AuthenticationSASLResponse", saslData: final });
    const messages = await this.readUntilReady();
    const error = messages.find(m => m.kind === "ErrorResponse");
    assert(!error, `authentication failed: ${error?.kind === "ErrorResponse" ? error.message : ""}`);
  }

  /*** Parse + Execute a command; the first ErrorResponse either answers, or undefined when it ran. ***/
  async run(commandText: string, options: QueryOptions = {}): Promise<(ServerMessage & { kind: "ErrorResponse"; }) | undefined> {
    const parsed = await this.parse(commandText, options);
    const parseError = parsed.find(m => m.kind === "ErrorResponse");
    if (parseError?.kind === "ErrorResponse") {
      return parseError;
    }
    const cdd = parsed.find(m => m.kind === "CommandDataDescription");
    assert(cdd && cdd.kind === "CommandDataDescription", `no description: ${parsed.map(m => m.kind).join(", ")}`);
    const executed = await this.execute(commandText, cdd, [], options);
    const error = executed.find(m => m.kind === "ErrorResponse");
    return error?.kind === "ErrorResponse" ? error : undefined;
  }

  /*** Parse a command: its input type id and input descriptor bytes. ***/
  async describeInput(commandText: string, options: QueryOptions = {}): Promise<{ id: string; typedesc: Uint8Array; }> {
    const parsed = await this.parse(commandText, options);
    const cdd = parsed.find(m => m.kind === "CommandDataDescription");
    assert(cdd && cdd.kind === "CommandDataDescription", `no description: ${parsed.map(m => m.kind).join(", ")}`);
    return { id: uuidString(cdd.inputTypedescId), typedesc: cdd.inputTypedesc };
  }

  private async parse(commandText: string, options: QueryOptions = {}): Promise<ServerMessage[]> {
    await this.send({
      allowedCapabilities: 0xffffffffffffffffn,
      annotations: [],
      commandText,
      compilationFlags: options.compilationFlags ?? 0n,
      expectedCardinality: options.expectedCardinality ?? Cardinality.MANY,
      implicitLimit: 0n,
      inputLanguage: InputLanguage.EDGEQL,
      kind: "Parse",
      outputFormat: options.outputFormat ?? OutputFormat.BINARY,
      stateData: new Uint8Array(0),
      stateTypedescId: ZERO_UUID
    });
    await this.send({ kind: "Sync" });
    return await this.readUntilReady();
  }

  private async execute(
    commandText: string,
    cdd: ServerMessage & { kind: "CommandDataDescription"; },
    args: [string, string | string[]][],
    options: QueryOptions = {}
  ): Promise<ServerMessage[]> {
    await this.send({
      allowedCapabilities: 0xffffffffffffffffn,
      annotations: [],
      arguments: encodeStrArgs(args),
      commandText,
      compilationFlags: options.compilationFlags ?? 0n,
      expectedCardinality: options.expectedCardinality ?? Cardinality.MANY,
      implicitLimit: 0n,
      inputLanguage: InputLanguage.EDGEQL,
      inputTypedescId: cdd.inputTypedescId,
      kind: "Execute",
      outputFormat: options.outputFormat ?? OutputFormat.BINARY,
      outputTypedescId: cdd.outputTypedescId,
      stateData: new Uint8Array(0),
      stateTypedescId: ZERO_UUID
    });
    await this.send({ kind: "Sync" });
    return await this.readUntilReady();
  }

  async query(commandText: string, args: [string, string | string[]][] = [], options: QueryOptions = {}): Promise<Answer> {
    const parsed = await this.parse(commandText, options);
    const cdd = parsed.find(m => m.kind === "CommandDataDescription");
    assert(cdd && cdd.kind === "CommandDataDescription", `no description: ${parsed.map(m => m.kind).join(", ")}`);

    const executed = await this.execute(commandText, cdd, args, options);
    const error = executed.find(m => m.kind === "ErrorResponse");
    assert(!error, `query failed: ${error?.kind === "ErrorResponse" ? error.message : ""}`);

    if (cdd.outputTypedesc.length === 0) {
      assertEquals(cdd.outputTypedescId, ZERO_UUID, "no output descriptor is the null type id");
      assert(!executed.some(m => m.kind === "Data"), "no data without an output descriptor");
      return { cardinality: cdd.resultCardinality, described: { kind: "null" }, values: [] };
    }
    const root = describeRoot(cdd.outputTypedesc);
    const values = executed
      .filter(m => m.kind === "Data")
      .map(m => decodeNode(root, (m as ServerMessage & { kind: "Data"; }).data[0]));
    return { cardinality: cdd.resultCardinality, described: describe(root), values };
  }
}

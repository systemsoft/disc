/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over the Gel binary protocol: `select {…}` is described as
 * a set of its elements.
 *
 * The output descriptor for a selected set literal fell through to the
 * `Object { id }` default, so a Gel client decoded `select {1, 2, 3}` as three
 * objects with a null `id`. The descriptor now carries the element type
 * (a base scalar, or the element query's object shape) and the result
 * cardinality follows Gel's union rules.
 *
 * Every case runs twice with the same query text, so the second run is a
 * prepared-statement cache hit.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { BinaryProtocolServer } from "../protocol/binary-server.ts";
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
import { decodeScalar, encodeScalar } from "../protocol/scalar-codecs.ts";
import { UUID_TO_TYPE } from "../protocol/typedesc.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";

const SDL = `module default {
  type SetLiteralNote {
    required label -> str;
  }
}`;

const ZERO_UUID = new Uint8Array(16);

/** A decoded output descriptor: a base scalar, or an object shape. */
type Described =
  | { kind: "scalar"; type: string; }
  | { fields: { name: string; type: string; }[]; kind: "object"; };

interface Answer {
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

  function scalarAt(pos: number): string {
    const r = new BufferReader(descriptors[pos]);
    assertEquals(r.readUInt8(), 2, "expected a CTYPE_BASE_SCALAR");
    const name = UUID_TO_TYPE.get(uuidString(r.readBytes(16)));
    assert(name, "unknown base scalar id");
    return name;
  }

  const rootPos = descriptors.length - 1;
  const root = new BufferReader(descriptors[rootPos]);
  const tag = root.readUInt8();
  if (tag === 2) {
    return { kind: "scalar", type: scalarAt(rootPos) };
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
    fields.push({ name, type: scalarAt(pos) });
  }
  return { fields, kind: "object" };
}

/*** Decode one Data element against its descriptor. ***/
function decodeElement(described: Described, bytes: Uint8Array): unknown {
  if (described.kind === "scalar") {
    return decodeScalar(described.type, bytes);
  }
  const r = new BufferReader(bytes);
  const count = r.readUInt32();
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    r.readUInt32(); // reserved
    const lenU = r.readUInt32();
    const field = described.fields[i];
    out[field.name] = lenU === 0xffffffff ? null : decodeScalar(field.type, r.readBytes(lenU));
  }
  return out;
}

/*** Encode `<str>$name` kwargs in their typedesc order. ***/
function encodeStrArgs(args: [string, string][]): Uint8Array {
  if (args.length === 0) {
    return new Uint8Array(0);
  }
  const w = new BufferWriter();
  w.writeUInt32(args.length);
  for (const [, value] of args) {
    const bytes = encodeScalar("str", value);
    w.writeUInt32(0); // reserved
    w.writeUInt32(bytes.length);
    w.writeBytes(bytes);
  }
  return w.toBytes();
}

class Client {
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

  async query(commandText: string, args: [string, string][] = []): Promise<Answer> {
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

Deno.test({
  name: "PG set literal over the binary protocol: select {…} is described as a set of its elements",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 4, minConnections: 1 });
    await pool.initialize();
    await resetTestDatabase(pool);

    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);
    await pool.query("INSERT INTO set_literal_note (id, label) VALUES (gen_random_uuid(), 'a'), (gen_random_uuid(), 'b')");

    const handler = new EdgeQLProtocolHandler({ connectionPool: pool, schema });
    const server = new BinaryProtocolServer({
      executor: handler.executeBinaryQuery.bind(handler),
      hostname: "127.0.0.1",
      port: 0,
      schema
    });
    server.start();
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: server.port });
    const client = new Client(conn);

    try {
      await client.send({
        extensions: [],
        kind: "ClientHandshake",
        majorVersion: PROTOCOL_MAJOR_VERSION,
        minorVersion: PROTOCOL_MINOR_VERSION,
        params: [{ name: "user", value: "test" }, { name: "database", value: "testdb" }]
      });
      await client.readUntilReady();

      const int64: Described = { kind: "scalar", type: "std::int64" };
      const str: Described = { kind: "scalar", type: "std::str" };

      for (const round of ["cache miss", "cache hit"]) {
        assertEquals(
          await client.query("select {1, 2, 3}"),
          { cardinality: Cardinality.AT_LEAST_ONE, described: int64, values: [1n, 2n, 3n] },
          round
        );
        assertEquals(
          await client.query("select {<str>$a, <str>$b}", [["a", "x"], ["b", "y"]]),
          { cardinality: Cardinality.AT_LEAST_ONE, described: str, values: ["x", "y"] },
          round
        );
        assertEquals(
          await client.query("with xs := {1, 2} select xs"),
          { cardinality: Cardinality.AT_LEAST_ONE, described: int64, values: [1n, 2n] },
          round
        );
        assertEquals(
          await client.query("select {1, 2.5}"),
          { cardinality: Cardinality.AT_LEAST_ONE, described: { kind: "scalar", type: "std::float64" }, values: [1, 2.5] },
          round
        );
        assertEquals(
          await client.query("select {7}"),
          { cardinality: Cardinality.ONE, described: int64, values: [7n] },
          round
        );

        const empty = await client.query("select {}");
        assertEquals(empty.described.kind, "scalar", round);
        assertEquals(empty.cardinality, Cardinality.AT_MOST_ONE, round);
        assertEquals(empty.values, [], round);

        assertEquals(
          await client.query(
            "select {(select SetLiteralNote { label } filter .label = 'b'), (select SetLiteralNote { label } order by .label)}"
          ),
          {
            cardinality: Cardinality.MANY,
            described: { fields: [{ name: "label", type: "std::str" }], kind: "object" },
            values: [{ label: "b" }, { label: "a" }, { label: "b" }]
          },
          round
        );
      }
    } finally {
      conn.close();
      await server.stop();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

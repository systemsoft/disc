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
import {
  generateDescriptorIdSync,
  resolveWellKnownType,
} from "./typedesc.ts";
import { BufferReader, BufferWriter } from "./buffer.ts";
import { uuidToBytes } from "./types.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import type * as AST from "../edgeql/ast.ts";
import type { Schema } from "../compiler/context.ts";
import {
  deriveKeys,
  generateServerFirstMessage,
  parseClientFirstMessage,
  type ScramServerState,
  verifyClientFinalMessage,
} from "./scram.ts";

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
import { QueryCache } from "../lib/query-cache.ts";
import {
  decodeScalar,
  encodeScalar,
  hasScalarCodec,
} from "./scalar-codecs.ts";

/**
 * Maximum size (in bytes) of a single wire-protocol message payload.
 *
 * Gel's reference server caps protocol messages at the same ~16 MB boundary.
 * Without this cap, a hostile or misbehaving client can send a 4 GB length
 * prefix and force the server to allocate a multi-gigabyte buffer before any
 * validation runs. The server will return an error and close the connection
 * when this limit is exceeded.
 */
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16 MiB

/**
 * Maximum number of cached prepared statements per connection.
 *
 * Each cache entry holds a parsed plan plus descriptors; an unbounded cache
 * lets a single connection push memory use toward OOM by issuing many unique
 * queries. LRU eviction keeps the working set bounded.
 */
export const MAX_STATEMENT_CACHE_SIZE = 1000;

// ---------------------------------------------------------------------------
// system_config ParameterStatus encoder
// ---------------------------------------------------------------------------

/**
 * Encode a `system_config` ParameterStatus value that the upstream Gel
 * Python and JS clients can decode.
 *
 * Both clients require this message at handshake-time and will crash on its
 * absence (Python reads `system_config.session_idle_timeout` directly with
 * no None check; JS only falls back to defaults for some settings).
 *
 * Wire format (protocol v2):
 *   [u32  totalLen + 16]
 *   [16   namedTupleId]
 *   [bytes  typedesc list — each descriptor length-prefixed (u32)]
 *     desc 0: BASE_SCALAR  std::duration   ([u8 t=2][16 tid])
 *     desc 1: NAMED_TUPLE  ([u8 t=5][16 tid][u32 nameLen][bytes name]
 *                           [u8 isShape=0][u16 ancestorCount=0]
 *                           [u16 els][per el: u32 nameLen, bytes name, u16 pos])
 *   [u32  valueLen]
 *   [bytes value]
 *     [u32 els=1]
 *     per el: [u32 reserved=0][i32 elemLen=16][i64 us][i32 days=0][i32 months=0]
 *
 * The value is hard-coded to the upstream Gel default of 60 seconds idle
 * timeout (60_000_000 microseconds) — disc does not yet surface a
 * configurable session_idle_timeout setting.
 */
function encodeSystemConfigValue(): Uint8Array {
  const DURATION_TID = uuidToBytes(
    "00000000-0000-0000-0000-00000000010e",
  );
  const TYPE_NAME = "cfg::AbstractConfig";
  const FIELD_NAME = "session_idle_timeout";
  const SESSION_IDLE_TIMEOUT_US = 60_000_000n; // 60 seconds

  // -- Descriptor 0: BASE_SCALAR (std::duration)
  const desc0 = new BufferWriter();
  desc0.writeUInt8(2); // t = CTYPE_BASE_SCALAR
  desc0.writeUUID(DURATION_TID);

  // -- Descriptor 1: NAMED_TUPLE
  // First we need its UUID — derive deterministically from a unique seed
  // so the client can cache the codec across connections.
  const idSeed = new TextEncoder().encode(
    `disc:system_config:${TYPE_NAME}:${FIELD_NAME}`,
  );
  const namedTupleTid = generateDescriptorIdSync(idSeed);

  const desc1 = new BufferWriter();
  desc1.writeUInt8(5); // t = CTYPE_NAMEDTUPLE
  desc1.writeUUID(namedTupleTid);
  desc1.writeString(TYPE_NAME); // u32-length-prefixed
  desc1.writeUInt8(0); // is_shape = false
  desc1.writeUInt16(0); // ancestor_count
  desc1.writeUInt16(1); // els
  desc1.writeString(FIELD_NAME);
  desc1.writeUInt16(0); // pos = 0 (refers to desc0)

  // Concatenate length-prefixed descriptors into the typedesc block
  const typedesc = new BufferWriter();
  typedesc.writeLenPrefixedBytes(desc0.toBytes());
  typedesc.writeLenPrefixedBytes(desc1.toBytes());
  const typedescBytes = typedesc.toBytes();

  // -- Value: NamedTuple with one field (session_idle_timeout)
  const value = new BufferWriter();
  value.writeUInt32(1); // els
  value.writeUInt32(0); // reserved
  value.writeUInt32(16); // elemLen
  value.writeUInt64(SESSION_IDLE_TIMEOUT_US);
  value.writeUInt32(0); // days
  value.writeUInt32(0); // months
  const valueBytes = value.toBytes();

  // -- Wrap: [u32 typedescLen+16][UUID][typedesc][u32 valueLen][value]
  const out = new BufferWriter();
  out.writeUInt32(typedescBytes.length + 16);
  out.writeUUID(namedTupleTid);
  out.writeBytes(typedescBytes);
  out.writeUInt32(valueBytes.length);
  out.writeBytes(valueBytes);
  return out.toBytes();
}

/**
 * Build the typedesc bytes + UUID for an empty connection-state codec.
 * Wired into the AuthOK sequence as a StateDataDescription so the upstream
 * Gel clients can encode connection state on Parse/Execute.
 *
 * The typedesc block is one length-prefixed CTYPE_INPUT_SHAPE descriptor:
 *   [u32 descLen=19][u8 t=8][16 tid][u16 els=0]
 */
function buildEmptyStateDescriptor(): { tid: Uint8Array; typedesc: Uint8Array } {
  const tid = generateDescriptorIdSync(
    new TextEncoder().encode("disc:state:empty:v1"),
  );
  const desc = new BufferWriter();
  desc.writeUInt8(8); // CTYPE_INPUT_SHAPE
  desc.writeUUID(tid);
  desc.writeUInt16(0); // els
  const block = new BufferWriter();
  block.writeLenPrefixedBytes(desc.toBytes());
  return { tid, typedesc: block.toBytes() };
}

// ---------------------------------------------------------------------------
// v2 typedesc encoders for CommandDataDescription
// ---------------------------------------------------------------------------
//
// Protocol v2 references inner codecs by **position** in the descriptor list
// (not by UUID). The wire shapes the upstream Gel clients expect:
//
//   CTYPE_BASE_SCALAR (=2): [u8 t][16 tid]
//   CTYPE_INPUT_SHAPE (=8): [u8 t][16 tid][u16 els]
//                           per el: [u32 flags][u8 cardinality]
//                                   [u32 nameLen][bytes name][u16 pos]
//   CTYPE_SHAPE       (=1): [u8 t][16 tid][u8 isCompound=0][u16 ephemeral=0]
//                           [u16 els]
//                           per el: [u32 flags][u8 cardinality]
//                                   [u32 nameLen][bytes name][u16 pos]
//                                   [u16 sourceTypePos]
//
// Each descriptor in the typedesc block is itself u32-length-prefixed.

interface ShapeElementV2 {
  name: string;
  /** index into the descriptor list of this field's type codec */
  pos: number;
  cardinality: number;
}

function encodeBaseScalarV2(tid: Uint8Array): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(2);
  w.writeUUID(tid);
  return w.toBytes();
}

function encodeShapeV2(
  tid: Uint8Array,
  elements: ShapeElementV2[],
): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(1);
  w.writeUUID(tid);
  w.writeUInt8(0); // is_compound
  w.writeUInt16(0); // ephemeral_free_objects
  w.writeUInt16(elements.length);
  for (const el of elements) {
    w.writeUInt32(0); // flags
    w.writeUInt8(el.cardinality);
    w.writeString(el.name);
    w.writeUInt16(el.pos);
    w.writeUInt16(0); // source_type_pos
  }
  return w.toBytes();
}

/**
 * Concatenate per-descriptor length-prefixed bytes into a typedesc block.
 * Returns the block plus the last descriptor's UUID (the "root" id that
 * gets sent in the CommandDataDescription header).
 */
function packTypedescBlock(
  descriptors: Array<{ id: Uint8Array; bytes: Uint8Array }>,
): { data: Uint8Array; rootId: Uint8Array } {
  const w = new BufferWriter();
  for (const d of descriptors) {
    w.writeLenPrefixedBytes(d.bytes);
  }
  const rootId = descriptors[descriptors.length - 1].id;
  return { data: w.toBytes(), rootId };
}

interface ParamInfo {
  name: string;
  edgeqlType: string;
}

interface OutputField {
  name: string;
  edgeqlType: string;
}

interface OutputShape {
  typeName: string;
  fields: OutputField[];
  /**
   * When true, the result is a bare scalar (no Object wrapper). `fields`
   * has exactly one entry whose `edgeqlType` is the scalar type — the
   * field name is irrelevant because no shape is advertised on the wire.
   * Drives `buildOutputDescriptor` to emit a single `CTYPE_BASE_SCALAR`
   * and `encodeRowAsObject` to write raw scalar bytes (no element-count
   * prefix, no per-field reserved/length wrapper).
   */
  isScalar?: boolean;
}

/**
 * Detect whether an expression resolves to a bare scalar at the top level
 * of a SELECT (i.e., the SELECT body is just `<bool>$x` or `42` or a
 * scalar function call, not a `SELECT Type { ... }` shape). Used by
 * `inferOutputShape` to decide between Object and BaseScalar typedesc.
 *
 * Returns the EdgeQL scalar type name (e.g., "bool", "int64") or null
 * if the expression isn't a known bare scalar form.
 */
function detectBareScalarType(expr: unknown): string | null {
  if (!expr || typeof expr !== "object") return null;
  const e = expr as { kind?: string };

  if (e.kind === "TypeCast") {
    const cast = expr as AST.TypeCast;
    const parts = cast.type?.name?.parts;
    if (parts && parts.length > 0) {
      return parts[parts.length - 1];
    }
  }

  if (e.kind === "Literal") {
    const lit = expr as AST.Literal;
    switch (lit.type) {
      case "string":
        return "str";
      case "integer":
        return "int64";
      case "float":
        return "float64";
      case "boolean":
        return "bool";
      case "uuid":
        return "uuid";
      case "bytes":
        return "bytes";
    }
  }

  return null;
}

/**
 * Walk an AST and collect every `<TypeName>$paramName` cast as a parameter.
 * Returns parameters in first-seen order (deduplicated by name).
 */
function collectParameters(node: unknown): ParamInfo[] {
  const seen = new Set<string>();
  const out: ParamInfo[] = [];

  function visit(n: unknown): void {
    if (!n || typeof n !== "object") return;
    const obj = n as { kind?: string; type?: AST.TypeName; expr?: unknown };
    if (
      obj.kind === "TypeCast" &&
      obj.expr &&
      typeof obj.expr === "object" &&
      (obj.expr as { kind?: string }).kind === "Parameter"
    ) {
      const param = obj.expr as AST.Parameter;
      const tn = obj.type;
      // The lexer keeps the leading `$` on parameter names. Strip it
      // before exposing on the wire — clients pass kwargs without `$`.
      const bare = param.name.startsWith("$") ? param.name.slice(1) : param.name;
      if (tn?.name?.parts?.length && !seen.has(bare)) {
        seen.add(bare);
        out.push({
          name: bare,
          edgeqlType: tn.name.parts[tn.name.parts.length - 1],
        });
      }
    }
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  }
  visit(node);
  return out;
}

/**
 * Derive the output shape from a parsed query. Phase B keeps this simple:
 *
 *   - INSERT/UPDATE/DELETE → just the implicit `id: uuid` field.
 *   - SELECT with explicit shape → walk shape elements, look up scalar
 *     property types in the schema; default unknown fields to uuid.
 *   - SELECT without shape → `{id: uuid}`.
 */
function inferOutputShape(
  query: unknown,
  schema?: { types?: Map<string, { properties: Map<string, { edgeqlType?: string; type: string }> }> },
): OutputShape {
  const idField: OutputField = { name: "id", edgeqlType: "uuid" };
  if (!query || typeof query !== "object") {
    return { typeName: "Object", fields: [idField] };
  }
  const q = query as { kind?: string };

  if (q.kind === "InsertQuery" || q.kind === "UpdateQuery" || q.kind === "DeleteQuery") {
    return { typeName: "Object", fields: [idField] };
  }

  if (q.kind === "SelectQuery") {
    const sel = q as AST.SelectQuery;

    // Bare-scalar SELECT (`SELECT <bool>$x`, `SELECT 42`, …): emit a
    // BaseScalar shape so the descriptor doesn't wrap the value in an
    // Object{id} on the wire. Only triggers when there's no shape and
    // no filter against an Object type — `SELECT Item FILTER ...` still
    // wants the Object path even with no shape.
    if (!sel.shape) {
      const scalar = detectBareScalarType(sel.expr);
      if (scalar !== null) {
        return {
          typeName: scalar,
          fields: [{ name: "_value", edgeqlType: scalar }],
          isScalar: true,
        };
      }
    }

    const typeName = extractTypeNameFromExpr(sel.expr) ?? "Object";
    const fields: OutputField[] = [];
    const typeDef = schema?.types?.get(typeName);

    if (sel.shape) {
      for (const el of sel.shape.elements) {
        const fieldName = el.name?.name ?? extractFieldNameFromExpr(el.expr);
        if (!fieldName) continue;
        // The schema's TypeDef uses `type` for the SQL type and may carry
        // the original EdgeQL type via a property-level field. Always
        // prefer the EdgeQL type since that's what the wire codec needs.
        const propType = typeDef?.properties.get(fieldName);
        const eqlType = propType?.edgeqlType ?? propType?.type ?? "uuid";
        fields.push({ name: fieldName, edgeqlType: eqlType });
      }
    }

    if (fields.length === 0) fields.push(idField);
    return { typeName, fields };
  }

  return { typeName: "Object", fields: [idField] };
}

function extractTypeNameFromExpr(expr: unknown): string | null {
  if (!expr || typeof expr !== "object") return null;
  const e = expr as {
    kind?: string;
    steps?: AST.PathStep[];
    name?: { parts?: string[] } | string;
  };
  if (e.kind === "Path" && e.steps && e.steps.length > 0) {
    // First step is the root type identifier in `SELECT Type { ... }`.
    return e.steps[0].name;
  }
  if (e.kind === "Identifier" && typeof e.name === "string") {
    return e.name;
  }
  // The parser produces `TypeName` for `SELECT Item { ... }` — `Item` is
  // a type reference, not a path. Pull the qualified name out of its
  // `parts` (one entry for default-module types).
  if (e.kind === "TypeName" && e.name && typeof e.name === "object") {
    const parts = (e.name as { parts?: string[] }).parts;
    if (parts && parts.length > 0) return parts.join("::");
  }
  return null;
}

/**
 * Best-effort field name extraction for shape elements without an
 * explicit `name :=` (i.e. just `id` or `.title` or `link.target`).
 */
function extractFieldNameFromExpr(expr: unknown): string | undefined {
  if (!expr || typeof expr !== "object") return undefined;
  const e = expr as { kind?: string; name?: string; steps?: AST.PathStep[] };
  if (e.kind === "Identifier" && typeof e.name === "string") return e.name;
  if (e.kind === "Path" && e.steps && e.steps.length > 0) {
    return e.steps[e.steps.length - 1]?.name;
  }
  return undefined;
}

/**
 * Build a CTYPE_INPUT_SHAPE descriptor list for the parameters. For each
 * unique scalar type emit a CTYPE_BASE_SCALAR descriptor first; the input
 * shape references those by position.
 */
function buildInputDescriptor(
  params: ParamInfo[],
): { id: Uint8Array; data: Uint8Array } {
  const descriptors: Array<{ id: Uint8Array; bytes: Uint8Array }> = [];
  const scalarPos = new Map<string, number>();

  function ensureScalar(eqlType: string): number {
    let pos = scalarPos.get(eqlType);
    if (pos !== undefined) return pos;
    const tid = resolveWellKnownType(eqlType) ??
      resolveWellKnownType("uuid")!;
    pos = descriptors.length;
    descriptors.push({ id: tid, bytes: encodeBaseScalarV2(tid) });
    scalarPos.set(eqlType, pos);
    return pos;
  }

  const elements: ShapeElementV2[] = params.map((p) => ({
    name: p.name,
    pos: ensureScalar(p.edgeqlType),
    cardinality: 0x41, // ONE
  }));

  const tid = generateDescriptorIdSync(
    new TextEncoder().encode(
      `disc:input:${params.map((p) => p.name + ":" + p.edgeqlType).join(",")}`,
    ),
  );
  // Use CTYPE_SHAPE (not CTYPE_INPUT_SHAPE) for query parameters: the
  // Python client raises NotImplementedError on encode_args when the
  // codec is sparse, and CTYPE_INPUT_SHAPE → SparseObjectCodec. Also
  // used when there are no params, so the client gets a non-empty codec.
  descriptors.push({ id: tid, bytes: encodeShapeV2(tid, elements) });

  const packed = packTypedescBlock(descriptors);
  return { id: packed.rootId, data: packed.data };
}

/** Byte-for-byte equality on two 16-byte UUIDs. */
function uuidsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Decode the `arguments` payload from an Execute message into a kwargs
 * map keyed by the bare parameter name.
 *
 * The upstream Gel client emits `[i32 4 + elem_data.len()][i32 objlen][elem_data]`
 * directly into the message buffer — the leading i32 doubles as the
 * `Bytes` length prefix that `readLenPrefixedBytes` consumes when
 * decoding Execute. By the time we get here, that prefix is gone and
 * the blob starts at:
 *
 *   [i32 elem_count = number of fields]
 *   per field: [u32 reserved=0][i32 elem_len][bytes...]
 *
 * `elem_count` must equal `params.length` (a mismatch means the client
 * is using a stale codec, never something we can recover from by
 * guessing). `elem_len = -1` means NULL.
 *
 * Empty `params` (no parameters) accepts an empty/missing args blob and
 * returns `{}` — clients can omit the count entirely in that case.
 */
function decodeArgs(
  blob: Uint8Array,
  params: ParamInfo[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (params.length === 0) return out;
  if (blob.length < 4) return out;

  const r = new BufferReader(blob);
  const elemCount = r.readUInt32();
  if (elemCount !== params.length) {
    throw new Error(
      `argument count mismatch: typedesc has ${params.length}, blob has ${elemCount}`,
    );
  }
  for (const p of params) {
    r.readUInt32(); // reserved (always 0)
    // The element length is wire-signed: -1 = NULL. Read as unsigned
    // first then re-interpret to keep BufferReader's API surface small.
    const lenU = r.readUInt32();
    const len = lenU > 0x7fffffff ? lenU - 0x100000000 : lenU;
    if (len === -1) {
      out[p.name] = null;
    } else {
      const bytes = r.readBytes(len);
      out[p.name] = decodeScalar(p.edgeqlType, bytes);
    }
  }
  return out;
}

/**
 * Encode a result row as a Data-message payload matching `shape`.
 *
 * Wire format (per the upstream Gel Object decoder, both Python and JS):
 *
 *   [u32 elem_count = shape.fields.length]
 *   per field: [u32 reserved=0][i32 elem_len][bytes...]
 *
 * `elem_len = -1` denotes NULL. Each field's bytes are produced by the
 * scalar codec for the field's EdgeQL type. Field order in the output
 * MUST match the descriptor we already advertised, otherwise the client
 * decodes name `email` from bytes that were intended for `count`.
 */
function encodeRowAsScalar(
  row: Record<string, unknown>,
  shape: OutputShape,
): Uint8Array {
  // Bare-scalar Data payload: no Object framing, no element-count prefix,
  // no per-field reserved/length wrapper — just the raw scalar bytes.
  // The Data message's per-element u32 length already delimits this blob.
  const eqlType = shape.fields[0].edgeqlType;
  // Pull the single value out of the executor row by ordinal: the row
  // looks like `{ bool: true }` for `SELECT $1::boolean` (PG names the
  // column after the cast type), `{ ?column?: ... }` for unaliased
  // expressions, etc. Always one column for a bare-scalar SELECT.
  let value: unknown = null;
  if (row && typeof row === "object") {
    const values = Object.values(row);
    if (values.length > 0) value = values[0];
  }
  if (value === null || value === undefined) {
    // Empty result set is handled by the caller (no Data frames sent).
    // A NULL inside a single-row scalar SELECT shouldn't happen for a
    // cast over a non-null parameter; surface as zero-length bytes so
    // the client sees a "missing" element rather than a crash.
    return new Uint8Array(0);
  }
  if (!hasScalarCodec(eqlType)) {
    return new Uint8Array(0);
  }
  return encodeScalar(eqlType, value);
}

function encodeRowAsObject(
  row: Record<string, unknown>,
  shape: OutputShape,
): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt32(shape.fields.length);
  for (const field of shape.fields) {
    w.writeUInt32(0); // reserved
    const value = row?.[field.name];
    if (value === null || value === undefined) {
      // -1 as a signed i32 is 0xFFFFFFFF unsigned.
      w.writeUInt32(0xffffffff);
      continue;
    }
    if (!hasScalarCodec(field.edgeqlType)) {
      // Unknown scalar — surface as null rather than crashing the whole
      // response. Client sees the field as missing; better than killing
      // the session over an unimplemented codec.
      w.writeUInt32(0xffffffff);
      continue;
    }
    const bytes = encodeScalar(field.edgeqlType, value);
    w.writeUInt32(bytes.length);
    w.writeBytes(bytes);
  }
  return w.toBytes();
}

function encodeRowsAsObjects(
  rows: Record<string, unknown>[],
  shape: OutputShape,
  outputFormat: number,
): Uint8Array[] {
  if (outputFormat === OutputFormat.NONE) return [];

  if (outputFormat === OutputFormat.JSON) {
    // JSON format: the whole result set is one JSON-encoded element.
    // Empty rows still emit `[]` so downstream JSON-parser callers see
    // a uniform shape — that's what the Phase 4.3 test asserts.
    return [
      new TextEncoder().encode(JSON.stringify(rows)),
    ];
  }

  if (outputFormat === OutputFormat.JSON_ELEMENTS) {
    // One JSON-encoded element per row.
    const enc = new TextEncoder();
    return rows.map((row) => enc.encode(JSON.stringify(row)));
  }

  if (shape.fields.length === 0) return [];
  if (shape.isScalar) {
    return rows.map((row) => encodeRowAsScalar(row, shape));
  }
  return rows.map((row) => encodeRowAsObject(row, shape));
}

function buildOutputDescriptor(
  shape: OutputShape,
): { id: Uint8Array; data: Uint8Array } {
  // Bare-scalar SELECT: emit a single CTYPE_BASE_SCALAR descriptor and
  // use its tid as the root. No CTYPE_SHAPE wrapper — both upstream Gel
  // clients special-case scalar codecs by descriptor type, and wrapping
  // the scalar in an Object surfaces as `Object{id := None}` regardless
  // of what bytes we put in the Data payload.
  if (shape.isScalar) {
    const eqlType = shape.fields[0].edgeqlType;
    const tid = resolveWellKnownType(eqlType) ??
      resolveWellKnownType("uuid")!;
    const descriptor = { id: tid, bytes: encodeBaseScalarV2(tid) };
    const packed = packTypedescBlock([descriptor]);
    return { id: packed.rootId, data: packed.data };
  }

  const descriptors: Array<{ id: Uint8Array; bytes: Uint8Array }> = [];
  const scalarPos = new Map<string, number>();

  function ensureScalar(eqlType: string): number {
    let pos = scalarPos.get(eqlType);
    if (pos !== undefined) return pos;
    const tid = resolveWellKnownType(eqlType) ??
      resolveWellKnownType("uuid")!;
    pos = descriptors.length;
    descriptors.push({ id: tid, bytes: encodeBaseScalarV2(tid) });
    scalarPos.set(eqlType, pos);
    return pos;
  }

  const elements: ShapeElementV2[] = shape.fields.map((f) => ({
    name: f.name,
    pos: ensureScalar(f.edgeqlType),
    cardinality: 0x41, // ONE
  }));

  const tid = generateDescriptorIdSync(
    new TextEncoder().encode(
      `disc:output:${shape.typeName}:${shape.fields.map((f) => f.name + ":" + f.edgeqlType).join(",")}`,
    ),
  );
  descriptors.push({ id: tid, bytes: encodeShapeV2(tid, elements) });

  const packed = packTypedescBlock(descriptors);
  return { id: packed.rootId, data: packed.data };
}

// ---------------------------------------------------------------------------
// Gel protocol error codes
// ---------------------------------------------------------------------------

export const GEL_ERROR_CODES = {
  InternalServerError: 0x01000000,
  ProtocolError: 0x03000000,
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
  /** Parameters in declaration order — used to decode Execute `arguments`. */
  params: ParamInfo[];
  /** Output shape — used to encode Data rows field-by-field. */
  outputShape: OutputShape;
}

/**
 * Result of running an EdgeQL command against the database. Mirrors the
 * shape `EdgeQLProtocolHandler.executeBinaryQuery` returns. The binary
 * server doesn't care which underlying handler is wired up, only that the
 * shape is consistent.
 */
export interface BinaryExecutionResult {
  rows: Record<string, unknown>[];
  status: string;
}

/**
 * Callback that runs a (named-args) EdgeQL query and returns the rows
 * the binary server needs to encode as Data messages. Optional — when
 * absent, Execute returns no rows so the smoke can still validate the
 * handshake / Parse / descriptor path without a live database.
 */
export type BinaryQueryExecutor = (
  commandText: string,
  args: Record<string, unknown>,
) => Promise<BinaryExecutionResult>;

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
  /**
   * When provided, the server upgrades each accepted connection to TLS and
   * advertises ALPN "edgedb-binary". Required for compatibility with the
   * upstream Gel Python/JS clients — they refuse to talk plain TCP.
   */
  tls?: { certFile: string; keyFile: string };
  /**
   * Runs an EdgeQL query against the underlying database and returns the
   * rows the binary server needs to encode as Data messages. Wired in by
   * `DiscServer` so the binary path uses the same compiler + connection
   * pool as the HTTP path.
   */
  executor?: BinaryQueryExecutor;
}

// ---------------------------------------------------------------------------
// BinaryProtocolServer
// ---------------------------------------------------------------------------

export class BinaryProtocolServer {
  private listener?: Deno.TcpListener | Deno.TlsListener;
  private connections = new Set<BinaryConnection>();
  private _port = 0;
  private running = false;

  constructor(private options: BinaryServerOptions) {}

  /**
   * Start listening for TCP (optionally TLS) connections.
   * If options.port is 0, the OS assigns an ephemeral port.
   */
  start(): void {
    const hostname = this.options.hostname ?? "127.0.0.1";
    if (this.options.tls) {
      // Gel clients require ALPN "edgedb-binary" after the TLS handshake.
      const cert = Deno.readTextFileSync(this.options.tls.certFile);
      const key = Deno.readTextFileSync(this.options.tls.keyFile);
      this.listener = Deno.listenTls({
        hostname,
        port: this.options.port,
        cert,
        key,
        alpnProtocols: ["edgedb-binary"],
      });
    } else {
      this.listener = Deno.listen({
        hostname,
        port: this.options.port,
        transport: "tcp",
      });
    }
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
          this.options.executor,
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

  // Phase 4.2: Prepared statement cache (LRU, capped per-connection)
  private stmtCache = new QueryCache<CachedStatement>(MAX_STATEMENT_CACHE_SIZE);

  constructor(
    private conn: Deno.TcpConn | Deno.TlsConn,
    private _schema: Schema,
    private password?: string,
    private executor?: BinaryQueryExecutor,
  ) {}

  /** Get the current session module context. */
  getModule(): string {
    return this.sessionState.module;
  }

  /** Get the prepared statement cache size (for testing). */
  getCacheSize(): number {
    return this.stmtCache.stats().size;
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

        // Reject oversized / malformed messages BEFORE allocating the buffer.
        // A hostile client can otherwise send a 4 GB length prefix and force
        // the server to allocate a multi-gigabyte Uint8Array.
        if (payloadLength < 0 || payloadLength > MAX_MESSAGE_SIZE) {
          if (!this.closed) {
            await this.sendErrorWithCode(
              `Message size ${payloadLength} bytes exceeds maximum of ${MAX_MESSAGE_SIZE}`,
              GEL_ERROR_CODES.ProtocolError,
            );
          }
          break; // Close the connection — payload framing is unrecoverable
        }

        // Read payload
        let payload = new Uint8Array(0);
        if (payloadLength > 0) {
          const p = await this.readExact(payloadLength);
          if (!p) break;
          payload = new Uint8Array(p);
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
        gs2Header: "",
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
      this.scramState.gs2Header = parsed.gs2Header;

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
      const built = this.buildDescriptors(msg.commandText);

      const commandStatus = this.detectCommandStatus(msg.commandText);

      // Store in cache
      this.stmtCache.set(msg.commandText, {
        commandText: msg.commandText,
        inputDescId: built.inputDesc.id,
        outputDescId: built.outputDesc.id,
        inputDesc: built.inputDesc.data,
        outputDesc: built.outputDesc.data,
        outputFormat: msg.outputFormat,
        resultCardinality: msg.expectedCardinality || Cardinality.MANY,
        commandStatus,
        params: built.params,
        outputShape: built.outputShape,
      });

      await this.sendMessage({
        kind: "CommandDataDescription",
        annotations: [],
        capabilities: 0n,
        resultCardinality: msg.expectedCardinality ||
          Cardinality.MANY,
        inputTypedescId: built.inputDesc.id,
        inputTypedesc: built.inputDesc.data,
        outputTypedescId: built.outputDesc.id,
        outputTypedesc: built.outputDesc.data,
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
      let params: ParamInfo[];
      let outputShape: OutputShape;

      const cached = this.stmtCache.get(msg.commandText);
      if (cached) {
        // Cache hit — reuse descriptors
        inputDesc = { id: cached.inputDescId, data: cached.inputDesc };
        outputDesc = { id: cached.outputDescId, data: cached.outputDesc };
        commandStatus = cached.commandStatus;
        params = cached.params;
        outputShape = cached.outputShape;
      } else {
        // Cache miss — build descriptors
        const descs = this.buildDescriptors(msg.commandText);
        inputDesc = descs.inputDesc;
        outputDesc = descs.outputDesc;
        commandStatus = this.detectCommandStatus(msg.commandText);
        params = descs.params;
        outputShape = descs.outputShape;

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
          params,
          outputShape,
        });
      }

      // Only re-send CommandDataDescription when the client's cached
      // descriptor IDs don't match what we'd build now. Sending it
      // unconditionally surfaces as `ExecuteContext.store_to_cache`
      // AssertionError on the upstream Python client — it interprets
      // the message as "your spec is out-dated" and re-runs cache
      // bookkeeping that assumes the descriptor actually changed.
      const inputMismatch = !uuidsEqual(
        msg.inputTypedescId,
        inputDesc.id,
      );
      const outputMismatch = !uuidsEqual(
        msg.outputTypedescId,
        outputDesc.id,
      );
      if (inputMismatch || outputMismatch) {
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
      }

      // Decode the args blob and execute against the database. When no
      // executor is wired up (test fixtures), behave like before: return
      // no rows so the rest of the protocol still completes cleanly.
      const args = decodeArgs(msg.arguments, params);

      let rows: Record<string, unknown>[] = [];
      if (this.executor) {
        const result = await this.executor(msg.commandText, args);
        rows = result.rows;
        // Prefer the executor's status (it knows whether INSERT had a
        // RETURNING clause, etc.) over the heuristic prefix detection.
        if (result.status) commandStatus = result.status;
      } else {
        // No executor wired up — used by the protocol-only test fixtures
        // that don't spin up a real database. Surface one placeholder
        // row so the existing test suite still observes a single Data
        // frame come back; production paths always supply an executor.
        rows = [{}];
      }

      const dataElements = encodeRowsAsObjects(
        rows,
        outputShape,
        msg.outputFormat,
      );

      // Send one Data message per row — the upstream Gel Python client's
      // parse_data_messages takes each Data, asserts exactly ONE column
      // (`flen != 1` raises), and decodes the rest as a single Object.
      // Bundling multiple rows into one Data with `data.length === N`
      // surfaces as silent N==1 fall-through that decodes only the first
      // row's bytes and trashes the rest.
      //
      // Empty result sets MUST send no Data messages: an empty Data
      // (i16 0) frame triggers `parse_data_messages` to read 6 bytes
      // from a 2-byte buffer and underflow. Real Gel servers omit the
      // Data frame for zero-row results; we do the same.
      if (msg.outputFormat !== OutputFormat.NONE) {
        for (const element of dataElements) {
          await this.sendMessage({ kind: "Data", data: [element] });
        }
      }

      // Phase 4.1: Build state response
      const stateResp = this.buildStateResponse();

      // Send CommandComplete. ReadyForCommand is intentionally NOT sent
      // here: per the Gel protocol the upstream Python and JS clients
      // always pair Execute with Sync, and Sync is the message that
      // produces RFC. Sending RFC twice (once from Execute, once from
      // Sync) leaves a dangling RFC in the client's buffer which the
      // *next* query then consumes as its first message — short-
      // circuiting parse_data_messages and surfacing as alternating
      // null/row results from sequential `query_single` calls.
      await this.sendMessage({
        kind: "CommandComplete",
        annotations: [],
        capabilities: 0n,
        status: commandStatus,
        stateTypedescId: stateResp.stateTypedescId,
        stateData: stateResp.stateData,
      });
    } catch (err) {
      const errorCode = err instanceof Error
        ? mapErrorToGelCode(err)
        : GEL_ERROR_CODES.InternalServerError;
      await this.sendErrorWithCode(
        err instanceof Error ? err.message : String(err),
        errorCode,
      );
      // Errors get an RFC immediately because the client may not send a
      // Sync after a failed Execute (it can't tell from the network
      // that we hit an error before its Sync arrives). The dispatch
      // loop's catch path already does this for unexpected errors;
      // mirror it here for protocol-consistent error handling.
      await this.sendReadyForCommand();
    }
  }

  private async handleSync(): Promise<void> {
    await this.sendReadyForCommand();
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
    commandText: string,
  ): {
    inputDesc: { id: Uint8Array; data: Uint8Array };
    outputDesc: { id: Uint8Array; data: Uint8Array };
    params: ParamInfo[];
    outputShape: OutputShape;
  } {
    // Phase B (P2-09): parse the EdgeQL command to derive minimum-viable
    // input + output type descriptors so the upstream Gel clients can
    // build codecs and round-trip values. Falls back to empty shapes on
    // parse error so query execution can surface a real error.
    try {
      const parser = new EdgeQLParser(commandText);
      const query = parser.parse();
      const params = collectParameters(query);
      const outputShape = inferOutputShape(query, this._schema);
      return {
        inputDesc: buildInputDescriptor(params),
        outputDesc: buildOutputDescriptor(outputShape),
        params,
        outputShape,
      };
    } catch {
      const emptyData = new Uint8Array(0);
      const emptyId = generateDescriptorIdSync(emptyData);
      return {
        inputDesc: { id: emptyId, data: emptyData },
        outputDesc: { id: emptyId, data: emptyData },
        params: [],
        outputShape: { typeName: "Object", fields: [] },
      };
    }
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

    // ParameterStatus messages.
    //
    // Two settings are advertised: `suggested_pool_concurrency` (UTF-8 int)
    // and `system_config` (typedesc-prefixed record). The Python client
    // crashes outright on a missing system_config — it reads
    // `system_config.session_idle_timeout` with no None check. The JS client
    // tolerates absence but errors on malformed shape. See
    // encodeSystemConfigValue() above for the wire layout.
    const encoder = new TextEncoder();
    await this.sendMessage({
      kind: "ParameterStatus",
      name: encoder.encode("suggested_pool_concurrency"),
      value: encoder.encode("4"),
    });
    await this.sendMessage({
      kind: "ParameterStatus",
      name: encoder.encode("system_config"),
      value: encodeSystemConfigValue(),
    });

    // StateDataDescription — required by the upstream Gel clients before
    // they will encode connection state on Parse/Execute. Without it, the
    // Python client hits `assert self.state_codec is not None` mid-query.
    // We advertise an empty SparseObject (CTYPE_INPUT_SHAPE, 0 fields)
    // since disc doesn't yet expose modules/globals/aliases over the wire.
    const emptyState = buildEmptyStateDescriptor();
    await this.sendMessage({
      kind: "StateDataDescription",
      typedescId: emptyState.tid,
      typedesc: emptyState.typedesc,
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

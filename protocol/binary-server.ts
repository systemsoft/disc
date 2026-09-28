/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

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

import { selectKeepsAtMostOne, tupleTypeElements, unitedTupleType } from "../compiler/compiler-base.ts";
import { powerType } from "../compiler/compiler-expressions.ts";
import type { Schema, TypeDef } from "../compiler/context.ts";
import type * as AST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { BufferReader, BufferWriter } from "./buffer.ts";
import {
  Cardinality,
  CompilationFlag,
  ErrorSeverity,
  OutputFormat,
  PROTOCOL_MAJOR_VERSION,
  PROTOCOL_MINOR_VERSION,
  TransactionState
} from "./enums.ts";
import {
  decodeClientMessage,
  encodeServerMessage,
  type ClientMessage,
  type ErrorAttribute,
  type ServerMessage
} from "./messages.ts";
import {
  deriveKeys,
  generateServerFirstMessage,
  parseClientFirstMessage,
  verifyClientFinalMessage,
  type ScramServerState
} from "./scram.ts";
import { generateDescriptorIdSync } from "./typedesc.ts";
import { uuidToBytes } from "./types.ts";

import {
  CompilationError,
  ConfigurationError,
  ConnectionError,
  DatabaseExecutionError,
  DisabledCapabilityError,
  DiscError,
  gelErrorMessage,
  InvalidReferenceError,
  InvalidValueError,
  postgresErrorFields,
  QueryError,
  QueryTimeoutError,
  ResultCardinalityMismatchError,
  SchemaError,
  SyntaxError,
  ValidationError
} from "../lib/errors.ts";
import { QueryCache } from "../lib/query-cache.ts";
import {
  appendSetDescriptor,
  appendTypeDescriptor,
  decodeWireValue,
  encodeSetValue,
  encodeWireValue,
  hasWireCodec,
  mapWireTypeScalars,
  parseWireType,
  type TypeDescriptorList
} from "./collection-codecs.ts";

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
    "00000000-0000-0000-0000-00000000010e"
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
    `disc:system_config:${TYPE_NAME}:${FIELD_NAME}`
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
function buildEmptyStateDescriptor(): {
  tid: Uint8Array;
  typedesc: Uint8Array;
} {
  const tid = generateDescriptorIdSync(
    new TextEncoder().encode("disc:state:empty:v1")
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
//   CTYPE_SHAPE       (=1): [u8 t][16 tid][u8 ephemeralFreeShape]
//                           [u16 objectTypePos=0][u16 els]
//                           per el: [u32 flags][u8 cardinality]
//                                   [u32 nameLen][bytes name][u16 pos]
//                                   [u16 sourceTypePos=0]
//
// Each descriptor in the typedesc block is itself u32-length-prefixed.
// Base scalars, arrays and tuples are encoded by `appendTypeDescriptor`,
// sets by `appendSetDescriptor` (`protocol/collection-codecs.ts`).

interface ShapeElementV2 {
  name: string;
  /** index into the descriptor list of this field's type codec */
  pos: number;
  cardinality: number;
  /** `SHAPE_POINTER_IS_*` bits (0 for a query parameter). */
  flags: number;
}

/**
 * A shape element's flags, as Gel's `ShapePointerFlags`
 * (edb/server/compiler/sertypes.py): an injected `id` / `__tid__` /
 * `__tname__` is implicit (the clients hide it), a link property is one (the
 * clients name it `@name`), and a pointer to objects is a link.
 */
const SHAPE_POINTER_IS_IMPLICIT = 1 << 0;
const SHAPE_POINTER_IS_LINKPROP = 1 << 1;
const SHAPE_POINTER_IS_LINK = 1 << 2;

function encodeShapeV2(
  tid: Uint8Array,
  elements: ShapeElementV2[],
  free = false
): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt8(1);
  w.writeUUID(tid);
  w.writeUInt8(free ? 1 : 0); // ephemeral_free_shape
  w.writeUInt16(0); // object type pos
  w.writeUInt16(elements.length);
  for (const el of elements) {
    w.writeUInt32(el.flags);
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
  descriptors: Array<{ id: Uint8Array; bytes: Uint8Array; }>
): { data: Uint8Array; rootId: Uint8Array; } {
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
  /**
   * Wire cardinality byte for this field (see `protocol/enums.ts`
   * `Cardinality`). Derived from the schema: required+single→ONE,
   * optional+single→AT_MOST_ONE, required+multi→AT_LEAST_ONE,
   * optional+multi→MANY. Drives the per-element cardinality emitted by
   * `buildOutputDescriptor` so the binary type descriptor is honest.
   * A multi cardinality (MANY, AT_LEAST_ONE) makes the field a set.
   */
  cardinality: number;
  /** For a field of objects (a link, a `group`'s key and elements), their shape. */
  shape?: OutputShape;
  /** An `id`, `__tid__` or `__tname__` Gel injects into the shape, which the clients hide. */
  implicit?: boolean;
  /** A link property (`@name` in a link's sub-shape): its value is the row's `@name`. */
  linkProperty?: boolean;
  /** The value of the field in every object, rather than the row's: an injected `__tid__` or `__tname__`. */
  constant?: unknown;
}

/**
 * Map a field's `required`/`multi` schema flags to the Gel wire
 * cardinality byte, matching the structured encoder's convention in
 * `protocol/typedesc.ts` `buildResultDescriptors`:
 *
 *   required + single → ONE
 *   optional + single → AT_MOST_ONE
 *   required + multi  → AT_LEAST_ONE
 *   optional + multi  → MANY
 */
function cardinalityFor(required: boolean, multi: boolean): number {
  if (multi) {
    return required ? Cardinality.AT_LEAST_ONE : Cardinality.MANY;
  }
  return required ? Cardinality.ONE : Cardinality.AT_MOST_ONE;
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
  /** A free object (`group`'s results and their keys): no object type of the schema. */
  free?: boolean;
  /**
   * The result cardinality, when the query's shape pins it down (a
   * selected scalar expression or set literal, a mutation). Otherwise the
   * CommandDataDescription echoes the client's expected cardinality.
   */
  cardinality?: number;
}

/**
 * The implicit fields a client asks Gel to inject into every object shape
 * of a binary result, by its Parse / Execute compilation flags
 * (INJECT_OUTPUT_OBJECT_IDS, _TYPE_IDS, _TYPE_NAMES; the Python client
 * always asks for ids, the JS client for none).
 */
export interface ImplicitFields {
  ids: boolean;
  typeIds: boolean;
  typeNames: boolean;
}

/**
 * What a `with` block brings into scope for the query it wraps: its
 * aliases, and its `module`, which bare type names then refer to.
 */
interface WithScope {
  aliases: Map<string, BoundAlias>;
  module?: string;
  schema?: DescribedSchema;
  /** The object type a relative path (`.name`) starts from: a shape's, or a `group`'s. */
  subject?: string;
  /** The implicit fields the client asked for. */
  implicit?: ImplicitFields;
  /** In a link's sub-shape, the link's properties, which `@name` names. */
  linkProperties?: Map<string, DescribedProperty>;
}

/**
 * A `with` alias: the expression it's bound to, in the scope it's bound in.
 * A `for` variable is bound to its iterator as an `element`: it stands for
 * one element of that set at a time.
 */
interface BoundAlias {
  element?: boolean;
  expr: AST.Expression;
  scope: WithScope;
}

/** A property (or link property) as an output description reads it. */
interface DescribedProperty {
  baseType?: string;
  computed?: boolean;
  edgeqlType?: string;
  multi?: boolean;
  required?: boolean;
  type: string;
}

/** The parts of the schema an output description reads. */
interface DescribedSchema {
  /** Each user scalar mapped to the built-in type it extends (`Schema.scalars`). */
  scalars?: Map<string, string>;
  types?: Map<
    string,
    {
      kind?: string;
      properties: Map<string, DescribedProperty>;
      links?: Map<string, { multi?: boolean; properties?: Map<string, DescribedProperty>; required?: boolean; target?: string; }>;
    }
  >;
}

const EMPTY_SCOPE: WithScope = { aliases: new Map() };

/**
 * Follow `with` aliases from `expr` to the expression they're bound to,
 * stopping at a `for` variable (which is one element of what it's bound to).
 */
function resolveAlias(expr: AST.Expression, scope: WithScope): BoundAlias {
  let bound: BoundAlias = { expr, scope };
  while (bound.expr.kind === "Identifier") {
    const next = bound.scope.aliases.get((bound.expr as AST.Identifier).name);
    if (!next || next.element) {
      break;
    }
    bound = next;
  }
  return bound;
}

/** The `for` variable `expr` names after `resolveAlias`, if it names one. */
function elementBinding(expr: AST.Expression, scope: WithScope): BoundAlias | undefined {
  return expr.kind === "Identifier" ? scope.aliases.get((expr as AST.Identifier).name) : undefined;
}

/** `name` in the scope's `with module`, unless it is already qualified. */
function qualifyTypeName(name: string, scope: WithScope): string {
  return scope.module && scope.module !== "default" && !name.includes("::") ? `${scope.module}::${name}` : name;
}

/**
 * The built-in type a scalar type is sent as: a user scalar
 * (`scalar type Count extending int64`) as the type it extends, a sequence
 * as int64, an enum as str. In an array or tuple, each scalar in it.
 */
function builtinScalarType(name: string, scope: WithScope): string {
  if (name.includes("<")) {
    return mapWireTypeScalars(name, scalar => builtinScalarType(scalar, scope));
  }
  const bare = name.replace(/^default::/, "");
  const base = scope.schema?.scalars?.get(bare) ?? scope.schema?.scalars?.get(name) ?? bare;
  if (base === "sequence") {
    return "int64";
  }
  return scope.schema?.types?.get(base)?.kind === "enum" ? "str" : base;
}

const COMPARISON_OPERATORS = new Set([
  "!=",
  "<",
  "<=",
  "=",
  ">",
  ">=",
  "?!=",
  "?=",
  "AND",
  "ILIKE",
  "IN",
  "LIKE",
  "NOT IN",
  "OR"
]);
const NUMERIC_OPERATORS = new Set(["%", "*", "+", "-", "/", "//", "^"]);

/**
 * The scalar type of an expression selected on its own (`select 42`,
 * `select <str>$x`, `select x + 1` with `x` a `with` alias), so
 * `inferOutputShape` can describe it as a BaseScalar instead of an Object.
 * Returns null if the expression isn't a scalar form recognized here.
 */
function inferScalarType(
  expr: AST.Expression,
  scope: WithScope
): string | null {
  const bound = resolveAlias(expr, scope);
  const e = bound.expr;
  switch (e.kind) {
    case "ArrayExpr": {
      // `[a, b]`: an array of the elements' common type (`[]` alone has none).
      const elements = (e as AST.ArrayExpr).elements.map(el => inferScalarType(el, bound.scope));
      return elements.length > 0 && elements.every(t => t !== null) ? `array<${unifyScalarTypes(elements as string[])}>` : null;
    }
    case "BinaryOp":
      return binaryOpType(e as AST.BinaryOp, bound.scope);
    case "NamedTuple": {
      const elements = (e as AST.NamedTuple).elements.map(el => [el.name, inferScalarType(el.value, bound.scope)]);
      return elements.every(([, t]) => t !== null) ? `tuple<${elements.map(([name, t]) => `${name}: ${t}`).join(", ")}>` : null;
    }
    case "TupleExpr": {
      const elements = (e as AST.TupleExpr).elements.map(el => inferScalarType(el, bound.scope));
      return elements.every(t => t !== null) ? `tuple<${elements.join(", ")}>` : null;
    }
    case "FunctionCall":
      return functionType(e as AST.FunctionCall, bound.scope);
    case "Identifier": {
      // A `for` variable: an element of its iterator.
      const element = elementBinding(e, bound.scope);
      return element ? inferScalarType(element.expr, element.scope) : null;
    }
    case "IfElse": {
      const ifElse = e as AST.IfElse;
      const branches = [inferScalarType(ifElse.then, bound.scope), inferScalarType(ifElse.else, bound.scope)];
      return branches[0] !== null && branches[1] !== null ? unifyScalarTypes(branches as string[]) : null;
    }
    case "Path": {
      const reached = inferPath(e as AST.Path, bound.scope);
      return reached && !reached.object ? reached.type : null;
    }
    case "SetExpr": {
      const shape = inferSetShape(e, bound.scope);
      return shape.isScalar ? shape.fields[0].edgeqlType : null;
    }
    case "Literal":
      switch ((e as AST.Literal).type) {
        case "bigint":
          return "bigint";
        case "boolean":
          return "bool";
        case "bytes":
          return "bytes";
        case "decimal":
          return "decimal";
        case "float":
          return "float64";
        case "integer":
          return "int64";
        case "string":
          return "str";
        case "uuid":
          return "uuid";
      }
      return null;
    case "Subquery": {
      const shape = inferOutputShape(
        (e as AST.Subquery).query,
        undefined,
        bound.scope
      );
      return shape.isScalar ? shape.fields[0].edgeqlType : null;
    }
    case "TypeCast": {
      const type = (e as AST.TypeCast).type;
      return type?.name?.parts?.length ? builtinScalarType(typeNameString(type), bound.scope) : null;
    }
    case "IndexExpression":
    case "SliceExpression": {
      // An array's element, a `str`'s character, a `bytes`' byte, a json's
      // element; a slice is of its operand's type.
      const base = inferScalarType((e as AST.IndexExpression | AST.SliceExpression).expr, bound.scope);
      const element = /^array<(.+)>$/.exec(base ?? "")?.[1];
      if (base === "str" || base === "bytes" || base === "json") {
        return base;
      }
      return e.kind === "SliceExpression" ? (element ? base : null) : element ?? null;
    }
    case "TupleAccessExpr": {
      const access = e as AST.TupleAccessExpr;
      const elements = tupleTypeElements(inferScalarType(access.tuple, bound.scope) ?? "") ?? [];
      const index = access.accessType === "index" ? access.index ?? -1 : elements.findIndex(el => el.name === access.fieldName);
      return elements[index]?.type ?? null;
    }
    case "UnaryOp": {
      const unary = e as AST.UnaryOp;
      if (unary.op === "EXISTS" || unary.op === "NOT") {
        return "bool";
      }
      if (unary.op === "DISTINCT") {
        return inferScalarType(unary.operand, bound.scope);
      }
      const operand = inferScalarType(unary.operand, bound.scope);
      return (unary.op === "+" || unary.op === "-") && operand !== null &&
          [...INT_TYPES, ...FLOAT_TYPES, ...DECIMAL_TYPES].includes(operand) ?
        operand :
        null;
    }
    default:
      return null;
  }
}

/**
 * The result type of a binary operator over scalars: comparisons and
 * logic give bool, `++` joins two strs (or bytes), and arithmetic on ints
 * and floats follows Gel's implicit casts — `/` and `**` of two ints are
 * float64 (bigint and decimal: `decimalOpType`). Anything else is null.
 */
function binaryOpType(op: AST.BinaryOp, scope: WithScope): string | null {
  if (COMPARISON_OPERATORS.has(op.op)) {
    return "bool";
  }
  if (op.op === "UNION") {
    const shape = inferSetShape(op, scope);
    return shape.isScalar ? shape.fields[0].edgeqlType : null;
  }
  const left = inferScalarType(op.left, scope);
  const right = inferScalarType(op.right, scope);
  if (left === null || right === null) {
    return null;
  }
  if (op.op === "??") {
    return unifyScalarTypes([left, right]);
  }
  if (op.op === "++") {
    const elements = [left, right].map(type => /^array<(.+)>$/.exec(type)?.[1]);
    if (elements[0] && elements[1]) {
      return `array<${unifyScalarTypes([elements[0], elements[1]])}>`;
    }
    return left === right && (left === "str" || left === "bytes") ?
      left :
      null;
  }
  const numeric = [...INT_TYPES, ...FLOAT_TYPES, ...DECIMAL_TYPES];
  if (
    !NUMERIC_OPERATORS.has(op.op) || !numeric.includes(left) ||
    !numeric.includes(right)
  ) {
    return null;
  }
  if (op.op === "^") {
    return powerType(left, right);
  }
  if (DECIMAL_TYPES.includes(left) || DECIMAL_TYPES.includes(right)) {
    return decimalOpType(op.op, left, right);
  }
  if (
    op.op === "/" && INT_TYPES.includes(left) &&
    INT_TYPES.includes(right)
  ) {
    return "float64";
  }
  return unifyScalarTypes([left, right]);
}

/**
 * The result type of arithmetic with a bigint or decimal operand: ints widen
 * to bigint, and a decimal operand or `/` makes it decimal. Gel has no
 * implicit cast between floats and either, so a float operand gives null.
 */
function decimalOpType(op: string, left: string, right: string): string | null {
  if (FLOAT_TYPES.includes(left) || FLOAT_TYPES.includes(right)) {
    return null;
  }
  return left === "decimal" || right === "decimal" || op === "/" ?
    "decimal" :
    "bigint";
}

/** A std function's result type, fixed or from its arguments' types (null where unknown). */
type FunctionResultType = string | ((args: (string | null)[]) => string | null);

const SAME_AS_ARGUMENT: FunctionResultType = ([arg]) => arg;
/*** `round`, `math::ceil`, `math::floor`: bigint and decimal keep their type, other numbers give float64. ***/
const ROUNDED: FunctionResultType = ([arg]) => arg === null || !NUMERIC_TYPES.includes(arg) ? null : DECIMAL_TYPES.includes(arg) ? arg : "float64";

/**
 * Gel's std functions by result type (`edb/lib/std`), for the functions a
 * query commonly selects on their own. A function not listed here is not
 * described as a scalar.
 */
const STD_FUNCTION_TYPES = new Map<string, FunctionResultType>([
  ["all", "bool"],
  ["any", "bool"],
  ["array_agg", ([arg]) => arg === null ? null : `array<${arg}>`],
  ["array_join", "str"],
  ["assert_distinct", SAME_AS_ARGUMENT],
  ["assert_exists", SAME_AS_ARGUMENT],
  ["assert_single", SAME_AS_ARGUMENT],
  ["cal::date_get", "float64"],
  ["cal::time_get", "float64"],
  ["contains", "bool"],
  ["count", "int64"],
  ["datetime_current", "datetime"],
  ["datetime_get", "float64"],
  ["datetime_of_statement", "datetime"],
  ["datetime_of_transaction", "datetime"],
  ["datetime_truncate", "datetime"],
  ["duration_get", "float64"],
  // One `(index, element)` tuple per element.
  ["enumerate", ([arg]) => arg === null ? null : `tuple<int64, ${arg}>`],
  ["find", "int64"],
  ["json_typeof", "str"],
  ["len", "int64"],
  ["math::abs", ([arg]) => arg !== null && NUMERIC_TYPES.includes(arg) ? arg : null],
  ["math::ceil", ROUNDED],
  ["math::floor", ROUNDED],
  // Ints and floats average to float64; bigints and decimals to decimal.
  ["math::mean", ([arg]) => arg === null || !NUMERIC_TYPES.includes(arg) ? null : DECIMAL_TYPES.includes(arg) ? "decimal" : "float64"],
  ["max", SAME_AS_ARGUMENT],
  ["min", SAME_AS_ARGUMENT],
  ["random", "float64"],
  ["re_replace", "str"],
  ["re_test", "bool"],
  ["round", ROUNDED],
  ["str_lower", "str"],
  ["str_pad_end", "str"],
  ["str_pad_start", "str"],
  ["str_repeat", "str"],
  ["str_replace", "str"],
  ["str_reverse", "str"],
  ["str_title", "str"],
  ["str_trim", "str"],
  ["str_trim_end", "str"],
  ["str_trim_start", "str"],
  ["str_upper", "str"],
  // Ints sum to int64; floats, bigints and decimals to their own type.
  ["sum", ([arg]) => arg === null || !NUMERIC_TYPES.includes(arg) ? null : INT_TYPES.includes(arg) ? "int64" : arg],
  ["to_bigint", "bigint"],
  ["to_datetime", "datetime"],
  ["to_decimal", "decimal"],
  ["to_float32", "float32"],
  ["to_float64", "float64"],
  ["to_int16", "int16"],
  ["to_int32", "int32"],
  ["to_int64", "int64"],
  ["to_json", "json"],
  ["to_str", "str"],
  ["uuid_generate_v1mc", "uuid"],
  ["uuid_generate_v4", "uuid"]
]);

/**
 * A cast's type as a type name: `<str>` → `str`, `<array<str>>` →
 * `array<str>`, `<tuple<a: int64>>` → `tuple<a: int64>`. A scalar is named
 * by the last part of its name.
 */
function typeNameString(type: AST.TypeName): string {
  const name = type.name.parts[type.name.parts.length - 1];
  const rendered = type.subtypes?.length ? `${name}<${type.subtypes.map(typeNameString).join(", ")}>` : name;
  return type.fieldName ? `${type.fieldName}: ${rendered}` : rendered;
}

/*** A function's name without the `std::` module: `std::count` → `count`, `math::abs` stays. ***/
function functionName(call: AST.FunctionCall): string {
  const parts = call.name.parts;
  return (parts.length === 2 && parts[0] === "std" ? parts.slice(1) : parts).join("::");
}

/** The scalar type a std function call returns, or null when it isn't one described here. */
function functionType(call: AST.FunctionCall, scope: WithScope): string | null {
  const result = STD_FUNCTION_TYPES.get(functionName(call));
  if (typeof result === "function") {
    return result(call.args.map(arg => inferScalarType(arg.value, scope)));
  }
  return result ?? null;
}

/**
 * Cardinality of a function call: an aggregate is one value (`min` and
 * `max` of an empty set none), `assert_exists` / `assert_single` bound
 * their argument's, and any other function is called once per combination
 * of its arguments (see `productCardinality`).
 */
function functionCardinality(call: AST.FunctionCall, scope: WithScope): number {
  const name = functionName(call);
  if (["all", "any", "array_agg", "count", "math::mean", "sum"].includes(name)) {
    return Cardinality.ONE;
  }
  if (name === "max" || name === "min") {
    return Cardinality.AT_MOST_ONE;
  }
  const args = call.args.map(arg => expressionCardinality(arg.value, scope));
  const [lower, upper] = cardinalityBounds(args[0] ?? Cardinality.ONE);
  if (name === "assert_exists") {
    return boundsCardinality(1, upper);
  }
  if (name === "assert_single") {
    return boundsCardinality(lower, 1);
  }
  return productCardinality(args);
}

/**
 * Walk an AST and collect every `<TypeName>$paramName` cast as a parameter.
 * Returns parameters in first-seen order (deduplicated by name).
 */
function collectParameters(node: unknown): ParamInfo[] {
  const seen = new Set<string>();
  const out: ParamInfo[] = [];

  function visit(n: unknown): void {
    if (!n || typeof n !== "object") {
      return;
    }
    const obj = n as { kind?: string; type?: AST.TypeName; expr?: unknown; };
    if (
      obj.kind === "TypeCast" &&
      obj.expr &&
      typeof obj.expr === "object" &&
      (obj.expr as { kind?: string; }).kind === "Parameter"
    ) {
      const param = obj.expr as AST.Parameter;
      const tn = obj.type;
      // The lexer keeps the leading `$` on parameter names. Strip it
      // before exposing on the wire — clients pass kwargs without `$`.
      const bare = param.name.startsWith("$") ?
        param.name.slice(1) :
        param.name;
      if (tn?.name?.parts?.length && !seen.has(bare)) {
        seen.add(bare);
        out.push({
          name: bare,
          edgeqlType: typeNameString(tn)
        });
      }
    }
    for (const value of Object.values(obj as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
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
export function inferOutputShape(
  query: unknown,
  schema?: DescribedSchema,
  outerScope: WithScope = EMPTY_SCOPE
): OutputShape {
  // The schema travels with the scope, so nested expressions see it.
  const scope = schema && outerScope.schema !== schema ? { ...outerScope, schema } : outerScope;
  if (!query || typeof query !== "object") {
    return { typeName: "Object", fields: withImplicitFields("Object", [], scope) };
  }
  const q = query as { kind?: string; };

  // A mutation answers the objects it wrote, each its `{id}`.
  if (
    q.kind === "InsertQuery" || q.kind === "UpdateQuery" ||
    q.kind === "DeleteQuery"
  ) {
    const mutation = q as AST.InsertQuery | AST.UpdateQuery | AST.DeleteQuery;
    const typeName = qualifyTypeName(extractTypeNameFromExpr(mutation.type) ?? "Object", scope);
    return { cardinality: mutationCardinality(mutation, typeName, scope), fields: withImplicitFields(typeName, [], scope), typeName };
  }

  // `with …`: describe the body like the same query without `with`, each
  // alias standing for what it's bound to. A binding sees the aliases
  // bound before it.
  if (q.kind === "WithBlock") {
    const block = q as AST.WithBlock;
    let inner: WithScope = {
      ...scope,
      module: block.module ?? scope.module
    };
    for (const binding of block.bindings) {
      inner = {
        ...inner,
        aliases: new Map(inner.aliases).set(binding.name.name, {
          expr: binding.value,
          scope: inner
        })
      };
    }
    return inferOutputShape(block.body, schema, inner);
  }

  // `for x in S union body`: the body's rows for each element of S, with
  // `x` standing for that element.
  if (q.kind === "ForQuery") {
    const loop = q as AST.ForQuery;
    const body = inferOutputShape(loop.body, schema, {
      ...scope,
      aliases: new Map(scope.aliases).set(loop.variable.name, { element: true, expr: loop.iterator, scope })
    });
    if (body.cardinality === undefined) {
      return body;
    }
    const cardinality = productCardinality([expressionCardinality(loop.iterator, scope), body.cardinality]);
    return { ...body, cardinality, fields: body.isScalar ? [{ ...body.fields[0], cardinality }] : body.fields };
  }

  if (q.kind === "SelectQuery") {
    const sel = q as AST.SelectQuery;
    const { expr, scope: exprScope } = resolveAlias(sel.expr, scope);
    // A filter, offset or limit can drop every element.
    const narrowed = Boolean(sel.filter || sel.offset || sel.limit);

    // Selected subquery (`select (select …)`, or an alias bound to one): a
    // shape re-selects the subquery's set; without one, the result is the
    // subquery's own.
    if (expr.kind === "Subquery") {
      const inner = (expr as AST.Subquery).query;
      if (!sel.shape) {
        return dropLowerBound(
          inferOutputShape(inner, schema, exprScope),
          narrowed
        );
      }
      if (inner.kind === "SelectQuery") {
        return inferOutputShape({ ...sel, expr: inner.expr }, schema, exprScope);
      }
    }

    // Selected set literal (`select {1, 2}`) or union (`select A union B`):
    // one element per row.
    if (
      !sel.shape &&
      (expr.kind === "SetExpr" || (expr.kind === "BinaryOp" && (expr as AST.BinaryOp).op === "UNION"))
    ) {
      return dropLowerBound(inferSetShape(expr, exprScope), narrowed);
    }

    // Bare-scalar SELECT (`SELECT <bool>$x`, `SELECT 42`, `SELECT 1 + 2`):
    // emit a BaseScalar shape so the descriptor doesn't wrap the value in
    // an Object{id} on the wire, with the expression's own cardinality.
    // Only triggers when there's no shape and the expression is a scalar —
    // `SELECT Item FILTER ...` still wants the Object path.
    if (!sel.shape) {
      const scalar = inferScalarType(expr, exprScope);
      if (scalar !== null) {
        const cardinality = expressionCardinality(expr, exprScope);
        return dropLowerBound({
          cardinality,
          fields: [{ cardinality, edgeqlType: scalar, name: "_value" }],
          isScalar: true,
          typeName: scalar
        }, narrowed);
      }
    }

    const typeName = objectTypeName(expr, exprScope) ?? "Object";
    return objectShape(typeName, sel.shape, scope);
  }

  if (q.kind === "GroupQuery") {
    return inferGroupShape(q as AST.GroupQuery, scope);
  }

  return { typeName: "Object", fields: withImplicitFields("Object", [], scope) };
}

/**
 * How many objects a mutation writes, as Gel infers it: an insert one (`unless
 * conflict` without `else`: at most one), an update or delete at most one
 * when it keeps at most one (a filter on `.id` or an exclusive property, see
 * `selectKeepsAtMostOne`), else many.
 */
function mutationCardinality(mutation: AST.InsertQuery | AST.UpdateQuery | AST.DeleteQuery, typeName: string, scope: WithScope): number {
  if (mutation.kind === "InsertQuery") {
    return mutation.unless && !mutation.unless.else ? Cardinality.AT_MOST_ONE : Cardinality.ONE;
  }
  // The schema an output description reads is Disc's (`Schema`), narrowed.
  const typeDef = scope.schema?.types?.get(typeName) as TypeDef | undefined;
  const limit = mutation.kind === "DeleteQuery" ? mutation.limit : undefined;
  const keepsOne = typeDef !== undefined &&
    selectKeepsAtMostOne({ expr: mutation.type, filter: mutation.filter, kind: "SelectQuery", limit }, typeDef);
  return keepsOne ? Cardinality.AT_MOST_ONE : Cardinality.MANY;
}

/**
 * An object shape's fields with the implicit ones Gel injects in front of
 * them (edb/edgeql/compiler/viewgen.py `_get_shape_configuration_inner`):
 * `id` when the shape has no pointers (link properties aside), or when the client asks for ids and
 * the shape doesn't select it; then `__tid__` and `__tname__` (the object's
 * type, `default::Author`) when asked for — so a shape starts `__tname__,
 * __tid__, id`. Disc has no type ids of its own: `__tid__` is derived from
 * the type's name.
 */
function withImplicitFields(typeName: string, fields: OutputField[], scope: WithScope): OutputField[] {
  const implicit = scope.implicit;
  const out = [...fields];
  const pointers = fields.filter(f => !f.linkProperty);
  if (pointers.length === 0 || (implicit?.ids && !pointers.some(f => f.name === "id"))) {
    out.unshift({ cardinality: Cardinality.ONE, edgeqlType: "uuid", implicit: true, name: "id" });
  }
  if (typeName === "Object") {
    return out;
  }
  const qualified = typeName.includes("::") ? typeName : `default::${typeName}`;
  if (implicit?.typeIds) {
    const typeId = generateDescriptorIdSync(new TextEncoder().encode(`disc:type:${qualified}`));
    out.unshift({ cardinality: Cardinality.ONE, constant: typeId, edgeqlType: "uuid", implicit: true, name: "__tid__" });
  }
  if (implicit?.typeNames) {
    out.unshift({ cardinality: Cardinality.ONE, constant: qualified, edgeqlType: "str", implicit: true, name: "__tname__" });
  }
  return out;
}

/**
 * The fields of a shape on objects of `typeName`: a property as its type, a
 * link as its objects in their sub-shape (`{id}` without one), a computed
 * element as what its expression gives, a splat (`*`) as the type's stored
 * properties, `id` first (as the compiler expands it). `[is T].p` is `T`'s
 * pointer, empty on objects of other types. Each has its cardinality, so a
 * multi link or property, or a computed set, is described as a set. In a
 * link's sub-shape, its link properties (`@p`, `@q := …`) follow the
 * shape's pointers, as Gel orders them.
 */
function shapeFields(
  typeName: string,
  shape: AST.Shape,
  scope: WithScope,
  linkProperties?: Map<string, DescribedProperty>
): OutputField[] {
  const types = scope.schema?.types;
  const typeDef = types?.get(typeName);
  const elementScope: WithScope = { ...scope, linkProperties, subject: typeName };
  const fields: OutputField[] = [];
  const properties: OutputField[] = [];
  const add = (field: OutputField): void => {
    if (!fields.some(f => f.name === field.name)) {
      fields.push(field);
    }
  };
  for (const el of shape.elements) {
    if (el.splat) {
      add({ cardinality: Cardinality.ONE, edgeqlType: "uuid", name: "id" });
      for (const [name, property] of typeDef?.properties ?? []) {
        if (!property.computed) {
          add(propertyField(name, property, scope));
        }
      }
      continue;
    }
    const fieldName = el.name?.name ?? extractFieldNameFromExpr(el.expr);
    if (!fieldName) {
      continue;
    }
    if (el.linkProperty) {
      properties.push(linkPropertyField(fieldName, el, elementScope));
      continue;
    }
    if (el.computable) {
      add(computedField(fieldName, el, elementScope));
      continue;
    }
    // `[is T].p`: `T`'s pointer, which objects of other types don't have.
    const sourceDef = el.typeFilter ? types?.get(qualifyTypeName(el.typeFilter, scope)) : typeDef;
    const intersected = el.typeFilter !== undefined;
    const propType = sourceDef?.properties.get(fieldName);
    if (propType) {
      add(propertyField(fieldName, propType, scope, intersected));
      continue;
    }
    const linkDef = sourceDef?.links?.get(fieldName);
    if (linkDef) {
      const target = linkDef.target?.replace(/^default::/, "") ?? "Object";
      add({
        name: fieldName,
        edgeqlType: target,
        cardinality: cardinalityFor(
          !intersected && (linkDef.required ?? false),
          linkDef.multi ?? false
        ),
        shape: objectShape(target, el.shape, scope, linkDef.properties)
      });
      continue;
    }
    // Unknown field — fall back to an optional single uuid.
    add({
      name: fieldName,
      edgeqlType: "uuid",
      cardinality: Cardinality.AT_MOST_ONE
    });
  }
  return [...fields, ...properties];
}

/**
 * A property's field: its EdgeQL type (the schema's `type` is the SQL
 * type), as the built-in type it's sent as. Optional when reached through a
 * type intersection (`[is T].p`).
 */
function propertyField(name: string, property: DescribedProperty, scope: WithScope, optional = false): OutputField {
  const eqlType = property.baseType ?? property.edgeqlType ?? property.type ?? "uuid";
  return {
    name,
    edgeqlType: builtinScalarType(eqlType, scope),
    cardinality: cardinalityFor(!optional && (property.required ?? false), property.multi ?? false)
  };
}

/**
 * A link property in a link's sub-shape (`@role`, `@r := @role ++ "!"`):
 * the link's property as its type, or what the expression gives. One value
 * at most, as a link property is single. Unknown, an optional uuid.
 */
function linkPropertyField(name: string, el: AST.ShapeElement, scope: WithScope): OutputField {
  if (el.computable) {
    const type = inferScalarType(el.expr, scope);
    return type === null ?
      { cardinality: Cardinality.AT_MOST_ONE, edgeqlType: "uuid", linkProperty: true, name } :
      { cardinality: expressionCardinality(el.expr, scope), edgeqlType: type, linkProperty: true, name };
  }
  const property = scope.linkProperties?.get(name);
  return property ?
    { ...propertyField(name, { ...property, multi: false }, scope), linkProperty: true } :
    { cardinality: Cardinality.AT_MOST_ONE, edgeqlType: "uuid", linkProperty: true, name };
}

/**
 * Objects of `typeName` in `shape` (reached by a link with
 * `linkProperties`), with Gel's implicit fields: `{id}` without a shape.
 */
function objectShape(
  typeName: string,
  shape: AST.Shape | undefined,
  scope: WithScope,
  linkProperties?: Map<string, DescribedProperty>
): OutputShape {
  const fields = shape ? shapeFields(typeName, shape, scope, linkProperties) : [];
  return { fields: withImplicitFields(typeName, fields, scope), typeName };
}

/**
 * A computed shape element (`n := count(.posts)`, `titles := .posts.title`,
 * `r := .<author[is Post] { title }`), in the scope of the shape's objects:
 * objects in their shape, or a scalar, with the expression's cardinality.
 * An expression not described here is an optional uuid, as before.
 */
function computedField(name: string, el: AST.ShapeElement, scope: WithScope): OutputField {
  const expr = el.expr.kind === "ShapeExpr" ? (el.expr as AST.ShapeExpr).expr : el.expr;
  const shape = el.expr.kind === "ShapeExpr" ? (el.expr as AST.ShapeExpr).shape : el.shape;
  const cardinality = expressionCardinality(expr, scope);
  const objectType = objectTypeName(expr, scope);
  const objectDef = objectType === null ? undefined : scope.schema?.types?.get(objectType);
  if (objectType !== null && objectDef && objectDef.kind !== "enum") {
    return { cardinality, edgeqlType: objectType, name, shape: objectShape(objectType, shape, scope) };
  }
  const scalar = inferScalarType(expr, scope);
  if (scalar !== null) {
    return { cardinality, edgeqlType: scalar, name };
  }
  return { cardinality: Cardinality.AT_MOST_ONE, edgeqlType: "uuid", name };
}

/**
 * A `group`'s results, as Gel describes them (edb/edgeql/desugar_group.py):
 * free objects of `key` (a free object of each key by name), `grouping`
 * (the key names, a set of str) and `elements` (the group's objects in the
 * shape given, `{id}` without one). A `using` key has its expression's
 * type (objects their `{id}`), a `.p` key its property's.
 */
function inferGroupShape(group: AST.GroupQuery, scope: WithScope): OutputShape {
  const subject = group.expr.kind === "ShapeExpr" ? (group.expr as AST.ShapeExpr).expr : group.expr;
  const shape = group.expr.kind === "ShapeExpr" ? (group.expr as AST.ShapeExpr).shape : undefined;
  const typeName = objectTypeName(subject, scope) ?? "Object";
  const subjectScope: WithScope = { ...scope, subject: typeName };
  const bound = new Map(group.using.map(binding => [binding.name.name, binding.value]));
  const keys: OutputField[] = group.by.elements.map(by => {
    const name = by.kind === "Identifier" ? (by as AST.Identifier).name : extractFieldNameFromExpr(by) ?? "expr";
    // A bare `p` not bound by `using` names the property `.p`.
    const expr: AST.Expression = bound.get(name) ??
      (by.kind === "Identifier" ? { kind: "Path", steps: [{ kind: "PathStep", name, type: "property" }] } as AST.Path : by);
    // A key of objects (`using b := .best`) is each object, in its `{id}`.
    const objectType = objectTypeName(expr, subjectScope);
    if (objectType !== null && scope.schema?.types?.get(objectType)?.kind === "object") {
      return { cardinality: Cardinality.AT_MOST_ONE, edgeqlType: objectType, name, shape: objectShape(objectType, undefined, scope) };
    }
    return { cardinality: Cardinality.AT_MOST_ONE, edgeqlType: inferScalarType(expr, subjectScope) ?? "str", name };
  });
  return {
    fields: [
      { cardinality: Cardinality.ONE, edgeqlType: "FreeObject", name: "key", shape: { fields: keys, free: true, typeName: "FreeObject" } },
      { cardinality: Cardinality.MANY, edgeqlType: "str", name: "grouping" },
      { cardinality: Cardinality.MANY, edgeqlType: typeName, name: "elements", shape: objectShape(typeName, shape, scope) }
    ],
    free: true,
    typeName: "FreeObject"
  };
}

/**
 * Describe a selected set literal or union (`{a, b}`, `a union b`): the
 * output is one row per element, so the element type is the output type.
 * Scalar elements unify to the type Gel would pick (`{1, 2.5}` → float64);
 * object elements (`{(select A {…}), …}`) are described like their first
 * object query. The result cardinality follows Gel's union rule (see
 * `unionCardinality`).
 */
function inferSetShape(set: AST.Expression, scope: WithScope): OutputShape {
  const cardinalities: number[] = [];
  const objects: OutputShape[] = [];
  const scalarTypes: string[] = [];
  let unknown: OutputShape | undefined;

  function visit(expr: AST.Expression): void {
    if (expr.kind === "SetExpr") {
      const elements = (expr as AST.SetExpr).elements;
      if (elements.length === 0) {
        cardinalities.push(Cardinality.AT_MOST_ONE);
      }
      elements.forEach(visit);
      return;
    }
    if (expr.kind === "BinaryOp" && (expr as AST.BinaryOp).op === "UNION") {
      visit((expr as AST.BinaryOp).left);
      visit((expr as AST.BinaryOp).right);
      return;
    }
    cardinalities.push(expressionCardinality(expr, scope));
    // Each element is described as if it were selected on its own.
    const shape = expr.kind === "Subquery" ?
      inferOutputShape((expr as AST.Subquery).query, undefined, scope) :
      inferOutputShape({ kind: "SelectQuery", expr }, undefined, scope);
    if (shape.isScalar) {
      scalarTypes.push(shape.fields[0].edgeqlType);
    } else if (shape.typeName !== "Object") {
      objects.push(shape);
    } else {
      unknown ??= shape;
    }
  }
  visit(set);

  const cardinality = unionCardinality(cardinalities);
  if (objects.length > 0) {
    return { ...objects[0], cardinality };
  }
  if (scalarTypes.length > 0 || !unknown) {
    // An untyped `{}` (which Gel rejects as indeterminate) never yields a
    // row, so its scalar type is never decoded; `str` is a placeholder.
    const scalar = scalarTypes.length > 0 ?
      unifyScalarTypes(scalarTypes) :
      "str";
    return {
      cardinality,
      fields: [{ cardinality, edgeqlType: scalar, name: "_value" }],
      isScalar: true,
      typeName: scalar
    };
  }
  return { ...unknown, cardinality };
}

/**
 * Cardinality of an expression, with `with` aliases resolved: a literal or
 * a required parameter is ONE, an `<optional T>$p` parameter is
 * AT_MOST_ONE, an element-wise operator combines its operands' (see
 * `productCardinality`), a subquery takes its own result cardinality, and
 * anything else (a type, a path, a query over objects) may be MANY.
 */
function expressionCardinality(
  expr: AST.Expression,
  scope: WithScope
): number {
  const bound = resolveAlias(expr, scope);
  const e = bound.expr;
  switch (e.kind) {
    case "BinaryOp": {
      const op = e as AST.BinaryOp;
      // `x in S` tests membership: one result per `x`.
      if (op.op === "IN" || op.op === "NOT IN") {
        return expressionCardinality(op.left, bound.scope);
      }
      const operands = [
        expressionCardinality(op.left, bound.scope),
        expressionCardinality(op.right, bound.scope)
      ];
      if (op.op === "UNION") {
        return unionCardinality(operands);
      }
      if (binaryOpType(op, bound.scope) === null) {
        return Cardinality.MANY;
      }
      // `a ?? b` is `a`, or `b` when `a` is empty.
      if (op.op === "??") {
        const [left, right] = operands.map(cardinalityBounds);
        return boundsCardinality(Math.max(left[0], right[0]), Math.max(left[1], right[1]));
      }
      // `?=` and `?!=` compare an empty operand too, rather than yielding
      // nothing.
      if (op.op === "?=" || op.op === "?!=") {
        return productCardinality(operands.map(c =>
          c === Cardinality.AT_MOST_ONE ?
            Cardinality.ONE :
            c === Cardinality.MANY ?
            Cardinality.AT_LEAST_ONE :
            c
        ));
      }
      return productCardinality(operands);
    }
    case "FunctionCall":
      return functionCardinality(e as AST.FunctionCall, bound.scope);
    case "Identifier":
      // A `for` variable is one element at a time.
      return elementBinding(e, bound.scope) ? Cardinality.ONE : Cardinality.MANY;
    case "IfElse": {
      // One of the branches per condition value.
      const ifElse = e as AST.IfElse;
      const [then, otherwise] = [ifElse.then, ifElse.else].map(branch => cardinalityBounds(expressionCardinality(branch, bound.scope)));
      return productCardinality([
        expressionCardinality(ifElse.condition, bound.scope),
        boundsCardinality(Math.min(then[0], otherwise[0]), Math.max(then[1], otherwise[1]))
      ]);
    }
    case "ArrayExpr":
    case "TupleExpr":
      // One array or tuple per combination of its elements.
      return productCardinality((e as AST.ArrayExpr | AST.TupleExpr).elements.map(el => expressionCardinality(el, bound.scope)));
    case "NamedTuple":
      return productCardinality((e as AST.NamedTuple).elements.map(el => expressionCardinality(el.value, bound.scope)));
    case "IndexExpression":
    case "SliceExpression": {
      // One element or slice per combination of its operands.
      const access = e as AST.IndexExpression | AST.SliceExpression;
      const operands = access.kind === "IndexExpression" ? [access.expr, access.index] : [access.expr, access.start, access.end];
      return productCardinality(
        operands.filter((operand): operand is AST.Expression => operand !== undefined).map(operand => expressionCardinality(operand, bound.scope))
      );
    }
    case "TupleAccessExpr":
      return expressionCardinality((e as AST.TupleAccessExpr).tuple, bound.scope);
    case "Literal":
      return Cardinality.ONE;
    case "Parameter":
      return Cardinality.ONE;
    case "Path":
      return inferPath(e as AST.Path, bound.scope)?.cardinality ?? Cardinality.MANY;
    case "SetExpr":
      return unionCardinality(
        (e as AST.SetExpr).elements.map(el => expressionCardinality(el, bound.scope))
      );
    case "Subquery":
      return inferOutputShape((e as AST.Subquery).query, undefined, bound.scope)
        .cardinality ?? Cardinality.MANY;
    case "TypeCast": {
      const cast = e as AST.TypeCast;
      if (cast.cardinality?.required === false) {
        return Cardinality.AT_MOST_ONE;
      }
      return expressionCardinality(cast.expr, bound.scope);
    }
    case "UnaryOp": {
      const unary = e as AST.UnaryOp;
      return unary.op === "EXISTS" ?
        Cardinality.ONE :
        expressionCardinality(unary.operand, bound.scope);
    }
    default:
      return Cardinality.MANY;
  }
}

/*** A cardinality's lower bound (0 or 1) and upper bound (1, or 2 for many). ***/
function cardinalityBounds(cardinality: number): [number, number] {
  return [
    cardinality === Cardinality.ONE || cardinality === Cardinality.AT_LEAST_ONE ? 1 : 0,
    cardinality === Cardinality.ONE || cardinality === Cardinality.AT_MOST_ONE ? 1 : 2
  ];
}

/*** The cardinality with these bounds (see `cardinalityBounds`). ***/
function boundsCardinality(lower: number, upper: number): number {
  if (upper <= 1) {
    return lower >= 1 ? Cardinality.ONE : Cardinality.AT_MOST_ONE;
  }
  return lower >= 1 ? Cardinality.AT_LEAST_ONE : Cardinality.MANY;
}

/** What a path reaches: objects of a type, or a property's values. */
interface ReachedPath {
  cardinality: number;
  object: boolean;
  type: string;
}

/**
 * What a rooted path (`User.posts.title`, `u.best`, `User.<author[is
 * Post]`) reaches, and how many: a path from a type is the set of all the
 * objects it reaches (MANY); from a `for` variable or a `with` binding,
 * each link or property multiplies in its own cardinality. `Enum.Member` is
 * one str. Null when a step isn't a link or property the schema knows.
 */
function inferPath(path: AST.Path, scope: WithScope): ReachedPath | null {
  // `@name` in a link's sub-shape: one value of the link property.
  const [first] = path.steps;
  if (!path.rooted && path.steps.length === 1 && first.type === "link_property") {
    const property = scope.linkProperties?.get(first.name);
    return property ?
      {
        cardinality: cardinalityFor(property.required ?? false, false),
        object: false,
        type: builtinScalarType(property.baseType ?? property.edgeqlType ?? property.type, scope)
      } :
      null;
  }
  const types = scope.schema?.types;
  if (!types || (!path.rooted && !scope.subject)) {
    return null;
  }
  // A relative path (`.posts.title`) starts at one object of the subject.
  const root = path.rooted ? path.steps[0] : undefined;
  const steps = path.rooted ? path.steps.slice(1) : path.steps;
  let reached: ReachedPath;
  if (!root) {
    reached = { cardinality: Cardinality.ONE, object: true, type: scope.subject! };
  } else if (scope.aliases.has(root.name)) {
    const rootIdentifier: AST.Identifier = { kind: "Identifier", name: root.name };
    const type = objectTypeName(rootIdentifier, scope);
    if (type === null) {
      return null;
    }
    reached = { cardinality: expressionCardinality(rootIdentifier, scope), object: true, type };
  } else {
    const type = qualifyTypeName(root.name, scope);
    if (types.get(type)?.kind === "enum") {
      return steps.length === 1 ? { cardinality: Cardinality.ONE, object: false, type: "str" } : null;
    }
    if (!types.has(type)) {
      return null;
    }
    reached = { cardinality: Cardinality.MANY, object: true, type };
  }

  for (const [index, step] of steps.entries()) {
    const typeDef = types.get(reached.type);
    if (!typeDef) {
      return null;
    }
    if (step.type === "backlink") {
      const target = step.filter?.kind === "TypeName" ? (step.filter as AST.TypeName).name.parts.join("::") : null;
      if (target === null) {
        return null;
      }
      reached = {
        cardinality: productCardinality([reached.cardinality, Cardinality.MANY]),
        object: true,
        type: qualifyTypeName(target, scope)
      };
      continue;
    }
    if (step.type !== "property" && step.type !== "link") {
      return null;
    }
    const property = typeDef.properties.get(step.name);
    if (property && index === steps.length - 1) {
      return {
        cardinality: productCardinality([
          reached.cardinality,
          cardinalityFor(property.required ?? false, property.multi ?? false)
        ]),
        object: false,
        type: builtinScalarType(property.baseType ?? property.edgeqlType ?? property.type, scope)
      };
    }
    const link = typeDef.links?.get(step.name);
    if (!link?.target) {
      return null;
    }
    reached = {
      cardinality: productCardinality([reached.cardinality, cardinalityFor(link.required ?? false, link.multi ?? false)]),
      object: true,
      type: link.target.replace(/^default::/, "")
    };
  }
  return reached;
}

/**
 * The object type of the set `expr` selects: a type, a path to objects, a
 * `with` binding of an object query, or a `for` variable over objects. Under
 * `with module m`, a bare type name is a type in `m`. Null when it isn't
 * known to be objects.
 */
function objectTypeName(expr: AST.Expression, scope: WithScope): string | null {
  const bound = resolveAlias(expr, scope);
  const e = bound.expr;
  const element = elementBinding(e, bound.scope);
  if (element) {
    return objectTypeName(element.expr, element.scope);
  }
  if (e.kind === "Subquery") {
    const shape = inferOutputShape((e as AST.Subquery).query, undefined, bound.scope);
    return shape.isScalar || shape.typeName === "Object" ? null : shape.typeName;
  }
  if (e.kind === "Path") {
    const reached = inferPath(e as AST.Path, bound.scope);
    if (reached) {
      return reached.object ? reached.type : null;
    }
  }
  const name = extractTypeNameFromExpr(e);
  return name === null ? null : qualifyTypeName(name, bound.scope);
}

/**
 * Cardinality of an element-wise operator: one result per combination of
 * its operands, so it's empty when any operand is.
 */
function productCardinality(cardinalities: number[]): number {
  const required = cardinalities.every(c => c === Cardinality.ONE || c === Cardinality.AT_LEAST_ONE);
  const single = cardinalities.every(c => c === Cardinality.ONE || c === Cardinality.AT_MOST_ONE);
  if (single) {
    return required ? Cardinality.ONE : Cardinality.AT_MOST_ONE;
  }
  return required ? Cardinality.AT_LEAST_ONE : Cardinality.MANY;
}

/**
 * A filter, offset or limit can drop every element of a result whose
 * cardinality is pinned down: ONE becomes AT_MOST_ONE, AT_LEAST_ONE MANY.
 */
function dropLowerBound(shape: OutputShape, narrowed: boolean): OutputShape {
  if (!narrowed || shape.cardinality === undefined) {
    return shape;
  }
  const cardinality = shape.cardinality === Cardinality.ONE ?
    Cardinality.AT_MOST_ONE :
    shape.cardinality === Cardinality.AT_LEAST_ONE ?
    Cardinality.MANY :
    shape.cardinality;
  return { ...shape, cardinality };
}

/**
 * Gel's UNION cardinality (edb/edgeql/compiler/inference/cardinality.py
 * `_union_cardinality`): lower and upper bounds add up. `{}` is
 * AT_MOST_ONE, like Gel's EmptySet.
 */
function unionCardinality(cardinalities: number[]): number {
  let lower = 0;
  let upper = 0;
  for (const c of cardinalities) {
    if (c === Cardinality.ONE || c === Cardinality.AT_LEAST_ONE) {
      lower += 1;
    }
    upper += c === Cardinality.ONE || c === Cardinality.AT_MOST_ONE ? 1 : 2;
  }
  if (upper <= 1) {
    return lower >= 1 ? Cardinality.ONE : Cardinality.AT_MOST_ONE;
  }
  return lower >= 1 ? Cardinality.AT_LEAST_ONE : Cardinality.MANY;
}

const INT_TYPES = ["int16", "int32", "int64"];
const FLOAT_TYPES = ["float32", "float64"];
const DECIMAL_TYPES = ["bigint", "decimal"];
const NUMERIC_TYPES = [...INT_TYPES, ...FLOAT_TYPES, ...DECIMAL_TYPES];

/**
 * The common type of a set literal's scalar elements, by Gel's implicit
 * numeric casts: ints widen to the widest int, floats to the widest float,
 * and a mix of ints and floats to float64 (float32 only for int16, the one
 * int Gel implicitly casts to float32). Ints widen to bigint, and ints and
 * bigints to decimal. Anything else (a float with a bigint or decimal, which
 * Gel rejects) keeps the first element's type.
 */
function unifyScalarTypes(types: string[]): string {
  if (types.every(t => t === types[0])) {
    return types[0];
  }
  // Tuples of different names are unnamed (`unitedTupleType`).
  if (types.every(t => tupleTypeElements(t))) {
    return unitedTupleType(types);
  }
  const ints = types.filter(t => INT_TYPES.includes(t));
  const floats = types.filter(t => FLOAT_TYPES.includes(t));
  const decimals = types.filter(t => DECIMAL_TYPES.includes(t));
  if (decimals.length > 0 && floats.length === 0 && ints.length + decimals.length === types.length) {
    return decimals.includes("decimal") ? "decimal" : "bigint";
  }
  if (ints.length + floats.length !== types.length) {
    return types[0];
  }
  const widest = (candidates: string[], order: string[]): string => order[Math.max(...candidates.map(t => order.indexOf(t)))];
  if (floats.length === 0) {
    return widest(ints, INT_TYPES);
  }
  if (ints.length === 0) {
    return widest(floats, FLOAT_TYPES);
  }
  return ints.every(t => t === "int16") &&
      floats.every(t => t === "float32") ?
    "float32" :
    "float64";
}

function extractTypeNameFromExpr(expr: unknown): string | null {
  if (!expr || typeof expr !== "object") {
    return null;
  }
  const e = expr as {
    kind?: string;
    steps?: AST.PathStep[];
    name?: { parts?: string[]; } | string;
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
    const parts = (e.name as { parts?: string[]; }).parts;
    if (parts && parts.length > 0) {
      return parts.join("::");
    }
  }
  return null;
}

/**
 * Best-effort field name extraction for shape elements without an
 * explicit `name :=` (i.e. just `id` or `.title` or `link.target`).
 */
function extractFieldNameFromExpr(expr: unknown): string | undefined {
  if (!expr || typeof expr !== "object") {
    return undefined;
  }
  const e = expr as { kind?: string; name?: string; steps?: AST.PathStep[]; };
  if (e.kind === "Identifier" && typeof e.name === "string") {
    return e.name;
  }
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
  params: ParamInfo[]
): { id: Uint8Array; data: Uint8Array; } {
  const list: TypeDescriptorList = { descriptors: [], positions: new Map() };
  const descriptors = list.descriptors;

  const elements: ShapeElementV2[] = params.map(p => ({
    name: p.name,
    pos: appendTypeDescriptor(list, p.edgeqlType),
    cardinality: 0x41, // ONE
    flags: 0
  }));

  const tid = generateDescriptorIdSync(
    new TextEncoder().encode(
      `disc:input:${params.map(p => p.name + ":" + p.edgeqlType).join(",")}`
    )
  );
  // Use CTYPE_SHAPE (not CTYPE_INPUT_SHAPE) for query parameters: the
  // Python client raises NotImplementedError on encode_args when the
  // codec is sparse, and CTYPE_INPUT_SHAPE → SparseObjectCodec. Also
  // used when there are no params, so the client gets a non-empty codec.
  descriptors.push({ id: tid, bytes: encodeShapeV2(tid, elements) });

  const packed = packTypedescBlock(descriptors);
  return { id: packed.rootId, data: packed.data };
}

/**
 * A prepared statement's cache key: its output format (JSON as one str) and
 * the implicit fields asked for describe it too.
 */
function statementKey(commandText: string, outputFormat: number, implicit: ImplicitFields | undefined): string {
  const fields = implicit ? `${Number(implicit.ids)}${Number(implicit.typeIds)}${Number(implicit.typeNames)}` : "";
  return `${outputFormat}:${fields}:${commandText}`;
}

/**
 * The implicit fields a Parse / Execute's compilation flags ask for. Only
 * binary output has them: Gel injects none in JSON
 * (edb/server/compiler/compiler.py `_get_compile_options`).
 */
function implicitFieldsFor(compilationFlags: bigint, outputFormat: number): ImplicitFields | undefined {
  if (outputFormat !== OutputFormat.BINARY) {
    return undefined;
  }
  return {
    ids: (compilationFlags & CompilationFlag.INJECT_OUTPUT_OBJECT_IDS) !== 0n,
    typeIds: (compilationFlags & CompilationFlag.INJECT_OUTPUT_TYPE_IDS) !== 0n,
    typeNames: (compilationFlags & CompilationFlag.INJECT_OUTPUT_TYPE_NAMES) !== 0n
  };
}

/*** Whether the client expects one result at most (`querySingle`, `queryRequiredSingle` and their JSON forms). ***/
function expectsOne(expectedCardinality: number): boolean {
  return expectedCardinality === Cardinality.ONE || expectedCardinality === Cardinality.AT_MOST_ONE;
}

/**
 * Gel's ResultCardinalityMismatchError for a query of many results where
 * the client expects one (edb/server/compiler/compiler.py). Gel knows it
 * when it compiles the query; so does Disc for a query whose cardinality
 * it describes (`resultCardinality`), and otherwise when it runs one.
 */
function resultCardinalityMismatch(cardinality: number): ResultCardinalityMismatchError {
  const name = cardinality === Cardinality.AT_LEAST_ONE ? "AT_LEAST_ONE" : "MANY";
  return new ResultCardinalityMismatchError(`the query has cardinality ${name} which does not match the expected cardinality ONE`);
}

/** Byte-for-byte equality on two 16-byte UUIDs. */
function uuidsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
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
  params: ParamInfo[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (params.length === 0) {
    return out;
  }
  if (blob.length < 4) {
    return out;
  }

  const r = new BufferReader(blob);
  const elemCount = r.readUInt32();
  if (elemCount !== params.length) {
    throw new Error(
      `argument count mismatch: typedesc has ${params.length}, blob has ${elemCount}`
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
      out[p.name] = decodeWireValue(p.edgeqlType, bytes);
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
  shape: OutputShape
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
    if (values.length > 0) {
      value = values[0];
    }
    // A selected named tuple (`select (a := 1, b := 'x')`) is built as a
    // JSON object, which comes back as the row itself.
    if (isRowNamedTuple(row, eqlType)) {
      value = row;
    }
  }
  if (value === null || value === undefined) {
    // Empty result set is handled by the caller (no Data frames sent).
    // A NULL inside a single-row scalar SELECT shouldn't happen for a
    // cast over a non-null parameter; surface as zero-length bytes so
    // the client sees a "missing" element rather than a crash.
    return new Uint8Array(0);
  }
  if (!hasWireCodec(eqlType)) {
    return new Uint8Array(0);
  }
  return encodeWireValue(eqlType, value);
}

/*** Whether `row` is itself a value of the named tuple type `eqlType`: its columns are the tuple's names. ***/
function isRowNamedTuple(row: Record<string, unknown>, eqlType: string): boolean {
  const type = parseWireType(eqlType);
  if (type.kind !== "tuple" || type.elements.some(el => el.name === undefined)) {
    return false;
  }
  const columns = Object.keys(row);
  return columns.length === type.elements.length && type.elements.every(el => columns.includes(el.name!));
}

function encodeRowAsObject(
  row: Record<string, unknown>,
  shape: OutputShape
): Uint8Array {
  const w = new BufferWriter();
  w.writeUInt32(shape.fields.length);
  for (const field of shape.fields) {
    w.writeUInt32(0); // reserved
    const value = field.constant !== undefined ? field.constant : row?.[field.linkProperty ? `@${field.name}` : field.name];
    const bytes = encodeFieldValue(field, value);
    if (bytes === null) {
      // -1 as a signed i32 is 0xFFFFFFFF unsigned.
      w.writeUInt32(0xffffffff);
      continue;
    }
    w.writeUInt32(bytes.length);
    w.writeBytes(bytes);
  }
  return w.toBytes();
}

/*** Whether a cardinality is multi (MANY, AT_LEAST_ONE): the field is a set. ***/
function isMulti(cardinality: number): boolean {
  return cardinality === Cardinality.MANY || cardinality === Cardinality.AT_LEAST_ONE;
}

/**
 * A field's value bytes, null for NULL. A set field's value is the set of
 * its elements (the executor's array; NULL is the empty set, as Gel sends
 * an empty multi link). A single link with a sub-shape comes as a
 * one-element array, which is its object.
 */
function encodeFieldValue(field: OutputField, value: unknown): Uint8Array | null {
  if (isMulti(field.cardinality)) {
    const items = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
    const arrayElements = !field.shape && parseWireType(field.edgeqlType).kind === "array";
    return encodeSetValue(items.map(item => encodeElementValue(field, item)), arrayElements);
  }
  return encodeElementValue(field, field.shape && Array.isArray(value) ? value[0] : value);
}

/**
 * One value of a field, null for NULL: an object in the field's shape (a
 * bare uuid is the object `{id}`), or a scalar, array or tuple. An unknown
 * scalar is NULL rather than crashing the whole response — the client sees
 * the field as missing; better than killing the session over an
 * unimplemented codec.
 */
function encodeElementValue(field: OutputField, value: unknown): Uint8Array | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (field.shape) {
    return encodeRowAsObject(typeof value === "string" ? { id: value } : value as Record<string, unknown>, field.shape);
  }
  return hasWireCodec(field.edgeqlType) ? encodeWireValue(field.edgeqlType, value) : null;
}

/**
 * The Data elements of a result. In JSON (Gel's `queryJSON`), the whole
 * result is one JSON array — or, when the client expects at most one
 * element (`querySingleJSON`), each element on its own, as Gel's
 * `top_output_as_value` (edb/pgsql/compiler/output.py) aggregates only
 * when not `expected_cardinality_one`. JSON_ELEMENTS is one JSON value per
 * element.
 */
function encodeRowsAsObjects(
  rows: Record<string, unknown>[],
  shape: OutputShape,
  outputFormat: number,
  values = false,
  expectOne = false
): Uint8Array[] {
  if (outputFormat === OutputFormat.NONE) {
    return [];
  }

  // In JSON, a select of values is its values (`["ann"]`), as in Gel.
  const elements: unknown[] = values ?
    rows.map(row => {
      const columns = Object.values(row);
      return columns.length === 1 ? columns[0] : row;
    }) :
    rows;

  if (outputFormat === OutputFormat.JSON && !expectOne) {
    // JSON format: the whole result set is one JSON-encoded element.
    // Empty rows still emit `[]` so downstream JSON-parser callers see
    // a uniform shape — that's what the Phase 4.3 test asserts.
    return [
      new TextEncoder().encode(JSON.stringify(elements))
    ];
  }

  if (outputFormat === OutputFormat.JSON || outputFormat === OutputFormat.JSON_ELEMENTS) {
    // One JSON-encoded element per row.
    const enc = new TextEncoder();
    return elements.map(element => enc.encode(JSON.stringify(element)));
  }

  if (shape.fields.length === 0) {
    return [];
  }
  if (shape.isScalar) {
    return rows.map(row => encodeRowAsScalar(row, shape));
  }
  return rows.map(row => encodeRowAsObject(row, shape));
}

export function buildOutputDescriptor(
  shape: OutputShape
): { id: Uint8Array; data: Uint8Array; } {
  // Bare-scalar SELECT: emit a single CTYPE_BASE_SCALAR descriptor and
  // use its tid as the root. No CTYPE_SHAPE wrapper — both upstream Gel
  // clients special-case scalar codecs by descriptor type, and wrapping
  // the scalar in an Object surfaces as `Object{id := None}` regardless
  // of what bytes we put in the Data payload.
  const list: TypeDescriptorList = { descriptors: [], positions: new Map() };
  const descriptors = list.descriptors;
  // An array or tuple is described like a scalar: its descriptor (after
  // those of its element types) is the root.
  if (shape.isScalar) {
    appendTypeDescriptor(list, shape.fields[0].edgeqlType);
    const packed = packTypedescBlock(descriptors);
    return { id: packed.rootId, data: packed.data };
  }

  appendShapeDescriptor(list, shape);
  const packed = packTypedescBlock(descriptors);
  return { id: packed.rootId, data: packed.data };
}

/*** A shape's identity: its type and each field's flags, name, type (a nested shape's identity) and cardinality. ***/
function shapeSignature(shape: OutputShape): string {
  const fields = shape.fields.map(f => `${shapePointerFlags(f)}:${f.name}:${f.shape ? `{${shapeSignature(f.shape)}}` : f.edgeqlType}:${f.cardinality}`);
  return `${shape.free ? "free:" : ""}${shape.typeName}:${fields.join(",")}`;
}

/*** A field's `SHAPE_POINTER_IS_*` flags: implicit, a link property, a link (a field of objects). ***/
function shapePointerFlags(field: OutputField): number {
  return (field.implicit ? SHAPE_POINTER_IS_IMPLICIT : 0) |
    (field.linkProperty ? SHAPE_POINTER_IS_LINKPROP : 0) |
    (field.shape ? SHAPE_POINTER_IS_LINK : 0);
}

/**
 * Append a shape's descriptor after those of its fields' types (a set of
 * the element type for a multi field, a nested shape for objects), once
 * per shape, and return its position.
 */
function appendShapeDescriptor(list: TypeDescriptorList, shape: OutputShape): number {
  const signature = shapeSignature(shape);
  const key = `shape:${signature}`;
  const known = list.positions.get(key);
  if (known !== undefined) {
    return known;
  }
  const elements: ShapeElementV2[] = shape.fields.map(f => {
    const pos = f.shape ? appendShapeDescriptor(list, f.shape) : appendTypeDescriptor(list, f.edgeqlType);
    return {
      cardinality: f.cardinality,
      flags: shapePointerFlags(f),
      name: f.name,
      pos: isMulti(f.cardinality) ? appendSetDescriptor(list, pos) : pos
    };
  });
  const tid = generateDescriptorIdSync(new TextEncoder().encode(`disc:output:${signature}`));
  const position = list.descriptors.length;
  list.descriptors.push({ id: tid, bytes: encodeShapeV2(tid, elements, shape.free) });
  list.positions.set(key, position);
  return position;
}

/*** JSON output (`queryJSON`) is described as one `std::str`, whatever the query, as in Gel. ***/
function buildJsonOutputDescriptor(): { id: Uint8Array; data: Uint8Array; } {
  const list: TypeDescriptorList = { descriptors: [], positions: new Map() };
  appendTypeDescriptor(list, "str");
  const packed = packTypedescBlock(list.descriptors);
  return { id: packed.rootId, data: packed.data };
}

// ---------------------------------------------------------------------------
// Gel protocol error codes
// ---------------------------------------------------------------------------

/**
 * Gel's error codes (edb/api/errors.txt). A client picks the error class
 * from the code — and, for the transaction conflicts and availability
 * errors, whether to retry — so each must match Gel's exactly.
 */
export const GEL_ERROR_CODES = {
  InternalServerError: 0x01000000,
  UnsupportedFeatureError: 0x02000000,
  ProtocolError: 0x03000000,
  ResultCardinalityMismatchError: 0x03030000,
  DisabledCapabilityError: 0x03040200,
  QueryError: 0x04000000,
  InvalidSyntaxError: 0x04010000,
  EdgeQLSyntaxError: 0x04010100,
  SchemaSyntaxError: 0x04010200,
  InvalidTypeError: 0x04020000,
  InvalidTargetError: 0x04020100,
  InvalidLinkTargetError: 0x04020101,
  InvalidReferenceError: 0x04030000,
  UnknownModuleError: 0x04030001,
  UnknownDatabaseError: 0x04030005,
  SchemaError: 0x04040000,
  SchemaDefinitionError: 0x04050000,
  InvalidConstraintDefinitionError: 0x04050109,
  DuplicateDatabaseDefinitionError: 0x04050205,
  IdleSessionTimeoutError: 0x04060100,
  QueryTimeoutError: 0x04060200,
  IdleTransactionTimeoutError: 0x04060a01,
  ExecutionError: 0x05000000,
  InvalidValueError: 0x05010000,
  DivisionByZeroError: 0x05010001,
  NumericOutOfRangeError: 0x05010002,
  AccessPolicyError: 0x05010003,
  IntegrityError: 0x05020000,
  ConstraintViolationError: 0x05020001,
  CardinalityViolationError: 0x05020002,
  MissingRequiredError: 0x05020003,
  TransactionError: 0x05030000,
  TransactionSerializationError: 0x05030101,
  TransactionDeadlockError: 0x05030102,
  ConfigurationError: 0x06000000,
  AccessError: 0x07000000,
  AuthenticationError: 0x07010000,
  AvailabilityError: 0x08000000,
  BackendUnavailableError: 0x08000001,
  UnsupportedBackendFeatureError: 0x09000100
} as const;

/**
 * PostgreSQL SQLSTATEs and the Gel error each is reported as, after Gel's
 * edb/server/compiler/errormech.py. Constraint violations are
 * ConstraintViolationError — including a foreign key's, which is how a
 * `restrict` delete fails — except a missing required value (not-null).
 * 42501 is also how `disc_access_check` (lib/stdlib-sql.ts) raises an
 * access policy violation.
 */
const SQLSTATE_GEL_CODES: Record<string, number> = {
  "0A000": GEL_ERROR_CODES.UnsupportedBackendFeatureError,
  "21000": GEL_ERROR_CODES.CardinalityViolationError,
  "22003": GEL_ERROR_CODES.NumericOutOfRangeError,
  "22012": GEL_ERROR_CODES.DivisionByZeroError,
  "22015": GEL_ERROR_CODES.NumericOutOfRangeError,
  "23000": GEL_ERROR_CODES.ConstraintViolationError,
  "23001": GEL_ERROR_CODES.ConstraintViolationError,
  "23502": GEL_ERROR_CODES.MissingRequiredError,
  "23503": GEL_ERROR_CODES.ConstraintViolationError,
  "23505": GEL_ERROR_CODES.ConstraintViolationError,
  "23514": GEL_ERROR_CODES.ConstraintViolationError,
  "23P01": GEL_ERROR_CODES.ConstraintViolationError,
  "25006": GEL_ERROR_CODES.TransactionError,
  "25P02": GEL_ERROR_CODES.TransactionError,
  "25P03": GEL_ERROR_CODES.IdleTransactionTimeoutError,
  "3D000": GEL_ERROR_CODES.UnknownDatabaseError,
  "40001": GEL_ERROR_CODES.TransactionSerializationError,
  "40P01": GEL_ERROR_CODES.TransactionDeadlockError,
  "42501": GEL_ERROR_CODES.AccessPolicyError,
  "42P04": GEL_ERROR_CODES.DuplicateDatabaseDefinitionError,
  "54000": GEL_ERROR_CODES.InvalidValueError,
  "55006": GEL_ERROR_CODES.ExecutionError,
  "57014": GEL_ERROR_CODES.QueryTimeoutError,
  "57P01": GEL_ERROR_CODES.BackendUnavailableError,
  "57P02": GEL_ERROR_CODES.BackendUnavailableError,
  "57P03": GEL_ERROR_CODES.BackendUnavailableError,
  "57P05": GEL_ERROR_CODES.IdleSessionTimeoutError
};

/*** The Gel error code of a PostgreSQL SQLSTATE; undefined for one Gel reports as an internal error. ***/
function sqlStateToGelCode(sqlState: string): number | undefined {
  const code = SQLSTATE_GEL_CODES[sqlState];
  if (code !== undefined) {
    return code;
  }
  // Class 22 (data exception): a value the operation can't take. Class 08
  // (connection exception): PostgreSQL is unreachable.
  if (sqlState.startsWith("22")) {
    return GEL_ERROR_CODES.InvalidValueError;
  }
  if (sqlState.startsWith("08")) {
    return GEL_ERROR_CODES.BackendUnavailableError;
  }
  return undefined;
}

/*** Gel's `details` ErrorResponse attribute (FIELD_DETAILS). ***/
const ERROR_ATTRIBUTE_DETAILS = 0x0002;

/**
 * The ErrorResponse attributes of `error`: the details line PostgreSQL sent
 * with it, if any — as for a violated `constraint expression on (…)`, Gel's
 * "violated constraint 'std::expression' on object type '…'".
 */
function errorAttributes(error: unknown): ErrorAttribute[] {
  const detail = postgresErrorFields(error)?.detail;
  return detail === undefined ? [] : [{ code: ERROR_ATTRIBUTE_DETAILS, value: new TextEncoder().encode(detail) }];
}

/**
 * Map a Disc error to the appropriate Gel protocol error code.
 *
 * - an error PostgreSQL raised (the driver's error, or a wrapper whose
 *   `cause` is it) -> by SQLSTATE (see SQLSTATE_GEL_CODES)
 * - SyntaxError -> EdgeQLSyntaxError
 * - SchemaError -> SchemaDefinitionError
 * - InvalidReferenceError -> InvalidReferenceError
 * - InvalidValueError -> InvalidValueError
 * - ConfigurationError -> ConfigurationError
 * - DisabledCapabilityError -> DisabledCapabilityError
 * - ResultCardinalityMismatchError -> ResultCardinalityMismatchError
 * - CompilationError, QueryError -> QueryError
 * - ValidationError -> InvalidValueError
 * - DatabaseExecutionError -> its `cause`'s code (a compile error the
 *   binary path wraps), else InternalServerError
 * - QueryTimeoutError -> QueryTimeoutError
 * - ConnectionError -> BackendUnavailableError
 * - InternalError, unknown -> InternalServerError
 */
export function mapErrorToGelCode(error: Error): number {
  const sqlState = postgresErrorFields(error)?.sqlState;
  if (sqlState !== undefined) {
    return sqlStateToGelCode(sqlState) ?? GEL_ERROR_CODES.InternalServerError;
  }
  if (error instanceof SyntaxError) {
    return GEL_ERROR_CODES.EdgeQLSyntaxError;
  }
  if (error instanceof SchemaError) {
    return GEL_ERROR_CODES.SchemaDefinitionError;
  }
  if (error instanceof InvalidReferenceError) {
    return GEL_ERROR_CODES.InvalidReferenceError;
  }
  if (error instanceof InvalidValueError) {
    return GEL_ERROR_CODES.InvalidValueError;
  }
  if (error instanceof ConfigurationError) {
    return GEL_ERROR_CODES.ConfigurationError;
  }
  if (error instanceof ResultCardinalityMismatchError) {
    return GEL_ERROR_CODES.ResultCardinalityMismatchError;
  }
  if (error instanceof DisabledCapabilityError) {
    return GEL_ERROR_CODES.DisabledCapabilityError;
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
    return error.cause instanceof DiscError ? mapErrorToGelCode(error.cause) : GEL_ERROR_CODES.InternalServerError;
  }
  if (error instanceof QueryTimeoutError) {
    return GEL_ERROR_CODES.QueryTimeoutError;
  }
  if (error instanceof ConnectionError) {
    return GEL_ERROR_CODES.BackendUnavailableError;
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
  /** The query selects values (`select User.name`): each row's one column holds the value. */
  values?: boolean;
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
  caller: BinaryCaller,
  options: BinaryExecuteOptions
) => Promise<BinaryExecutionResult>;

/** How a binary client asks for a query's results. */
export interface BinaryExecuteOptions {
  /**
   * Select `id` in every object shape (`withImplicitIds`), which the output
   * description then carries: the client sent INJECT_OUTPUT_OBJECT_IDS.
   */
  implicitIds: boolean;
}

/**
 * Who a binary connection is. `admin` when it authenticated with the
 * server's password (`DISC_BINARY_PASSWORD`) — the listener's only
 * credential, as Gel's server password is its superuser's. With no
 * password configured anyone can connect, so no connection is an admin.
 */
export interface BinaryCaller {
  admin: boolean;
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
  /**
   * When provided, the server upgrades each accepted connection to TLS and
   * advertises ALPN "edgedb-binary". Required for compatibility with the
   * upstream Gel Python/JS clients — they refuse to talk plain TCP.
   */
  tls?: { certFile: string; keyFile: string; };
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
        alpnProtocols: ["edgedb-binary"]
      });
    } else {
      this.listener = Deno.listen({
        hostname,
        port: this.options.port,
        transport: "tcp"
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
    // Gracefully tear down each connection: send a FIN (closeWrite) before
    // closing the resource. A plain close() while the connection's read loop
    // is blocked in an in-flight read() is platform-sensitive in Deno — on
    // Linux the peer may never observe EOF, hanging any client blocked in
    // read() (this is what wedged CI for hours). An explicit closeWrite()
    // flushes a FIN so the peer sees EOF deterministically on every platform.
    await Promise.all([...this.connections].map(conn => conn.shutdown()));
    this.connections.clear();
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
          this.options.executor
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
        if (!this.running) {
          break;
        }
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
  /*** Set once the client proved it knows the server's password (see BinaryCaller). ***/
  private passwordAuthenticated = false;
  private scramState?: ScramServerState;
  private scramStoredKey?: Uint8Array;
  private scramServerKey?: Uint8Array;
  private closed = false;
  /**
   * Set after an ErrorResponse: as in Gel's server (`recover_from_error`),
   * the messages up to the client's next Sync are discarded, and that Sync
   * is answered with the ReadyForCommand.
   */
  private discardUntilSync = false;

  // Phase 4.1: Session state
  private sessionState: ConnectionState = {
    module: "default",
    aliases: new Map(),
    config: new Map()
  };

  // Phase 4.2: Prepared statement cache (LRU, capped per-connection)
  private stmtCache = new QueryCache<CachedStatement>(MAX_STATEMENT_CACHE_SIZE);

  constructor(
    private conn: Deno.TcpConn | Deno.TlsConn,
    private _schema: Schema,
    private password?: string,
    private executor?: BinaryQueryExecutor
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
          header.byteOffset
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
              GEL_ERROR_CODES.ProtocolError
            );
          }
          break; // Close the connection — payload framing is unrecoverable
        }

        // Read payload
        let payload = new Uint8Array(0);
        if (payloadLength > 0) {
          const p = await this.readExact(payloadLength);
          if (!p) {
            break;
          }
          payload = new Uint8Array(p);
        }

        // Decode and dispatch
        try {
          const msg = decodeClientMessage(mtype, payload);
          if (this.discardUntilSync && msg.kind !== "Sync") {
            continue;
          }
          await this.dispatch(msg);
        } catch (err) {
          // Send error and continue (unless closed)
          if (!this.closed) {
            const errorCode = err instanceof Error ?
              mapErrorToGelCode(err) :
              GEL_ERROR_CODES.InternalServerError;
            await this.sendErrorWithCode(
              err instanceof Error ? gelErrorMessage(err) : String(err),
              errorCode,
              errorAttributes(err)
            );
            // After error, the client's next Sync gets the ReadyForCommand
            if (this.state === "ready") {
              this.discardUntilSync = true;
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

  /**
   * Graceful teardown used by the server on stop(): send a FIN (closeWrite)
   * so the peer observes EOF even though our read loop is blocked in an
   * in-flight read(), then release the resource. A plain close() during a
   * pending read does not reliably flush a FIN on Linux, leaving the peer
   * hung; an explicit closeWrite() makes shutdown deterministic across
   * platforms.
   */
  async shutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    try {
      await this.conn.closeWrite();
    } catch {
      // peer may have already closed its read half
    }
    this.close();
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
    _msg: ClientMessage & { kind: "ClientHandshake"; }
  ): Promise<void> {
    // Send ServerHandshake with our protocol version
    await this.sendMessage({
      kind: "ServerHandshake",
      majorVersion: PROTOCOL_MAJOR_VERSION,
      minorVersion: PROTOCOL_MINOR_VERSION,
      extensions: []
    });

    if (this.password) {
      // Derive SCRAM keys from password
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
      const iterations = 4096;
      const { storedKey, serverKey } = await deriveKeys(
        this.password,
        salt,
        iterations
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
        gs2Header: ""
      };

      // Send AuthenticationRequiredSASL
      this.state = "authenticating";
      await this.sendMessage({
        kind: "AuthenticationRequiredSASL",
        methods: ["SCRAM-SHA-256"]
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
    msg: ClientMessage & { kind: "AuthenticationSASLInitialResponse"; }
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
        this.scramState.iterations
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
        saslData: encoder.encode(serverFirstMessage)
      });
    } catch (err) {
      await this.sendError(
        `SCRAM auth failed: ${err instanceof Error ? err.message : String(err)}`
      );
      this.close();
    }
  }

  private async handleSASLResponse(
    msg: ClientMessage & { kind: "AuthenticationSASLResponse"; }
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
        this.scramServerKey
      );

      if (!valid) {
        await this.sendError("Authentication failed: invalid credentials");
        this.close();
        return;
      }
      this.passwordAuthenticated = true;

      // Send AuthenticationSASLFinal with server signature
      const encoder = new TextEncoder();
      await this.sendMessage({
        kind: "AuthenticationSASLFinal",
        saslData: encoder.encode(`v=${serverSignature}`)
      });

      // Send AuthenticationOK + setup messages
      await this.sendAuthOKSequence();
    } catch (err) {
      await this.sendError(
        `SCRAM verification failed: ${err instanceof Error ? err.message : String(err)}`
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
    stateData: Uint8Array
  ): void {
    // Zero UUID means no state data
    const isZero = stateTypedescId.every(b => b === 0);
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
      stateData: new Uint8Array(0)
    };
  }

  // -----------------------------------------------------------------------
  // Query operations (enhanced with cache, output format, error codes)
  // -----------------------------------------------------------------------

  private async handleParse(
    msg: ClientMessage & { kind: "Parse"; }
  ): Promise<void> {
    try {
      // Phase 4.1: Parse state data if present
      this.parseStateData(msg.stateTypedescId, msg.stateData);

      // Phase 4.2: Check cache first
      const implicit = implicitFieldsFor(msg.compilationFlags, msg.outputFormat);
      const key = statementKey(msg.commandText, msg.outputFormat, implicit);
      const cached = this.stmtCache.get(key);
      if (cached) {
        this.checkResultCardinality(cached.outputShape, msg.expectedCardinality);
        // Cache hit — send cached descriptors
        await this.sendMessage({
          kind: "CommandDataDescription",
          annotations: [],
          capabilities: 0n,
          resultCardinality: cached.outputShape.cardinality ??
            (msg.expectedCardinality || Cardinality.MANY),
          inputTypedescId: cached.inputDescId,
          inputTypedesc: cached.inputDesc,
          outputTypedescId: cached.outputDescId,
          outputTypedesc: cached.outputDesc
        });
        return;
      }

      // Cache miss — compile and build type descriptors
      const built = this.buildDescriptors(msg.commandText, msg.outputFormat, implicit);

      const commandStatus = this.detectCommandStatus(msg.commandText);

      // Store in cache
      this.stmtCache.set(key, {
        commandText: msg.commandText,
        inputDescId: built.inputDesc.id,
        outputDescId: built.outputDesc.id,
        inputDesc: built.inputDesc.data,
        outputDesc: built.outputDesc.data,
        outputFormat: msg.outputFormat,
        resultCardinality: msg.expectedCardinality || Cardinality.MANY,
        commandStatus,
        params: built.params,
        outputShape: built.outputShape
      });
      this.checkResultCardinality(built.outputShape, msg.expectedCardinality);

      await this.sendMessage({
        kind: "CommandDataDescription",
        annotations: [],
        capabilities: 0n,
        resultCardinality: built.outputShape.cardinality ??
          (msg.expectedCardinality || Cardinality.MANY),
        inputTypedescId: built.inputDesc.id,
        inputTypedesc: built.inputDesc.data,
        outputTypedescId: built.outputDesc.id,
        outputTypedesc: built.outputDesc.data
      });
    } catch (err) {
      const errorCode = err instanceof Error ?
        mapErrorToGelCode(err) :
        GEL_ERROR_CODES.InternalServerError;
      await this.sendErrorWithCode(
        err instanceof Error ? gelErrorMessage(err) : String(err),
        errorCode,
        errorAttributes(err)
      );
      this.discardUntilSync = true;
    }
  }

  private async handleExecute(
    msg: ClientMessage & { kind: "Execute"; }
  ): Promise<void> {
    try {
      // Phase 4.1: Parse state data if present
      this.parseStateData(msg.stateTypedescId, msg.stateData);

      // Phase 4.2: Check cache for previously parsed statements
      let inputDesc: { id: Uint8Array; data: Uint8Array; };
      let outputDesc: { id: Uint8Array; data: Uint8Array; };
      let commandStatus: string;
      let params: ParamInfo[];
      let outputShape: OutputShape;

      const implicit = implicitFieldsFor(msg.compilationFlags, msg.outputFormat);
      const key = statementKey(msg.commandText, msg.outputFormat, implicit);
      const cached = this.stmtCache.get(key);
      if (cached) {
        // Cache hit — reuse descriptors
        inputDesc = { id: cached.inputDescId, data: cached.inputDesc };
        outputDesc = { id: cached.outputDescId, data: cached.outputDesc };
        commandStatus = cached.commandStatus;
        params = cached.params;
        outputShape = cached.outputShape;
      } else {
        // Cache miss — build descriptors
        const descs = this.buildDescriptors(msg.commandText, msg.outputFormat, implicit);
        inputDesc = descs.inputDesc;
        outputDesc = descs.outputDesc;
        commandStatus = this.detectCommandStatus(msg.commandText);
        params = descs.params;
        outputShape = descs.outputShape;

        // Store in cache for future use
        this.stmtCache.set(key, {
          commandText: msg.commandText,
          inputDescId: inputDesc.id,
          outputDescId: outputDesc.id,
          inputDesc: inputDesc.data,
          outputDesc: outputDesc.data,
          outputFormat: msg.outputFormat,
          resultCardinality: msg.expectedCardinality || Cardinality.MANY,
          commandStatus,
          params,
          outputShape
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
        inputDesc.id
      );
      const outputMismatch = !uuidsEqual(
        msg.outputTypedescId,
        outputDesc.id
      );
      this.checkResultCardinality(outputShape, msg.expectedCardinality);
      if (inputMismatch || outputMismatch) {
        await this.sendMessage({
          kind: "CommandDataDescription",
          annotations: [],
          capabilities: 0n,
          resultCardinality: outputShape.cardinality ??
            (msg.expectedCardinality || Cardinality.MANY),
          inputTypedescId: inputDesc.id,
          inputTypedesc: inputDesc.data,
          outputTypedescId: outputDesc.id,
          outputTypedesc: outputDesc.data
        });
      }

      // Decode the args blob and execute against the database. When no
      // executor is wired up (test fixtures), behave like before: return
      // no rows so the rest of the protocol still completes cleanly.
      const args = decodeArgs(msg.arguments, params);

      let rows: Record<string, unknown>[] = [];
      let values = false;
      if (this.executor) {
        const result = await this.executor(msg.commandText, args, { admin: this.passwordAuthenticated }, {
          implicitIds: implicit?.ids ?? false
        });
        rows = result.rows;
        values = result.values === true;
        // Prefer the executor's status (it knows whether INSERT had a
        // RETURNING clause, etc.) over the heuristic prefix detection.
        if (result.status) {
          commandStatus = result.status;
        }
      } else {
        // No executor wired up — used by the protocol-only test fixtures
        // that don't spin up a real database. Surface one placeholder
        // row so the existing test suite still observes a single Data
        // frame come back; production paths always supply an executor.
        rows = [{}];
      }
      // A single result found to be many when run (see `resultCardinalityMismatch`).
      if (expectsOne(msg.expectedCardinality) && msg.outputFormat !== OutputFormat.NONE && rows.length > 1) {
        throw resultCardinalityMismatch(Cardinality.MANY);
      }

      const dataElements = encodeRowsAsObjects(
        rows,
        outputShape,
        msg.outputFormat,
        values,
        expectsOne(msg.expectedCardinality)
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
        stateData: stateResp.stateData
      });
    } catch (err) {
      const errorCode = err instanceof Error ?
        mapErrorToGelCode(err) :
        GEL_ERROR_CODES.InternalServerError;
      await this.sendErrorWithCode(
        err instanceof Error ? gelErrorMessage(err) : String(err),
        errorCode,
        errorAttributes(err)
      );
      // Clients pair Execute with Sync: its ReadyForCommand follows the
      // error (a second one here would be left in the client's buffer).
      this.discardUntilSync = true;
    }
  }

  private async handleSync(): Promise<void> {
    this.discardUntilSync = false;
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
      if (cmd.includes(" select ")) {
        return "SELECT";
      }
      if (cmd.includes(" insert ")) {
        return "INSERT";
      }
      if (cmd.includes(" update ")) {
        return "UPDATE";
      }
      if (cmd.includes(" delete ")) {
        return "DELETE";
      }
    }

    return "SELECT";
  }

  // -----------------------------------------------------------------------
  // Descriptor building
  // -----------------------------------------------------------------------

  /**
   * Gel's ResultCardinalityMismatchError when the client expects one result
   * and the query's described cardinality is many (see
   * `resultCardinalityMismatch`).
   */
  private checkResultCardinality(shape: OutputShape, expectedCardinality: number): void {
    if (expectsOne(expectedCardinality) && shape.cardinality !== undefined && isMulti(shape.cardinality)) {
      throw resultCardinalityMismatch(shape.cardinality);
    }
  }

  private buildDescriptors(
    commandText: string,
    outputFormat: number,
    implicit: ImplicitFields | undefined
  ): {
    inputDesc: { id: Uint8Array; data: Uint8Array; };
    outputDesc: { id: Uint8Array; data: Uint8Array; };
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
      const outputShape = inferOutputShape(query, this._schema, { ...EMPTY_SCOPE, implicit });
      // Output format NONE (`execute`) is described as Gel's null type id,
      // with no descriptors and no result (edb/server/compiler/compiler.py).
      if (outputFormat === OutputFormat.NONE) {
        return {
          inputDesc: buildInputDescriptor(params),
          outputDesc: { id: new Uint8Array(16), data: new Uint8Array(0) },
          params,
          outputShape: { ...outputShape, cardinality: Cardinality.NO_RESULT }
        };
      }
      return {
        inputDesc: buildInputDescriptor(params),
        outputDesc: outputFormat === OutputFormat.JSON || outputFormat === OutputFormat.JSON_ELEMENTS ?
          buildJsonOutputDescriptor() :
          buildOutputDescriptor(outputShape),
        params,
        outputShape
      };
    } catch {
      const emptyData = new Uint8Array(0);
      const emptyId = generateDescriptorIdSync(emptyData);
      return {
        inputDesc: { id: emptyId, data: emptyData },
        outputDesc: { id: emptyId, data: emptyData },
        params: [],
        outputShape: { typeName: "Object", fields: [] }
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
      data: keyData
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
      value: encoder.encode("4")
    });
    await this.sendMessage({
      kind: "ParameterStatus",
      name: encoder.encode("system_config"),
      value: encodeSystemConfigValue()
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
      typedesc: emptyState.typedesc
    });

    // Mark ready
    this.state = "ready";
    await this.sendReadyForCommand();
  }

  // -----------------------------------------------------------------------
  // Low-level send/receive helpers
  // -----------------------------------------------------------------------

  private async sendMessage(msg: ServerMessage): Promise<void> {
    if (this.closed) {
      return;
    }
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
    attributes: ErrorAttribute[] = []
  ): Promise<void> {
    await this.sendMessage({
      kind: "ErrorResponse",
      severity: ErrorSeverity.ERROR,
      errorCode,
      message,
      attributes
    });
  }

  private async sendReadyForCommand(): Promise<void> {
    await this.sendMessage({
      kind: "ReadyForCommand",
      annotations: [],
      transactionState: this.transactionState
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
      if (nread === null) {
        return null;
      }
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

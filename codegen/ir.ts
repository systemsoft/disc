/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Language-neutral codegen IR (RFC 0001).
 *
 * This is the single contract between frontends (Schema -> IR, and later
 * Parse/Describe -> IR) and emitters (TypeScript, Rust, Go, Python). Adding a
 * target language must mean "write one more emitter" and never "touch a
 * frontend." Everything here is pure data: no language assumptions, no logic.
 *
 * Phase 1 of the effort = these declarations only. See docs/rfcs/0001-codegen-ir.md.
 *
 * Three ratified design decisions shape the model:
 *   1. Denormalized shape variants. The frontend pre-derives insert/update/
 *      filter shapes per object type; emitters pretty-print them and never
 *      re-derive optionality/exclusion rules per language.
 *   2. The IR carries the filterable field set + operand types as an explicit
 *      filter shape, plus an explicit filterVars shape for raw-string binding.
 *      Operator spelling (eq/like/in/...) is the emitter's concern.
 *   3. Modules are first-class namespaces. The root groups by module and every
 *      definition/reference carries its module.
 */

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/** The complete IR for one codegen run. */
export interface CodegenIR {
  /** IR schema version, for forward-compatible evolution of this contract. */
  version: number;
  /** First-class module namespaces (e.g. "default", "api", "logger"). */
  modules: Module[];
}

/** A module namespace. Emitters map this to a TS `namespace` / Rust `mod`. */
export interface Module {
  name: string;
  enums: EnumType[];
  objects: ObjectType[];
}

// ---------------------------------------------------------------------------
// Cardinality
// ---------------------------------------------------------------------------

/**
 * Result/field multiplicity, wire-complete (matches protocol/enums.ts). The
 * schema frontend only ever produces Empty/AtMostOne/One/Many; the future
 * descriptor frontend can also produce AtLeastOne (a set proven non-empty, e.g.
 * `assert_exists`). Emitter mapping is mechanical:
 *   One         -> T            (TS) / T         (Rust)
 *   AtMostOne   -> T | null     (TS) / Option<T> (Rust)
 *   Many        -> T[]          (TS) / Vec<T>    (Rust)
 *   AtLeastOne  -> T[]          (TS) / Vec<T>    (Rust)   [aliases Many until a
 *                  language refines it to a non-empty type]
 *   Empty where One expected    -> generation-time error
 */
export type Cardinality =
  | "Empty"
  | "AtMostOne"
  | "One"
  | "Many"
  | "AtLeastOne";

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/**
 * The canonical scalar set requiring faithful per-language mapping. Named
 * semantically; the concrete native type and codec are the emitter's job. The
 * well-known UUIDs / EdgeQL names for each live in protocol/typedesc.ts.
 */
export type ScalarKind =
  | "str"
  | "bool"
  | "int16"
  | "int32"
  | "int64"
  | "float32"
  | "float64"
  | "decimal"
  | "bigint"
  | "uuid"
  | "datetime"
  | "duration"
  | "local_datetime"
  | "local_date"
  | "local_time"
  | "relative_duration"
  | "date_duration"
  | "bytes"
  | "json"
  | "memory";

// ---------------------------------------------------------------------------
// Type references
// ---------------------------------------------------------------------------

/** A fully-qualified type name, module-first per decision (3). */
export interface QualifiedName {
  module: string;
  name: string;
}

/**
 * A reference to a type from a field, param, or output position. Discriminated
 * on `kind`. Object/enum refs point at definitions elsewhere in the IR by
 * `QualifiedName`; collections nest other refs; `shape` points at a denormalized
 * variant (decision 1).
 */
export type TypeRef =
  | ScalarRef
  | EnumRef
  | ObjectRef
  | ShapeRef
  | ArrayRef
  | TupleRef
  | NamedTupleRef
  | RangeRef
  | MultiRangeRef;

export interface ScalarRef {
  kind: "scalar";
  scalar: ScalarKind;
}

/** References an EnumType in the IR. */
export interface EnumRef {
  kind: "enum";
  name: QualifiedName;
}

/** References the base interface of an ObjectType (the full `T`). */
export interface ObjectRef {
  kind: "object";
  name: QualifiedName;
}

/**
 * References a denormalized shape variant of an ObjectType — e.g. the `data`
 * param of `insert` is a `ShapeRef` to that type's insert shape. Emitters
 * resolve this to the variant's generated name (e.g. `PersonalKeyInsert`).
 */
export interface ShapeRef {
  kind: "shape";
  object: QualifiedName;
  variant: ShapeVariant;
}

export type ShapeVariant = "insert" | "update" | "filter" | "filterVars";

export interface ArrayRef {
  kind: "array";
  element: TypeRef;
}

export interface TupleRef {
  kind: "tuple";
  elements: TypeRef[];
}

export interface NamedTupleRef {
  kind: "named_tuple";
  elements: NamedTupleElement[];
}

export interface NamedTupleElement {
  name: string;
  type: TypeRef;
}

export interface RangeRef {
  kind: "range";
  element: TypeRef;
}

export interface MultiRangeRef {
  kind: "multirange";
  element: TypeRef;
}

// ---------------------------------------------------------------------------
// Type model — enums and objects
// ---------------------------------------------------------------------------

export interface EnumType {
  name: QualifiedName;
  members: string[];
}

/**
 * An object type: its base field set, its denormalized shape variants
 * (decision 1), and its operation set. Keys are grouped logically (identity,
 * structure, derived) rather than alphabetically for readability.
 */
export interface ObjectType {
  name: QualifiedName;
  fields: Field[];
  shapes: ShapeVariants;
  operations: Operation[];
}

/**
 * One field of the base object type. Carries enough metadata that emitters and
 * the frontend's own variant-derivation never need to re-inspect the schema.
 */
export interface Field {
  name: string;
  type: TypeRef;
  cardinality: Cardinality;
  isLink: boolean;
  isComputed: boolean;
  isExclusive: boolean;
  hasDefault: boolean;
  readonly: boolean;
}

// ---------------------------------------------------------------------------
// Denormalized shape variants (decision 1)
// ---------------------------------------------------------------------------

/** Frontend-derived variants an emitter pretty-prints without further logic. */
export interface ShapeVariants {
  insert: Shape;
  update: Shape;
  filter: FilterShape;
  filterVars: FilterVarsShape;
}

/** A plain field set (used for insert/update). */
export interface Shape {
  fields: ShapeField[];
}

export interface ShapeField {
  name: string;
  type: TypeRef;
  cardinality: Cardinality;
  /** Emit as optional (`?` / `Option`). insert: defaulted or non-required; update: always. */
  optional: boolean;
}

/**
 * The filterable field set with operand types (decision 2). Operator spelling
 * and the derived `FilterVars` binding type are the emitter's concern.
 */
export interface FilterShape {
  fields: FilterField[];
}

export interface FilterField {
  name: string;
  /** The type a filter value is compared against (link -> uuid or nested object). */
  operand: TypeRef;
  cardinality: Cardinality;
  isLink: boolean;
}

/**
 * The variables bag for raw-string filtering: each filterable field exposed as
 * an independently-bindable variable of its operand type. Distinct from
 * FilterShape — it is flat (no operators) and every field is optional, since a
 * caller binds only the variables their condition string references.
 */
export interface FilterVarsShape {
  fields: FilterVarField[];
}

export interface FilterVarField {
  name: string;
  /** Operand type bound as the variable's value. */
  type: TypeRef;
}

// ---------------------------------------------------------------------------
// Operation model
// ---------------------------------------------------------------------------

/**
 * A generated callable. For the schema frontend these are the standard CRUD
 * methods per object type; `query` is reserved for free-standing query-file
 * operations from the future descriptor frontend.
 */
export interface Operation {
  name: string;
  kind: OperationKind;
  params: Param[];
  output: Output;
}

export type OperationKind =
  | "select"
  | "selectById"
  | "filter"
  | "insert"
  | "update"
  | "delete"
  | "count"
  | "query";

export interface Param {
  name: string;
  type: TypeRef;
  cardinality: Cardinality;
  optional: boolean;
  hasDefault: boolean;
}

export interface Output {
  type: TypeRef;
  cardinality: Cardinality;
}

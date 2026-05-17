/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Codegen-free TS schema declaration (Disc-original feature #1, Phase 2).
 *
 * `defineSchema()` is the TS-side companion to the runtime query builder.
 * Users declare their schema once with marker constructors (`t.str()`,
 * `t.multi("Post")`, …) and the resulting `DiscSchema<S>` carries enough
 * type info to drive full inference on the builder — `qb.User.select(...)`
 * narrows the awaited row type from the requested shape.
 *
 * Schema-of-record stays in `.disc` (the SDL is what the server applies
 * and what `disc migrate` diffs). The TS file is a thin re-declaration —
 * either hand-written or generated once by `disc codegen` and committed.
 * Either way, no codegen step on every change.
 */

// --- Field markers (runtime values + phantom TS types) ---

/**
 * Phantom-typed scalar marker. The `__t` field is never set at runtime —
 * it only exists for `FieldType<F>` to read off via `infer T`.
 */
export interface Scalar<TypeName extends string, T> {
  readonly kind: "scalar";
  readonly typeName: TypeName;
  readonly __t?: T;
}

export interface Optional<F extends FieldMarker> {
  readonly kind: "optional";
  readonly inner: F;
}

export interface Link<
  TargetName extends string,
  Card extends "single" | "multi"
> {
  readonly kind: "link";
  readonly target: TargetName;
  readonly cardinality: Card;
}

export type FieldMarker =
  | Scalar<string, unknown>
  | Optional<FieldMarker>
  | Link<string, "single" | "multi">;

/**
 * Field marker constructors. Namespaced under `t` so `t.bigint()` and
 * `t.json()` don't shadow TS builtin types when imported into user code.
 */
export const t = {
  str: (): Scalar<"str", string> => ({ kind: "scalar", typeName: "str" }),
  bool: (): Scalar<"bool", boolean> => ({ kind: "scalar", typeName: "bool" }),
  int16: (): Scalar<"int16", number> => ({ kind: "scalar", typeName: "int16" }),
  int32: (): Scalar<"int32", number> => ({ kind: "scalar", typeName: "int32" }),
  int64: (): Scalar<"int64", number> => ({ kind: "scalar", typeName: "int64" }),
  float32: (): Scalar<"float32", number> => ({
    kind: "scalar",
    typeName: "float32"
  }),
  float64: (): Scalar<"float64", number> => ({
    kind: "scalar",
    typeName: "float64"
  }),
  bigint: (): Scalar<"bigint", bigint> => ({
    kind: "scalar",
    typeName: "bigint"
  }),
  datetime: (): Scalar<"datetime", Date> => ({
    kind: "scalar",
    typeName: "datetime"
  }),
  bytes: (): Scalar<"bytes", Uint8Array> => ({
    kind: "scalar",
    typeName: "bytes"
  }),
  uuid: (): Scalar<"uuid", string> => ({ kind: "scalar", typeName: "uuid" }),
  json: (): Scalar<"json", unknown> => ({ kind: "scalar", typeName: "json" }),

  optional: <F extends FieldMarker>(inner: F): Optional<F> => ({
    kind: "optional",
    inner
  }),

  single: <TargetName extends string>(
    target: TargetName
  ): Link<TargetName, "single"> => ({
    kind: "link",
    target,
    cardinality: "single"
  }),
  multi: <TargetName extends string>(
    target: TargetName
  ): Link<TargetName, "multi"> => ({
    kind: "link",
    target,
    cardinality: "multi"
  })
} as const;

// --- Schema spec + DiscSchema wrapper ---

/** A schema spec: each top-level key is a type, mapped to its fields. */
export type SchemaSpec = {
  [TypeName: string]: { [FieldName: string]: FieldMarker; };
};

/**
 * The output of `defineSchema()`. Carries the spec at runtime and a
 * phantom `__rows` field that lets `createQueryBuilder<S>` recover the
 * spec at the type level via `infer S`.
 */
export interface DiscSchema<S extends SchemaSpec> {
  readonly spec: S;
  readonly __rows?: { [K in keyof S]: ResolveType<S, S[K]>; };
}

// --- Type-level helpers (used by the typed builder) ---

/**
 * Stub returned for an unselected link. Matches EdgeQL semantics:
 * `select User { posts }` (no sub-shape) returns each linked Post as
 * just an `{ id: string }` reference. Full expansion happens only via
 * `select User { posts: { title } }` and `ResolveSelected`.
 */
export type LinkStub = { id: string; };

/** Resolve a single field marker to its TS type. */
export type FieldType<S extends SchemaSpec, F> = F extends Scalar<string, infer T> ? T :
  F extends Optional<infer Inner> ? FieldType<S, Inner> | null :
  F extends Link<string, "single"> ? LinkStub | null :
  F extends Link<string, "multi"> ? LinkStub[] :
  never;

/**
 * Resolve a whole type spec to its row shape. Scalars resolve to their
 * TS type; links resolve to `LinkStub` (no transitive expansion). This
 * keeps the type non-circular even when the schema graph is — full
 * expansion happens via `ResolveSelected` when the user opts into it.
 */
export type ResolveType<S extends SchemaSpec, Type> = {
  [F in keyof Type]: FieldType<S, Type[F]>;
};

/** Distinguish link markers from scalars at the type level. */
export type IsLink<F> = F extends Link<string, "single" | "multi"> ? true :
  false;
export type LinkTarget<F> = F extends Link<infer T, "single" | "multi"> ? T :
  never;
export type LinkCardinality<F> = F extends Link<string, infer C> ? C : never;

/**
 * Shape spec accepted by `select()` for type K.
 *
 * - Scalars accept `true`.
 * - Single links accept either `true` (just the link presence — empty
 *   shape gets the default fields when the server compiles it) or a
 *   nested SelectShape for the target type.
 * - Multi links accept a nested SelectShape only (link expansion
 *   without a sub-shape would emit `posts: { ... }` with no fields).
 */
export type SelectShape<S extends SchemaSpec, K extends keyof S> = {
  [F in keyof S[K]]?: S[K][F] extends Link<infer Target, "single" | "multi"> ? Target extends keyof S ? SelectShape<S, Target> | true : never :
    true;
};

/**
 * Inferred row type for a given select shape. Mirrors `SelectShape` —
 * `true` collapses to the field's TS type, a nested shape recurses
 * into the link target.
 */
export type ResolveSelected<S extends SchemaSpec, K extends keyof S, Sh> = {
  [F in keyof Sh & keyof S[K]]: Sh[F] extends true ? FieldType<S, S[K][F]> :
    Sh[F] extends Record<string, unknown> ? S[K][F] extends Link<infer T, "single"> ? T extends keyof S ? ResolveSelected<S, T, Sh[F]> | null : never :
      S[K][F] extends Link<infer T, "multi"> ? T extends keyof S ? ResolveSelected<S, T, Sh[F]>[] : never :
      never :
    never;
};

// --- defineSchema() ---

const TYPE_NAME_RE = /^[A-Z][a-zA-Z0-9_]*$/;
const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function isFieldMarker(value: unknown): value is FieldMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const kind = (value as { kind?: unknown; }).kind;
  return kind === "scalar" || kind === "optional" || kind === "link";
}

/**
 * Build a typed schema. Runtime side: validates type and field names,
 * checks every link target points at a defined type, and rejects
 * malformed markers. The result drives `createQueryBuilder<S>(...)`.
 */
export function defineSchema<S extends SchemaSpec>(spec: S): DiscSchema<S> {
  for (const [typeName, fields] of Object.entries(spec)) {
    if (!TYPE_NAME_RE.test(typeName)) {
      throw new Error(
        `Type name must be PascalCase identifier: ${JSON.stringify(typeName)}`
      );
    }
    for (const [fieldName, marker] of Object.entries(fields)) {
      if (!FIELD_NAME_RE.test(fieldName)) {
        throw new Error(`Invalid field name: ${typeName}.${fieldName}`);
      }
      if (!isFieldMarker(marker)) {
        throw new Error(
          `Invalid field marker for ${typeName}.${fieldName} — use t.str(), t.single("X"), etc.`
        );
      }
      // Walk into Optional to find the underlying marker.
      let cursor: FieldMarker = marker;
      while (cursor.kind === "optional") {
        cursor = cursor.inner;
      }
      if (cursor.kind === "link" && !(cursor.target in spec)) {
        throw new Error(
          `Link target not found in schema: ${typeName}.${fieldName} → ${cursor.target}`
        );
      }
    }
  }
  return { spec };
}

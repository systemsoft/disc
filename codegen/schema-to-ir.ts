/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Schema frontend: compiler `Schema` -> codegen IR (RFC 0001, Phase 2).
 *
 * Produces the language-neutral IR that every emitter consumes. The
 * denormalized insert/update/filter/filterVars shapes are derived here, once,
 * exactly matching the rules the existing TypeScript generator applies, so an
 * IR-driven emitter reproduces today's output (the Phase 3 oracle).
 */

import type { LinkDef, PropertyDef, Schema, TypeDef } from "../compiler/context.ts";
import type {
  Cardinality,
  CodegenIR,
  EnumType,
  Field,
  FilterField,
  FilterShape,
  FilterVarField,
  FilterVarsShape,
  Module,
  ObjectType,
  Operation,
  Output,
  Param,
  QualifiedName,
  ScalarKind,
  Shape,
  ShapeField,
  TypeRef,
} from "./ir.ts";

/** Current IR schema version emitted by this frontend. */
export const IR_VERSION = 1;

/** Names (sans module prefix) of the well-known scalar kinds. */
const SCALAR_KINDS: ReadonlySet<string> = new Set<ScalarKind>([
  "str",
  "bool",
  "int16",
  "int32",
  "int64",
  "float32",
  "float64",
  "decimal",
  "bigint",
  "uuid",
  "datetime",
  "duration",
  "local_datetime",
  "local_date",
  "local_time",
  "relative_duration",
  "date_duration",
  "bytes",
  "json",
  "memory",
]);

/** Resolves a (possibly bare) type name to its definition, if known. */
type NameResolver = (name: string) => TypeDef | undefined;

/** Transform a compiler Schema into the codegen IR. */
export function schemaToIR(schema: Schema): CodegenIR {
  const resolve = makeResolver(schema);
  const byModule = new Map<string, { enums: EnumType[]; objects: ObjectType[] }>();

  for (const typeDef of schema.types.values()) {
    const moduleName = typeDef.module ?? "default";
    const bucket = byModule.get(moduleName) ?? { enums: [], objects: [] };
    if (typeDef.kind === "enum" && typeDef.enumValues && typeDef.enumValues.length > 0) {
      bucket.enums.push(enumOf(typeDef, moduleName));
    } else if (typeDef.kind === "object") {
      bucket.objects.push(objectOf(typeDef, moduleName, resolve));
    }
    byModule.set(moduleName, bucket);
  }

  const modules: Module[] = orderModules([...byModule.keys()]).map((name) => ({
    name,
    enums: byModule.get(name)!.enums,
    objects: byModule.get(name)!.objects,
  }));

  return { version: IR_VERSION, modules };
}

// ---------------------------------------------------------------------------
// Module / enum / object
// ---------------------------------------------------------------------------

/** Default module first, then the rest alphabetically (matches the generator). */
function orderModules(names: string[]): string[] {
  return names.sort((a, b) => {
    if (a === "default") return b === "default" ? 0 : -1;
    if (b === "default") return 1;
    return a.localeCompare(b);
  });
}

function enumOf(typeDef: TypeDef, moduleName: string): EnumType {
  return {
    name: { module: moduleName, name: typeDef.name },
    members: [...(typeDef.enumValues ?? [])],
  };
}

function objectOf(typeDef: TypeDef, moduleName: string, resolve: NameResolver): ObjectType {
  const name: QualifiedName = { module: moduleName, name: typeDef.name };
  const props = [...typeDef.properties.values()];
  const links = [...typeDef.links.values()];

  const fields: Field[] = [
    ...props.map((p) => fieldOfProperty(p, resolve)),
    ...links.map((l) => fieldOfLink(l, resolve)),
  ];

  return {
    name,
    fields,
    shapes: {
      insert: insertShape(props, links, resolve),
      update: updateShape(props, links, resolve),
      filter: filterShape(props, links, resolve),
      filterVars: filterVarsShape(props, resolve),
    },
    operations: operations(name),
  };
}

// ---------------------------------------------------------------------------
// Base fields
// ---------------------------------------------------------------------------

function fieldOfProperty(prop: PropertyDef, resolve: NameResolver): Field {
  return {
    name: prop.name,
    type: typeRefOf(prop.edgeqlType ?? prop.type, resolve),
    cardinality: cardinalityOf(prop.required, prop.multi),
    isLink: false,
    isComputed: prop.computed ?? false,
    isExclusive: (prop.constraints ?? []).some((c) => c.name === "exclusive"),
    hasDefault: prop.hasDefault ?? false,
    readonly: prop.readonly ?? false,
  };
}

function fieldOfLink(link: LinkDef, resolve: NameResolver): Field {
  return {
    name: link.name,
    type: { kind: "object", name: resolveQualified(link.target, resolve) },
    cardinality: cardinalityOf(link.required, link.multi),
    isLink: true,
    isComputed: link.computed ?? false,
    isExclusive: false,
    hasDefault: false,
    readonly: false,
  };
}

// ---------------------------------------------------------------------------
// Denormalized shape variants
// ---------------------------------------------------------------------------

/**
 * Insert: exclude `id`, computed props, and props that are both readonly and
 * defaulted; exclude computed links. A kept field is optional iff it has a
 * default or is not required. Links are represented by their uuid foreign key.
 */
function insertShape(props: PropertyDef[], links: LinkDef[], resolve: NameResolver): Shape {
  const fields: ShapeField[] = [];
  for (const p of props) {
    if (p.name === "id" || p.computed || (p.readonly && p.hasDefault)) continue;
    fields.push({
      name: p.name,
      type: typeRefOf(p.edgeqlType ?? p.type, resolve),
      cardinality: cardinalityOf(p.required, p.multi),
      isLink: false,
      optional: (p.hasDefault ?? false) || !p.required,
    });
  }
  for (const l of links) {
    if (l.computed) continue;
    fields.push(linkShapeField(l, !l.required));
  }
  return { fields };
}

/**
 * Update: exclude `id`, computed props, and any readonly prop; exclude computed
 * links. Every kept field is optional. Links are represented by their uuid
 * foreign key (multi links accept a full set or an add/remove delta — an
 * emitter concern keyed off `isLink` + cardinality).
 */
function updateShape(props: PropertyDef[], links: LinkDef[], resolve: NameResolver): Shape {
  const fields: ShapeField[] = [];
  for (const p of props) {
    if (p.name === "id" || p.computed || p.readonly) continue;
    fields.push({
      name: p.name,
      type: typeRefOf(p.edgeqlType ?? p.type, resolve),
      cardinality: cardinalityOf(p.required, p.multi),
      isLink: false,
      optional: true,
    });
  }
  for (const l of links) {
    if (l.computed) continue;
    fields.push(linkShapeField(l, true));
  }
  return { fields };
}

/** A link rendered as its uuid foreign key inside an insert/update shape. */
function linkShapeField(link: LinkDef, optional: boolean): ShapeField {
  return {
    name: link.name,
    type: { kind: "scalar", scalar: "uuid" },
    cardinality: cardinalityOf(link.required, link.multi),
    isLink: true,
    optional,
  };
}

/**
 * Filter: non-computed scalar props by operand type; links as nested filters
 * (operand = the target object). Operator spelling and the reserved
 * select/order_by/limit/offset keys are emitter concerns. (Computed props are
 * filterable only when tuple-inferable — deferred; skipped here.)
 */
function filterShape(props: PropertyDef[], links: LinkDef[], resolve: NameResolver): FilterShape {
  const fields: FilterField[] = [];
  for (const p of props) {
    if (p.computed) continue;
    fields.push({
      name: p.name,
      operand: typeRefOf(p.edgeqlType ?? p.type, resolve),
      cardinality: cardinalityOf(p.required, p.multi),
      isLink: false,
    });
  }
  for (const l of links) {
    fields.push({
      name: l.name,
      operand: { kind: "object", name: resolveQualified(l.target, resolve) },
      cardinality: cardinalityOf(l.required, l.multi),
      isLink: true,
    });
  }
  return { fields };
}

/** FilterVars: every property as a bindable value (computed included); no links. */
function filterVarsShape(props: PropertyDef[], resolve: NameResolver): FilterVarsShape {
  const fields: FilterVarField[] = props.map((p) => ({
    name: p.name,
    type: typeRefOf(p.edgeqlType ?? p.type, resolve),
  }));
  return { fields };
}

// ---------------------------------------------------------------------------
// Operations (standard CRUD set per object type)
// ---------------------------------------------------------------------------

function operations(object: QualifiedName): Operation[] {
  const self: TypeRef = { kind: "object", name: object };
  const id: Param = {
    name: "id",
    type: { kind: "scalar", scalar: "uuid" },
    cardinality: "One",
    optional: false,
    hasDefault: false,
  };
  const out = (cardinality: Cardinality): Output => ({ type: self, cardinality });
  const dataParam = (variant: "insert" | "update"): Param => ({
    name: "data",
    type: { kind: "shape", object, variant },
    cardinality: "One",
    optional: false,
    hasDefault: false,
  });

  return [
    { name: "select", kind: "select", params: [], output: out("Many") },
    { name: "selectById", kind: "selectById", params: [id], output: out("AtMostOne") },
    {
      name: "filter",
      kind: "filter",
      params: [{
        name: "filter",
        type: { kind: "shape", object, variant: "filter" },
        cardinality: "One",
        optional: false,
        hasDefault: false,
      }],
      output: out("Many"),
    },
    { name: "insert", kind: "insert", params: [dataParam("insert")], output: out("One") },
    { name: "update", kind: "update", params: [id, dataParam("update")], output: out("One") },
    { name: "delete", kind: "delete", params: [id], output: out("One") },
    {
      name: "count",
      kind: "count",
      params: [
        {
          name: "condition",
          type: { kind: "scalar", scalar: "str" },
          cardinality: "One",
          optional: true,
          hasDefault: false,
        },
        {
          name: "variables",
          type: { kind: "shape", object, variant: "filterVars" },
          cardinality: "One",
          optional: true,
          hasDefault: false,
        },
      ],
      output: { type: { kind: "scalar", scalar: "int64" }, cardinality: "One" },
    },
  ];
}

// ---------------------------------------------------------------------------
// Type references
// ---------------------------------------------------------------------------

/** required x multi -> cardinality (see ir.ts Cardinality). */
function cardinalityOf(required: boolean, multi: boolean): Cardinality {
  if (multi) return required ? "AtLeastOne" : "Many";
  return required ? "One" : "AtMostOne";
}

/** Parse an EdgeQL type string into a TypeRef (scalars, enums, objects, collections). */
function typeRefOf(raw: string, resolve: NameResolver): TypeRef {
  const s = raw.trim();

  const collection = collectionRefOf(s, resolve);
  if (collection) return collection;

  const scalar = scalarKindOf(s);
  if (scalar) return { kind: "scalar", scalar };

  const def = resolve(s);
  if (def?.kind === "enum") {
    return { kind: "enum", name: { module: def.module ?? "default", name: def.name } };
  }
  return { kind: "object", name: resolveQualified(s, resolve) };
}

function collectionRefOf(s: string, resolve: NameResolver): TypeRef | null {
  for (const wrapper of ["array", "multirange", "range"] as const) {
    const inner = unwrap(s, wrapper);
    if (inner !== null) {
      const element = typeRefOf(inner, resolve);
      if (wrapper === "array") return { kind: "array", element };
      if (wrapper === "multirange") return { kind: "multirange", element };
      return { kind: "range", element };
    }
  }
  const tupleInner = unwrap(s, "tuple");
  if (tupleInner !== null) {
    const parts = splitTopLevel(tupleInner);
    const labeled = parts.every((p) => /^[A-Za-z_]\w*\s*:/.test(p));
    if (labeled) {
      return {
        kind: "named_tuple",
        elements: parts.map((p) => {
          const idx = p.indexOf(":");
          return { name: p.slice(0, idx).trim(), type: typeRefOf(p.slice(idx + 1), resolve) };
        }),
      };
    }
    return { kind: "tuple", elements: parts.map((p) => typeRefOf(p, resolve)) };
  }
  return null;
}

/** If `s` is `wrapper<...>`, return the inner text; else null. */
function unwrap(s: string, wrapper: string): string | null {
  const prefix = `${wrapper}<`;
  if (s.startsWith(prefix) && s.endsWith(">")) {
    return s.slice(prefix.length, -1);
  }
  return null;
}

/** Split on top-level commas (ignoring commas nested inside `<...>`). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function scalarKindOf(s: string): ScalarKind | null {
  const bare = s.replace(/^(std|cal|cfg)::/, "");
  return SCALAR_KINDS.has(bare) ? (bare as ScalarKind) : null;
}

/** Resolve a (bare or qualified) type name to a QualifiedName. */
function resolveQualified(name: string, resolve: NameResolver): QualifiedName {
  const def = resolve(name);
  if (def) return { module: def.module ?? "default", name: def.name };
  if (name.includes("::")) {
    const [module, bare] = name.split("::");
    return { module, name: bare };
  }
  return { module: "default", name };
}

/** Build a resolver that indexes the schema by both qualified key and bare name. */
function makeResolver(schema: Schema): NameResolver {
  const byBare = new Map<string, TypeDef>();
  for (const def of schema.types.values()) {
    if (!byBare.has(def.name)) byBare.set(def.name, def);
  }
  return (name: string) => {
    if (schema.types.has(name)) return schema.types.get(name);
    const bare = name.includes("::") ? name.split("::").pop()! : name;
    return byBare.get(bare);
  };
}

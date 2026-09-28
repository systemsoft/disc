/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The query compiler's Schema from SDL modules (`modulesToSchema`), apart from
 * `SchemaManager` so the migration differ can compile against it without
 * importing the manager, which imports the engine and the differ.
 */

import { adaptAccessPolicies } from "../access/policy-adapter.ts";
import { getBuiltinFunctions } from "../compiler/builtin-functions.ts";
import { selectKeepsAtMostOne } from "../compiler/compiler-base.ts";
import {
  AbstractAnnotationDef,
  AliasDef,
  FunctionDef,
  GlobalDef,
  IndexDef,
  LinkDef,
  PropertyConstraint,
  PropertyDef,
  RewriteDef,
  Schema,
  TriggerDef,
  TypeDef
} from "../compiler/context.ts";
import {
  globalSettingName,
  linkColumnName,
  propNameToColumnName,
  typeNameToTableName
} from "../lib/identifiers.ts";
import {
  AccessPolicy as SDLAccessPolicy,
  AliasDeclaration,
  Annotation as SDLAnnotation,
  AnnotationDeclaration,
  Constraint as SDLConstraint,
  Expression,
  GlobalDeclaration,
  LinkDeclaration,
  PropertyDeclaration,
  ScalarTypeDeclaration,
  TriggerDeclaration,
  TypeDeclaration
} from "../schema/ast.ts";
import { enumPgTypeNames, Module, qualifySharedEnumReferences, SDLConverter } from "../schema/converter.ts";
import type * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { sdlExpressionToEdgeQL } from "../schema/expression-printer.ts";
import { inferComputedValues, type ComputedValues } from "./computed-values.ts";
import { scalarChecksOf } from "./scalar-constraints.ts";

/**
 * SDL type name to SQL column type mapping
 */
const SDL_TO_SQL_TYPE_MAP: Record<string, string> = {
  str: "text",
  bool: "boolean",
  int16: "smallint",
  int32: "integer",
  int64: "bigint",
  float32: "real",
  float64: "double precision",
  bigint: "numeric",
  decimal: "numeric",
  uuid: "uuid",
  datetime: "timestamptz",
  duration: "interval",
  bytes: "bytea",
  json: "jsonb",
  sequence: "bigint",
  "cal::local_datetime": "timestamp",
  "cal::local_date": "date",
  "cal::local_time": "time",
  "cal::relative_duration": "interval",
  "cal::date_duration": "interval",
  // Array types
  "array<str>": "text[]",
  "array<int16>": "smallint[]",
  "array<int32>": "integer[]",
  "array<int64>": "bigint[]",
  "array<float32>": "real[]",
  "array<float64>": "double precision[]",
  "array<bool>": "boolean[]",
  "array<uuid>": "uuid[]",
  "array<datetime>": "timestamptz[]",
  "array<json>": "jsonb[]",
  "array<bytes>": "bytea[]",
  "array<bigint>": "numeric[]",
  "array<decimal>": "numeric[]",
  "array<cal::local_date>": "date[]",
  "array<cal::local_time>": "time[]",
  "array<cal::local_datetime>": "timestamp[]",
  // Range types
  "range<int32>": "int4range",
  "range<int64>": "int8range",
  "range<float64>": "numrange",
  "range<decimal>": "numrange",
  "range<datetime>": "tstzrange",
  "range<cal::local_date>": "daterange",
  "range<cal::local_datetime>": "tsrange",
  // Multirange types
  "multirange<int32>": "int4multirange",
  "multirange<int64>": "int8multirange",
  "multirange<float64>": "nummultirange",
  "multirange<decimal>": "nummultirange",
  "multirange<datetime>": "tstzmultirange",
  "multirange<cal::local_date>": "datemultirange",
  "multirange<cal::local_datetime>": "tsmultirange"
};

/**
 * If a computed expression is a pure reverse-link path (`.<fwd[is Target]`),
 * extract the forward link name and the intersection target type. Returns null
 * for any other computed shape (scalar computeds, trailing-property backlinks,
 * etc.), which stay classified as computed properties.
 */
function extractBacklinkInfo(
  expr: Expression
): { forwardLink: string; target: string; } | null {
  if (expr.kind !== "PathExpression") {
    return null;
  }
  const p = expr.path;
  if (p.length !== 3 || p[0] !== "." || !p[1].startsWith("<")) {
    return null;
  }
  const m = /^\[is (.+)\]$/.exec(p[2]);
  if (!m) {
    return null;
  }
  return { forwardLink: p[1].slice(1), target: m[1] };
}

/**
 * The objects a computed's expression yields, as the computed link Gel infers
 * for it, or null when it yields no objects of a known type (a scalar
 * computed stays a property):
 *
 *   .author, .author.best_friend        → author's target; multi if a hop is
 *   .<post[is Comment]                  → Comment, multi
 *   Comment                             → every Comment, multi
 *   (select <one of the above> … limit 1) → single
 *   (select Comment filter .id = …)     → single (so is an exclusive property)
 *   assert_single(<one of the above>)   → single
 *   <any of the above> { shape }
 *
 * Required when every hop is a required single link and nothing narrows it.
 */
function inferComputedLink(
  expr: EdgeQLAST.Expression,
  source: TypeDef,
  resolveType: (name: string) => TypeDef | undefined
): { multi: boolean; required: boolean; target: string; } | null {
  if (expr.kind === "ShapeExpr") {
    return inferComputedLink(expr.expr, source, resolveType);
  }
  if (expr.kind === "TypeName") {
    // The source type's own name stands for its current object, not a set of them.
    const type = resolveType(expr.name.parts.join("::"));
    return type?.kind === "object" && type !== source ? { multi: true, required: false, target: type.name } : null;
  }
  if (expr.kind === "FunctionCall" && expr.args.length === 1 && expr.name.parts.join("::").replace(/^std::/, "") === "assert_single") {
    const inner = inferComputedLink(expr.args[0].value, source, resolveType);
    return inner && { ...inner, multi: false };
  }
  if (expr.kind === "Subquery") {
    const query = expr.query;
    const inner = query.kind === "SelectQuery" ? inferComputedLink(query.expr, source, resolveType) : null;
    if (query.kind !== "SelectQuery" || !inner) {
      return null;
    }
    const target = query.expr.kind === "TypeName" ? resolveType(inner.target) : undefined;
    const atMostOne = (query.limit?.kind === "Literal" && Number(query.limit.value) <= 1) ||
      (target !== undefined && selectKeepsAtMostOne(query, target));
    return {
      multi: inner.multi && !atMostOne,
      required: inner.required && !query.filter && !query.offset && !query.limit,
      target: inner.target
    };
  }
  if (expr.kind !== "Path" || expr.rooted || expr.steps.length === 0) {
    return null;
  }
  let type = source;
  let multi = false;
  let required = true;
  for (const step of expr.steps) {
    let next: TypeDef | undefined;
    if (step.type === "type_intersection") {
      next = resolveType(step.name);
      required = false;
    } else if (step.type === "backlink") {
      next = step.filter?.kind === "TypeName" ? resolveType(step.filter.name.parts.join("::")) : undefined;
      multi = true;
      required = false;
    } else if (step.type === "link" || step.type === "property") {
      const link = type.links.get(step.name);
      next = link ? resolveType(link.target) : undefined;
      multi = multi || (link?.multi ?? false);
      required = required && (link?.required ?? false);
    }
    if (!next) {
      return null;
    }
    type = next;
  }
  return { multi, required, target: type.name };
}

/**
 * The values a computed's expression yields when it is a relative path
 * ending in a property (`.title`, `.<post[is Comment].body`), as the
 * computed property Gel infers for it: that property's type, multi when the
 * property or a hop before it is, required when the property and every hop
 * are. Null for any other expression, or a property not yet typed.
 */
function inferComputedProperty(
  expr: EdgeQLAST.Expression,
  source: TypeDef,
  resolveType: (name: string) => TypeDef | undefined
): { baseType?: string; edgeqlType: string; multi: boolean; required: boolean; } | null {
  if (expr.kind !== "Path" || expr.rooted || expr.steps.length === 0) {
    return null;
  }
  const last = expr.steps[expr.steps.length - 1];
  // A link property of the last link (`.teams.members@role`): one value per link, of any of them.
  if (last.type === "link_property" && expr.steps.length > 1) {
    const linkStep = expr.steps[expr.steps.length - 2];
    const prefix = expr.steps.slice(0, -2);
    const hops = prefix.length > 0 ? inferComputedLink({ ...expr, steps: prefix }, source, resolveType) : { multi: false, required: true, target: source.name };
    const owner = hops ? resolveType(hops.target) : undefined;
    const link = owner?.links.get(linkStep.name);
    const property = link?.properties?.get(last.name);
    if (!hops || !link || !property?.edgeqlType) {
      return null;
    }
    return {
      ...(property.baseType ? { baseType: property.baseType } : {}),
      edgeqlType: property.edgeqlType,
      multi: hops.multi || link.multi,
      required: false
    };
  }
  let owner: { multi: boolean; required: boolean; type: TypeDef; } | null = { multi: false, required: true, type: source };
  if (expr.steps.length > 1) {
    const hops = inferComputedLink({ ...expr, steps: expr.steps.slice(0, -1) }, source, resolveType);
    const type = hops ? resolveType(hops.target) : undefined;
    owner = hops && type ? { ...hops, type } : null;
  }
  const property = last.type === "property" ? owner?.type.properties.get(last.name) : undefined;
  if (!owner || !property?.edgeqlType || property.edgeqlType === "auto") {
    return null;
  }
  return {
    ...(property.baseType ? { baseType: property.baseType } : {}),
    edgeqlType: property.edgeqlType,
    multi: owner.multi || property.multi,
    required: owner.required && property.required
  };
}

/**
 * The values a computed property's expression yields (inferComputedValues),
 * a path in it read as inferComputedProperty types a property (or, to
 * objects, as inferComputedLink does, of no scalar type).
 */
function inferComputedPropertyValues(
  expr: EdgeQLAST.Expression,
  source: TypeDef,
  resolveType: (name: string) => TypeDef | undefined,
  functions: Map<string, FunctionDef>
): ComputedValues | null {
  return inferComputedValues(expr, path => {
    const property = inferComputedProperty(path, source, resolveType);
    if (property) {
      const { edgeqlType, ...values } = property;
      return { ...values, type: edgeqlType };
    }
    const link = inferComputedLink(path, source, resolveType);
    return link && { multi: link.multi, required: link.required, type: null };
  }, functions);
}

/*** True when a computed's expression carries a shape (`.<post[is C] { body }`, `(select … { … } …)`). ***/
function hasShape(expr: EdgeQLAST.Expression): boolean {
  return expr.kind === "ShapeExpr" ||
    (expr.kind === "Subquery" && expr.query.kind === "SelectQuery" && (expr.query.shape !== undefined || hasShape(expr.query.expr)));
}

/**
 * What Gel rejects in a schema's computed pointers, as the error message, or
 * null: a shape in a computed link's expression, `required` on a computed
 * whose expression may be empty, and `single` on one whose expression may
 * yield several. (A computed is required when it is declared so or its
 * expression is never empty — see modulesToSchema — so a required one whose
 * expression may be empty was declared required.)
 */
export function detectComputedPointerErrors(schema: Schema): string | null {
  const errors: string[] = [];
  const functions = schema.functions;
  for (const typeDef of schema.types.values()) {
    const resolve = (target: string): TypeDef | undefined =>
      schema.types.get(target) ??
        (typeDef.module && typeDef.module !== "default" ? schema.types.get(`${typeDef.module}::${target}`) : undefined) ??
        schema.types.get(target.replace(/^default::/, ""));
    const pointers = [
      ...[...typeDef.links.values()].map(link => ({ kind: "link", pointer: link })),
      ...[...typeDef.properties.values()].map(property => ({ kind: "property", pointer: property }))
    ];
    for (const { kind, pointer } of pointers) {
      if (!pointer.computed || !pointer.computedExpr) {
        continue;
      }
      const expr = new EdgeQLParser(pointer.computedExpr).parseExpressionOnly();
      const where = `the computed ${kind} '${pointer.name}' of object type '${typeDef.name}'`;
      if (kind === "link" && hasShape(expr)) {
        errors.push(`${where}: including a shape on schema-defined computed links is not yet supported`);
        continue;
      }
      const inferred = kind === "link" ? inferComputedLink(expr, typeDef, resolve) : inferComputedPropertyValues(expr, typeDef, resolve, functions);
      if (pointer.required && inferred && !inferred.required) {
        errors.push(`possibly an empty set returned by an expression for ${where} explicitly declared as 'required'`);
      }
      if (pointer.single && inferred?.multi) {
        errors.push(`possibly more than one element returned by an expression for ${where} explicitly declared as 'single'`);
      }
    }
  }
  return errors.length > 0 ? errors.map(error => `  • ${error}`).join("\n") : null;
}

/**
 * Detect mutual stored `multi` links: two object types that each declare a
 * non-computed `multi` link pointing at the other. Disc stores every stored
 * multi link in its own junction table and can't tell which side pairs with
 * which, so such a schema yields a DDL/query-layer disagreement that crashes
 * at query time. Bidirectional M2M must instead be one stored link plus one
 * computed backlink.
 *
 * Returns an error message when any such pair exists, or null when clean.
 * Self-referential multi links (a type pointing `multi` at itself) are fine —
 * they each get their own junction and are unambiguous.
 */
export function detectMutualStoredMultiLinks(schema: Schema): string | null {
  const resolve = (target: string): TypeDef | undefined =>
    schema.types.get(target) ??
      schema.types.get(`default::${target}`) ??
      schema.types.get(target.replace(/^default::/, ""));

  const seen = new Set<string>();
  const pairs: string[] = [];
  for (const [, t] of schema.types) {
    for (const [lName, l] of t.links) {
      if (!l.multi || l.computed) {
        continue;
      }
      const u = resolve(l.target);
      if (!u || u === t) {
        continue;
      }
      for (const [mName, m] of u.links) {
        if (!m.multi || m.computed || resolve(m.target) !== t) {
          continue;
        }
        const key = [`${t.name}.${lName}`, `${u.name}.${mName}`].sort().join("|");
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        pairs.push(
          `  • '${t.name}.${lName} -> ${u.name}' and '${u.name}.${mName} -> ${t.name}'`
        );
      }
    }
  }

  if (pairs.length === 0) {
    return null;
  }
  return `Ambiguous bidirectional links (${pairs.length}): both sides are ` +
    `stored 'multi' links, so Disc can't tell which pairs with which.\n` +
    `${pairs.join("\n")}\n` +
    `Model a two-way relationship as one stored 'multi' link plus a computed ` +
    `backlink on the other side, e.g.:\n` +
    `    type A { multi bs -> B; }\n` +
    `    type B { as := .<bs[is A]; }`;
}

/**
 * Map an SDL type name to a SQL column type
 */
function sdlTypeToSqlType(sdlType: string): string {
  if (SDL_TO_SQL_TYPE_MAP[sdlType]) {
    return SDL_TO_SQL_TYPE_MAP[sdlType];
  }

  // Tuple types map to jsonb (PostgreSQL has no native tuple type).
  // Arrays of tuples (`array<tuple<...>>`) likewise map to jsonb.
  if (sdlType.startsWith("tuple<") || sdlType.startsWith("array<tuple<")) {
    return "jsonb";
  }

  return "text";
}

/**
 * Each non-enum user scalar in `modules`, mapped to the built-in type it
 * ultimately extends (`Cents` → `Money` → `decimal`), for `Schema.scalars`.
 * Keyed qualified and bare (the default module's when scalars share a name).
 */
function userScalarBaseTypes(modules: Module[]): Map<string, string> {
  const scalars = new Map<string, { base: string; module: string; }>();

  for (const module of modules) {
    for (const item of module.items) {
      const base = item.kind === "ScalarTypeDeclaration" ? (item as ScalarTypeDeclaration).extending?.[0] : undefined;

      if (!base || base.name.parts[0] === "enum")
        continue;

      const name = (item as ScalarTypeDeclaration).name.value;
      const scalar = { base: typeRefToSdlString(base), module: module.name };
      scalars.set(`${module.name}::${name}`, scalar);

      if (module.name === "default" || !scalars.has(name))
        scalars.set(name, scalar);
    }
  }

  // A bare base names a scalar of the same module before one elsewhere.
  const builtinOf = (key: string, seen: Set<string>): string => {
    const { base, module } = scalars.get(key)!;
    const next = scalars.has(`${module}::${base}`) ? `${module}::${base}` : base;
    return scalars.has(next) && !seen.has(next) ? builtinOf(next, seen.add(next)) : base;
  };

  return new Map([...scalars.keys()].map(key => [key, builtinOf(key, new Set([key]))]));
}

/**
 * The built-in type `sdlType`, named in `module`, is when it names a user
 * scalar (`Count` → `bigint`, `array<Count>` → `array<bigint>`; a sequence
 * scalar is an `int64`), for `PropertyDef.baseType`; undefined when it names
 * none. `scalars` is `userScalarBaseTypes`; a bare name is `module`'s scalar
 * before one elsewhere.
 */
function scalarBaseType(sdlType: string, module: string, scalars: Map<string, string>): string | undefined {
  const resolved = sdlType.replace(/[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*/g, name => {
    const base = (name.includes("::") ? undefined : scalars.get(`${module}::${name}`)) ?? scalars.get(name);
    return base === undefined ? name : base === "sequence" ? "int64" : base;
  });
  return resolved === sdlType ? undefined : resolved;
}

/**
 * The PostgreSQL type of the enum `sdlType` names in `module`, from
 * `enumPgTypeNames`; a bare name is `module`'s enum before the default
 * module's. Undefined when it names no enum.
 */
function enumPgType(sdlType: string, module: string, enums: Map<string, string>): string | undefined {
  return sdlType.includes("::") ? enums.get(sdlType) : enums.get(`${module}::${sdlType}`) ?? enums.get(`default::${sdlType}`);
}

/**
 * Build a full SDL type string from a TypeRef, including type parameters.
 * For example: range<int32>, multirange<cal::local_date>
 */
function typeRefToSdlString(
  typeRef: {
    name: { parts: string[]; };
    params?: { name: { parts: string[]; }; params?: unknown[]; }[];
    fieldName?: string;
  }
): string {
  let result = typeRef.name.parts.join("::");
  if (typeRef.params && typeRef.params.length > 0) {
    result += `<${
      typeRef
        .params
        .map(p =>
          typeRefToSdlString(
            p as {
              name: { parts: string[]; };
              params?: { name: { parts: string[]; }; params?: unknown[]; }[];
              fieldName?: string;
            }
          )
        )
        .join(", ")
    }>`;
  }
  // Named-tuple field: `icon: str`.
  if (typeRef.fieldName) {
    result = `${typeRef.fieldName}: ${result}`;
  }
  return result;
}

/**
 * Stringify an SDL Expression node into a human-readable string.
 * Used for rendering constraint arguments, trigger bodies, and
 * computed property expressions.
 */
function stringifyExpression(expr: Expression): string {
  switch (expr.kind) {
    case "Literal":
      if (typeof expr.value === "string") {
        return `'${expr.value}'`;
      }
      return String(expr.value);
    case "PathExpression": {
      // EdgeQL expression tokens (from parseEdgeQLExpression) are stored as
      // individual tokens in the path array. Detect them by checking whether
      // the first token is a query keyword and join with spaces instead of
      // dots so the expression round-trips correctly through the EdgeQL parser.
      const edgeqlKeywords = new Set([
        "select",
        "insert",
        "update",
        "delete",
        "with",
        "for",
        "group"
      ]);
      if (
        expr.path.length > 0 &&
        edgeqlKeywords.has(expr.path[0].toLowerCase())
      ) {
        return expr.path.join(" ");
      }
      // The SDL parser's parsePath emits `["", "name"]` style arrays where
      // separator dots and identifier tokens are interleaved (e.g. `.name`
      // → `[".", "name"]`). Joining with another `.` would double-up to
      // `..name`. Concatenate without a separator so the dots that the
      // tokenizer already captured stand in as the separators.
      if (expr.path.some(p => p === ".")) {
        return expr.path.join("");
      }
      return expr.path.join(".");
    }
    case "FunctionCall":
      return `${expr.name.parts.join("::")}(${expr.args.map(stringifyExpression).join(", ")})`;
    case "BinaryOp":
      return `${stringifyExpression(expr.left)} ${expr.op} ${stringifyExpression(expr.right)}`;
    case "UnaryOp":
      return `${expr.op} ${stringifyExpression(expr.operand)}`;
    case "TypeCast":
      return `<${expr.type.name.parts.join("::")}>${stringifyExpression(expr.expr)}`;
    case "Parameter":
      return `$${expr.name}`;
    case "ConditionalExpression":
      return `${stringifyExpression(expr.consequent)} if ${stringifyExpression(expr.test)} else ${stringifyExpression(expr.alternate)}`;
    case "TupleExpression":
      return `(${expr.elements.map(stringifyExpression).join(", ")})`;
    case "NamedTupleExpression":
      return `(${
        expr
          .elements
          .map(e => `${e.name} := ${stringifyExpression(e.value)}`)
          .join(", ")
      })`;
    default:
      return String((expr as { value?: unknown; }).value ?? "");
  }
}

/**
 * Extract PropertyConstraint[] from SDL Constraint AST nodes.
 */
function extractPropertyConstraints(
  sdlConstraints: SDLConstraint[] | undefined
): PropertyConstraint[] | undefined {
  if (!sdlConstraints || sdlConstraints.length === 0) {
    return undefined;
  }

  return sdlConstraints.map(c => {
    const constraint: PropertyConstraint = {
      name: c.name?.value ?? "unknown"
    };
    if (c.args && c.args.length > 0) {
      constraint.args = c.args.map(stringifyExpression);
    }
    return constraint;
  });
}

/**
 * The runtime PropertyDefs of a link's link properties — columns of the
 * link's junction table — or undefined when the link declares none.
 */
function linkPropertyDefs(
  declarations: PropertyDeclaration[] | undefined,
  baseTypeOf: (sdlType: string) => string | undefined
): Map<string, PropertyDef> | undefined {
  if (!declarations || declarations.length === 0) {
    return undefined;
  }
  return new Map(declarations.map(decl => {
    const name = decl.name.value;
    const edgeqlType = typeRefToSdlString(decl.type);
    const baseType = baseTypeOf(edgeqlType);
    const property: PropertyDef = {
      name,
      type: sdlTypeToSqlType(baseType ?? edgeqlType),
      required: decl.required ?? false,
      multi: false,
      columnName: propNameToColumnName(name),
      edgeqlType,
      ...(baseType ? { baseType } : {}),
      readonly: decl.readonly ?? false,
      hasDefault: decl.default !== undefined,
      constraints: extractPropertyConstraints(decl.constraints),
      annotations: extractAnnotationMap(decl.annotations)
    };
    return [name, property];
  }));
}

function extractAnnotationMap(
  annotations: SDLAnnotation[] | undefined
): Record<string, string> | undefined {
  if (!annotations || annotations.length === 0) {
    return undefined;
  }

  const result: Record<string, string> = {};
  for (const ann of annotations) {
    const name = ann.name.parts.join("::");
    result[name] = ann.value ? stringifyExpression(ann.value) : "true";
  }
  return result;
}

/**
 * Convert Module[] (SDL AST) into a Schema suitable for the query compiler.
 *
 * This is a pure bridge function with no side effects. It iterates through
 * each module's TypeDeclarations and converts them into TypeDef objects
 * with PropertyDef and LinkDef maps.
 */
export function modulesToSchema(sdlModules: Module[]): Schema {
  // `status: Status` inside `agents` names `agents::Status` even when
  // `default::Status` exists; qualify it so the bare name can't resolve to
  // the default one.
  const modules = qualifySharedEnumReferences(sdlModules);
  const enumSqlTypes = enumPgTypeNames(modules);
  const types = new Map<string, TypeDef>();
  const aliases = new Map<string, AliasDef>();
  const globals = new Map<string, GlobalDef>();
  const abstractAnnotations = new Map<string, AbstractAnnotationDef>();
  const converter = new SDLConverter();

  // First pass: collect abstract link and annotation declarations, plus a
  // global set of object type names. The SDL parser uses arrow shorthand
  // (`name -> Type`) for both scalar properties and object links — only
  // the target type's kind can distinguish them, and that's a
  // cross-module question. We need every object type's name (bare AND
  // module-qualified) before extracting members so link-vs-property
  // classification works regardless of declaration order.
  const abstractLinks = new Map<string, LinkDeclaration>();
  const objectTypeNames = new Set<string>();
  for (const module of modules) {
    for (const item of module.items) {
      // Collect abstract annotation declarations
      if (item.kind === "AnnotationDeclaration") {
        const annDecl = item as AnnotationDeclaration;
        const annName = annDecl.name.value;
        const annDef: AbstractAnnotationDef = { name: annName };
        if (annDecl.type) {
          annDef.type = annDecl.type.name.parts.join("::");
        }
        abstractAnnotations.set(annName, annDef);
      }

      if (
        item.kind === "LinkDeclaration" &&
        (item as LinkDeclaration).abstract
      ) {
        const linkDecl = item as LinkDeclaration;
        abstractLinks.set(linkDecl.name.value, linkDecl);
      }

      if (item.kind === "TypeDeclaration") {
        const name = (item as TypeDeclaration).name.value;
        objectTypeNames.add(name);
        objectTypeNames.add(`${module.name}::${name}`);
      }
    }
  }

  const scalars = userScalarBaseTypes(modules);

  for (const module of modules) {
    const baseTypeOf = (sdlType: string): string | undefined => scalarBaseType(sdlType, module.name, scalars);
    // A property of a sequence scalar gets its value from the scalar's
    // sequence when an insert leaves it out (see `migration/ddl.ts`). A bare
    // name is this module's scalar before one elsewhere.
    const isSequenceType = (edgeqlType: string): boolean =>
      ((edgeqlType.includes("::") ? undefined : scalars.get(`${module.name}::${edgeqlType}`)) ?? scalars.get(edgeqlType)) === "sequence";
    for (const item of module.items) {
      // Handle alias declarations
      if (item.kind === "AliasDeclaration") {
        const aliasDecl = item as AliasDeclaration;
        const aliasName = aliasDecl.name.value;
        const expression = stringifyExpression(aliasDecl.using);

        // Attempt to detect targetType from the expression.
        // If the expression is a PathExpression starting with a type name,
        // or a select/filter over a type, extract that type name.
        let targetType: string | undefined;
        if (aliasDecl.using.kind === "PathExpression") {
          // e.g., alias := User  or  alias := User.posts
          const firstSegment = aliasDecl.using.path[0];
          if (firstSegment && /^[A-Z]/.test(firstSegment)) {
            targetType = firstSegment;
          }
        } else if (aliasDecl.using.kind === "FunctionCall") {
          // Could be a select-like function, check first arg
          if (aliasDecl.using.args.length > 0) {
            const firstArg = aliasDecl.using.args[0];
            if (
              firstArg.kind === "PathExpression" &&
              firstArg.path[0] &&
              /^[A-Z]/.test(firstArg.path[0])
            ) {
              targetType = firstArg.path[0];
            }
          }
        }

        const aliasDef: AliasDef = {
          name: aliasName,
          expression
        };
        if (targetType) {
          aliasDef.targetType = targetType;
        }

        const aliasKey = module.name === "default" ?
          aliasName :
          `${module.name}::${aliasName}`;
        aliases.set(aliasKey, aliasDef);
        continue;
      }

      // Handle global declarations
      if (item.kind === "GlobalDeclaration") {
        const globalDecl = item as GlobalDeclaration;
        const globalName = globalDecl.name.value;
        const moduleName = module.name;
        const qualifiedName = `${moduleName}::${globalName}`;
        const edgeqlType = typeRefToSdlString(globalDecl.type);
        // A global of an enum has the enum's type, and one of a user scalar
        // its base type's, so its value compares and casts as one.
        const pgType = enumPgType(edgeqlType, moduleName, enumSqlTypes) ?? sdlTypeToSqlType(baseTypeOf(edgeqlType) ?? edgeqlType);

        const globalDef: GlobalDef = {
          name: globalName,
          module: moduleName,
          type: edgeqlType,
          pgType,
          required: globalDecl.required ?? false,
          multi: globalDecl.multi ?? false,
          readonly: globalDecl.readonly ?? false,
          pgSettingName: globalSettingName(moduleName, globalName)
        };

        if (globalDecl.default) {
          globalDef.default = stringifyExpression(globalDecl.default);
        }

        globals.set(qualifiedName, globalDef);
        continue;
      }

      // Handle scalar enum types
      if (item.kind === "ScalarTypeDeclaration") {
        const scalarDecl = item as ScalarTypeDeclaration;
        const scalarName = scalarDecl.name.value;

        // Detect enum scalars: scalar type Status extending enum<...>
        // The extending TypeRef name will be "enum" if the parser captured it
        const enumExt = scalarDecl.extending?.find(
          ext => ext.name.parts[0] === "enum"
        );
        if (enumExt) {
          // The SDL parser wraps each `"VALUE"` literal as a TypeRef whose
          // qualified name is the string value (see `parseTypeParam` in
          // schema/parser.ts). Pull the values back out so the runtime
          // Schema knows what the enum accepts — without this, codegen,
          // drift detection, and the EdgeQL→SQL compiler's enum-cast
          // path can't tell the type apart from any other unknown name.
          const enumValues = (enumExt.params ?? []).map(p => p.name.parts.join("::"));
          const enumDef: TypeDef = {
            name: scalarName,
            kind: "enum",
            tableName: typeNameToTableName(scalarName),
            properties: new Map(),
            links: new Map(),
            enumSqlType: enumSqlTypes.get(`${module.name}::${scalarName}`),
            enumValues,
            module: module.name
          };
          // Store under the bare name so `<LogLevel>` lookups in cast
          // expressions resolve regardless of which module declared the
          // enum. Also store under the module-qualified name so existing
          // call sites that pass `logger::LogLevel` still find it. When
          // enums share a name, the bare name is the default module's.
          if (module.name === "default" || types.get(scalarName)?.module !== "default")
            types.set(scalarName, enumDef);
          if (module.name !== "default") {
            types.set(`${module.name}::${scalarName}`, enumDef);
          }
        }

        continue;
      }

      if (item.kind !== "TypeDeclaration") {
        continue;
      }

      const typeDecl = item as TypeDeclaration;
      const typeName = typeDecl.name.value;
      const tableName = typeNameToTableName(typeName);

      // Start with implicit id property
      const properties = new Map<string, PropertyDef>();
      properties.set("id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id"
      });

      const links = new Map<string, LinkDef>();

      // Extract properties from the type declaration
      const propDeclarations = converter.extractProperties(typeDecl);
      for (const propDecl of propDeclarations) {
        const propName = propDecl.name.value;
        const sdlTypeName = typeRefToSdlString(propDecl.type);

        // Reclassify: SDL colon-form `name: ObjectType` parses as a
        // PropertyDeclaration but is semantically a link whenever the
        // target is an object type. Build a LinkDef so DDL lays down a
        // proper FK column (not a `text` column with the class name as a
        // string) and codegen routes the reference through namespace-aware
        // type resolution. Mirrors the arrow-shorthand reclassification
        // below (which handles `name -> ScalarType` in the inverse
        // direction).
        // A computed pure-backlink (`subscribers := .<subscriptions[is
        // Customer]`) is a real reverse *link*, not a scalar property.
        // Classify it as a computed multi-link targeting the intersection
        // type; the third pass below derives its junction/FK traversal from
        // the forward link it reverses. `backlink` temporarily holds the
        // forward link name until then.
        if (propDecl.computed) {
          const bl = extractBacklinkInfo(propDecl.computed);
          const blTargetIsObject = bl !== null &&
            (objectTypeNames.has(bl.target) ||
              objectTypeNames.has(bl.target.replace(/^default::/, "")));
          if (bl && blTargetIsObject) {
            links.set(propName, {
              name: propName,
              target: bl.target,
              // Declared `required` (which detectComputedPointerErrors rejects: a backlink may be empty).
              required: propDecl.required ?? false,
              multi: true,
              // Declared `single` (which detectComputedPointerErrors rejects: a backlink may be several).
              ...(propDecl.single ? { single: true } : {}),
              computed: true,
              computedExpr: propDecl.computedSource ?? sdlExpressionToEdgeQL(propDecl.computed),
              backlink: bl.forwardLink
            });
            continue;
          }
        }

        const isObjectTarget = objectTypeNames.has(sdlTypeName) ||
          objectTypeNames.has(sdlTypeName.replace(/^default::/, ""));
        if (isObjectTarget && !propDecl.computed) {
          const linkAnnotations = extractAnnotationMap(propDecl.annotations);
          const isMultiLink = propDecl.multi ?? false;
          const linkProperties = linkPropertyDefs(propDecl.properties, baseTypeOf);
          links.set(propName, {
            name: propName,
            target: sdlTypeName,
            required: propDecl.required ?? false,
            multi: isMultiLink,
            // Same column convention as the LinkDeclaration branch below:
            // single links live in a snake_case `<name>_id` FK column,
            // multi links in a junction table (no inline column).
            columnName: isMultiLink ?
              undefined :
              linkColumnName(propName),
            computed: propDecl.computed !== undefined,
            annotations: linkAnnotations,
            ...(linkProperties ? { properties: linkProperties } : {})
          });
          continue;
        }

        // A stored multi property is an array column of its element type
        // (`multi scopes: str` → `text[]`); `edgeqlType` keeps the element.
        // A user scalar's column is its base type's.
        const baseType = baseTypeOf(sdlTypeName);
        const elementSqlType = sdlTypeToSqlType(baseType ?? sdlTypeName);
        const sqlType = propDecl.multi && !propDecl.computed ? `${elementSqlType}[]` : elementSqlType;

        const constraints = extractPropertyConstraints(
          propDecl.constraints
        );

        // Extract rewrites from the property declaration
        const rewrites: RewriteDef[] | undefined = propDecl.rewrites && propDecl.rewrites.length > 0 ?
          propDecl.rewrites.map(r => ({
            events: [...r.events],
            body: r.using
          })) :
          undefined;

        const propAnnotations = extractAnnotationMap(
          propDecl.annotations
        );

        // Stringify the computed expression so the compiler can re-parse
        // and inline it at shape-element resolution. Without this, a
        // computed property like `expires := .created + ...` would emit
        // a column reference to a non-existent `expires` column.
        const computedExpr = propDecl.computed ?
          propDecl.computedSource ?? sdlExpressionToEdgeQL(propDecl.computed) :
          undefined;

        properties.set(propName, {
          name: propName,
          type: sqlType,
          required: propDecl.required ?? false,
          multi: propDecl.multi ?? false,
          columnName: propNameToColumnName(propName),
          edgeqlType: sdlTypeName,
          ...(baseType ? { baseType } : {}),
          readonly: propDecl.readonly ?? false,
          hasDefault: propDecl.default !== undefined || (!propDecl.multi && isSequenceType(sdlTypeName)),
          computed: propDecl.computed !== undefined,
          computedExpr,
          ...(propDecl.single ? { single: true } : {}),
          constraints,
          rewrites,
          annotations: propAnnotations
        });
      }

      // Extract links from the type declaration, resolving link inheritance
      const linkDeclarations = converter.extractLinks(typeDecl);
      for (const linkDecl of linkDeclarations) {
        // Resolve link inheritance: merge properties and constraints
        // from abstract links into this concrete link
        if (linkDecl.extending) {
          for (const baseRef of linkDecl.extending) {
            const baseName = baseRef.name.parts.join("::");
            const abstractLink = abstractLinks.get(baseName);
            if (!abstractLink) {
              continue;
            }

            // Merge inherited properties (concrete wins)
            if (abstractLink.properties) {
              const ownPropNames = new Set(
                (linkDecl.properties ?? []).map(p => p.name.value)
              );
              const inherited = abstractLink.properties.filter(
                p => !ownPropNames.has(p.name.value)
              );
              if (inherited.length > 0) {
                if (!linkDecl.properties) {
                  linkDecl.properties = [];
                }
                linkDecl.properties.push(...inherited);
              }
            }

            // Merge inherited constraints
            if (abstractLink.constraints) {
              if (!linkDecl.constraints) {
                linkDecl.constraints = [];
              }
              linkDecl.constraints.push(...abstractLink.constraints);
            }
          }
        }

        const linkName = linkDecl.name.value;
        const targetName = linkDecl.target.name.parts.join("::");
        const isMulti = linkDecl.multi ?? false;

        const linkAnnotations = extractAnnotationMap(
          linkDecl.annotations
        );

        // Reclassify: SDL arrow shorthand `name -> ScalarType` parses as
        // a LinkDeclaration but is semantically a property whenever the
        // target isn't an object type. Build a PropertyDef directly from
        // the LinkDecl AST so the body's default/readonly/constraints
        // carry over (they're captured by parseLinkBody).
        const isObjectTarget = objectTypeNames.has(targetName) ||
          objectTypeNames.has(targetName.replace(/^default::/, ""));
        if (!isObjectTarget) {
          // Render the FULL target type — `targetName` is only the bare head
          // (`tuple`, `array`), so collection parameters would otherwise be
          // lost and codegen would emit unbindable `<tuple>`/`<array>` casts.
          // Mirrors the PropertyDeclaration branch, which uses the same helper.
          const fullTypeName = typeRefToSdlString(linkDecl.target);
          const baseType = baseTypeOf(fullTypeName);
          const elementSqlType = sdlTypeToSqlType(baseType ?? fullTypeName);
          const sqlType = isMulti && !linkDecl.computed ? `${elementSqlType}[]` : elementSqlType;
          const linkConstraints = extractPropertyConstraints(
            linkDecl.constraints
          );
          properties.set(linkName, {
            name: linkName,
            type: sqlType,
            required: linkDecl.required ?? false,
            multi: isMulti,
            columnName: propNameToColumnName(linkName),
            edgeqlType: fullTypeName,
            ...(baseType ? { baseType } : {}),
            readonly: linkDecl.readonly ?? false,
            hasDefault: linkDecl.default !== undefined || (!isMulti && isSequenceType(fullTypeName)),
            computed: linkDecl.computed !== undefined,
            constraints: linkConstraints,
            annotations: linkAnnotations
          });
          continue;
        }

        const linkProperties = linkPropertyDefs(linkDecl.properties, baseTypeOf);
        links.set(linkName, {
          ...(linkProperties ? { properties: linkProperties } : {}),
          name: linkName,
          target: targetName,
          required: linkDecl.required ?? false,
          multi: isMulti,
          // FK column name is snake_case so Postgres' unquoted-identifier
          // lowercasing doesn't break round-tripping (e.g. `payoutAddresses_id`
          // would lowercase to `payoutaddresses_id` and miss the column).
          columnName: isMulti ?
            undefined :
            linkColumnName(linkName),
          computed: linkDecl.computed ? true : undefined,
          annotations: linkAnnotations
        });
      }

      // Extract access policies from the type declaration
      const sdlPolicies = typeDecl.members.filter(
        (m): m is SDLAccessPolicy => m.kind === "AccessPolicy"
      );
      const accessPolicies = sdlPolicies.length > 0 ?
        adaptAccessPolicies(typeName, sdlPolicies) :
        undefined;

      // Extract indexes from the type declaration. SDL `index on (.foo)`
      // surfaces here as `AST.Index` members; we stringify the `on`
      // expression via the existing helper so the EdgeQL compiler and
      // introspection endpoint can both render them.
      const indexDecls = converter.extractIndexes(typeDecl);
      const indexes: IndexDef[] | undefined = indexDecls.length > 0 ?
        indexDecls.map(idx => ({
          name: idx.name?.value,
          expression: stringifyExpression(idx.on)
        })) :
        undefined;

      // Extract triggers from the type declaration
      const triggerDecls = typeDecl.members.filter(
        (m): m is TriggerDeclaration => m.kind === "TriggerDeclaration"
      );
      const triggers: TriggerDef[] | undefined = triggerDecls.length > 0 ?
        triggerDecls.map(t => ({
          name: t.name.value,
          timing: t.timing,
          events: [...t.events],
          scope: t.scope,
          body: stringifyExpression(t.body)
        })) :
        undefined;

      // Extract inheritance info from SDL AST
      const isAbstract = typeDecl.abstract ?? false;
      const parentTypeNames = typeDecl.extending?.map(
        ext => ext.name.parts.join("::")
      );

      // Extract type-level annotations from type members
      const typeAnnotationMembers = typeDecl.members.filter(
        (m): m is SDLAnnotation => m.kind === "Annotation"
      );
      const typeAnnotations = extractAnnotationMap(
        typeAnnotationMembers.length > 0 ? typeAnnotationMembers : undefined
      );

      const typeDef: TypeDef = {
        name: typeName,
        kind: "object",
        tableName,
        properties,
        links,
        accessPolicies,
        triggers,
        annotations: typeAnnotations,
        indexes
      };

      if (isAbstract) {
        typeDef.abstract = true;
      }
      if (parentTypeNames && parentTypeNames.length > 0) {
        typeDef.parentTypes = parentTypeNames;
      }

      typeDef.module = module.name;
      const typeKey = module.name === "default" ?
        typeName :
        `${module.name}::${typeName}`;
      types.set(typeKey, typeDef);
    }
  }

  // Second pass: resolve type hierarchy — populate subtypes, merge
  // inherited properties/links, and set discriminator columns.
  // Supports multiple inheritance: each parent contributes properties/links.
  for (const [_typeName, typeDef] of types) {
    if (!typeDef.parentTypes || typeDef.parentTypes.length === 0) {
      continue;
    }

    for (const parentName of typeDef.parentTypes) {
      // Look up by literal name first, then strip a `default::` prefix —
      // types in the default module are stored under their bare key (see
      // line 737-740), so `extending default::BaseRecord` from another
      // module would otherwise silently fail to find its parent.
      let parentDef = types.get(parentName);
      if (!parentDef && parentName.startsWith("default::")) {
        parentDef = types.get(parentName.slice("default::".length));
      }
      if (!parentDef) {
        continue;
      }

      // Register this type as a subtype of each parent
      if (!parentDef.subtypes) {
        parentDef.subtypes = [];
      }
      parentDef.subtypes.push(typeDef.name);

      // Set discriminator column on parent
      parentDef.discriminatorColumn = "__type__";

      // Merge inherited properties: add parent props that child doesn't have
      for (const [propName, propDef] of parentDef.properties) {
        if (!typeDef.properties.has(propName)) {
          typeDef.properties.set(propName, { ...propDef });
        }
      }

      // Merge inherited links: add parent links that child doesn't have
      for (const [linkName, linkDef] of parentDef.links) {
        if (!typeDef.links.has(linkName)) {
          typeDef.links.set(linkName, { ...linkDef });
        }
      }
    }
  }

  // Access policies are inherited (Gel: "any sub-type extending a type
  // inherits all of its access policies"): a type answers to its own
  // policies and every ancestor's, each registered under the type's own
  // name. A policy the type (or a nearer ancestor) declares under the same
  // name takes the place of the inherited one.
  const ownPolicies = new Map([...types.values()].map(typeDef => [typeDef, typeDef.accessPolicies ?? []]));
  const findType = (name: string): TypeDef | undefined =>
    types.get(name) ?? (name.startsWith("default::") ? types.get(name.slice("default::".length)) : undefined);
  for (const typeDef of types.values()) {
    const policies = [...ownPolicies.get(typeDef)!];
    const visited = new Set<TypeDef>([typeDef]);
    const inherit = (child: TypeDef): void => {
      for (const parent of (child.parentTypes ?? []).map(findType)) {
        if (!parent || visited.has(parent)) {
          continue;
        }
        visited.add(parent);
        for (const policy of ownPolicies.get(parent)!) {
          if (!policies.some(existing => existing.name === policy.name)) {
            policies.push({ ...policy, objectType: typeDef.name });
          }
        }
        inherit(parent);
      }
    };
    inherit(typeDef);
    if (policies.length > 0) {
      typeDef.accessPolicies = policies;
    }
  }

  // Third pass: resolve junction tables and computed reverse-link traversal.

  // Cross-module-aware lookup: SDL stores `linkDef.target` verbatim from
  // the source text (often unqualified, e.g. `multi options -> PaymentOption`
  // from inside `payment::`), but `types` is keyed by qualified name for
  // non-default modules. Try the verbatim key, then a same-module qualified
  // key (so `PaymentOption` resolves to `payment::PaymentOption` when the
  // owner is in `payment::`), and finally strip a `default::` prefix.
  const resolveLinkTarget = (
    target: string,
    ownerModule: string | undefined
  ): TypeDef | undefined => {
    const direct = types.get(target);
    if (direct)
      return direct;
    if (!target.includes("::") && ownerModule && ownerModule !== "default") {
      const qualified = types.get(`${ownerModule}::${target}`);
      if (qualified)
        return qualified;
    }
    if (target.startsWith("default::")) {
      return types.get(target.slice("default::".length));
    }
    return undefined;
  };

  // (a) Every stored `multi` link is backed by its own junction table
  // `<table>_<link>` (source_id/target_id) — matching the DDL generator,
  // which emits one per multi link unconditionally. A plain `multi x -> T`
  // is its own relationship; bidirectional M2M is expressed as one stored
  // link plus a computed backlink (resolved in (b) below), and mutual stored
  // multi links are rejected before reaching here (see
  // `detectMutualStoredMultiLinks`).
  for (const [, typeDef] of types) {
    for (const [, linkDef] of typeDef.links) {
      if (!linkDef.multi || linkDef.computed || linkDef.junctionTable) {
        continue;
      }
      linkDef.junctionTable = `${typeDef.tableName}_${linkDef.name}`;
      linkDef.junctionSourceColumn = "source_id";
      linkDef.junctionTargetColumn = "target_id";
    }
  }

  // (b) Computed reverse-link traversal (`x := .<fwd[is T]`). The link
  // reverses a forward link on the target type; derive its junction (with
  // source/target columns swapped) or single-FK `backlink` metadata so the
  // compiler's existing link-shape and aggregate machinery can walk it.
  // `backlink` currently holds the forward link's name.
  for (const [, typeDef] of types) {
    for (const [, linkDef] of typeDef.links) {
      if (!linkDef.computed || !linkDef.backlink) {
        continue;
      }
      const targetTypeDef = resolveLinkTarget(linkDef.target, typeDef.module);
      const forwardLink = targetTypeDef?.links.get(linkDef.backlink);
      if (!forwardLink) {
        continue;
      }
      if (forwardLink.junctionTable) {
        // Same junction, reversed direction → swap source/target columns.
        linkDef.junctionTable = forwardLink.junctionTable;
        linkDef.junctionSourceColumn = forwardLink.junctionTargetColumn ??
          "target_id";
        linkDef.junctionTargetColumn = forwardLink.junctionSourceColumn ??
          "source_id";
        linkDef.backlink = undefined;
        // The junction row carries the link properties in both directions.
        if (forwardLink.properties) {
          linkDef.properties = forwardLink.properties;
        }
      }
      // else: forward link is a single FK; keep `backlink` so the link-shape
      // compiler resolves `target.<backlink>.columnName`.
    }
  }

  // SDL `function` declarations, so a call to one is a known function. A
  // function of the default module is called bare; any other by its module.
  const functions = getBuiltinFunctions();
  for (const module of modules) {
    for (const item of module.items) {
      if (item.kind === "FunctionDeclaration") {
        const name = module.name === "default" ? item.name.value : `${module.name}::${item.name.value}`;
        functions.set(name, {
          args: item.parameters.map(parameter => ({
            name: parameter.name.value,
            required: parameter.typemod !== "optional" && !parameter.default,
            type: parameter.type.name.parts.join("::")
          })),
          name,
          returnType: typeRefToSdlString(item.returnType),
          ...(item.returnTypemod ? { returnTypemod: item.returnTypemod } : {})
        });
      }
    }
  }

  // (c) A computed that yields objects (`auth := .author`, `first :=
  // (select .<post[is Comment] … limit 1)`) is a computed link to their
  // type, not a property: selected with a sub-shape, filtered through, and
  // typed by codegen like a stored link. It has no storage; the compiler
  // inlines `computedExpr`. A path to a property (`t := .title`, `bodies :=
  // .<post[is Comment].body`) is typed as that property, and any other
  // expression as inferComputedValues types it (`count(…)` is a required
  // int64). Repeated until nothing changes, since one may go through another
  // (`x := .auth.best_friend`). Declared `multi` / `required` / `single`
  // stand (detectComputedPointerErrors rejects `required` on one that may be
  // empty, `single` on one that may be several).
  for (let changed = true; changed;) {
    changed = false;
    for (const typeDef of types.values()) {
      for (const [name, property] of typeDef.properties) {
        if (!property.computed || !property.computedExpr || property.edgeqlType !== "auto") {
          continue;
        }
        const expr = new EdgeQLParser(property.computedExpr).parseExpressionOnly();
        const resolve = (target: string) => resolveLinkTarget(target, typeDef.module);
        const inferred = inferComputedLink(expr, typeDef, resolve);
        if (!inferred) {
          const values = inferComputedPropertyValues(expr, typeDef, resolve, functions);
          // Its cardinality even when its type can't be told (it stays `auto`).
          const next: PropertyDef | null = values && {
            ...property,
            ...(values.type ? { edgeqlType: values.type } : {}),
            ...(values.baseType ? { baseType: values.baseType } : {}),
            multi: !property.single && (property.multi || values.multi),
            required: property.required || values.required
          };
          if (next && (next.edgeqlType !== property.edgeqlType || next.multi !== property.multi || next.required !== property.required)) {
            typeDef.properties.set(name, next);
            changed = true;
          }
          continue;
        }
        typeDef.properties.delete(name);
        typeDef.links.set(name, {
          annotations: property.annotations,
          computed: true,
          computedExpr: property.computedExpr,
          multi: !property.single && (property.multi || inferred.multi),
          name,
          required: property.required || inferred.required,
          ...(property.single ? { single: true } : {}),
          target: inferred.target
        });
        changed = true;
      }
    }
  }

  const schema: Schema = {
    types,
    functions
  };
  if (aliases.size > 0) {
    schema.aliases = aliases;
  }
  if (globals.size > 0) {
    schema.globals = globals;
  }
  if (abstractAnnotations.size > 0) {
    schema.abstractAnnotations = abstractAnnotations;
  }
  if (scalars.size > 0) {
    schema.scalars = scalars;
  }
  const scalarChecks = scalarChecksOf(modules);
  if (scalarChecks.size > 0) {
    schema.scalarChecks = scalarChecks;
  }
  return schema;
}

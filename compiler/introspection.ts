/**
 * Schema Introspection Module
 *
 * Provides DESCRIBE TYPE and DESCRIBE SCHEMA functionality by extracting
 * metadata from the in-memory Schema representation and returning structured
 * descriptions that the compiler serializes as JSON literals.
 */

import type { FunctionDef, LinkDef, PropertyDef, Schema, TypeDef } from "./context.ts";
import { CompilationError } from "../lib/errors.ts";

// ---------------------------------------------------------------------------
// Description interfaces
// ---------------------------------------------------------------------------

export interface PropertyDescription {
  name: string;
  type: string;
  required: boolean;
  readonly: boolean;
  hasDefault: boolean;
  computed: boolean;
  constraints: string[];
  annotations: Record<string, string>;
  /**
   * True when marked with `@secret := true` (or qualified `std::secret`).
   * SDK and UI consumers use this to mask values in introspection output
   * and admin views without string-matching the annotations map.
   */
  secret: boolean;
}

export interface LinkDescription {
  name: string;
  target: string;
  cardinality: "single" | "multi";
  required: boolean;
  readonly: boolean;
  annotations: Record<string, string>;
  secret: boolean;
}

export interface TypeDescription {
  name: string;
  module: string;
  abstract: boolean;
  parentTypes: string[];
  properties: PropertyDescription[];
  links: LinkDescription[];
  accessPolicies: string[];
  indexes: string[];
  annotations: Record<string, string>;
  secret: boolean;
}

export interface FunctionDescription {
  name: string;
  params: string[];
  returnType: string;
}

export interface SchemaDescription {
  modules: string[];
  types: TypeDescription[];
  functions: FunctionDescription[];
}

// ---------------------------------------------------------------------------
// describeType
// ---------------------------------------------------------------------------

/**
 * Look up a type in the schema and return a structured description of its
 * properties, links, constraints, access policies, and inheritance.
 *
 * Throws a CompilationError if the type is not found.
 */
export function describeType(
  schema: Schema,
  typeName: string,
): TypeDescription {
  // Try exact match first, then try common qualified lookups
  let typeDef = schema.types.get(typeName);

  if (!typeDef && !typeName.includes("::")) {
    typeDef = schema.types.get(`default::${typeName}`);
  }

  if (!typeDef) {
    throw new CompilationError(
      `Type '${typeName}' not found in schema`,
    );
  }

  return buildTypeDescription(typeDef);
}

// ---------------------------------------------------------------------------
// describeSchema
// ---------------------------------------------------------------------------

/**
 * Iterate all types and functions in the schema and return a full description.
 */
export function describeSchema(schema: Schema): SchemaDescription {
  const modulesSet = new Set<string>();
  const types: TypeDescription[] = [];

  for (const typeDef of schema.types.values()) {
    const desc = buildTypeDescription(typeDef);
    types.push(desc);
    modulesSet.add(desc.module);
  }

  const functions: FunctionDescription[] = [];
  for (const funcDef of schema.functions.values()) {
    functions.push(buildFunctionDescription(funcDef));
  }

  // Sort for deterministic output
  const modules = [...modulesSet].sort();
  types.sort((a, b) => a.name.localeCompare(b.name));
  functions.sort((a, b) => a.name.localeCompare(b.name));

  return { modules, types, functions };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isSecretAnnotation(
  annotations: Record<string, string> | undefined,
): boolean {
  if (!annotations) return false;
  const raw = annotations["secret"] ?? annotations["std::secret"];
  if (raw === undefined) return false;
  // SchemaManager preserves SDL string literal quotes (e.g. `'true'`),
  // while synthetic test fixtures pass raw `"true"`. Accept both.
  const stripped = raw.replace(/^['"]|['"]$/g, "");
  return stripped === "true";
}

function buildTypeDescription(typeDef: TypeDef): TypeDescription {
  const module = extractModule(typeDef.name);

  const properties: PropertyDescription[] = [];
  for (const prop of typeDef.properties.values()) {
    properties.push(buildPropertyDescription(prop));
  }
  properties.sort((a, b) => a.name.localeCompare(b.name));

  const links: LinkDescription[] = [];
  for (const link of typeDef.links.values()) {
    links.push(buildLinkDescription(link));
  }
  links.sort((a, b) => a.name.localeCompare(b.name));

  const accessPolicies: string[] = [];
  if (typeDef.accessPolicies) {
    for (const policy of typeDef.accessPolicies) {
      accessPolicies.push(policy.name);
    }
  }

  const indexes: string[] = [];
  if (typeDef.indexes) {
    for (const idx of typeDef.indexes) {
      // Format as `name: expression` when named, else just the
      // expression — matches the convention SDL uses textually.
      indexes.push(idx.name ? `${idx.name}: ${idx.expression}` : idx.expression);
    }
  }

  return {
    name: typeDef.name,
    module,
    abstract: typeDef.abstract ?? false,
    parentTypes: typeDef.parentTypes ?? [],
    properties,
    links,
    accessPolicies,
    indexes,
    annotations: typeDef.annotations ?? {},
    secret: isSecretAnnotation(typeDef.annotations),
  };
}

function buildPropertyDescription(prop: PropertyDef): PropertyDescription {
  const constraints: string[] = [];
  if (prop.constraints) {
    for (const c of prop.constraints) {
      if (c.args && c.args.length > 0) {
        constraints.push(`${c.name}(${c.args.join(", ")})`);
      } else {
        constraints.push(c.name);
      }
    }
  }

  return {
    name: prop.name,
    type: prop.edgeqlType ?? prop.type,
    required: prop.required,
    readonly: prop.readonly ?? false,
    hasDefault: prop.hasDefault ?? false,
    computed: prop.computed ?? false,
    constraints,
    annotations: prop.annotations ?? {},
    secret: isSecretAnnotation(prop.annotations),
  };
}

function buildLinkDescription(link: LinkDef): LinkDescription {
  return {
    name: link.name,
    target: link.target,
    cardinality: link.multi ? "multi" : "single",
    required: link.required,
    readonly: false,
    annotations: link.annotations ?? {},
    secret: isSecretAnnotation(link.annotations),
  };
}

function buildFunctionDescription(funcDef: FunctionDef): FunctionDescription {
  const params = funcDef.args.map((arg) => {
    const req = arg.required ? "required " : "";
    return `${req}${arg.name}: ${arg.type}`;
  });

  return {
    name: funcDef.name,
    params,
    returnType: funcDef.returnType,
  };
}

/**
 * Extract the module name from a (possibly qualified) type name.
 * "default::User" -> "default"
 * "User" -> "default"
 */
function extractModule(name: string): string {
  const idx = name.lastIndexOf("::");
  if (idx >= 0) {
    return name.substring(0, idx);
  }
  return "default";
}

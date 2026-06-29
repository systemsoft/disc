/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * TypeScript Codegen Types and Interfaces
 */

/*** UTILITY ------------------------------------------ ***/

/**
 * Map SQL type names to their EdgeQL equivalents for backward compatibility.
 * When PropertyDef.edgeqlType is missing, the type field may contain SQL types
 * (e.g., "text", "integer") instead of EdgeQL types (e.g., "str", "int32").
 */
const SQL_TO_EDGEQL_TYPE_MAP: Record<string, string> = {
  bigint: "int64",
  boolean: "bool",
  bytea: "bytes",
  date: "cal::local_date",
  "double precision": "float64",
  integer: "int32",
  interval: "duration",
  jsonb: "json",
  numeric: "decimal",
  real: "float32",
  smallint: "int16",
  text: "str",
  time: "cal::local_time",
  timestamp: "cal::local_datetime",
  timestamptz: "datetime",
  uuid: "uuid"
};

/*** EXPORT ------------------------------------------- ***/

export interface ClientDefinition {
  className: string;
  constructorParams: MethodParameter[];
  imports: string[];
  methods: ClientMethod[];
}

export interface ClientMethod {
  body: string;
  description?: string;
  isAsync: boolean;
  name: string;
  parameters: MethodParameter[];
  returnType: string;
}

export interface CodegenConfig {
  formatOutput: boolean;
  includeClient: boolean;
  includeMutations: boolean;
  includeQueryBuilders: boolean;
  interfaceSuffix?: string;
  outputDir: string;
  schemaDir?: string;
  /**
   * Schema epoch baked into the generated client as
   * `static readonly SCHEMA_EPOCH`. Must equal the value `disc migrate`
   * stores in `disc_migrations.schema_hash` (computed via
   * `MigrationEngine.hashSchemaForBaseline`) so the client and server
   * agree on which schema version the generated code targets. Optional
   * for back-compat: when absent, no epoch is emitted.
   */
  schemaEpoch?: string;
  schemaSource: string;
  /**
   * Base module specifier for the Disc SDK re-exports emitted into the
   * generated client. Defaults to `"./sdk/mod.ts"` — `disc codegen`
   * materializes the embedded SDK into `<outputDir>/sdk/` alongside the
   * generated `client.ts`, so the relative import resolves out of the
   * box for downstream projects. Override to e.g. `"jsr:@disc/db/sdk"`
   * if you’d rather depend on a published SDK package than ship the
   * extracted copy.
   */
  sdkImportBase?: string;
  target: "both" | "client" | "server";
  typePrefix?: string;
}

export interface CodegenResult {
  errors: string[];
  files: GeneratedFile[];
  warnings: string[];
}

export interface GeneratedFile {
  content: string;
  path: string;
  type: "client" | "index" | "interfaces" | "mutations" | "queries" | "types";
}

export interface MethodParameter {
  description?: string;
  name: string;
  optional: boolean;
  type: string;
}

export interface PropertyDefinition {
  array: boolean;
  defaultValue?: string;
  description?: string;
  name: string;
  nullable: boolean;
  optional: boolean;
  type: string;
}

export interface QueryBuilderDefinition {
  methods: QueryMethod[];
  name: string;
  returnType: string;
  targetType: string;
}

export interface QueryMethod {
  body: string;
  description?: string;
  name: string;
  parameters: MethodParameter[];
  returnType: string;
}

export interface TypeDefinition {
  description?: string;
  export: boolean;
  extends?: string[];
  kind: "enum" | "interface" | "type" | "union";
  name: string;
  properties: PropertyDefinition[];
}

export interface TypeMapping {
  arrayType: string;
  edgeqlType: string;
  importRequired?: string;
  nullableType: string;
  typescriptType: string;
}

export const DEFAULT_TYPE_MAPPINGS: TypeMapping[] = [
  {
    arrayType: "string[]",
    edgeqlType: "str",
    nullableType: "string | null",
    typescriptType: "string"
  },
  {
    arrayType: "boolean[]",
    edgeqlType: "bool",
    nullableType: "boolean | null",
    typescriptType: "boolean"
  },
  {
    arrayType: "number[]",
    edgeqlType: "int16",
    nullableType: "number | null",
    typescriptType: "number"
  },
  {
    arrayType: "number[]",
    edgeqlType: "int32",
    nullableType: "number | null",
    typescriptType: "number"
  },
  {
    arrayType: "bigint[]",
    /*** `int64` values can exceed JS `Number.MAX_SAFE_INTEGER` (2^53-1). Generating `number` lost
         precision silently on large values. `bigint` is lossless and matches how PG drivers
         surface int8. ***/
    edgeqlType: "int64",
    nullableType: "bigint | null",
    typescriptType: "bigint"
  },
  {
    arrayType: "number[]",
    edgeqlType: "float32",
    nullableType: "number | null",
    typescriptType: "number"
  },
  {
    arrayType: "number[]",
    edgeqlType: "float64",
    nullableType: "number | null",
    typescriptType: "number"
  },
  {
    arrayType: "number[]",
    edgeqlType: "decimal",
    nullableType: "number | null",
    typescriptType: "number"
  },
  {
    arrayType: "string[]",
    edgeqlType: "uuid",
    nullableType: "string | null",
    typescriptType: "string"
  },
  {
    arrayType: "Date[]",
    edgeqlType: "datetime",
    nullableType: "Date | null",
    typescriptType: "Date"
  },
  {
    arrayType: "string[]",
    edgeqlType: "duration",
    nullableType: "string | null",
    typescriptType: "string"
  },
  {
    arrayType: "Uint8Array[]",
    edgeqlType: "bytes",
    importRequired: "// Note: Uint8Array is built-in",
    nullableType: "Uint8Array | null",
    typescriptType: "Uint8Array"
  },
  {
    arrayType: "unknown[]",
    edgeqlType: "json",
    nullableType: "unknown | null",
    typescriptType: "unknown"
  },
  {
    arrayType: "Date[]",
    edgeqlType: "cal::local_datetime",
    nullableType: "Date | null",
    typescriptType: "Date"
  },
  {
    arrayType: "string[]",
    edgeqlType: "cal::local_date",
    nullableType: "string | null",
    typescriptType: "string"
  },
  {
    arrayType: "string[]",
    edgeqlType: "cal::local_time",
    nullableType: "string | null",
    typescriptType: "string"
  },
  {
    arrayType: "string[]",
    edgeqlType: "cal::relative_duration",
    nullableType: "string | null",
    typescriptType: "string"
  },
  {
    arrayType: "string[]",
    edgeqlType: "cal::date_duration",
    nullableType: "string | null",
    typescriptType: "string"
  }
];

export function getTypeMapping(edgeqlType: string): TypeMapping | null {
  return DEFAULT_TYPE_MAPPINGS.find(mapping => mapping.edgeqlType === edgeqlType) || null;
}

/**
 * Map an EdgeQL type name to its EdgeQL cast syntax.
 */
export function mapEdgeQLTypeToEdgeQLCast(edgeqlType: string): string {
  const castMap: Record<string, string> = {
    bigint: "<bigint>",
    bool: "<bool>",
    bytes: "<bytes>",
    "cal::date_duration": "<cal::date_duration>",
    "cal::local_date": "<cal::local_date>",
    "cal::local_datetime": "<cal::local_datetime>",
    "cal::local_time": "<cal::local_time>",
    "cal::relative_duration": "<cal::relative_duration>",
    datetime: "<datetime>",
    decimal: "<decimal>",
    duration: "<duration>",
    float32: "<float32>",
    float64: "<float64>",
    int16: "<int16>",
    int32: "<int32>",
    int64: "<int64>",
    json: "<json>",
    sequence: "<sequence>",
    str: "<str>",
    uuid: "<uuid>"
  };

  return castMap[edgeqlType] || `<${edgeqlType}>`;
}

/**
 * Split a collection type's parameter list on top-level commas, ignoring
 * commas nested inside `<...>` (e.g. `tuple<int64, str>, str` → two params).
 */
function splitTopLevelParams(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "<")
      depth++;
    else if (ch === ">")
      depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

/**
 * Recursively map an EdgeQL type string to a *base* TypeScript type (no
 * nullability/multi suffix). Handles `array<T>` → `T[]`, named
 * `tuple<a: T, b: U>` → `{ a: T; b: U }`, and positional `tuple<T, U>` →
 * `[T, U]`; scalars/enums/objects defer to mapEdgeQLTypeToTypeScript. Without
 * this, raw EdgeQL collection syntax (the `:` inside `<>`) would leak into
 * generated .ts as invalid TypeScript.
 */
function edgeqlCollectionToTsBase(edgeqlType: string): string {
  const t = edgeqlType.trim();

  if (t.startsWith("array<") && t.endsWith(">")) {
    const inner = t.slice("array<".length, -1);
    return `${edgeqlCollectionToTsBase(inner)}[]`;
  }

  if (t.startsWith("tuple<") && t.endsWith(">")) {
    const params = splitTopLevelParams(t.slice("tuple<".length, -1));
    const labeled = params.map(p => {
      const m = p.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
      return m ? { name: m[1], type: m[2] } : { name: null, type: p };
    });
    /*** Named when every field carries a label (EdgeQL requires all-or-none). ***/
    if (labeled.every(f => f.name !== null)) {
      const fields = labeled
        .map(f => `${f.name}: ${edgeqlCollectionToTsBase(f.type)}`)
        .join("; ");
      return `{ ${fields} }`;
    }
    return `[${labeled.map(f => edgeqlCollectionToTsBase(f.type)).join(", ")}]`;
  }

  /*** Scalar / enum / object element — reuse the scalar mapping (required,
       non-multi) so `str` → `string`, `PFPShape` → `PFPShape`, etc. ***/
  return mapEdgeQLTypeToTypeScript(t, true, false);
}

export function mapEdgeQLTypeToTypeScript(edgeqlType: string, required: boolean = true, multi: boolean = false): string {
  /*** Computed properties carry the parser’s placeholder type `auto` — there’s no inference engine
       yet, so the surface type is genuinely unknown. Emit `unknown` rather than letting the keyword
       leak into TS as a literal. ***/
  if (edgeqlType === "auto") {
    const base = "unknown";

    if (multi)
      return required ? `${base}[]` : `${base}[] | null`;

    return required ? base : `${base} | null`;
  }

  /*** Collection types (array<…>, tuple<…>) have no scalar mapping — map them
       structurally so the generated .ts is valid TypeScript instead of leaking
       raw EdgeQL syntax. ***/
  const trimmed = edgeqlType.trim();
  if (trimmed.startsWith("array<") || trimmed.startsWith("tuple<")) {
    const base = edgeqlCollectionToTsBase(trimmed);
    const withMulti = multi ? `${base}[]` : base;
    return required ? withMulti : `${withMulti} | null`;
  }

  /*** Try direct EdgeQL type mapping first ***/
  let mapping = getTypeMapping(edgeqlType);

  /*** Fall back to SQL type name mapping for backward compatibility ***/
  if (!mapping) {
    const edgeqlEquivalent = SQL_TO_EDGEQL_TYPE_MAP[edgeqlType];

    if (edgeqlEquivalent)
      mapping = getTypeMapping(edgeqlEquivalent);
  }

  if (!mapping) {
    /*** For object types, use the type name directly. Strip any `module::` qualifier so the bare
         type name lands in TS — cross-module routing is handled by `resolveTypeReference` higher up
         in the generator. ***/
    let tsType = edgeqlType.includes("::") ?
      edgeqlType.split("::").pop()! :
      edgeqlType;

    if (multi)
      tsType += "[]";

    if (!required)
      tsType += " | null";

    return tsType;
  }

  if (multi)
    return required ? mapping.arrayType : `${mapping.arrayType} | null`;

  return required ? mapping.typescriptType : mapping.nullableType;
}

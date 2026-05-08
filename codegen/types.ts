/**
 * TypeScript Codegen Types and Interfaces
 */

export interface CodegenConfig {
  outputDir: string;
  schemaSource: string;
  schemaDir?: string;
  target: "client" | "server" | "both";
  typePrefix?: string;
  interfaceSuffix?: string;
  includeQueryBuilders: boolean;
  includeMutations: boolean;
  includeClient: boolean;
  formatOutput: boolean;
  /**
   * Base module specifier for the Disc SDK re-exports emitted into the
   * generated client. Defaults to `"./sdk/mod.ts"` — `disc codegen`
   * materializes the embedded SDK into `<outputDir>/sdk/` alongside the
   * generated `client.ts`, so the relative import resolves out of the
   * box for downstream projects. Override to e.g. `"jsr:@disc/db/sdk"`
   * if you'd rather depend on a published SDK package than ship the
   * extracted copy. (P1-21)
   */
  sdkImportBase?: string;
}

export interface TypeDefinition {
  name: string;
  kind: "interface" | "type" | "enum" | "union";
  properties: PropertyDefinition[];
  extends?: string[];
  export: boolean;
  description?: string;
}

export interface PropertyDefinition {
  name: string;
  type: string;
  optional: boolean;
  nullable: boolean;
  array: boolean;
  description?: string;
  defaultValue?: string;
}

export interface QueryBuilderDefinition {
  name: string;
  targetType: string;
  methods: QueryMethod[];
  returnType: string;
}

export interface QueryMethod {
  name: string;
  parameters: MethodParameter[];
  returnType: string;
  body: string;
  description?: string;
}

export interface MethodParameter {
  name: string;
  type: string;
  optional: boolean;
  description?: string;
}

export interface ClientDefinition {
  className: string;
  methods: ClientMethod[];
  constructorParams: MethodParameter[];
  imports: string[];
}

export interface ClientMethod {
  name: string;
  parameters: MethodParameter[];
  returnType: string;
  isAsync: boolean;
  body: string;
  description?: string;
}

export interface CodegenResult {
  files: GeneratedFile[];
  warnings: string[];
  errors: string[];
}

export interface GeneratedFile {
  path: string;
  content: string;
  type: "types" | "interfaces" | "client" | "queries" | "mutations" | "index";
}

export interface TypeMapping {
  edgeqlType: string;
  typescriptType: string;
  nullableType: string;
  arrayType: string;
  importRequired?: string;
}

// Built-in type mappings
export const DEFAULT_TYPE_MAPPINGS: TypeMapping[] = [
  {
    edgeqlType: "str",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]"
  },
  {
    edgeqlType: "bool",
    typescriptType: "boolean",
    nullableType: "boolean | null",
    arrayType: "boolean[]"
  },
  {
    edgeqlType: "int16",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]"
  },
  {
    edgeqlType: "int32",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]"
  },
  {
    // P1-20: `int64` values can exceed JS `Number.MAX_SAFE_INTEGER` (2^53-1).
    // Generating `number` lost precision silently on large values. `bigint`
    // is lossless and matches how PG drivers surface int8.
    edgeqlType: "int64",
    typescriptType: "bigint",
    nullableType: "bigint | null",
    arrayType: "bigint[]"
  },
  {
    edgeqlType: "float32",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]"
  },
  {
    edgeqlType: "float64",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]"
  },
  {
    edgeqlType: "decimal",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]"
  },
  {
    edgeqlType: "uuid",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]"
  },
  {
    edgeqlType: "datetime",
    typescriptType: "Date",
    nullableType: "Date | null",
    arrayType: "Date[]"
  },
  {
    edgeqlType: "duration",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]"
  },
  {
    edgeqlType: "bytes",
    typescriptType: "Uint8Array",
    nullableType: "Uint8Array | null",
    arrayType: "Uint8Array[]",
    importRequired: "// Note: Uint8Array is built-in"
  },
  {
    edgeqlType: "json",
    typescriptType: "unknown",
    nullableType: "unknown | null",
    arrayType: "unknown[]"
  },
  {
    edgeqlType: "cal::local_datetime",
    typescriptType: "Date",
    nullableType: "Date | null",
    arrayType: "Date[]"
  },
  {
    edgeqlType: "cal::local_date",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]"
  },
  {
    edgeqlType: "cal::local_time",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]"
  },
  {
    edgeqlType: "cal::relative_duration",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]"
  },
  {
    edgeqlType: "cal::date_duration",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]"
  }
];

export function getTypeMapping(edgeqlType: string): TypeMapping | null {
  return DEFAULT_TYPE_MAPPINGS.find(mapping => mapping.edgeqlType === edgeqlType) || null;
}

/**
 * Map SQL type names to their EdgeQL equivalents for backward compatibility.
 * When PropertyDef.edgeqlType is missing, the type field may contain SQL types
 * (e.g., "text", "integer") instead of EdgeQL types (e.g., "str", "int32").
 */
const SQL_TO_EDGEQL_TYPE_MAP: Record<string, string> = {
  text: "str",
  boolean: "bool",
  smallint: "int16",
  integer: "int32",
  bigint: "int64",
  real: "float32",
  "double precision": "float64",
  numeric: "decimal",
  uuid: "uuid",
  timestamptz: "datetime",
  timestamp: "cal::local_datetime",
  interval: "duration",
  bytea: "bytes",
  jsonb: "json",
  date: "cal::local_date",
  time: "cal::local_time"
};

/**
 * Map an EdgeQL type name to its EdgeQL cast syntax.
 */
export function mapEdgeQLTypeToEdgeQLCast(edgeqlType: string): string {
  const castMap: Record<string, string> = {
    str: "<str>",
    int16: "<int16>",
    int32: "<int32>",
    int64: "<int64>",
    float32: "<float32>",
    float64: "<float64>",
    bool: "<bool>",
    datetime: "<datetime>",
    duration: "<duration>",
    uuid: "<uuid>",
    bytes: "<bytes>",
    json: "<json>",
    bigint: "<bigint>",
    decimal: "<decimal>",
    sequence: "<sequence>",
    "cal::local_datetime": "<cal::local_datetime>",
    "cal::local_date": "<cal::local_date>",
    "cal::local_time": "<cal::local_time>",
    "cal::relative_duration": "<cal::relative_duration>",
    "cal::date_duration": "<cal::date_duration>"
  };
  return castMap[edgeqlType] || `<${edgeqlType}>`;
}

export function mapEdgeQLTypeToTypeScript(
  edgeqlType: string,
  required: boolean = true,
  multi: boolean = false
): string {
  // Try direct EdgeQL type mapping first
  let mapping = getTypeMapping(edgeqlType);

  // Fall back to SQL type name mapping for backward compatibility
  if (!mapping) {
    const edgeqlEquivalent = SQL_TO_EDGEQL_TYPE_MAP[edgeqlType];
    if (edgeqlEquivalent) {
      mapping = getTypeMapping(edgeqlEquivalent);
    }
  }

  if (!mapping) {
    // For object types, use the type name directly
    let tsType = edgeqlType;

    if (multi) {
      tsType += "[]";
    }

    if (!required) {
      tsType += " | null";
    }

    return tsType;
  }

  if (multi) {
    return required ? mapping.arrayType : `${mapping.arrayType} | null`;
  }

  return required ? mapping.typescriptType : mapping.nullableType;
}

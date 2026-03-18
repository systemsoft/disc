/**
 * TypeScript Codegen Types and Interfaces
 */

export interface CodegenConfig {
  outputDir: string;
  schemaSource: string;
  target: "client" | "server" | "both";
  typePrefix?: string;
  interfaceSuffix?: string;
  includeQueryBuilders: boolean;
  includeMutations: boolean;
  includeClient: boolean;
  formatOutput: boolean;
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
  type: "types" | "client" | "queries" | "mutations" | "index";
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
    arrayType: "string[]",
  },
  {
    edgeqlType: "bool",
    typescriptType: "boolean",
    nullableType: "boolean | null",
    arrayType: "boolean[]",
  },
  {
    edgeqlType: "int16",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]",
  },
  {
    edgeqlType: "int32",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]",
  },
  {
    edgeqlType: "int64",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]",
  },
  {
    edgeqlType: "float32",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]",
  },
  {
    edgeqlType: "float64",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]",
  },
  {
    edgeqlType: "decimal",
    typescriptType: "number",
    nullableType: "number | null",
    arrayType: "number[]",
  },
  {
    edgeqlType: "uuid",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]",
  },
  {
    edgeqlType: "datetime",
    typescriptType: "Date",
    nullableType: "Date | null",
    arrayType: "Date[]",
  },
  {
    edgeqlType: "duration",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]",
  },
  {
    edgeqlType: "bytes",
    typescriptType: "Uint8Array",
    nullableType: "Uint8Array | null",
    arrayType: "Uint8Array[]",
    importRequired: "// Note: Uint8Array is built-in",
  },
  {
    edgeqlType: "json",
    typescriptType: "unknown",
    nullableType: "unknown | null",
    arrayType: "unknown[]",
  },
  {
    edgeqlType: "cal::local_datetime",
    typescriptType: "Date",
    nullableType: "Date | null",
    arrayType: "Date[]",
  },
  {
    edgeqlType: "cal::local_date",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]",
  },
  {
    edgeqlType: "cal::local_time",
    typescriptType: "string",
    nullableType: "string | null",
    arrayType: "string[]",
  },
];

export function getTypeMapping(edgeqlType: string): TypeMapping | null {
  return DEFAULT_TYPE_MAPPINGS.find((mapping) =>
    mapping.edgeqlType === edgeqlType
  ) || null;
}

export function mapEdgeQLTypeToTypeScript(
  edgeqlType: string,
  required: boolean = true,
  multi: boolean = false,
): string {
  const mapping = getTypeMapping(edgeqlType);

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

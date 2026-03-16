/**
 * TypeScript Codegen Types and Interfaces
 */


export interface CodegenConfig {
  output_dir: string;
  schema_source: string;
  target: "client" | "server" | "both";
  type_prefix?: string;
  interface_suffix?: string;
  include_query_builders: boolean;
  include_mutations: boolean;
  include_client: boolean;
  format_output: boolean;
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
  default_value?: string;
}

export interface QueryBuilderDefinition {
  name: string;
  target_type: string;
  methods: QueryMethod[];
  return_type: string;
}

export interface QueryMethod {
  name: string;
  parameters: MethodParameter[];
  return_type: string;
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
  class_name: string;
  methods: ClientMethod[];
  constructor_params: MethodParameter[];
  imports: string[];
}

export interface ClientMethod {
  name: string;
  parameters: MethodParameter[];
  return_type: string;
  is_async: boolean;
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
  edgeql_type: string;
  typescript_type: string;
  nullable_type: string;
  array_type: string;
  import_required?: string;
}

// Built-in type mappings
export const DEFAULT_TYPE_MAPPINGS: TypeMapping[] = [
  {
    edgeql_type: "str",
    typescript_type: "string",
    nullable_type: "string | null",
    array_type: "string[]",
  },
  {
    edgeql_type: "bool",
    typescript_type: "boolean", 
    nullable_type: "boolean | null",
    array_type: "boolean[]",
  },
  {
    edgeql_type: "int16",
    typescript_type: "number",
    nullable_type: "number | null",
    array_type: "number[]",
  },
  {
    edgeql_type: "int32",
    typescript_type: "number",
    nullable_type: "number | null", 
    array_type: "number[]",
  },
  {
    edgeql_type: "int64",
    typescript_type: "number",
    nullable_type: "number | null",
    array_type: "number[]",
  },
  {
    edgeql_type: "float32",
    typescript_type: "number",
    nullable_type: "number | null",
    array_type: "number[]",
  },
  {
    edgeql_type: "float64", 
    typescript_type: "number",
    nullable_type: "number | null",
    array_type: "number[]",
  },
  {
    edgeql_type: "decimal",
    typescript_type: "number",
    nullable_type: "number | null",
    array_type: "number[]",
  },
  {
    edgeql_type: "uuid",
    typescript_type: "string",
    nullable_type: "string | null",
    array_type: "string[]",
  },
  {
    edgeql_type: "datetime",
    typescript_type: "Date",
    nullable_type: "Date | null",
    array_type: "Date[]",
  },
  {
    edgeql_type: "duration",
    typescript_type: "string",
    nullable_type: "string | null", 
    array_type: "string[]",
  },
  {
    edgeql_type: "bytes",
    typescript_type: "Uint8Array",
    nullable_type: "Uint8Array | null",
    array_type: "Uint8Array[]",
    import_required: "// Note: Uint8Array is built-in",
  },
  {
    edgeql_type: "json",
    typescript_type: "unknown",
    nullable_type: "unknown | null",
    array_type: "unknown[]",
  },
  {
    edgeql_type: "cal::local_datetime",
    typescript_type: "Date",
    nullable_type: "Date | null",
    array_type: "Date[]",
  },
  {
    edgeql_type: "cal::local_date",
    typescript_type: "string",
    nullable_type: "string | null",
    array_type: "string[]",
  },
  {
    edgeql_type: "cal::local_time", 
    typescript_type: "string",
    nullable_type: "string | null",
    array_type: "string[]",
  },
];

export function getTypeMapping(edgeqlType: string): TypeMapping | null {
  return DEFAULT_TYPE_MAPPINGS.find(mapping => mapping.edgeql_type === edgeqlType) || null;
}

export function mapEdgeQLTypeToTypeScript(
  edgeqlType: string,
  required: boolean = true,
  multi: boolean = false
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
    return required ? mapping.array_type : `${mapping.array_type} | null`;
  }
  
  return required ? mapping.typescript_type : mapping.nullable_type;
}
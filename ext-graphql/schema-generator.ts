/**
 * Generates GraphQL schema definition from Disc schema types.
 *
 * Maps EdgeQL types to GraphQL types, producing both structured
 * GraphQLType representations and a full GraphQL SDL string.
 */

import type { LinkDef, PropertyDef, Schema } from "../compiler/context.ts";
import type { GraphQLField, GraphQLType } from "./types.ts";

/**
 * EdgeQL scalar type to GraphQL scalar type mapping.
 *
 * GraphQL Int is 32-bit, so int64 and bigint are mapped to String.
 * uuid maps to ID as the natural GraphQL identifier type.
 */
export const SCALAR_TYPE_MAP: Record<string, string> = {
  "bigint": "String",
  "bool": "Boolean",
  "bytes": "String",
  "datetime": "DateTime",
  "decimal": "String",
  "float32": "Float",
  "float64": "Float",
  "int16": "Int",
  "int32": "Int",
  "int64": "String",
  "json": "JSON",
  "str": "String",
  "uuid": "ID",
};

/**
 * Map an EdgeQL type name to a GraphQL type name.
 * Falls back to String for unknown scalar types.
 */
export function mapEdgeQLTypeToGraphQL(
  edgeqlType: string,
  schema: Schema,
): string {
  // Check scalar map first
  const mapped = SCALAR_TYPE_MAP[edgeqlType];
  if (mapped) return mapped;

  // Check if it is an enum type in the schema
  const typeDef = schema.types.get(edgeqlType);
  if (typeDef && typeDef.enumValues && typeDef.enumValues.length > 0) {
    return stripModule(typeDef.name);
  }

  // Check if it is an object type (link target)
  if (typeDef && typeDef.kind === "object") {
    return stripModule(typeDef.name);
  }

  return "String";
}

/**
 * Strip module prefix from type names (e.g. "default::User" -> "User").
 */
function stripModule(name: string): string {
  const idx = name.lastIndexOf("::");
  return idx >= 0 ? name.slice(idx + 2) : name;
}

/**
 * Convert a PropertyDef to a GraphQLField.
 */
function propertyToField(
  prop: PropertyDef,
  schema: Schema,
): GraphQLField {
  const graphqlType = mapEdgeQLTypeToGraphQL(
    prop.edgeqlType ?? prop.type,
    schema,
  );
  return {
    description: prop.annotations?.description,
    isList: prop.multi,
    name: prop.name,
    required: prop.required,
    type: graphqlType,
  };
}

/**
 * Convert a LinkDef to a GraphQLField.
 */
function linkToField(link: LinkDef): GraphQLField {
  const targetName = stripModule(link.target);
  return {
    description: link.annotations?.description,
    isList: link.multi,
    name: link.name,
    required: link.required,
    type: targetName,
  };
}

/**
 * Generate structured GraphQLType representations from the Disc schema.
 * Only includes non-abstract object types and enum types.
 */
export function generateGraphQLTypes(schema: Schema): GraphQLType[] {
  const types: GraphQLType[] = [];

  for (const [, typeDef] of schema.types) {
    if (typeDef.abstract) continue;

    if (typeDef.kind === "object") {
      const fields: GraphQLField[] = [];

      for (const [, prop] of typeDef.properties) {
        // Skip computed properties — they are not directly settable
        if (prop.computed) continue;
        fields.push(propertyToField(prop, schema));
      }

      for (const [, link] of typeDef.links) {
        fields.push(linkToField(link));
      }

      types.push({
        description: typeDef.annotations?.description,
        fields,
        name: stripModule(typeDef.name),
      });
    }
  }

  return types;
}

/**
 * Format a GraphQL field type string with required/list modifiers.
 */
function formatFieldType(field: GraphQLField): string {
  let typeStr = field.type;
  if (field.required) typeStr += "!";
  if (field.isList) typeStr = `[${typeStr}]`;
  return typeStr;
}

/**
 * Generate a complete GraphQL SDL string from the Disc schema.
 *
 * Includes:
 * - Custom scalar declarations (DateTime, JSON)
 * - Object types from non-abstract TypeDefs
 * - Enum types
 * - Query type with fetch-by-id and list queries
 * - Mutation type (if enableMutations is true) with create/update/delete
 * - Input types for mutations
 */
export function generateGraphQLSchema(
  schema: Schema,
  options?: { enableMutations?: boolean; },
): string {
  const enableMutations = options?.enableMutations ?? false;
  const lines: string[] = [];

  // Custom scalars
  lines.push("scalar DateTime");
  lines.push("scalar JSON");
  lines.push("");

  // Enum types
  for (const [, typeDef] of schema.types) {
    if (typeDef.enumValues && typeDef.enumValues.length > 0) {
      const name = stripModule(typeDef.name);
      lines.push(`enum ${name} {`);
      for (const val of typeDef.enumValues) {
        lines.push(`  ${val}`);
      }
      lines.push("}");
      lines.push("");
    }
  }

  // Object types
  const objectTypes = generateGraphQLTypes(schema);
  for (const gqlType of objectTypes) {
    if (gqlType.description) {
      lines.push(`"""${gqlType.description}"""`);
    }
    lines.push(`type ${gqlType.name} {`);
    for (const field of gqlType.fields) {
      const typeStr = formatFieldType(field);
      lines.push(`  ${field.name}: ${typeStr}`);
    }
    lines.push("}");
    lines.push("");
  }

  // Query type
  lines.push("type Query {");
  for (const gqlType of objectTypes) {
    const lcName = gqlType.name.charAt(0).toLowerCase() + gqlType.name.slice(1);
    lines.push(`  ${lcName}(id: ID!): ${gqlType.name}`);
    lines.push(
      `  all${gqlType.name}s(first: Int, offset: Int, filter: String): [${gqlType.name}]`,
    );
  }
  lines.push("}");

  // Mutation type
  if (enableMutations) {
    lines.push("");

    // Input types for create/update
    for (const gqlType of objectTypes) {
      // Create input — skip id (auto-generated)
      lines.push(`input Create${gqlType.name}Input {`);
      for (const field of gqlType.fields) {
        if (field.name === "id") continue;
        const typeStr = field.type + (field.required ? "!" : "");
        lines.push(`  ${field.name}: ${typeStr}`);
      }
      lines.push("}");
      lines.push("");

      // Update input — all fields optional
      lines.push(`input Update${gqlType.name}Input {`);
      for (const field of gqlType.fields) {
        if (field.name === "id") continue;
        lines.push(`  ${field.name}: ${field.type}`);
      }
      lines.push("}");
      lines.push("");
    }

    lines.push("type Mutation {");
    for (const gqlType of objectTypes) {
      lines.push(
        `  create${gqlType.name}(input: Create${gqlType.name}Input!): ${gqlType.name}`,
      );
      lines.push(
        `  update${gqlType.name}(id: ID!, input: Update${gqlType.name}Input!): ${gqlType.name}`,
      );
      lines.push(
        `  delete${gqlType.name}(id: ID!): Boolean`,
      );
    }
    lines.push("}");
  }

  return lines.join("\n");
}

/**
 * Get the list of non-abstract object types from the schema.
 * Used to determine which types should have GraphQL query/mutation roots.
 */
export function getObjectTypeNames(schema: Schema): string[] {
  const names: string[] = [];
  for (const [, typeDef] of schema.types) {
    if (typeDef.kind === "object" && !typeDef.abstract) {
      names.push(stripModule(typeDef.name));
    }
  }
  return names;
}

/**
 * OpenAPI 3.1 spec generator for the schema-derived REST surface
 * (Bundle J — Disc-original feature #2).
 *
 * Walks the schema's object types and emits one path-and-operation
 * stanza per route the router serves. Component schemas reference each
 * SDL type so downstream codegens (TypeScript, Go, OpenAPI generators)
 * pick up properties + links automatically.
 *
 * Filled in by `server/rest/openapi.ts`'s caller — Phase 5 ships the
 * full body. This module is referenced from Phase 2 onwards so the
 * `/api/openapi.json` route can mount even before its body is rich.
 */

import type { LinkDef, PropertyDef, Schema, TypeDef } from "../../compiler/context.ts";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
  };
  paths: Record<string, PathItem>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes?: Record<string, SecurityScheme>;
  };
  security?: Array<Record<string, string[]>>;
}

export interface OpenApiOptions {
  /** When true, emit a global `bearerAuth` security requirement. */
  requireAuth: boolean;
  /** Override the spec's `info.version` field. Defaults to `0.1.0`. */
  version?: string;
}

interface PathItem {
  get?: Operation;
  post?: Operation;
  patch?: Operation;
  delete?: Operation;
  parameters?: Parameter[];
}

interface Operation {
  summary: string;
  operationId: string;
  parameters?: Parameter[];
  requestBody?: RequestBody;
  responses: Record<string, ResponseObj>;
}

interface Parameter {
  name: string;
  in: "query" | "path";
  required?: boolean;
  description?: string;
  schema: JsonSchema;
}

interface RequestBody {
  required: boolean;
  content: {
    "application/json": { schema: JsonSchema; };
  };
}

interface ResponseObj {
  description: string;
  content?: {
    "application/json": { schema: JsonSchema; };
  };
}

interface JsonSchema {
  type?: string;
  format?: string;
  $ref?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  enum?: string[];
  oneOf?: JsonSchema[];
  nullable?: boolean;
}

interface SecurityScheme {
  type: "http";
  scheme: "bearer";
  bearerFormat?: string;
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export function renderOpenApiSpec(
  schema: Schema,
  options: OpenApiOptions,
): OpenApiSpec {
  const paths: Record<string, PathItem> = {};
  const componentSchemas: Record<string, JsonSchema> = {};

  for (const typeDef of schema.types.values()) {
    if (typeDef.kind !== "object") continue;
    if (typeDef.abstract) continue;
    addTypePaths(paths, typeDef, schema);
    componentSchemas[typeDef.name] = buildTypeSchema(typeDef, schema);
  }

  const spec: OpenApiSpec = {
    openapi: "3.1.0",
    info: {
      title: "Disc Schema-Derived REST API",
      description: "Auto-generated from the database schema. Every object type "
        + "exposes list/get/insert/update/delete and per-link collection "
        + "endpoints. All routes pass through the standard EdgeQL "
        + "pipeline, so access policies, read-only mode, and the auth "
        + "gate apply.",
      version: options.version ?? "0.1.0",
    },
    paths,
    components: {
      schemas: componentSchemas,
    },
  };

  if (options.requireAuth) {
    spec.components.securitySchemes = {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    };
    spec.security = [{ bearerAuth: [] }];
  }

  return spec;
}

function addTypePaths(
  paths: Record<string, PathItem>,
  typeDef: TypeDef,
  schema: Schema,
): void {
  const typeName = typeDef.name;
  const ref: JsonSchema = { $ref: `#/components/schemas/${typeName}` };
  const arrayOfRef: JsonSchema = { type: "array", items: ref };

  // Collection: GET list + POST insert
  paths[`/api/${typeName}`] = {
    get: {
      summary: `List ${typeName} objects`,
      operationId: `list${typeName}`,
      parameters: [
        ...filterParametersFor(typeDef),
        {
          name: "limit",
          in: "query",
          description: "Maximum number of rows to return.",
          schema: { type: "integer", format: "int32" },
        },
        {
          name: "offset",
          in: "query",
          description: "Skip this many rows before returning results.",
          schema: { type: "integer", format: "int32" },
        },
        {
          name: "order_by",
          in: "query",
          description: "Property to order by. Prefix with `-` for descending.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: `An array of ${typeName} objects.`,
          content: { "application/json": { schema: arrayOfRef } },
        },
        "400": { description: "Bad request — unknown filter or pagination." },
      },
    },
    post: {
      summary: `Insert a ${typeName}`,
      operationId: `insert${typeName}`,
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: buildInputSchema(typeDef, schema) },
        },
      },
      responses: {
        "201": {
          description: `The inserted ${typeName}.`,
          content: { "application/json": { schema: ref } },
        },
        "400": { description: "Validation or compile error." },
      },
    },
  };

  // Item: GET / PATCH / DELETE
  paths[`/api/${typeName}/{id}`] = {
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string", format: "uuid" },
      },
    ],
    get: {
      summary: `Fetch a single ${typeName} by id`,
      operationId: `get${typeName}`,
      responses: {
        "200": {
          description: `The ${typeName} object.`,
          content: { "application/json": { schema: ref } },
        },
        "404": { description: `${typeName} not found.` },
      },
    },
    patch: {
      summary: `Update a ${typeName}`,
      operationId: `update${typeName}`,
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: buildInputSchema(typeDef, schema) },
        },
      },
      responses: {
        "200": {
          description: `The updated ${typeName}.`,
          content: { "application/json": { schema: ref } },
        },
        "404": { description: `${typeName} not found.` },
        "400": { description: "Unknown field or compile error." },
      },
    },
    delete: {
      summary: `Delete a ${typeName}`,
      operationId: `delete${typeName}`,
      responses: {
        "204": { description: "Deleted." },
      },
    },
  };

  // Linked-collection: GET /api/<Type>/{id}/<linkName>
  for (const [linkName, link] of typeDef.links) {
    if (link.computed) continue;
    const targetType = schema.types.get(link.target)
      ?? schema.types.get(`default::${link.target}`);
    if (!targetType) continue;
    const targetRef: JsonSchema = {
      $ref: `#/components/schemas/${targetType.name}`,
    };
    paths[`/api/${typeName}/{id}/${linkName}`] = {
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
      ],
      get: {
        summary: `Fetch the ${linkName} linked from ${typeName}`,
        operationId: `list${typeName}_${linkName}`,
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", format: "int32" },
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", format: "int32" },
          },
        ],
        responses: {
          "200": {
            description: `Array of linked ${targetType.name} objects.`,
            content: {
              "application/json": {
                schema: link.multi ? { type: "array", items: targetRef } : targetRef,
              },
            },
          },
          "404": { description: `${typeName} not found.` },
        },
      },
    };
  }
}

function filterParametersFor(typeDef: TypeDef): Parameter[] {
  const params: Parameter[] = [];
  for (const [name, prop] of typeDef.properties) {
    if (isHidden(prop.annotations)) continue;
    if (prop.computed) continue;
    params.push({
      name,
      in: "query",
      description: `Filter rows where ${name} = the given value. `
        + `Pair as \`${name}__in=a,b,c\` for set membership or `
        + `\`${name}__contains=x\` for substring.`,
      schema: jsonSchemaForProperty(prop),
    });
  }
  return params;
}

function buildTypeSchema(typeDef: TypeDef, schema: Schema): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, prop] of typeDef.properties) {
    if (isHidden(prop.annotations)) continue;
    if (prop.computed) continue;
    properties[name] = jsonSchemaForProperty(prop);
    if (prop.required) required.push(name);
  }
  for (const [name, link] of typeDef.links) {
    if (!isExpand(link.annotations)) continue;
    const targetType = schema.types.get(link.target)
      ?? schema.types.get(`default::${link.target}`);
    if (!targetType) continue;
    const targetRef: JsonSchema = {
      $ref: `#/components/schemas/${targetType.name}`,
    };
    properties[name] = link.multi ? { type: "array", items: targetRef } : targetRef;
  }
  const out: JsonSchema = {
    type: "object",
    properties,
  };
  if (required.length > 0) out.required = required;
  return out;
}

function buildInputSchema(typeDef: TypeDef, _schema: Schema): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [name, prop] of typeDef.properties) {
    if (name === "id") continue;
    if (prop.computed) continue;
    if (prop.readonly) continue;
    properties[name] = jsonSchemaForProperty(prop);
    if (prop.required && !prop.hasDefault) required.push(name);
  }
  for (const [name, link] of typeDef.links) {
    if (link.computed) continue;
    properties[name] = { type: "string", format: "uuid" };
    if (link.required) required.push(name);
  }
  const out: JsonSchema = {
    type: "object",
    properties,
  };
  if (required.length > 0) out.required = required;
  return out;
}

function jsonSchemaForProperty(prop: PropertyDef): JsonSchema {
  switch (prop.edgeqlType ?? prop.type) {
    case "uuid":
      return { type: "string", format: "uuid" };
    case "str":
      return { type: "string" };
    case "bool":
      return { type: "boolean" };
    case "int16":
    case "int32":
      return { type: "integer", format: "int32" };
    case "int64":
      return { type: "integer", format: "int64" };
    case "float32":
      return { type: "number", format: "float" };
    case "float64":
    case "decimal":
      return { type: "number", format: "double" };
    case "datetime":
      return { type: "string", format: "date-time" };
    case "cal::local_date":
      return { type: "string", format: "date" };
    case "cal::local_time":
      return { type: "string", format: "time" };
    case "duration":
      return { type: "string", description: "ISO-8601 duration" };
    case "json":
      return {};
    default:
      return { type: "string" };
  }
}

function isHidden(annotations: Record<string, string> | undefined): boolean {
  if (!annotations) return false;
  return "rest::hidden" in annotations;
}

function isExpand(annotations: Record<string, string> | undefined): boolean {
  if (!annotations) return false;
  return "rest::expand" in annotations;
}

// Re-export for tests; LinkDef export keeps the type-only import in scope
// for tooling.
export type _LinkDef = LinkDef;

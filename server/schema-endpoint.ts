/**
 * Schema introspection REST endpoint handlers
 *
 * Provides /schema routes for browsing the current database schema via HTTP:
 *   GET /schema          — full schema description (types, functions, modules)
 *   GET /schema/types    — all type descriptions
 *   GET /schema/types/:name — single type description
 */

import type { Schema } from "../compiler/context.ts";
import { describeSchema, describeType } from "../compiler/introspection.ts";
import { CompilationError } from "../lib/errors.ts";

/** A function that returns the current Schema. */
export type SchemaProvider = () => Schema;

export interface SchemaRouteContext {
  schemaProvider: SchemaProvider;
  defaultHeaders: () => Headers;
}

/**
 * Handle GET /schema — returns the full schema description.
 */
export function handleGetSchema(ctx: SchemaRouteContext): Response {
  const schema = ctx.schemaProvider();
  const description = describeSchema(schema);

  return new Response(JSON.stringify(description, null, 2), {
    status: 200,
    headers: ctx.defaultHeaders()
  });
}

/**
 * Handle GET /schema/types — returns all type descriptions.
 *
 * Optional query parameter `module` filters by module name.
 */
export function handleGetSchemaTypes(
  ctx: SchemaRouteContext,
  url: URL
): Response {
  const schema = ctx.schemaProvider();
  const description = describeSchema(schema);

  const moduleFilter = url.searchParams.get("module");
  let types = description.types;
  if (moduleFilter) {
    types = types.filter(t => t.module === moduleFilter);
  }

  return new Response(JSON.stringify(types, null, 2), {
    status: 200,
    headers: ctx.defaultHeaders()
  });
}

/**
 * Handle GET /schema/types/:name — returns a single type description.
 *
 * Returns 404 if the type is not found.
 */
export function handleGetSchemaType(
  ctx: SchemaRouteContext,
  typeName: string
): Response {
  const schema = ctx.schemaProvider();

  try {
    const description = describeType(schema, typeName);
    return new Response(JSON.stringify(description, null, 2), {
      status: 200,
      headers: ctx.defaultHeaders()
    });
  } catch (error) {
    if (error instanceof CompilationError) {
      return new Response(
        JSON.stringify({ error: error.message }),
        {
          status: 404,
          headers: ctx.defaultHeaders()
        }
      );
    }
    throw error;
  }
}

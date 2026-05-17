/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Schema-derived REST router (Bundle J — Disc-original feature #2).
 *
 * Every object type in the schema gets a conventional REST surface:
 *
 *   GET    /api/<Type>            list with filter/order/limit
 *   GET    /api/<Type>/<id>       single object
 *   POST   /api/<Type>            insert
 *   PATCH  /api/<Type>/<id>       update
 *   DELETE /api/<Type>/<id>       delete
 *   GET    /api/<Type>/<id>/<link>  linked collection
 *
 * Routes do NOT bypass the EdgeQL pipeline — they synthesize an EdgeQL
 * string and send it through `protocolHandler.handleRequest`, so access
 * policies, read-only mode, and auth all compose without extra work.
 *
 * Visibility / shape is gated by SDL annotations:
 *   - `rest::hidden` excludes a property/link from the default GET shape.
 *   - `rest::expand` inlines a linked collection rather than emitting a
 *     hyperlink reference.
 */

import type {
  LinkDef,
  PropertyDef,
  Schema,
  TypeDef
} from "../../compiler/context.ts";
import type * as Types from "../types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DispatchRestOptions {
  request: Request;
  schema: Schema;
  protocolHandler: Types.ProtocolHandler;
  context: Types.QueryContext;
  /** Mounted path prefix. Defaults to `/api`. */
  prefix?: string;
}

/**
 * Dispatch a REST request. Returns:
 *   - `null` when the request is not under the `/api` prefix; the caller
 *     should continue with its other dispatch logic.
 *   - A `Response` when the request was handled (success or error).
 */
export async function dispatchRest(
  options: DispatchRestOptions
): Promise<Response | null> {
  const prefix = options.prefix ?? "/api";
  const url = new URL(options.request.url);
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) {
    return null;
  }

  const tail = url.pathname.slice(prefix.length).replace(/^\/+|\/+$/g, "");
  // OpenAPI spec is mounted under `/api/openapi.json` but produced by a
  // sibling module — the HTTP server matches it before calling us.
  if (tail === "" || tail === "openapi.json") {
    return null;
  }

  const segments = tail.split("/").filter(Boolean);
  const typeName = segments[0];
  const typeDef = resolveType(options.schema, typeName);
  if (!typeDef) {
    return errorJson(
      `Type '${typeName}' is not defined in the schema`,
      404
    );
  }

  const method = options.request.method.toUpperCase();

  // /api/<Type>
  if (segments.length === 1) {
    if (method === "GET") {
      return await handleList(options, typeDef, url);
    }
    if (method === "POST") {
      return await handleInsert(options, typeDef);
    }
    return errorJson("Method not allowed", 405);
  }

  // /api/<Type>/<id>
  if (segments.length === 2) {
    const id = decodeURIComponent(segments[1]);
    if (!isValidUuid(id)) {
      return errorJson(
        `Invalid id '${id}' — expected UUID`,
        400
      );
    }
    if (method === "GET") {
      return await handleGet(options, typeDef, id);
    }
    if (method === "PATCH") {
      return await handleUpdate(options, typeDef, id);
    }
    if (method === "DELETE") {
      return await handleDelete(options, typeDef, id);
    }
    return errorJson("Method not allowed", 405);
  }

  // /api/<Type>/<id>/<link>
  if (segments.length === 3) {
    const id = decodeURIComponent(segments[1]);
    const linkName = decodeURIComponent(segments[2]);
    if (!isValidUuid(id)) {
      return errorJson(`Invalid id '${id}' — expected UUID`, 400);
    }
    if (method !== "GET") {
      return errorJson("Method not allowed", 405);
    }
    return await handleLinkedCollection(options, typeDef, id, linkName, url);
  }

  return errorJson("Not found", 404);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleList(
  opts: DispatchRestOptions,
  typeDef: TypeDef,
  url: URL
): Promise<Response> {
  let filter: string | undefined;
  let order: string | undefined;
  let limit: number | undefined;
  let offset: number | undefined;
  try {
    const built = buildFilter(typeDef, url.searchParams);
    filter = built.filter;
    order = built.order;
    limit = built.limit;
    offset = built.offset;
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : String(err), 400);
  }

  const shape = renderShape(opts.schema, typeDef);
  let edgeql = `select ${typeDef.name} ${shape}`;
  if (filter) {
    edgeql += ` filter ${filter}`;
  }
  if (order) {
    edgeql += ` order by ${order}`;
  }
  if (offset !== undefined) {
    edgeql += ` offset ${offset}`;
  }
  if (limit !== undefined) {
    edgeql += ` limit ${limit}`;
  }

  const result = await runEdgeQL(opts, edgeql);
  if (result instanceof Response) {
    return result;
  }
  return jsonResponse(coerceArray(result), 200);
}

async function handleGet(
  opts: DispatchRestOptions,
  typeDef: TypeDef,
  id: string
): Promise<Response> {
  const shape = renderShape(opts.schema, typeDef);
  const edgeql = `select ${typeDef.name} ${shape} filter .id = <uuid>${edgeqlString(id)}`;

  const result = await runEdgeQL(opts, edgeql);
  if (result instanceof Response) {
    return result;
  }
  const rows = coerceArray(result);
  if (rows.length === 0) {
    return errorJson(`${typeDef.name} '${id}' not found`, 404);
  }
  return jsonResponse(rows[0], 200);
}

async function handleInsert(
  opts: DispatchRestOptions,
  typeDef: TypeDef
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(opts.request);
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : String(err), 400);
  }

  let assignments: string;
  try {
    assignments = renderAssignments(typeDef, body, { allowEmpty: false });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : String(err), 400);
  }

  // The compiler returns the inserted row's columns via `RETURNING *`,
  // which the protocol handler maps back to the camelCase property
  // shape. The result is one record; we forward it as the 201 body so
  // clients have the server-assigned id.
  const edgeql = `insert ${typeDef.name} { ${assignments} }`;

  const result = await runEdgeQL(opts, edgeql);
  if (result instanceof Response) {
    return result;
  }
  const rows = coerceArray(result);
  return jsonResponse(rows[0] ?? null, 201);
}

async function handleUpdate(
  opts: DispatchRestOptions,
  typeDef: TypeDef,
  id: string
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(opts.request);
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : String(err), 400);
  }

  let assignments: string;
  try {
    assignments = renderAssignments(typeDef, body, { allowEmpty: true });
  } catch (err) {
    return errorJson(err instanceof Error ? err.message : String(err), 400);
  }
  if (assignments === "") {
    return errorJson("PATCH body must contain at least one field", 400);
  }

  const edgeql = `update ${typeDef.name} filter .id = <uuid>${edgeqlString(id)} ` +
    `set { ${assignments} }`;

  const result = await runEdgeQL(opts, edgeql);
  if (result instanceof Response) {
    return result;
  }
  const rows = coerceArray(result);
  if (rows.length === 0) {
    return errorJson(`${typeDef.name} '${id}' not found`, 404);
  }
  return jsonResponse(rows[0], 200);
}

async function handleDelete(
  opts: DispatchRestOptions,
  typeDef: TypeDef,
  id: string
): Promise<Response> {
  const edgeql = `delete ${typeDef.name} filter .id = <uuid>${edgeqlString(id)}`;
  const result = await runEdgeQL(opts, edgeql);
  if (result instanceof Response) {
    return result;
  }
  // Return 204 even if the row didn't exist — DELETE is idempotent and
  // callers only need the success signal. Strict 404-on-missing is a
  // future opt-in if it turns out apps want it.
  return new Response(null, { status: 204 });
}

async function handleLinkedCollection(
  opts: DispatchRestOptions,
  parentType: TypeDef,
  parentId: string,
  linkName: string,
  url: URL
): Promise<Response> {
  const link = parentType.links.get(linkName);
  if (!link) {
    return errorJson(
      `${parentType.name} has no link named '${linkName}'`,
      404
    );
  }
  const targetType = resolveType(opts.schema, link.target);
  if (!targetType) {
    return errorJson(
      `Linked target type '${link.target}' is not defined in the schema`,
      500
    );
  }

  // Pagination params apply to the linked collection (limit/offset only;
  // filter/order_by would conflict with EdgeQL's link-shape grammar in
  // ways that don't pay back the complexity in this bundle).
  let limit: number | undefined;
  let offset: number | undefined;
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  if (limitParam !== null) {
    const n = Number(limitParam);
    if (!Number.isInteger(n) || n < 0) {
      return errorJson("'limit' must be a non-negative integer", 400);
    }
    limit = n;
  }
  if (offsetParam !== null) {
    const n = Number(offsetParam);
    if (!Number.isInteger(n) || n < 0) {
      return errorJson("'offset' must be a non-negative integer", 400);
    }
    offset = n;
  }

  const linkShape = renderShape(opts.schema, targetType);
  let linkClause = `${linkName}: ${linkShape}`;
  if (offset !== undefined) {
    linkClause += ` offset ${offset}`;
  }
  if (limit !== undefined) {
    linkClause += ` limit ${limit}`;
  }

  const edgeql = `select ${parentType.name} { ${linkClause} } ` +
    `filter .id = <uuid>${edgeqlString(parentId)}`;

  const result = await runEdgeQL(opts, edgeql);
  if (result instanceof Response) {
    return result;
  }
  const rows = coerceArray(result);
  if (rows.length === 0) {
    return errorJson(`${parentType.name} '${parentId}' not found`, 404);
  }
  const parent = rows[0] as Record<string, unknown>;
  const collection = parent[linkName];
  return jsonResponse(coerceArray(collection), 200);
}

// ---------------------------------------------------------------------------
// EdgeQL composition helpers
// ---------------------------------------------------------------------------

/**
 * Render the default shape for a type as `{ a, b, c, link: { ... } }`.
 *
 * Properties annotated `rest::hidden` are excluded. Links that don't carry
 * `rest::expand` are also excluded from the default shape — callers fetch
 * them via the linked-collection endpoint, which keeps payloads bounded.
 */
function renderShape(schema: Schema, typeDef: TypeDef): string {
  const fields: string[] = [];
  for (const [name, prop] of typeDef.properties) {
    if (prop.computed) {
      continue;
    }
    if (isHidden(prop.annotations)) {
      continue;
    }
    fields.push(name);
  }
  for (const [name, link] of typeDef.links) {
    if (!isExpand(link.annotations)) {
      continue;
    }
    const targetType = resolveType(schema, link.target);
    if (!targetType) {
      continue;
    }
    const sub = renderShape(schema, targetType);
    fields.push(`${name}: ${sub}`);
  }
  return `{ ${fields.join(", ")} }`;
}

interface FilterParts {
  filter?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/**
 * Translate URL query params into an EdgeQL filter / order / pagination
 * suffix. Supported operators (Bundle J scope):
 *   ?prop=value           equality
 *   ?prop__in=a,b,c       set membership
 *   ?prop__contains=foo   ILIKE %foo% (string-only)
 *
 * `limit`, `offset`, `order_by` are special-cased pagination knobs.
 * Unknown property names → 400 (don't silently ignore).
 */
function buildFilter(
  typeDef: TypeDef,
  params: URLSearchParams
): FilterParts {
  const filterClauses: string[] = [];
  let order: string | undefined;
  let limit: number | undefined;
  let offset: number | undefined;

  for (const [rawKey, rawValue] of params) {
    if (rawKey === "limit") {
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error("'limit' must be a non-negative integer");
      }
      limit = n;
      continue;
    }
    if (rawKey === "offset") {
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error("'offset' must be a non-negative integer");
      }
      offset = n;
      continue;
    }
    if (rawKey === "order_by") {
      const desc = rawValue.startsWith("-");
      const propName = desc ? rawValue.slice(1) : rawValue;
      if (!typeDef.properties.has(propName)) {
        throw new Error(
          `Cannot order by unknown property '${propName}' on type ${typeDef.name}`
        );
      }
      order = `.${propName}${desc ? " desc" : ""}`;
      continue;
    }

    // Filter clause: `<prop>` or `<prop>__<op>`
    const sepIndex = rawKey.indexOf("__");
    let propName = rawKey;
    let op = "eq";
    if (sepIndex !== -1) {
      propName = rawKey.slice(0, sepIndex);
      op = rawKey.slice(sepIndex + 2);
    }
    if (!typeDef.properties.has(propName)) {
      throw new Error(
        `Unknown filter field '${propName}' on type ${typeDef.name}`
      );
    }

    if (op === "eq") {
      filterClauses.push(`.${propName} = ${edgeqlString(rawValue)}`);
    } else if (op === "in") {
      const values = rawValue.split(",").map(v => edgeqlString(v));
      filterClauses.push(`.${propName} in {${values.join(", ")}}`);
    } else if (op === "contains") {
      filterClauses.push(`contains(.${propName}, ${edgeqlString(rawValue)})`);
    } else {
      throw new Error(
        `Unsupported filter operator '__${op}' (allowed: eq, in, contains)`
      );
    }
  }

  return {
    filter: filterClauses.length > 0 ? filterClauses.join(" and ") : undefined,
    order,
    limit,
    offset
  };
}

interface AssignmentOptions {
  allowEmpty: boolean;
}

/**
 * Translate a JSON body into EdgeQL `set { … }` / `insert { … }` body.
 * Unknown fields → 400. Passing through accepted fields means the SQL
 * compiler still does its own type-cast and constraint checks downstream.
 */
function renderAssignments(
  typeDef: TypeDef,
  body: Record<string, unknown>,
  opts: AssignmentOptions
): string {
  const known = new Set<string>();
  for (const name of typeDef.properties.keys()) {
    known.add(name);
  }
  for (const name of typeDef.links.keys()) {
    known.add(name);
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!known.has(key)) {
      throw new Error(
        `Unknown field '${key}' for type ${typeDef.name}`
      );
    }
    if (key === "id") {
      throw new Error(
        "'id' cannot be set via REST body — it's assigned by the server"
      );
    }
    parts.push(`${key} := ${renderAssignmentValue(typeDef, key, value)}`);
  }
  if (parts.length === 0 && !opts.allowEmpty) {
    throw new Error(
      `Request body for type ${typeDef.name} must contain at least one field`
    );
  }
  return parts.join(", ");
}

/**
 * Render a single field's RHS as an EdgeQL literal. Properties become
 * scalar literals; links become `<TargetType><uuid>'<id>'` casts. The
 * compiler's downstream type-checking handles real coercion — we just
 * produce something parseable.
 */
function renderAssignmentValue(
  typeDef: TypeDef,
  key: string,
  value: unknown
): string {
  const link = typeDef.links.get(key);
  if (link) {
    if (typeof value !== "string") {
      throw new Error(
        `Link '${key}' must be a UUID string in REST bodies`
      );
    }
    if (!isValidUuid(value)) {
      throw new Error(
        `Link '${key}' must be a UUID, got '${value}'`
      );
    }
    return `(select ${link.target} filter .id = <uuid>${edgeqlString(value)})`;
  }

  const prop = typeDef.properties.get(key);
  if (!prop) {
    // Should be unreachable — caller already checked.
    throw new Error(`Unknown field '${key}'`);
  }
  return renderScalarLiteral(prop, value);
}

function renderScalarLiteral(prop: PropertyDef, value: unknown): string {
  if (value === null) {
    return "{}";
  }
  switch (prop.edgeqlType ?? prop.type) {
    case "bool":
      if (typeof value !== "boolean") {
        throw new Error(`'${prop.name}' must be a boolean`);
      }
      return value ? "true" : "false";
    case "int16":
    case "int32":
    case "int64":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`'${prop.name}' must be an integer`);
      }
      return String(value);
    case "float32":
    case "float64":
    case "decimal":
      if (typeof value !== "number") {
        throw new Error(`'${prop.name}' must be a number`);
      }
      return String(value);
    case "uuid":
      if (typeof value !== "string" || !isValidUuid(value)) {
        throw new Error(`'${prop.name}' must be a UUID string`);
      }
      return `<uuid>${edgeqlString(value)}`;
    case "datetime":
    case "duration":
    case "cal::local_date":
    case "cal::local_datetime":
    case "cal::local_time":
      if (typeof value !== "string") {
        throw new Error(`'${prop.name}' must be an ISO string`);
      }
      return `<${prop.edgeqlType ?? prop.type}>${edgeqlString(value)}`;
    case "json":
      return `<json>${edgeqlString(JSON.stringify(value))}`;
    default:
      // Fall-through covers `str`, enum scalars, custom scalars: the
      // compiler validates these against the actual schema later.
      if (typeof value !== "string") {
        throw new Error(`'${prop.name}' must be a string`);
      }
      return edgeqlString(value);
  }
}

// ---------------------------------------------------------------------------
// Pipeline glue
// ---------------------------------------------------------------------------

async function runEdgeQL(
  opts: DispatchRestOptions,
  query: string
): Promise<unknown | Response> {
  const response = await opts.protocolHandler.handleRequest(
    { query },
    opts.context
  );

  // The protocol handler may return errors (parse, compile, access policy
  // denial, read-only mode rejection, etc.). Map them to HTTP statuses.
  const realErrors = (response.errors ?? []).filter(
    e => e.extensions?.code !== "WARNING"
  );
  if (realErrors.length > 0) {
    const code = String(realErrors[0].extensions?.code ?? "");
    const status = mapErrorCodeToStatus(code);
    return new Response(
      JSON.stringify({
        error: realErrors[0].message,
        code: code || undefined
      }),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }

  return response.data;
}

function mapErrorCodeToStatus(code: string): number {
  switch (code) {
    case "READ_ONLY_MODE":
      return 503;
    case "ACCESS_DENIED":
    case "POLICY_DENIED":
      return 403;
    case "PARSE_ERROR":
    case "VALIDATION_ERROR":
    case "QUERY_TOO_LARGE":
      return 400;
    case "TIMEOUT":
      return 408;
    default:
      return 400;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveType(schema: Schema, name: string): TypeDef | undefined {
  return schema.types.get(name) ??
    schema.types.get(`default::${name}`);
}

function isHidden(annotations: Record<string, string> | undefined): boolean {
  if (!annotations) {
    return false;
  }
  return "rest::hidden" in annotations;
}

function isExpand(annotations: Record<string, string> | undefined): boolean {
  if (!annotations) {
    return false;
  }
  return "rest::expand" in annotations;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Quote a string as an EdgeQL string literal. Doubles single-quotes (the
 * SQL-standard form) and escapes backslashes for parser robustness.
 */
function edgeqlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''");
  return `'${escaped}'`;
}

async function readJsonBody(
  request: Request
): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function coerceArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === null || value === undefined) {
    return [];
  }
  return [value];
}

function jsonResponse(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function errorJson(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

// Re-export private helpers used by the OpenAPI emitter so we keep one
// source of truth for shape rules. Not part of the user-facing API.
export const _internals = {
  isExpand,
  isHidden,
  renderShape,
  resolveType
};

// LinkDef export keeps the import side of the import-only-types statement
// in scope for tooling that doesn't agree it's used.
export type _LinkDef = LinkDef;

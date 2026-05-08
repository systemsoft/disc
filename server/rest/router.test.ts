/**
 * Unit tests for the schema-derived REST router (Bundle J phase 2).
 *
 * Black-box: feed in a Request + minimal Schema, capture the EdgeQL
 * string the router asked the protocol handler to run, and assert on
 * the shape of the response. Real EdgeQL/SQL execution is exercised
 * separately in `rest-pg.test.ts` against a live PG instance.
 */

import { assert, assertEquals } from "@std/assert";
import type { Schema, TypeDef } from "../../compiler/context.ts";
import type * as Types from "../types.ts";
import { dispatchRest } from "./router.ts";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function buildSchema(): Schema {
  const userType: TypeDef = {
    name: "User",
    kind: "object",
    tableName: "users",
    module: "default",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }],
      ["email", {
        name: "email",
        type: "str",
        required: true,
        multi: false,
        columnName: "email",
        edgeqlType: "str",
        annotations: { "rest::hidden": "true" }
      }],
      ["name", {
        name: "name",
        type: "str",
        required: true,
        multi: false,
        columnName: "name",
        edgeqlType: "str"
      }]
    ]),
    links: new Map([
      ["posts", {
        name: "posts",
        target: "Post",
        required: false,
        multi: true
      }]
    ])
  };

  const postType: TypeDef = {
    name: "Post",
    kind: "object",
    tableName: "posts",
    module: "default",
    properties: new Map([
      ["id", {
        name: "id",
        type: "uuid",
        required: true,
        multi: false,
        columnName: "id",
        edgeqlType: "uuid"
      }],
      ["title", {
        name: "title",
        type: "str",
        required: true,
        multi: false,
        columnName: "title",
        edgeqlType: "str"
      }]
    ]),
    links: new Map()
  };

  return {
    types: new Map([
      ["default::User", userType],
      ["default::Post", postType]
    ]),
    functions: new Map()
  };
}

interface CapturedQuery {
  query: string;
  variables?: Record<string, unknown>;
}

function makeStubHandler(
  responder: (q: string) => unknown = () => []
): {
  handler: Types.ProtocolHandler;
  captured: CapturedQuery[];
} {
  const captured: CapturedQuery[] = [];
  const handler: Types.ProtocolHandler = {
    handleRequest: request => {
      captured.push({
        query: request.query,
        variables: request.variables
      });
      return Promise.resolve({ data: responder(request.query) });
    },
    validateRequest: () => []
  };
  return { handler, captured };
}

function makeContext(): Types.QueryContext {
  return {
    session: {
      sessionId: "test",
      database: "disc",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: "rest-test",
    startedAt: new Date()
  };
}

// ---------------------------------------------------------------------------
// dispatch detection
// ---------------------------------------------------------------------------

Deno.test("dispatchRest returns null for non-/api/* paths", async () => {
  const { handler } = makeStubHandler();
  const result = await dispatchRest({
    request: new Request("http://localhost/health"),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  assertEquals(result, null);
});

Deno.test("dispatchRest returns 404 for unknown type", async () => {
  const { handler } = makeStubHandler();
  const result = await dispatchRest({
    request: new Request("http://localhost/api/Nonexistent"),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  assert(result instanceof Response);
  assertEquals(result.status, 404);
});

// ---------------------------------------------------------------------------
// GET list
// ---------------------------------------------------------------------------

Deno.test("GET /api/User compiles a SELECT with default shape (no hidden fields)", async () => {
  const { handler, captured } = makeStubHandler(() => [
    { id: "1", name: "Ada" },
    { id: "2", name: "Billie" }
  ]);
  const result = await dispatchRest({
    request: new Request("http://localhost/api/User"),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  assert(result instanceof Response);
  assertEquals(result.status, 200);
  assertEquals(captured.length, 1);
  // EdgeQL contains the type name and the visible properties; email is
  // suppressed because it carries `rest::hidden`.
  const q = captured[0].query;
  assert(q.includes("select User"), `expected select User, got: ${q}`);
  assert(q.includes("name"), `expected 'name' in shape, got: ${q}`);
  assert(q.includes("id"), `expected 'id' in shape, got: ${q}`);
  assert(!q.includes("email"), `expected 'email' suppressed, got: ${q}`);
});

Deno.test("GET /api/User?name=Ada produces a filter clause", async () => {
  const { handler, captured } = makeStubHandler(() => []);
  await dispatchRest({
    request: new Request("http://localhost/api/User?name=Ada"),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  const q = captured[0].query;
  assert(/filter\b/i.test(q), `expected filter, got: ${q}`);
  assert(q.includes(".name"), `expected .name in filter, got: ${q}`);
  assert(q.includes("Ada"), `expected 'Ada' in filter, got: ${q}`);
});

Deno.test("GET /api/User?limit=10&offset=5&order_by=-name applies pagination", async () => {
  const { handler, captured } = makeStubHandler(() => []);
  await dispatchRest({
    request: new Request(
      "http://localhost/api/User?limit=10&offset=5&order_by=-name"
    ),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  const q = captured[0].query;
  assert(/limit\s+10/.test(q), `expected limit 10, got: ${q}`);
  assert(/offset\s+5/.test(q), `expected offset 5, got: ${q}`);
  assert(/order by\s+\.name\s+desc/i.test(q), `expected DESC order, got: ${q}`);
});

Deno.test("GET /api/User?email__in=a,b uses 'in' operator", async () => {
  const { handler, captured } = makeStubHandler(() => []);
  await dispatchRest({
    request: new Request(
      "http://localhost/api/User?email__in=a@x.com,b@y.com"
    ),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  const q = captured[0].query;
  assert(/\.email\s+in\s+\{/i.test(q), `expected 'email in {...}', got: ${q}`);
  assert(q.includes("a@x.com"));
  assert(q.includes("b@y.com"));
});

Deno.test("GET /api/User rejects unknown filter field with 400", async () => {
  const { handler } = makeStubHandler();
  const result = await dispatchRest({
    request: new Request("http://localhost/api/User?nonexistent=foo"),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  assert(result instanceof Response);
  assertEquals(result.status, 400);
  const body = await result.json();
  assert(
    String(body.error ?? "").includes("nonexistent"),
    `error should mention 'nonexistent', got: ${JSON.stringify(body)}`
  );
});

// ---------------------------------------------------------------------------
// GET single
// ---------------------------------------------------------------------------

Deno.test("GET /api/User/<uuid> filters by id and returns single object", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const { handler, captured } = makeStubHandler(() => [
    { id, name: "Ada" }
  ]);
  const result = await dispatchRest({
    request: new Request(`http://localhost/api/User/${id}`),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  assert(result instanceof Response);
  assertEquals(result.status, 200);
  const q = captured[0].query;
  assert(/filter\s+\.id\s*=/i.test(q), `expected id filter, got: ${q}`);
  assert(q.includes(id), `expected id literal in query, got: ${q}`);
  // Single-object response, not array.
  const body = await result.json();
  assertEquals(body.name, "Ada");
});

Deno.test("GET /api/User/<id> returns 404 when row missing", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const { handler } = makeStubHandler(() => []);
  const result = await dispatchRest({
    request: new Request(`http://localhost/api/User/${id}`),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  assert(result instanceof Response);
  assertEquals(result.status, 404);
});

Deno.test("GET /api/User rejects malformed UUID id with 400", async () => {
  const { handler } = makeStubHandler();
  const result = await dispatchRest({
    request: new Request("http://localhost/api/User/not-a-uuid"),
    schema: buildSchema(),
    protocolHandler: handler,
    context: makeContext()
  });
  assert(result instanceof Response);
  assertEquals(result.status, 400);
});

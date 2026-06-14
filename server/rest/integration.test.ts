/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Schema-derived REST surface — black-box integration tests
 * (Bundle J — Disc-original feature #2).
 *
 * Spins up the real `HttpServer` with a stub protocol handler that
 * captures the EdgeQL string the router synthesizes. End-to-end:
 * fetch → HTTP server → REST router → protocol handler. Real PG
 * coverage is a follow-on (the EdgeQL string is exercised by the
 * existing PG test sweep).
 */

import { assert, assertEquals } from "@std/assert";
import type { Schema, TypeDef } from "../../compiler/context.ts";
import { HttpServer } from "../http.ts";
import type * as Types from "../types.ts";

const TEST_HOST = "127.0.0.1";

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

function makeStubHandler(
  responder: (q: string) => unknown = () => []
): {
  handler: Types.ProtocolHandler;
  captured: { query: string; }[];
} {
  const captured: { query: string; }[] = [];
  const handler: Types.ProtocolHandler = {
    handleRequest: request => {
      captured.push({ query: request.query });
      return Promise.resolve({ data: responder(request.query) });
    },
    validateRequest: () => []
  };
  return { handler, captured };
}

async function startServer(opts: {
  enableRest?: boolean;
  responder?: (q: string) => unknown;
} = {}): Promise<{
  baseUrl: string;
  captured: { query: string; }[];
  cleanup: () => Promise<void>;
}> {
  const schema = buildSchema();
  const { handler, captured } = makeStubHandler(opts.responder);
  const server = new HttpServer({
    config: {
      host: TEST_HOST,
      // Bind on 0 so the OS hands us a free ephemeral port. A random fixed
      // port collides under load (AddrInUse), and the unawaited start()
      // below would surface that as an uncaught rejection that fails the
      // whole module. Read the real port from `server.boundPort` after bind.
      port: 0,
      databaseUrl: "postgresql://localhost:5432/test",
      maxConnections: 10,
      requestTimeout: 5000,
      enableCors: true,
      enableWebsockets: false,
      enableRest: opts.enableRest
    },
    protocolHandler: handler,
    schemaProvider: () => schema
  });
  // start() blocks on server.finished, so it's intentionally not awaited.
  // Attach a catch immediately so a bind failure can't escape as an
  // unhandled rejection before cleanup runs.
  const _running = server.start();
  _running.catch(() => undefined);
  await new Promise(r => setTimeout(r, 200));
  return {
    baseUrl: `http://${TEST_HOST}:${server.boundPort}`,
    captured,
    cleanup: async () => {
      await server.stop();
      await _running.catch(() => undefined);
    }
  };
}

// ---------------------------------------------------------------------------
// GET list
// ---------------------------------------------------------------------------

Deno.test("REST integration: GET /api/User round-trips through HTTP", async () => {
  const { baseUrl, captured, cleanup } = await startServer({
    responder: () => [{ id: "u1", name: "Ada" }]
  });
  try {
    const res = await fetch(`${baseUrl}/api/User`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body));
    assertEquals(body[0].name, "Ada");
    // Verify EdgeQL was actually compiled.
    assertEquals(captured.length, 1);
    assert(captured[0].query.includes("select User"));
    // Hidden field stays out of the shape.
    assert(!captured[0].query.includes("email"));
  } finally {
    await cleanup();
  }
});

Deno.test("REST integration: enableRest=false → 404 on /api routes", async () => {
  const { baseUrl, cleanup } = await startServer({ enableRest: false });
  try {
    const res = await fetch(`${baseUrl}/api/User`);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await cleanup();
  }
});

Deno.test("REST integration: GET /api/openapi.json emits an OpenAPI spec", async () => {
  const { baseUrl, cleanup } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/api/openapi.json`);
    assertEquals(res.status, 200);
    const spec = await res.json();
    assertEquals(spec.openapi, "3.1.0");
    assert(spec.paths["/api/User"]);
    assert(spec.paths["/api/User/{id}"]);
    assert(spec.paths["/api/Post"]);
    // User has a `posts` link, so the linked-collection path is emitted.
    assert(spec.paths["/api/User/{id}/posts"]);
    assert(spec.components.schemas.User);
    // `email` is hidden, so it's NOT in the response component schema.
    assert(!spec.components.schemas.User.properties?.email);
    assert(spec.components.schemas.User.properties?.name);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// POST insert / PATCH update / DELETE delete
// ---------------------------------------------------------------------------

Deno.test("REST integration: POST /api/Post compiles an insert", async () => {
  const { baseUrl, captured, cleanup } = await startServer({
    responder: () => [{ id: "p1", title: "hello" }]
  });
  try {
    const res = await fetch(`${baseUrl}/api/Post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "hello" })
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.title, "hello");
    assertEquals(captured.length, 1);
    assert(captured[0].query.includes("insert Post"));
    assert(captured[0].query.includes("title := 'hello'"));
  } finally {
    await cleanup();
  }
});

Deno.test("REST integration: POST /api/Post rejects unknown field with 400", async () => {
  const { baseUrl, captured, cleanup } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/api/Post`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "ok", bogus: 42 })
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assert(String(body.error ?? "").includes("bogus"));
    // Compiler was never invoked.
    assertEquals(captured.length, 0);
  } finally {
    await cleanup();
  }
});

Deno.test("REST integration: PATCH /api/Post/{id} compiles an update", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const { baseUrl, captured, cleanup } = await startServer({
    responder: () => [{ id, title: "renamed" }]
  });
  try {
    const res = await fetch(`${baseUrl}/api/Post/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "renamed" })
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.title, "renamed");
    assertEquals(captured.length, 1);
    const q = captured[0].query;
    assert(q.includes("update Post"));
    assert(q.includes(id));
    assert(q.includes("title := 'renamed'"));
  } finally {
    await cleanup();
  }
});

Deno.test("REST integration: DELETE /api/Post/{id} returns 204", async () => {
  const id = "11111111-2222-3333-4444-555555555555";
  const { baseUrl, captured, cleanup } = await startServer({
    responder: () => [{ id }]
  });
  try {
    const res = await fetch(`${baseUrl}/api/Post/${id}`, {
      method: "DELETE"
    });
    assertEquals(res.status, 204);
    // Body is empty; no stream to drain.
    assertEquals(captured.length, 1);
    assert(captured[0].query.includes("delete Post"));
    assert(captured[0].query.includes(id));
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Linked collection
// ---------------------------------------------------------------------------

Deno.test("REST integration: GET /api/User/{id}/posts returns linked collection", async () => {
  const userId = "11111111-2222-3333-4444-555555555555";
  const { baseUrl, captured, cleanup } = await startServer({
    responder: () => [
      {
        id: userId,
        name: "Ada",
        posts: [{ id: "p1", title: "first" }, { id: "p2", title: "second" }]
      }
    ]
  });
  try {
    const res = await fetch(`${baseUrl}/api/User/${userId}/posts`);
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body));
    assertEquals(body.length, 2);
    assertEquals(body[0].title, "first");
    assertEquals(captured.length, 1);
    const q = captured[0].query;
    assert(q.includes("select User"));
    assert(q.includes("posts:"));
    assert(q.includes(userId));
  } finally {
    await cleanup();
  }
});

Deno.test("REST integration: GET /api/User/{id}/nonsense returns 404", async () => {
  const userId = "11111111-2222-3333-4444-555555555555";
  const { baseUrl, cleanup } = await startServer();
  try {
    const res = await fetch(`${baseUrl}/api/User/${userId}/nonsense`);
    assertEquals(res.status, 404);
    await res.body?.cancel();
  } finally {
    await cleanup();
  }
});

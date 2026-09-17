/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * HTTP Transaction Route Tests
 *
 * `DiscClient.transaction()` has always POSTed to `/transaction/begin`, but
 * the route table never had it — every call 404'd against a real server and
 * the SDK's own tests stubbed `fetch`. These cover the real wire contract:
 *
 * 1. begin returns a transaction id, commit/rollback consume it
 * 2. isolation level and read-only flag travel in the begin body
 * 3. unknown ids 404, non-POST 405, malformed input 400
 * 4. a transaction opened by one user can't be driven by another
 */

import { assertEquals, assertExists } from "@std/assert";
import { HttpServer } from "./http.ts";
import type {
  ProtocolHandler,
  QueryContext,
  QueryError,
  QueryRequest,
  QueryResponse,
  ServerConfig
} from "./types.ts";

// --- Helpers ---

function createTestConfig(
  overrides: Partial<ServerConfig> = {}
): ServerConfig {
  return {
    host: "localhost",
    port: 0,
    databaseUrl: "postgresql://localhost:5432/test",
    maxConnections: 10,
    requestTimeout: 5000,
    enableCors: false,
    enableWebsockets: false,
    ...overrides
  };
}

/** Records the context it was handed so tests can assert on transaction threading. */
function createRecordingHandler(): {
  handler: ProtocolHandler;
  contexts: QueryContext[];
} {
  const contexts: QueryContext[] = [];

  return {
    contexts,
    handler: {
      handleRequest(
        _request: QueryRequest,
        context: QueryContext
      ): Promise<QueryResponse> {
        contexts.push(context);
        return Promise.resolve({ data: { ok: true } });
      },
      validateRequest(_request: QueryRequest): QueryError[] {
        return [];
      }
    }
  };
}

/**
 * Minimal stand-in for AuthMiddleware. `http-handlers` only calls
 * `authenticate(request)`, so a bearer-token-to-user map is enough to
 * exercise the ownership gate without standing up real JWT signing.
 */
function createFakeAuthMiddleware(
  tokenToUser: Record<string, string>
): { authenticate(request: Request): Promise<{ userId: string; } | null>; } {
  return {
    authenticate(request: Request): Promise<{ userId: string; } | null> {
      const header = request.headers.get("authorization") ?? "";
      const token = header.replace(/^Bearer\s+/i, "");
      const userId = tokenToUser[token];
      return Promise.resolve(userId ? { userId } : null);
    }
  };
}

interface TestServerHandle {
  cleanup: () => Promise<void>;
  port: number;
  server: HttpServer;
}

function withTestServer(
  handler: ProtocolHandler,
  options: {
    authMiddleware?: ReturnType<typeof createFakeAuthMiddleware>;
    configOverrides?: Partial<ServerConfig>;
  } = {}
): TestServerHandle {
  const server = new HttpServer({
    config: createTestConfig(options.configOverrides),
    protocolHandler: handler,
    // deno-lint-ignore no-explicit-any
    authMiddleware: options.authMiddleware as any
  });

  const testServer = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request: Request, info: Deno.ServeHandlerInfo) =>
      // deno-lint-ignore no-explicit-any
      (server as any).handleRequest(request, info)
  );

  return {
    cleanup: async () => {
      await testServer.shutdown();
    },
    port: testServer.addr.port,
    server
  };
}

function begin(
  port: number,
  body?: Record<string, unknown>,
  token?: string
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/transaction/begin`, {
    body: body ? JSON.stringify(body) : undefined,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    method: "POST"
  });
}

function finish(
  port: number,
  action: "commit" | "rollback",
  transactionId?: string,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (transactionId) {
    headers["X-Transaction-ID"] = transactionId;
  }
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }

  return fetch(`http://127.0.0.1:${port}/transaction/${action}`, {
    headers,
    method: "POST"
  });
}

// --- Begin ---

Deno.test("POST /transaction/begin returns a transaction id", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port, server } = withTestServer(handler);

  try {
    const response = await begin(port);
    assertEquals(response.status, 200);

    const body = await response.json() as { transactionId: string; };
    assertExists(body.transactionId);
    assertEquals(body.transactionId.startsWith("txn_"), true);

    // deno-lint-ignore no-explicit-any
    const manager = (server as any).transaction_manager;
    assertExists(manager.getTransaction(body.transactionId));
  } finally {
    await cleanup();
  }
});

Deno.test("POST /transaction/begin honors isolation level and readOnly", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port, server } = withTestServer(handler);

  try {
    const response = await begin(port, {
      isolationLevel: "serializable",
      readOnly: true
    });
    const { transactionId } = await response.json() as { transactionId: string; };

    // deno-lint-ignore no-explicit-any
    const transaction = (server as any).transaction_manager.getTransaction(
      transactionId
    );
    assertEquals(transaction.isolationLevel, "serializable");
    assertEquals(transaction.readOnly, true);
  } finally {
    await cleanup();
  }
});

Deno.test("POST /transaction/begin defaults to read_committed", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port, server } = withTestServer(handler);

  try {
    const response = await begin(port);
    const { transactionId } = await response.json() as { transactionId: string; };

    // deno-lint-ignore no-explicit-any
    const transaction = (server as any).transaction_manager.getTransaction(
      transactionId
    );
    assertEquals(transaction.isolationLevel, "read_committed");
    assertEquals(transaction.readOnly, false);
  } finally {
    await cleanup();
  }
});

Deno.test("POST /transaction/begin rejects an unknown isolation level", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler);

  try {
    const response = await begin(port, { isolationLevel: "snapshot" });
    assertEquals(response.status, 400);
    await response.body?.cancel();
  } finally {
    await cleanup();
  }
});

Deno.test("GET /transaction/begin is rejected", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler);

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/transaction/begin`,
      { method: "GET" }
    );
    assertEquals(response.status, 405);
    await response.body?.cancel();
  } finally {
    await cleanup();
  }
});

// --- Commit and rollback ---

Deno.test("POST /transaction/commit consumes the transaction", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port, server } = withTestServer(handler);

  try {
    const { transactionId } = await (await begin(port)).json() as {
      transactionId: string;
    };

    const response = await finish(port, "commit", transactionId);
    assertEquals(response.status, 200);
    assertEquals((await response.json() as { ok: boolean; }).ok, true);

    // deno-lint-ignore no-explicit-any
    const manager = (server as any).transaction_manager;
    assertEquals(manager.getTransaction(transactionId), null);
  } finally {
    await cleanup();
  }
});

Deno.test("POST /transaction/rollback consumes the transaction", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port, server } = withTestServer(handler);

  try {
    const { transactionId } = await (await begin(port)).json() as {
      transactionId: string;
    };

    const response = await finish(port, "rollback", transactionId);
    assertEquals(response.status, 200);
    await response.body?.cancel();

    // deno-lint-ignore no-explicit-any
    const manager = (server as any).transaction_manager;
    assertEquals(manager.getTransaction(transactionId), null);
  } finally {
    await cleanup();
  }
});

Deno.test("commit with an unknown transaction id is a 404", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler);

  try {
    const response = await finish(port, "commit", "txn_nope");
    assertEquals(response.status, 404);
    await response.body?.cancel();
  } finally {
    await cleanup();
  }
});

Deno.test("commit without a transaction id is a 400", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler);

  try {
    const response = await finish(port, "commit");
    assertEquals(response.status, 400);
    await response.body?.cancel();
  } finally {
    await cleanup();
  }
});

Deno.test("an unknown /transaction/* action is a 404", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler);

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/transaction/savepoint`,
      { method: "POST" }
    );
    assertEquals(response.status, 404);
    await response.body?.cancel();
  } finally {
    await cleanup();
  }
});

// --- Ownership ---

Deno.test("a transaction is pinned to the user that opened it", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port, server } = withTestServer(handler, {
    authMiddleware: createFakeAuthMiddleware({
      "ada-token": "user_ada",
      "billie-token": "user_billie"
    })
  });

  try {
    const { transactionId } = await (await begin(port, undefined, "ada-token"))
      .json() as { transactionId: string; };

    // deno-lint-ignore no-explicit-any
    const transaction = (server as any).transaction_manager.getTransaction(
      transactionId
    );
    assertEquals(transaction.ownerUserId, "user_ada");

    // Billie holds the token but is not the owner.
    const stolen = await finish(port, "commit", transactionId, "billie-token");
    assertEquals(stolen.status, 403);
    await stolen.body?.cancel();

    // Still alive and still Ada's.
    const owned = await finish(port, "commit", transactionId, "ada-token");
    assertEquals(owned.status, 200);
    await owned.body?.cancel();
  } finally {
    await cleanup();
  }
});

Deno.test("with auth disabled the token alone authorizes the transaction", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port, server } = withTestServer(handler);

  try {
    const { transactionId } = await (await begin(port)).json() as {
      transactionId: string;
    };

    // deno-lint-ignore no-explicit-any
    const transaction = (server as any).transaction_manager.getTransaction(
      transactionId
    );
    assertEquals(transaction.ownerUserId, undefined);

    const response = await finish(port, "commit", transactionId);
    assertEquals(response.status, 200);
    await response.body?.cancel();
  } finally {
    await cleanup();
  }
});

// --- Queries inside a transaction ---

Deno.test("X-Transaction-ID threads the transaction onto the query context", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler);

  try {
    const { transactionId } = await (await begin(port)).json() as {
      transactionId: string;
    };

    const response = await fetch(`http://127.0.0.1:${port}/query`, {
      body: JSON.stringify({ query: "select 1" }),
      headers: { "X-Transaction-ID": transactionId },
      method: "POST"
    });
    assertEquals(response.status, 200);
    await response.body?.cancel();

    assertEquals(contexts.length, 1);
    assertEquals(contexts[0].session.transactionId, transactionId);
  } finally {
    await cleanup();
  }
});

Deno.test("a query with no X-Transaction-ID carries no transaction", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/query`, {
      body: JSON.stringify({ query: "select 1" }),
      method: "POST"
    });
    await response.body?.cancel();

    assertEquals(contexts[0].session.transactionId, undefined);
  } finally {
    await cleanup();
  }
});

Deno.test("a query against an unknown transaction is a 404", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/query`, {
      body: JSON.stringify({ query: "select 1" }),
      headers: { "X-Transaction-ID": "txn_nope" },
      method: "POST"
    });
    assertEquals(response.status, 404);
    await response.body?.cancel();

    // The query never reached the protocol handler.
    assertEquals(contexts.length, 0);
  } finally {
    await cleanup();
  }
});

Deno.test("a query against someone else's transaction is a 403", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, {
    authMiddleware: createFakeAuthMiddleware({
      "ada-token": "user_ada",
      "billie-token": "user_billie"
    })
  });

  try {
    const { transactionId } = await (await begin(port, undefined, "ada-token"))
      .json() as { transactionId: string; };

    const response = await fetch(`http://127.0.0.1:${port}/query`, {
      body: JSON.stringify({ query: "select 1" }),
      headers: {
        authorization: "Bearer billie-token",
        "X-Transaction-ID": transactionId
      },
      method: "POST"
    });
    assertEquals(response.status, 403);
    await response.body?.cancel();
    assertEquals(contexts.length, 0);
  } finally {
    await cleanup();
  }
});

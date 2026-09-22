/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Service credential (`ServerConfig.serviceToken` / `DISC_SERVICE_TOKEN`).
 *
 * A static, server-configured bearer token that a trusted backend presents as
 * `Authorization: Bearer <token>` on `/query` and `/transaction/*`. On a match
 * the caller is `{ userId: "service", roles: ["service"] }` with access
 * policies bypassed and no JWT involved. Everything else about the request —
 * cookies, URL, body, other routes, WebSocket, the header-bypass gate — must
 * keep behaving exactly as if no service token were configured.
 *
 * No PostgreSQL: a recording protocol handler captures the `QueryContext` the
 * HTTP layer builds; a dry-run `EdgeQLProtocolHandler` shows the SQL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding";
import { AuthMiddleware } from "../auth/middleware.ts";
import { AuthProvider } from "../auth/provider.ts";
import { TestDatabase } from "../auth/test-database.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";
import type {
  ProtocolHandler,
  QueryContext,
  QueryError,
  QueryRequest,
  QueryResponse,
  ServerConfig
} from "./types.ts";

const SERVICE_TOKEN = "service-token-for-tests-0123456789abcdef-ghij";
const JWT_SECRET = "service-token-tests-jwt-secret-at-least-32-bytes";

const SDL = `
type Locked {
  required name: str;
  access policy nobody {
    allow all;
    using (false);
  }
}
`;

/*** Harness ------------------------------------------- ***/

function createTestConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    databaseUrl: "postgresql://localhost:5432/test",
    enableAccessPolicies: true,
    enableCors: false,
    enableWebsockets: true,
    host: "localhost",
    maxConnections: 10,
    port: 0,
    requestTimeout: 5000,
    ...overrides
  };
}

/** Records every `QueryContext` the HTTP layer hands to the protocol handler. */
function createRecordingHandler(): { contexts: QueryContext[]; handler: ProtocolHandler; } {
  const contexts: QueryContext[] = [];
  return {
    contexts,
    handler: {
      handleRequest(_request: QueryRequest, context: QueryContext): Promise<QueryResponse> {
        contexts.push(context);
        return Promise.resolve({ data: [] });
      },
      validateRequest(_request: QueryRequest): QueryError[] {
        return [];
      }
    }
  };
}

async function createDryRunHandler(): Promise<EdgeQLProtocolHandler> {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL(SDL);
  if (!parsed.ok) {
    throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
  }
  return new EdgeQLProtocolHandler({
    dryRun: true,
    enableAccessPolicies: true,
    enableExplain: true,
    schema: manager.modulesToSchema(parsed.value)
  });
}

/**
 * Stand-in for `AuthMiddleware` keyed by bearer token, for the tests that need
 * a caller with roles (the real provider would need a role assignment and a
 * re-login for that). `http-handlers` only calls `authenticate(request)`.
 */
function createFakeAuthMiddleware(
  tokens: Record<string, { roles?: string[]; userId: string; }>
): { authenticate(request: Request): Promise<{ roles?: string[]; userId: string; } | null>; } {
  return {
    authenticate(request: Request) {
      const header = request.headers.get("authorization") ?? "";
      const token = header.replace(/^Bearer\s+/i, "");
      return Promise.resolve(tokens[token] ?? null);
    }
  };
}

/** A real `AuthProvider` + `AuthMiddleware` over the in-memory test database, with one registered user. */
async function createRealAuth(): Promise<{ close(): Promise<void>; middleware: AuthMiddleware; userId: string; userToken: string; }> {
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider({ bcryptRounds: 4, jwtSecret: JWT_SECRET, passwordMinLength: 6, tokenExpiry: 3600 }, db);
  await provider.initialize();
  const registered = await provider.register({ email: "user@example.com", password: "TestPass123!" });
  return {
    close: () => db.close(),
    middleware: new AuthMiddleware(provider),
    userId: registered.user.id,
    userToken: registered.token
  };
}

interface TestServer {
  cleanup(): Promise<void>;
  port: number;
  server: HttpServer;
}

function withTestServer(
  handler: ProtocolHandler,
  options: {
    // deno-lint-ignore no-explicit-any
    authMiddleware?: any;
    config?: Partial<ServerConfig>;
    schemaProvider?: import("./schema-endpoint.ts").SchemaProvider;
  } = {}
): TestServer {
  const server = new HttpServer({
    authMiddleware: options.authMiddleware,
    config: createTestConfig(options.config),
    protocolHandler: handler,
    schemaProvider: options.schemaProvider
  });

  const listener = Deno.serve(
    { hostname: "127.0.0.1", onListen() {}, port: 0 },
    (request: Request, info: Deno.ServeHandlerInfo) =>
      // deno-lint-ignore no-explicit-any
      (server as any).handleRequest(request, info)
  );

  return {
    cleanup: () => listener.shutdown(),
    port: listener.addr.port,
    server
  };
}

async function query(
  port: number,
  headers: Record<string, string> = {},
  path = "/query",
  body: Record<string, unknown> = { query: "select Locked { name }" }
): Promise<{ body: QueryResponse; status: number; }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST"
  });
  const text = await response.text();
  return { body: text ? JSON.parse(text) : {}, status: response.status };
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

function assertServiceCaller(context: QueryContext): void {
  assertEquals(context.auth.userId, "service");
  assertEquals(context.auth.roles, ["service"]);
  assertEquals(context.bypassAccessPolicies, true);
}

function assertNotServiceCaller(context: QueryContext): void {
  assert(context.auth.userId !== "service", "caller must not be the service");
  assert(!context.auth.roles.includes("service"), "caller must not hold the service role");
  assert(context.bypassAccessPolicies !== true, "policies must not be bypassed");
}

/*** Match ---------------------------------------------- ***/

Deno.test("service token: a matching bearer on /query is the service caller with policies bypassed", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, { config: { serviceToken: SERVICE_TOKEN } });
  try {
    const { status } = await query(port, bearer(SERVICE_TOKEN));
    assertEquals(status, 200);
    assertEquals(contexts.length, 1);
    assertServiceCaller(contexts[0]);
  } finally {
    await cleanup();
  }
});

Deno.test("service token: the service reads a type closed to everyone (dry-run SQL has no policy filter)", async () => {
  const handler = await createDryRunHandler();
  const { cleanup, port } = withTestServer(handler, { config: { serviceToken: SERVICE_TOKEN } });
  try {
    const service = await query(port, bearer(SERVICE_TOKEN));
    const serviceSql = service.body.extensions?.sql as string;
    assert(serviceSql, "expected sql in extensions");
    assert(!/WHERE\s+FALSE/i.test(serviceSql), `service SQL must not carry the policy filter: ${serviceSql}`);

    const anonymous = await query(port);
    const anonymousSql = anonymous.body.extensions?.sql as string;
    assert(/WHERE\s+FALSE/i.test(anonymousSql), `anonymous SQL must carry the policy filter: ${anonymousSql}`);
  } finally {
    await cleanup();
  }
});

Deno.test("service token: the service may insert into a type closed to everyone", async () => {
  const handler = await createDryRunHandler();
  const { cleanup, port } = withTestServer(handler, { config: { serviceToken: SERVICE_TOKEN } });
  try {
    const service = await query(port, bearer(SERVICE_TOKEN), "/query", { query: "insert Locked { name := 'x' }" });
    assertEquals(service.status, 200);
    assertStringIncludes(service.body.extensions?.sql as string, "INSERT INTO locked");

    const anonymous = await query(port, {}, "/query", { query: "insert Locked { name := 'x' }" });
    assertEquals(anonymous.status, 400);
    assert(anonymous.body.errors?.some(e => /not allowed on Locked/.test(e.message)), JSON.stringify(anonymous.body));
  } finally {
    await cleanup();
  }
});

Deno.test("service token: works with auth disabled (no auth middleware, requireAuth off)", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, { config: { serviceToken: SERVICE_TOKEN } });
  try {
    await query(port, bearer(SERVICE_TOKEN));
    assertServiceCaller(contexts[0]);
  } finally {
    await cleanup();
  }
});

Deno.test("service token: works with requireAuth on and NO auth middleware (no 503 for the service)", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, { config: { requireAuth: true, serviceToken: SERVICE_TOKEN } });
  try {
    const service = await query(port, bearer(SERVICE_TOKEN));
    assertEquals(service.status, 200);
    assertServiceCaller(contexts[0]);

    // Everyone else still hits the fail-loud 503.
    const other = await query(port, bearer("not-the-service-token"));
    assertEquals(other.status, 503);
    const anonymous = await query(port);
    assertEquals(anonymous.status, 503);
  } finally {
    await cleanup();
  }
});

Deno.test("service token: works with requireAuth on and an auth middleware; other bearers still need a JWT", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, {
    authMiddleware: createFakeAuthMiddleware({ "user-token": { userId: "user_1" } }),
    config: { requireAuth: true, serviceToken: SERVICE_TOKEN }
  });
  try {
    assertEquals((await query(port, bearer(SERVICE_TOKEN))).status, 200);
    assertServiceCaller(contexts[0]);

    assertEquals((await query(port, bearer("user-token"))).status, 200);
    assertEquals(contexts[1].auth.userId, "user_1");
    assertNotServiceCaller(contexts[1]);

    assertEquals((await query(port, bearer("garbage"))).status, 401);
    assertEquals((await query(port)).status, 401);
  } finally {
    await cleanup();
  }
});

/*** Mismatch and inert configurations ------------------ ***/

Deno.test("service token: a wrong bearer falls through to JWT verification (a user JWT is a bearer token too)", async () => {
  const auth = await createRealAuth();
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, { authMiddleware: auth.middleware, config: { serviceToken: SERVICE_TOKEN } });
  try {
    await query(port, bearer(auth.userToken));
    assertEquals(contexts[0].auth.userId, auth.userId);
    assertNotServiceCaller(contexts[0]);

    await query(port, bearer(SERVICE_TOKEN.slice(0, -1)));
    assertEquals(contexts[1].auth.userId, undefined, "a near-miss is anonymous, not the service");
    assertNotServiceCaller(contexts[1]);
  } finally {
    await cleanup();
    await auth.close();
  }
});

Deno.test("service token: a valid user cookie plus a wrong bearer never yields service rights", async () => {
  const auth = await createRealAuth();
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, { authMiddleware: auth.middleware, config: { serviceToken: SERVICE_TOKEN } });
  try {
    await query(port, { ...bearer("wrong-bearer-token"), Cookie: `auth_token=${auth.userToken}` });
    assertNotServiceCaller(contexts[0]);
    // The header wins over the cookie in `AuthMiddleware.extractToken`, and a
    // wrong header verifies as nobody — so this request is anonymous.
    assertEquals(contexts[0].auth.userId, undefined);
  } finally {
    await cleanup();
    await auth.close();
  }
});

Deno.test("service token: the token is only read from the Authorization header, never cookie, URL or body", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, { config: { serviceToken: SERVICE_TOKEN } });
  try {
    await query(port, { Cookie: `auth_token=${SERVICE_TOKEN}` });
    await query(port, {}, `/query?token=${encodeURIComponent(SERVICE_TOKEN)}`);
    await query(port, {}, "/query", { query: "select Locked { name }", token: SERVICE_TOKEN });
    await query(port, { Authorization: SERVICE_TOKEN }); // no "Bearer " scheme
    await query(port, { Authorization: `Basic ${encodeBase64(`service:${SERVICE_TOKEN}`)}` });
    assertEquals(contexts.length, 5);
    for (const context of contexts) {
      assertNotServiceCaller(context);
    }
  } finally {
    await cleanup();
  }
});

Deno.test("service token: with no token configured the feature is inert (empty bearer never matches)", async () => {
  const { contexts, handler } = createRecordingHandler();
  const unset = withTestServer(handler);
  const empty = withTestServer(handler, { config: { serviceToken: "" } });
  try {
    for (const { port } of [unset, empty]) {
      await query(port, bearer(""));
      await query(port, { Authorization: "Bearer" });
      await query(port, { Authorization: "Bearer " });
      await query(port, bearer(SERVICE_TOKEN));
    }
    assertEquals(contexts.length, 8);
    for (const context of contexts) {
      assertNotServiceCaller(context);
    }
  } finally {
    await unset.cleanup();
    await empty.cleanup();
  }
});

/*** Scope: only /query and /transaction/* ----------------- ***/

Deno.test("service token: REST routes do not honor it", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL(SDL);
  assert(parsed.ok);
  const schema = manager.modulesToSchema(parsed.value);

  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, { config: { serviceToken: SERVICE_TOKEN }, schemaProvider: () => schema });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/Locked`, { headers: bearer(SERVICE_TOKEN) });
    await response.body?.cancel();
    assertEquals(contexts.length, 1, "the REST route should have reached the handler");
    assertNotServiceCaller(contexts[0]);
  } finally {
    await cleanup();
  }
});

Deno.test("service token: with requireAuth on, REST and other routes still reject the service bearer", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, {
    authMiddleware: createFakeAuthMiddleware({}),
    config: { requireAuth: true, serviceToken: SERVICE_TOKEN }
  });
  try {
    for (const path of ["/api/Locked", "/stats", "/schema", "/migrations"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: bearer(SERVICE_TOKEN) });
      await response.body?.cancel();
      assertEquals(response.status, 401, `${path} must not accept the service token`);
    }
    assertEquals(contexts.length, 0);
  } finally {
    await cleanup();
  }
});

Deno.test("service token: a WebSocket query carrying the bearer on the upgrade is not the service", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, { config: { serviceToken: SERVICE_TOKEN } });
  try {
    const reply = await rawWebSocketQuery(port, SERVICE_TOKEN, { payload: { query: "select Locked { name }" }, type: "query" });
    assertEquals(reply.type, "query_result");
    assertEquals(contexts.length, 1);
    assertNotServiceCaller(contexts[0]);
  } finally {
    await cleanup();
  }
});

Deno.test("service token: the binary listener and the protocol handler know nothing about it", async () => {
  // The binary path (`executeBinaryQuery`) compiles as an anonymous caller
  // (server/binary-query-context.test.ts). Pin that neither it nor anything
  // under protocol/ can read the token: the only consumer is the HTTP layer.
  const sources = [
    "./edgeql-protocol.ts",
    "./simple-edgeql-protocol.ts",
    "../protocol/server.ts",
    "../protocol/connection.ts",
    "../protocol/binary-server.ts"
  ];
  for (const source of sources) {
    const text = await Deno.readTextFile(new URL(source, import.meta.url));
    assert(!text.includes("serviceToken"), `${source} must not reference the service token`);
  }
});

/*** Transactions ------------------------------------------ ***/

Deno.test("service token: the service owns its transactions and users cannot touch them (and vice versa)", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port, server } = withTestServer(handler, {
    authMiddleware: createFakeAuthMiddleware({ "user-token": { userId: "user_1" } }),
    config: { serviceToken: SERVICE_TOKEN }
  });
  const base = `http://127.0.0.1:${port}`;
  const begin = async (headers: Record<string, string>): Promise<string> => {
    const response = await fetch(`${base}/transaction/begin`, { headers, method: "POST" });
    return (await response.json() as { transactionId: string; }).transactionId;
  };
  const finish = async (action: string, id: string, headers: Record<string, string>): Promise<number> => {
    const response = await fetch(`${base}/transaction/${action}`, { headers: { ...headers, "X-Transaction-ID": id }, method: "POST" });
    await response.body?.cancel();
    return response.status;
  };
  try {
    const serviceTx = await begin(bearer(SERVICE_TOKEN));
    // deno-lint-ignore no-explicit-any
    assertEquals((server as any).transaction_manager.getTransaction(serviceTx).ownerUserId, "service");

    // The service queries inside and commits its own transaction.
    const inside = await query(port, { ...bearer(SERVICE_TOKEN), "X-Transaction-ID": serviceTx });
    assertEquals(inside.status, 200);
    assertServiceCaller(contexts[0]);
    assertEquals(contexts[0].session.transactionId, serviceTx);

    // A user cannot query in, commit or roll back the service's transaction.
    assertEquals((await query(port, { ...bearer("user-token"), "X-Transaction-ID": serviceTx })).status, 403);
    assertEquals((await query(port, { "X-Transaction-ID": serviceTx })).status, 403);
    assertEquals(await finish("commit", serviceTx, bearer("user-token")), 403);
    assertEquals(await finish("rollback", serviceTx, {}), 403);
    assertEquals(await finish("commit", serviceTx, bearer(SERVICE_TOKEN)), 200);

    // And the service cannot touch a user's transaction.
    const userTx = await begin(bearer("user-token"));
    assertEquals((await query(port, { ...bearer(SERVICE_TOKEN), "X-Transaction-ID": userTx })).status, 403);
    assertEquals(await finish("commit", userTx, bearer(SERVICE_TOKEN)), 403);
    assertEquals(await finish("rollback", userTx, bearer("user-token")), 200);
  } finally {
    await cleanup();
  }
});

/*** Observability and leakage ----------------------------- ***/

Deno.test("service token: /stats counts policy-bypassed queries and never shows the token", async () => {
  const { handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, {
    authMiddleware: createFakeAuthMiddleware({ "admin-token": { roles: ["admin"], userId: "admin_1" }, "user-token": { userId: "user_1" } }),
    config: { serviceToken: SERVICE_TOKEN }
  });
  try {
    await query(port, bearer(SERVICE_TOKEN));
    await query(port, bearer(SERVICE_TOKEN));
    await query(port, { ...bearer("admin-token"), "X-Disc-Apply-Access-Policies": "false" });
    await query(port, bearer("user-token"));
    await query(port);

    const stats = await fetch(`http://127.0.0.1:${port}/stats`);
    const text = await stats.text();
    const parsed = JSON.parse(text) as { queries: { bypassed: number; total: number; }; };
    assertEquals(parsed.queries.bypassed, 3);
    assertEquals(parsed.queries.total, 6); // the five queries plus this /stats request
    assert(!text.includes(SERVICE_TOKEN), "/stats must not echo the service token");

    const config = await fetch(`http://127.0.0.1:${port}/config`);
    assert(!(await config.text()).includes(SERVICE_TOKEN), "/config must not echo the service token");
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert(!(await root.text()).includes(SERVICE_TOKEN), "/ must not echo the service token");
  } finally {
    await cleanup();
  }
});

/*** Header-bypass role alignment -------------------------- ***/

Deno.test("header bypass: X-Disc-Apply-Access-Policies is honored for admin and superuser, dropped for others", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, {
    authMiddleware: createFakeAuthMiddleware({
      "admin-token": { roles: ["admin"], userId: "admin_1" },
      "super-token": { roles: ["superuser"], userId: "super_1" },
      "user-token": { roles: ["editor"], userId: "user_1" }
    })
  });
  const off = { "X-Disc-Apply-Access-Policies": "false" };
  try {
    await query(port, { ...bearer("admin-token"), ...off });
    await query(port, { ...bearer("super-token"), ...off });
    await query(port, { ...bearer("user-token"), ...off });
    await query(port, off);
    assertEquals(contexts.map(c => c.bypassAccessPolicies), [true, true, false, false]);
  } finally {
    await cleanup();
  }
});

Deno.test("header bypass: X-Disc-Disable-Policies uses the same admin-or-superuser gate", async () => {
  const { contexts, handler } = createRecordingHandler();
  const { cleanup, port } = withTestServer(handler, {
    authMiddleware: createFakeAuthMiddleware({
      "admin-token": { roles: ["admin"], userId: "admin_1" },
      "super-token": { roles: ["superuser"], userId: "super_1" },
      "user-token": { roles: ["editor"], userId: "user_1" }
    })
  });
  const disable = { "X-Disc-Disable-Policies": "Locked.nobody" };
  try {
    await query(port, { ...bearer("admin-token"), ...disable });
    await query(port, { ...bearer("super-token"), ...disable });
    await query(port, { ...bearer("user-token"), ...disable });
    assertEquals(contexts.map(c => [...(c.disabledPolicies ?? [])]), [["Locked.nobody"], ["Locked.nobody"], []]);
  } finally {
    await cleanup();
  }
});

/*** Raw WebSocket client ---------------------------------- ***/

/**
 * `WebSocket` cannot set request headers, so drive the upgrade by hand: one
 * HTTP/1.1 upgrade with an `Authorization` header, one masked text frame,
 * one reply frame. Enough of RFC 6455 for a single small exchange.
 */
async function rawWebSocketQuery(port: number, token: string, message: unknown): Promise<{ type: string; }> {
  const conn = await Deno.connect({ hostname: "127.0.0.1", port });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  try {
    const key = encodeBase64(crypto.getRandomValues(new Uint8Array(16)));
    await conn.write(encoder.encode(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${token}\r\n\r\n`
    ));

    let buffer = new Uint8Array(0);
    const readMore = async (): Promise<void> => {
      const chunk = new Uint8Array(65536);
      const n = await conn.read(chunk);
      if (n === null) {
        throw new Error("connection closed");
      }
      const next = new Uint8Array(buffer.length + n);
      next.set(buffer);
      next.set(chunk.subarray(0, n), buffer.length);
      buffer = next;
    };
    const indexOfHeaderEnd = (): number => {
      const text = decoder.decode(buffer);
      const at = text.indexOf("\r\n\r\n");
      return at === -1 ? -1 : encoder.encode(text.slice(0, at + 4)).length;
    };
    while (indexOfHeaderEnd() === -1) {
      await readMore();
    }
    const headerEnd = indexOfHeaderEnd();
    const statusLine = decoder.decode(buffer.subarray(0, headerEnd)).split("\r\n")[0];
    assertStringIncludes(statusLine, "101");
    buffer = buffer.subarray(headerEnd);

    // Client frames must be masked (RFC 6455 §5.3).
    const payload = encoder.encode(JSON.stringify(message));
    const mask = crypto.getRandomValues(new Uint8Array(4));
    const header = payload.length < 126 ?
      new Uint8Array([0x81, 0x80 | payload.length]) :
      new Uint8Array([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    const frame = new Uint8Array(header.length + 4 + payload.length);
    frame.set(header);
    frame.set(mask, header.length);
    for (let i = 0; i < payload.length; i++) {
      frame[header.length + 4 + i] = payload[i] ^ mask[i % 4];
    }
    await conn.write(frame);

    // Server frames are unmasked; read one complete text frame.
    for (;;) {
      if (buffer.length >= 2) {
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126 && buffer.length >= 4) {
          length = (buffer[2] << 8) | buffer[3];
          offset = 4;
        } else if (length === 127) {
          throw new Error("frame too large for this helper");
        }
        if (buffer.length >= offset + length) {
          return JSON.parse(decoder.decode(buffer.subarray(offset, offset + length)));
        }
      }
      await readMore();
    }
  } finally {
    try {
      await conn.write(new Uint8Array([0x88, 0x80, 0, 0, 0, 0]));
    } catch {
      // Already closed by the server.
    }
    conn.close();
  }
}

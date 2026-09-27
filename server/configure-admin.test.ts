/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Persistent configuration is for administrators only.
 *
 * `configure system …` is `ALTER SYSTEM SET` and `configure database |
 * instance …` writes Disc's own settings: only an administrator may run
 * them — the service credential, or a user with the `admin` role or the
 * `superuser` role `disc admin create-superuser` grants. Anyone else gets
 * Gel's DisabledCapabilityError ("cannot execute configuration commands"),
 * over HTTP a 403. `configure session …` stays open to every caller, for the
 * session-level keys only. `POST /config` (the admin UI's editor, also
 * `ALTER SYSTEM SET`) takes the same administrators.
 *
 * No PostgreSQL: a dry-run `EdgeQLProtocolHandler` answers with the SQL it
 * would run. server/configure-admin-pg.test.ts runs the same over a real
 * PostgreSQL, over HTTP and the binary protocol.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createTestSchema } from "../compiler/context.ts";
import { DisabledCapabilityError } from "../lib/errors.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";
import type { ProtocolHandler, QueryResponse, ServerConfig } from "./types.ts";

const SERVICE_TOKEN = "configure-admin-service-token-0123456789abcdef";

const TOKENS: Record<string, { roles?: string[]; userId: string; }> = {
  "admin-token": { roles: ["admin"], userId: "admin_1" },
  "editor-token": { roles: ["editor"], userId: "editor_1" },
  "super-token": { roles: ["superuser"], userId: "super_1" },
  "user-token": { userId: "user_1" }
};

/*** Harness ------------------------------------------- ***/

function createFakeAuthMiddleware(): { authenticate(request: Request): Promise<{ roles?: string[]; userId: string; } | null>; } {
  return {
    authenticate(request: Request) {
      const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      return Promise.resolve(TOKENS[token] ?? null);
    }
  };
}

function withTestServer(
  handler: ProtocolHandler,
  config: Partial<ServerConfig> = {}
): { cleanup(): Promise<void>; port: number; } {
  const server = new HttpServer({
    authMiddleware: createFakeAuthMiddleware() as never,
    config: {
      databaseUrl: "postgresql://localhost:5432/test",
      enableCors: false,
      enableWebsockets: true,
      host: "localhost",
      maxConnections: 10,
      port: 0,
      requestTimeout: 5000,
      serviceToken: SERVICE_TOKEN,
      ...config
    },
    protocolHandler: handler
  });
  const listener = Deno.serve(
    { hostname: "127.0.0.1", onListen() {}, port: 0 },
    (request: Request, info: Deno.ServeHandlerInfo) =>
      // deno-lint-ignore no-explicit-any
      (server as any).handleRequest(request, info)
  );
  return { cleanup: () => listener.shutdown(), port: listener.addr.port };
}

function dryRunHandler(): EdgeQLProtocolHandler {
  return new EdgeQLProtocolHandler({ dryRun: true, enableExplain: true, schema: createTestSchema() });
}

async function post(
  port: number,
  path: string,
  body: unknown,
  token?: string
): Promise<{ body: QueryResponse & { error?: string; }; status: number; }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    method: "POST"
  });
  const text = await response.text();
  return { body: text ? JSON.parse(text) : {}, status: response.status };
}

function query(port: number, text: string, token?: string): ReturnType<typeof post> {
  return post(port, "/query", { query: text }, token);
}

function assertRefused(reply: Awaited<ReturnType<typeof post>>, label: string): void {
  assertEquals(reply.status, 403, `${label}: ${JSON.stringify(reply.body)}`);
  assertEquals(reply.body.errors?.[0]?.extensions?.code, "DISABLED_CAPABILITY", label);
  assertStringIncludes(reply.body.errors?.[0]?.message ?? "", "cannot execute configuration commands", label);
}

const PERSISTENT = [
  "configure system set shared_buffers := '1GB'",
  "configure system reset shared_buffers",
  "configure database set query_execution_timeout := '30s'",
  "configure instance reset query_execution_timeout",
  "with x := 1 configure system set work_mem := '1GB'"
];

/*** /query ------------------------------------------- ***/

Deno.test("configure admin: an anonymous caller may not configure the system, database or instance", async () => {
  const { cleanup, port } = withTestServer(dryRunHandler());
  try {
    for (const text of PERSISTENT) {
      assertRefused(await query(port, text), text);
    }
  } finally {
    await cleanup();
  }
});

Deno.test("configure admin: a user without the admin or superuser role may not either", async () => {
  const { cleanup, port } = withTestServer(dryRunHandler());
  try {
    for (const token of ["user-token", "editor-token"]) {
      assertRefused(await query(port, PERSISTENT[0], token), token);
    }
  } finally {
    await cleanup();
  }
});

Deno.test("configure admin: the service token, an admin and a superuser may", async () => {
  const { cleanup, port } = withTestServer(dryRunHandler());
  try {
    for (const token of [SERVICE_TOKEN, "admin-token", "super-token"]) {
      const reply = await query(port, "configure system set shared_buffers := '1GB'", token);
      assertEquals(reply.status, 200, `${token}: ${JSON.stringify(reply.body)}`);
      assertStringIncludes(reply.body.extensions?.sql as string, "ALTER SYSTEM SET shared_buffers");
    }
  } finally {
    await cleanup();
  }
});

Deno.test("configure admin: a query an admin compiled (a cache hit) is still refused to anyone else", async () => {
  const { cleanup, port } = withTestServer(dryRunHandler());
  try {
    const text = "configure system set effective_io_concurrency := 4";
    assertEquals((await query(port, text, SERVICE_TOKEN)).status, 200);
    assertRefused(await query(port, text), "anonymous after the service");
    assertRefused(await query(port, text, "user-token"), "user after the service");
  } finally {
    await cleanup();
  }
});

Deno.test("configure admin: configure session stays open to everyone, for session-level keys", async () => {
  const { cleanup, port } = withTestServer(dryRunHandler());
  try {
    const reply = await query(port, "configure session set query_execution_timeout := '30s'");
    assertEquals(reply.status, 200, JSON.stringify(reply.body));
    assertStringIncludes(reply.body.extensions?.sql as string, "SET LOCAL statement_timeout = '30s'");

    const system = await query(port, "configure session set work_mem := '1GB'");
    assertEquals(system.status, 400);
    assertEquals(system.body.errors?.[0]?.extensions?.code, "CONFIGURATION_ERROR");
    assertStringIncludes(system.body.errors?.[0]?.message ?? "", "'work_mem' is a system-level configuration parameter");
  } finally {
    await cleanup();
  }
});

Deno.test("configure admin: an unknown or dangerous key is a ConfigurationError, even for the service", async () => {
  const { cleanup, port } = withTestServer(dryRunHandler());
  try {
    for (
      const [text, token] of [
        ["configure session set custom_setting := 1", undefined],
        ["configure session set session_replication_role := 'replica'", undefined],
        ["configure system set archive_command := 'curl evil'", SERVICE_TOKEN],
        ["configure system set ssl_key_file := '/tmp/k'", "admin-token"],
        ["configure database set password_encryption := 'md5'", "super-token"]
      ] as const
    ) {
      const reply = await query(port, text, token);
      assertEquals(reply.status, 400, text);
      assertEquals(reply.body.errors?.[0]?.extensions?.code, "CONFIGURATION_ERROR", text);
      assertStringIncludes(reply.body.errors?.[0]?.message ?? "", "unrecognized configuration parameter", text);
    }
  } finally {
    await cleanup();
  }
});

/*** WebSocket ----------------------------------------- ***/

Deno.test("configure admin: a WebSocket query may not configure the system (the socket is never an admin)", async () => {
  const { cleanup, port } = withTestServer(dryRunHandler());
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error("WebSocket failed to open"));
    });
    const reply = new Promise<{ payload: QueryResponse; type: string; }>(resolve => {
      socket.onmessage = event => resolve(JSON.parse(event.data));
    });
    socket.send(JSON.stringify({ payload: { query: PERSISTENT[0] }, type: "query" }));
    const message = await reply;
    assertEquals(message.type, "query_result");
    assertEquals(message.payload.errors?.[0]?.extensions?.code, "DISABLED_CAPABILITY");
  } finally {
    const closed = new Promise(resolve => {
      socket.onclose = resolve;
    });
    socket.close();
    await closed;
    await cleanup();
  }
});

/*** Binary executor ----------------------------------- ***/

Deno.test("configure admin: the binary executor refuses persistent configure unless the connection is an admin", async () => {
  const handler = new EdgeQLProtocolHandler({ schema: createTestSchema() });
  for (const text of PERSISTENT) {
    await assertRejects(() => handler.executeBinaryQuery(text, {}), DisabledCapabilityError, "cannot execute configuration commands");
    await assertRejects(
      () => handler.executeBinaryQuery(text, {}, { admin: false }),
      DisabledCapabilityError,
      "cannot execute configuration commands"
    );
  }
  // No pool: an admin's statement compiles and "runs" with no rows.
  const admin = await handler.executeBinaryQuery(PERSISTENT[0], {}, { admin: true });
  assertEquals(admin.rows, []);
  // Session configure needs no admin.
  const session = await handler.executeBinaryQuery("configure session set lock_timeout := '1s'", {});
  assertEquals(session.rows, []);
});

/*** POST /config -------------------------------------- ***/

function recordingConfigHandler(): { handler: ProtocolHandler; writes: string[]; } {
  const writes: string[] = [];
  return {
    handler: {
      handleRequest: () => Promise.resolve({ data: [] }),
      setConfigValue(pgName: string, value: string) {
        writes.push(`${pgName}=${value}`);
        return Promise.resolve({ pendingRestart: false, value });
      },
      validateRequest: () => []
    },
    writes
  };
}

Deno.test("configure admin: POST /config is refused to anyone but an administrator", async () => {
  const { handler, writes } = recordingConfigHandler();
  const { cleanup, port } = withTestServer(handler);
  try {
    for (const token of [undefined, "user-token", "editor-token"]) {
      const reply = await post(port, "/config", { name: "work_mem", value: "8MB" }, token);
      assertEquals(reply.status, 403, `${token}: ${JSON.stringify(reply.body)}`);
    }
    assertEquals(writes, []);

    for (const token of [SERVICE_TOKEN, "admin-token", "super-token"]) {
      const reply = await post(port, "/config", { name: "work_mem", value: "8MB" }, token);
      assertEquals(reply.status, 200, `${token}: ${JSON.stringify(reply.body)}`);
    }
    assertEquals(writes, ["work_mem=8MB", "work_mem=8MB", "work_mem=8MB"]);

    // The allowlist holds here too.
    const unknown = await post(port, "/config", { name: "archive_command", value: "x" }, SERVICE_TOKEN);
    assertEquals(unknown.status, 400);
    assert(writes.length === 3);
  } finally {
    await cleanup();
  }
});

Deno.test("configure admin: with requireAuth on, the service token reaches POST /config", async () => {
  const { handler, writes } = recordingConfigHandler();
  const { cleanup, port } = withTestServer(handler, { requireAuth: true });
  try {
    const reply = await post(port, "/config", { name: "lock_timeout", value: "1s" }, SERVICE_TOKEN);
    assertEquals(reply.status, 200, JSON.stringify(reply.body));
    assertEquals(writes, ["lock_timeout=1s"]);
  } finally {
    await cleanup();
  }
});

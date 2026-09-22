/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file
import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";

import { createClient, DiscClient } from "./client.ts";
import {
  DiscAuthError,
  DiscConnectionError,
  DiscProtocolError,
  DiscQueryError,
  DiscServerError,
  DiscTransactionError,
  SerializationFailureError,
  UniqueViolationError
} from "./errors.ts";

// --- Mock fetch helper ---

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ?
      input :
      input instanceof URL ?
      input.toString() :
      input.url;
    return Promise.resolve(handler(url, init));
  };
  return () => {
    globalThis.fetch = original;
  };
}

// --- Tests ---

Deno.test("client - createClient factory", () => {
  const client = createClient({ baseUrl: "http://example.com:1234" });
  assertInstanceOf(client, DiscClient);
  assertEquals(client.getBaseUrl(), "http://example.com:1234");
});

Deno.test("client - default config", () => {
  const client = new DiscClient();
  assertEquals(client.getBaseUrl(), "http://localhost:5656");
});

Deno.test("client - strips trailing slash from baseUrl", () => {
  const client = new DiscClient({ baseUrl: "http://localhost:5656/" });
  assertEquals(client.getBaseUrl(), "http://localhost:5656");
});

Deno.test("client - query returns data", async () => {
  const restore = mockFetch(_url => new Response(JSON.stringify({ data: [{ name: "Ada" }] })));
  try {
    const client = new DiscClient();
    const result = await client.query<{ name: string; }[]>(
      "select User { name }"
    );
    assertEquals(result, [{ name: "Ada" }]);
  } finally {
    restore();
  }
});

Deno.test("client - query passes variables", async () => {
  let capturedBody = "";
  const restore = mockFetch((_url, init) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ data: null }));
  });
  try {
    const client = new DiscClient();
    await client.query("select User filter .id = <uuid>$id", { id: "123" });
    const parsed = JSON.parse(capturedBody);
    assertEquals(parsed.variables.id, "123");
  } finally {
    restore();
  }
});

Deno.test("client - query serializes bigint variables as numeric strings", async () => {
  // Regression: int64 fields are typed `bigint` by codegen, and passing one
  // back as a variable used to throw "Do not know how to serialize a BigInt".
  let capturedBody = "";
  const restore = mockFetch((_url, init) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ data: null }));
  });
  try {
    const client = new DiscClient();
    await client.query("insert Counter { value := <int64>$value }", {
      value: BigInt(0),
      big: BigInt("9223372036854775807")
    });
    const parsed = JSON.parse(capturedBody);
    assertEquals(parsed.variables.value, "0");
    assertEquals(parsed.variables.big, "9223372036854775807");
  } finally {
    restore();
  }
});

Deno.test("client - query sends Uint8Array variables as base64, not as an index map", async () => {
  let capturedBody = "";
  const restore = mockFetch((_url, init) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ data: null }));
  });
  try {
    const client = new DiscClient();
    await client.query("insert GitObject { content := <bytes>$content, chunks := <array<bytes>>$chunks }", {
      chunks: [new Uint8Array([1, 2]), new Uint8Array(0)],
      content: new Uint8Array([0x1f, 0x8b, 0x00, 0xff])
    });
    assertEquals(capturedBody.includes("\"0\":"), false, capturedBody);
    assertEquals(JSON.parse(capturedBody).variables, { chunks: ["AQI=", ""], content: "H4sA/w==" });
  } finally {
    restore();
  }
});

Deno.test("client - query revives the bytes paths it is given", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ data: [{ content: "H4sA/w==", object_id: "H4sA" }] })));
  try {
    const client = new DiscClient();
    const rows = await client.query<Array<{ content: Uint8Array; object_id: string; }>>(
      "select GitObject { object_id, content }",
      undefined,
      { revive: { bytes: ["content"] } }
    );
    assertEquals(rows, [{ content: new Uint8Array([0x1f, 0x8b, 0x00, 0xff]), object_id: "H4sA" }]);
  } finally {
    restore();
  }
});

Deno.test("client - resolves baseUrl from disc.toml [server] port", () => {
  const tmp = Deno.makeTempDirSync();
  const cwd = Deno.cwd();
  try {
    Deno.writeTextFileSync(
      `${tmp}/disc.toml`,
      `name = "demo"\n[server]\nport = 7777\nhost = "0.0.0.0"\n`
    );
    Deno.chdir(tmp);
    const client = new DiscClient();
    assertEquals(client.getBaseUrl(), "http://0.0.0.0:7777");
  } finally {
    Deno.chdir(cwd);
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("client - explicit baseUrl overrides disc.toml", () => {
  const tmp = Deno.makeTempDirSync();
  const cwd = Deno.cwd();
  try {
    Deno.writeTextFileSync(
      `${tmp}/disc.toml`,
      `name = "demo"\n[server]\nport = 7777\n`
    );
    Deno.chdir(tmp);
    const client = new DiscClient({ baseUrl: "http://example.com:1234" });
    assertEquals(client.getBaseUrl(), "http://example.com:1234");
  } finally {
    Deno.chdir(cwd);
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("client - resolves baseUrl from DISC_SERVER_URL env", () => {
  Deno.env.set("DISC_SERVER_URL", "http://env-host:8888");
  try {
    const client = new DiscClient();
    assertEquals(client.getBaseUrl(), "http://env-host:8888");
  } finally {
    Deno.env.delete("DISC_SERVER_URL");
  }
});

Deno.test("client - DISC_SERVER_URL takes precedence over disc.toml", () => {
  const tmp = Deno.makeTempDirSync();
  const cwd = Deno.cwd();
  Deno.env.set("DISC_SERVER_URL", "http://env-host:8888");
  try {
    Deno.writeTextFileSync(`${tmp}/disc.toml`, `name = "demo"\n[server]\nport = 7777\n`);
    Deno.chdir(tmp);
    const client = new DiscClient();
    assertEquals(client.getBaseUrl(), "http://env-host:8888");
  } finally {
    Deno.env.delete("DISC_SERVER_URL");
    Deno.chdir(cwd);
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("client - explicit baseUrl overrides DISC_SERVER_URL", () => {
  Deno.env.set("DISC_SERVER_URL", "http://env-host:8888");
  try {
    const client = new DiscClient({ baseUrl: "http://explicit:1234" });
    assertEquals(client.getBaseUrl(), "http://explicit:1234");
  } finally {
    Deno.env.delete("DISC_SERVER_URL");
  }
});

Deno.test("client - warns via logger when disc.toml read fails", () => {
  // A non-NotFound read error (e.g. permission denied) should surface through
  // the logger instead of silently falling back to localhost.
  const original = Deno.readTextFileSync;
  Deno.env.delete("DISC_SERVER_URL");
  const warnings: string[] = [];
  (Deno as { readTextFileSync: typeof Deno.readTextFileSync; }).readTextFileSync = () => {
    throw new Deno.errors.PermissionDenied("denied");
  };
  try {
    const client = new DiscClient({
      logger: { warn: (message: string) => warnings.push(message) }
    });
    assertEquals(client.getBaseUrl(), "http://localhost:5656");
    assertEquals(warnings.length >= 1, true);
    assertEquals(warnings[0].includes("could not read"), true);
  } finally {
    (Deno as { readTextFileSync: typeof Deno.readTextFileSync; }).readTextFileSync = original;
  }
});

Deno.test("client - query throws DiscQueryError on server errors", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      errors: [{ message: "Unknown type 'Foo'" }]
    }))
  );
  try {
    const client = new DiscClient();
    await assertRejects(
      () => client.query("select Foo"),
      DiscQueryError,
      "Unknown type 'Foo'"
    );
  } finally {
    restore();
  }
});

Deno.test("client - queryRaw returns full envelope", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      data: [1, 2, 3],
      extensions: { parseMs: 1.5 }
    }))
  );
  try {
    const client = new DiscClient();
    const result = await client.queryRaw<number[]>("select {1, 2, 3}");
    assertEquals(result.data, [1, 2, 3]);
    assertEquals(result.extensions?.parseMs, 1.5);
  } finally {
    restore();
  }
});

Deno.test("client - queryRaw does not throw on errors", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      errors: [{ message: "Some error" }]
    }))
  );
  try {
    const client = new DiscClient();
    const result = await client.queryRaw("bad query");
    assertEquals(result.errors?.length, 1);
  } finally {
    restore();
  }
});

Deno.test("client - health endpoint", async () => {
  const restore = mockFetch(url => {
    if (url.endsWith("/health")) {
      return new Response(JSON.stringify({ status: "healthy" }));
    }
    return new Response("not found", { status: 404 });
  });
  try {
    const client = new DiscClient();
    const health = await client.health();
    assertEquals(health.status, "healthy");
  } finally {
    restore();
  }
});

Deno.test("client - isAlive returns true when server responds", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ status: "alive" })));
  try {
    const client = new DiscClient();
    assertEquals(await client.isAlive(), true);
  } finally {
    restore();
  }
});

Deno.test("client - isAlive returns false on error", async () => {
  const restore = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const client = new DiscClient();
    assertEquals(await client.isAlive(), false);
  } finally {
    restore();
  }
});

Deno.test("client - isReady returns true when server is ready", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ status: "healthy" })));
  try {
    const client = new DiscClient();
    assertEquals(await client.isReady(), true);
  } finally {
    restore();
  }
});

Deno.test("client - isReady returns false on 503", async () => {
  const restore = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const client = new DiscClient();
    assertEquals(await client.isReady(), false);
  } finally {
    restore();
  }
});

Deno.test("client - stats endpoint", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ uptimeMs: 12345 })));
  try {
    const client = new DiscClient();
    const stats = await client.stats();
    assertEquals(stats.uptimeMs, 12345);
  } finally {
    restore();
  }
});

Deno.test("client - setAuthToken adds Authorization header", async () => {
  let capturedHeaders: Headers | undefined;
  const restore = mockFetch((_url, init) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit);
    return new Response(JSON.stringify({ data: null }));
  });
  try {
    const client = new DiscClient();
    client.setAuthToken("my-jwt-token");
    await client.query("select 1");
    assertEquals(capturedHeaders?.get("Authorization"), "Bearer my-jwt-token");
  } finally {
    restore();
  }
});

Deno.test("client - clearAuthToken removes Authorization", async () => {
  let capturedHeaders: Headers | undefined;
  const restore = mockFetch((_url, init) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit);
    return new Response(JSON.stringify({ data: null }));
  });
  try {
    const client = new DiscClient();
    client.setAuthToken("token");
    client.clearAuthToken();
    await client.query("select 1");
    assertEquals(capturedHeaders?.get("Authorization"), null);
  } finally {
    restore();
  }
});

Deno.test("client - 401 throws DiscAuthError", async () => {
  const restore = mockFetch(() => new Response("Unauthorized", { status: 401 }));
  try {
    const client = new DiscClient();
    await assertRejects(
      () => client.query("select 1"),
      DiscAuthError
    );
  } finally {
    restore();
  }
});

Deno.test("client - 403 throws DiscAuthError", async () => {
  const restore = mockFetch(() => new Response("Forbidden", { status: 403 }));
  try {
    const client = new DiscClient();
    await assertRejects(
      () => client.query("select 1"),
      DiscAuthError
    );
  } finally {
    restore();
  }
});

Deno.test("client - 500 throws DiscServerError", async () => {
  const restore = mockFetch(() => new Response("Internal Server Error", { status: 500 }));
  try {
    const client = new DiscClient();
    await assertRejects(
      () => client.query("select 1"),
      DiscServerError
    );
  } finally {
    restore();
  }
});

Deno.test("client - network error throws DiscConnectionError", async () => {
  const restore = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const client = new DiscClient();
    await assertRejects(
      () => client.query("select 1"),
      DiscConnectionError
    );
  } finally {
    restore();
  }
});

Deno.test("client - retries on network error", async () => {
  let attempts = 0;
  const restore = mockFetch(() => {
    attempts++;
    if (attempts < 3) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify({ data: "ok" }));
  });
  try {
    const client = new DiscClient({ retries: 2, retryDelay: 10 });
    const result = await client.query("select 1");
    assertEquals(result, "ok");
    assertEquals(attempts, 3);
  } finally {
    restore();
  }
});

Deno.test("client - retries exhausted throws", async () => {
  const restore = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const client = new DiscClient({ retries: 1, retryDelay: 10 });
    await assertRejects(
      () => client.query("select 1"),
      DiscConnectionError
    );
  } finally {
    restore();
  }
});

Deno.test("client - custom headers are sent", async () => {
  let capturedHeaders: Headers | undefined;
  const restore = mockFetch((_url, init) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit);
    return new Response(JSON.stringify({ data: null }));
  });
  try {
    const client = new DiscClient({
      headers: { "X-Custom": "test-value" }
    });
    await client.query("select 1");
    assertEquals(capturedHeaders?.get("X-Custom"), "test-value");
  } finally {
    restore();
  }
});

Deno.test("client - transaction commits on success", async () => {
  const calls: string[] = [];
  const restore = mockFetch((url, _init) => {
    if (url.endsWith("/transaction/begin")) {
      calls.push("begin");
      return new Response(JSON.stringify({ transactionId: "tx-1" }));
    }
    if (url.includes("/commit")) {
      calls.push("commit");
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.endsWith("/query")) {
      calls.push("query");
      return new Response(JSON.stringify({ data: 42 }));
    }
    return new Response("not found", { status: 404 });
  });
  try {
    const client = new DiscClient();
    const result = await client.transaction(async tx => {
      return await tx.query<number>("select 42");
    });
    assertEquals(result, 42);
    assertEquals(calls, ["begin", "query", "commit"]);
  } finally {
    restore();
  }
});

Deno.test("client - transaction rolls back on error", async () => {
  const calls: string[] = [];
  const restore = mockFetch(url => {
    if (url.endsWith("/transaction/begin")) {
      calls.push("begin");
      return new Response(JSON.stringify({ transactionId: "tx-2" }));
    }
    if (url.includes("/rollback")) {
      calls.push("rollback");
      return new Response(JSON.stringify({ ok: true }));
    }
    if (url.endsWith("/query")) {
      calls.push("query");
      return new Response(JSON.stringify({
        errors: [{ message: "fail" }]
      }));
    }
    return new Response("not found", { status: 404 });
  });
  try {
    const client = new DiscClient();
    await assertRejects(
      () =>
        client.transaction(async tx => {
          return await tx.query("bad query");
        }),
      DiscQueryError
    );
    assertEquals(calls, ["begin", "query", "rollback"]);
  } finally {
    restore();
  }
});

// --- Transaction wire protocol (HTTP transaction routes) ---

Deno.test("client - transaction options travel in the begin body", async () => {
  let beginBody: string | undefined;
  const restore = mockFetch((url, init) => {
    if (url.endsWith("/transaction/begin")) {
      beginBody = init?.body as string | undefined;
      return new Response(JSON.stringify({ transactionId: "tx-3" }));
    }
    if (url.endsWith("/query")) {
      return new Response(JSON.stringify({ data: 1 }));
    }
    return new Response(JSON.stringify({ ok: true }));
  });

  try {
    const client = new DiscClient();
    await client.transaction(
      async tx => await tx.query<number>("select 1"),
      { isolationLevel: "serializable", readOnly: true }
    );

    assertEquals(
      JSON.parse(beginBody ?? "{}"),
      { isolationLevel: "serializable", readOnly: true }
    );
  } finally {
    restore();
  }
});

Deno.test("client - transaction without options sends no begin body", async () => {
  let beginBody: string | undefined | null = "unset";
  const restore = mockFetch((url, init) => {
    if (url.endsWith("/transaction/begin")) {
      beginBody = (init?.body as string | undefined) ?? null;
      return new Response(JSON.stringify({ transactionId: "tx-4" }));
    }
    if (url.endsWith("/query")) {
      return new Response(JSON.stringify({ data: 1 }));
    }
    return new Response(JSON.stringify({ ok: true }));
  });

  try {
    const client = new DiscClient();
    await client.transaction(async tx => await tx.query<number>("select 1"));
    assertEquals(beginBody, null);
  } finally {
    restore();
  }
});

Deno.test("client - commit sends the transaction id as a header, not in the URL", async () => {
  let commitUrl: string | undefined;
  let commitTxId: string | null = null;

  const restore = mockFetch((url, init) => {
    if (url.endsWith("/transaction/begin")) {
      return new Response(JSON.stringify({ transactionId: "tx-secret" }));
    }
    if (url.endsWith("/query")) {
      return new Response(JSON.stringify({ data: 1 }));
    }
    commitUrl = url;
    commitTxId = new Headers(init?.headers).get("X-Transaction-ID");
    return new Response(JSON.stringify({ ok: true }));
  });

  try {
    const client = new DiscClient();
    await client.transaction(async tx => await tx.query<number>("select 1"));

    assertEquals(commitUrl?.endsWith("/transaction/commit"), true);
    assertEquals(commitTxId, "tx-secret");
    // The id authorizes the transaction — keep it out of URLs, which end up
    // in access logs, proxy logs, and Referer headers.
    assertEquals(commitUrl?.includes("tx-secret"), false);
  } finally {
    restore();
  }
});

// --- Non-OK responses are failures (Phase 7: S3, S4, S11) ---

/** A scripted transaction server: begin, then whatever `routes` says per path suffix. */
function transactionServer(routes: Record<string, () => Response>): { calls: string[]; restore: () => void; } {
  const calls: string[] = [];
  const restore = mockFetch(url => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/transaction/begin") {
      return new Response(JSON.stringify({ transactionId: "tx-p7" }));
    }
    const route = routes[path];
    return route ? route() : new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
  });
  return { calls, restore };
}

const OK = () => new Response(JSON.stringify({ ok: true }));
const ROW = () => new Response(JSON.stringify({ data: [{ id: "r" }] }));

Deno.test("client - S3: a 413 { error } body rejects query() with DiscProtocolError instead of resolving undefined", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ error: "Request body too large (max 4194304 bytes)" }), { status: 413 }));
  try {
    const client = new DiscClient();
    const error = await assertRejects(() => client.query("insert GitObject { content := <bytes>$c }", { c: "AAAA" }), DiscProtocolError);
    assertEquals(error.statusCode, 413);
    assertEquals(error.message, "Request body too large (max 4194304 bytes)");
  } finally {
    restore();
  }
});

Deno.test("client - S3: a non-JSON 4xx body is a DiscProtocolError carrying the text", async () => {
  const restore = mockFetch(() => new Response("Too Many Requests", { status: 429 }));
  try {
    const client = new DiscClient();
    const error = await assertRejects(() => client.query("select 1"), DiscProtocolError);
    assertEquals(error.statusCode, 429);
    assertEquals(error.message, "Too Many Requests");
  } finally {
    restore();
  }
});

Deno.test("client - a 400 { errors } body with a SQLSTATE throws the typed query error", async () => {
  const restore = mockFetch(() =>
    new Response(
      JSON.stringify({
        errors: [{
          extensions: { code: "EXECUTION_ERROR", constraint: "uk_git_ref_program_id_name", sqlState: "23505", table: "git_ref" },
          message: "Database query failed: duplicate key value violates unique constraint \"uk_git_ref_program_id_name\""
        }]
      }),
      { status: 400 }
    )
  );
  try {
    const client = new DiscClient();
    const error = await assertRejects(() => client.query("insert GitRef { … }"), UniqueViolationError);
    assertInstanceOf(error, DiscQueryError);
    assertEquals(error.constraint, "uk_git_ref_program_id_name");
    assertEquals(error.sqlState, "23505");
  } finally {
    restore();
  }
});

Deno.test("client - a 200 envelope with errors also goes through the typed factory", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ errors: [{ extensions: { sqlState: "40001" }, message: "could not serialize access" }] })));
  try {
    const client = new DiscClient();
    await assertRejects(() => client.query("select 1"), SerializationFailureError);
  } finally {
    restore();
  }
});

Deno.test("client - S3: transaction() rejects when the commit is a 404 (the server no longer knows the transaction)", async () => {
  const { calls, restore } = transactionServer({
    "/query": ROW,
    "/transaction/commit": () => new Response(JSON.stringify({ error: "Unknown transaction: \"tx-p7\"" }), { status: 404 })
  });
  try {
    const client = new DiscClient();
    const error = await assertRejects(() => client.transaction(tx => tx.query("insert Program { name := 'x' }")), DiscProtocolError);
    assertEquals(error.statusCode, 404);
    assertEquals(calls, ["/transaction/begin", "/query", "/transaction/commit"]);
  } finally {
    restore();
  }
});

Deno.test("client - S3: a 409 TRANSACTION_ABORTED commit rejects transaction()", async () => {
  const { restore } = transactionServer({
    "/query": ROW,
    "/transaction/commit": () =>
      new Response(
        JSON.stringify({
          errors: [{ extensions: { code: "TRANSACTION_ABORTED" }, message: "Transaction tx-p7 was aborted by a failed statement and has been rolled back" }]
        }),
        {
          status: 409
        }
      )
  });
  try {
    const client = new DiscClient();
    const error = await assertRejects(() => client.transaction(tx => tx.query("select 1")), DiscQueryError);
    assertEquals(error.errors[0].extensions?.code, "TRANSACTION_ABORTED");
  } finally {
    restore();
  }
});

Deno.test("client - S4: a failed commit is sent once even with retries configured, and transaction() rejects", async () => {
  let commits = 0;
  const { calls, restore } = transactionServer({
    "/query": ROW,
    "/transaction/commit": () => {
      commits++;
      return new Response(JSON.stringify({ errors: [{ extensions: { code: "EXECUTION_ERROR", sqlState: "40001" }, message: "could not serialize access" }] }), {
        status: 500
      });
    }
  });
  try {
    const client = new DiscClient({ retries: 2, retryDelay: 1 });
    await assertRejects(() => client.transaction(tx => tx.query("select 1")), DiscServerError);
    assertEquals(commits, 1, "a COMMIT must never be re-sent: the first one may have succeeded");
    assertEquals(calls.filter(path => path === "/transaction/rollback"), [], "nothing to roll back after a commit was attempted");
  } finally {
    restore();
  }
});

Deno.test("client - S4: a query carrying X-Transaction-ID is not retried on a network error", async () => {
  let queries = 0;
  const restore = mockFetch((url, init) => {
    const path = new URL(url).pathname;
    if (path === "/transaction/begin") {
      return new Response(JSON.stringify({ transactionId: "tx-p7" }));
    }
    if (path === "/query" && new Headers(init?.headers).get("X-Transaction-ID")) {
      queries++;
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  try {
    const client = new DiscClient({ retries: 3, retryDelay: 1 });
    await assertRejects(() => client.transaction(tx => tx.query("insert Program { name := 'x' }")), DiscConnectionError);
    assertEquals(queries, 1);
  } finally {
    restore();
  }
});

Deno.test("client - S4: a plain query is still retried on a network error", async () => {
  let attempts = 0;
  const restore = mockFetch(() => {
    attempts++;
    if (attempts === 1) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify({ data: 1 }));
  });
  try {
    const client = new DiscClient({ retries: 1, retryDelay: 1 });
    assertEquals(await client.query("select 1"), 1);
    assertEquals(attempts, 2);
  } finally {
    restore();
  }
});

Deno.test("client - S11: a caught statement error still fails the transaction — rollback, never commit", async () => {
  const { calls, restore } = transactionServer({
    "/query": () => new Response(JSON.stringify({ errors: [{ extensions: { sqlState: "23505" }, message: "duplicate key" }] }), { status: 400 }),
    "/transaction/rollback": OK
  });
  try {
    const client = new DiscClient();
    let caught: unknown;
    const error = await assertRejects(
      () =>
        client.transaction(async tx => {
          try {
            await tx.query("insert Program { name := 'dup' }");
          } catch (e) {
            caught = e;
          }
          return "returned normally";
        }),
      DiscTransactionError
    );
    assertInstanceOf(caught, UniqueViolationError);
    assertEquals(error.cause, caught);
    assertEquals(calls, ["/transaction/begin", "/query", "/transaction/rollback"]);
  } finally {
    restore();
  }
});

// --- Derived clients (withToken / withHeaders) ---

Deno.test("client - withToken returns a derived client with its own credential and the parent's config", async () => {
  const seen: Array<{ auth: string | null; url: string; }> = [];
  const restore = mockFetch((url, init) => {
    seen.push({ auth: new Headers(init?.headers).get("Authorization"), url });
    return new Response(JSON.stringify({ data: [] }));
  });

  try {
    const parent = new DiscClient({ baseUrl: "http://example.com:1234", headers: { "X-App": "forge" } });
    parent.setAuthToken("parent-token");
    const service = parent.withToken("service-token");

    assertEquals(service.getBaseUrl(), "http://example.com:1234");
    assertEquals(service.getAuthToken(), "service-token");
    assertEquals(parent.getAuthToken(), "parent-token", "the parent keeps its own credential");

    await service.query("select 1");
    await parent.query("select 1");
    assertEquals(seen.map(s => s.auth), ["Bearer service-token", "Bearer parent-token"]);
    assertEquals(seen[0].url, "http://example.com:1234/query");
  } finally {
    restore();
  }
});

Deno.test("client - withHeaders returns a derived client that does not inherit the parent's token", async () => {
  const seen: Headers[] = [];
  const restore = mockFetch((_url, init) => {
    seen.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ data: [] }));
  });

  try {
    const parent = new DiscClient({ baseUrl: "http://example.com", headers: { "X-App": "forge" } });
    parent.setAuthToken("parent-token");
    const derived = parent.withHeaders({ "X-Request-Source": "worker" });

    await derived.query("select 1");
    assertEquals(seen[0].get("Authorization"), null, "credentials are not shared");
    assertEquals(seen[0].get("X-App"), "forge", "the parent's headers are kept");
    assertEquals(seen[0].get("X-Request-Source"), "worker");

    // An Authorization header given explicitly is a way to carry a bearer too.
    await parent.withHeaders({ Authorization: "Bearer explicit" }).query("select 1");
    assertEquals(seen[1].get("Authorization"), "Bearer explicit");

    // The parent is untouched.
    await parent.query("select 1");
    assertEquals(seen[2].get("Authorization"), "Bearer parent-token");
    assertEquals(seen[2].get("X-Request-Source"), null);
  } finally {
    restore();
  }
});

Deno.test("client - two derived clients in flight concurrently each send their own Authorization", async () => {
  const seen: Array<{ auth: string | null; query: string; }> = [];
  const restore = mockFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string; };
    // Reverse the completion order so the slow request cannot borrow the fast one's header.
    await new Promise(resolve => setTimeout(resolve, body.query === "slow" ? 20 : 1));
    seen.push({ auth: new Headers(init?.headers).get("Authorization"), query: body.query });
    return new Response(JSON.stringify({ data: body.query }));
  });

  try {
    const parent = new DiscClient({ baseUrl: "http://example.com" });
    const a = parent.withToken("token-a");
    const b = parent.withToken("token-b");
    const [fromA, fromB] = await Promise.all([a.query("slow"), b.query("fast")]);
    assertEquals([fromA, fromB], ["slow", "fast"]);
    assertEquals(seen.find(s => s.query === "slow")?.auth, "Bearer token-a");
    assertEquals(seen.find(s => s.query === "fast")?.auth, "Bearer token-b");
  } finally {
    restore();
  }
});

Deno.test("client - a Transaction inherits the credential of the client that created it", async () => {
  const seen: Array<{ auth: string | null; path: string; }> = [];
  const restore = mockFetch((url, init) => {
    seen.push({ auth: new Headers(init?.headers).get("Authorization"), path: new URL(url).pathname });
    if (url.endsWith("/transaction/begin")) {
      return new Response(JSON.stringify({ transactionId: "tx-derived" }));
    }
    if (url.endsWith("/query")) {
      return new Response(JSON.stringify({ data: 1 }));
    }
    return new Response(JSON.stringify({ ok: true }));
  });

  try {
    const parent = new DiscClient({ baseUrl: "http://example.com" });
    parent.setAuthToken("parent-token");
    const service = parent.withToken("service-token");

    await service.transaction(async tx => await tx.query("select 1"));

    assertEquals(seen.map(s => s.path), ["/transaction/begin", "/query", "/transaction/commit"]);
    assertEquals(seen.map(s => s.auth), ["Bearer service-token", "Bearer service-token", "Bearer service-token"]);
  } finally {
    restore();
  }
});

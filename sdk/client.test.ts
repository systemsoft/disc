/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file
import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";

import { createClient, DiscClient } from "./client.ts";
import {
  DiscAuthError,
  DiscConnectionError,
  DiscQueryError,
  DiscServerError
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

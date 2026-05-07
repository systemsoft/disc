// deno-lint-ignore-file
import {
  assertEquals,
  assertInstanceOf,
  assertRejects,} from "@std/assert";

import { createClient, DiscClient } from "./client.ts";
import {
  DiscAuthError,
  DiscConnectionError,
  DiscQueryError,
  DiscServerError,} from "./errors.ts";

// --- Mock fetch helper ---

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
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
  const restore = mockFetch((_url) =>
    new Response(JSON.stringify({ data: [{ name: "Ada" }] }))
  );
  try {
    const client = new DiscClient();
    const result = await client.query<{ name: string }[]>(
      "select User { name }",
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

Deno.test("client - query throws DiscQueryError on server errors", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      errors: [{ message: "Unknown type 'Foo'" }],
    }))
  );
  try {
    const client = new DiscClient();
    await assertRejects(
      () => client.query("select Foo"),
      DiscQueryError,
      "Unknown type 'Foo'",
    );
  } finally {
    restore();
  }
});

Deno.test("client - queryRaw returns full envelope", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      data: [1, 2, 3],
      extensions: { parseMs: 1.5 },
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
      errors: [{ message: "Some error" }],
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
  const restore = mockFetch((url) => {
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
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ status: "alive" }))
  );
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
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ status: "healthy" }))
  );
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
  const restore = mockFetch(() =>
    new Response(JSON.stringify({ uptimeMs: 12345 }))
  );
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
  const restore = mockFetch(() =>
    new Response("Unauthorized", { status: 401 })
  );
  try {
    const client = new DiscClient();
    await assertRejects(
      () => client.query("select 1"),
      DiscAuthError,
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
      DiscAuthError,
    );
  } finally {
    restore();
  }
});

Deno.test("client - 500 throws DiscServerError", async () => {
  const restore = mockFetch(() =>
    new Response("Internal Server Error", { status: 500 })
  );
  try {
    const client = new DiscClient();
    await assertRejects(
      () => client.query("select 1"),
      DiscServerError,
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
      DiscConnectionError,
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
      DiscConnectionError,
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
      headers: { "X-Custom": "test-value" },
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
    const result = await client.transaction(async (tx) => {
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
  const restore = mockFetch((url) => {
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
        errors: [{ message: "fail" }],
      }));
    }
    return new Response("not found", { status: 404 });
  });
  try {
    const client = new DiscClient();
    await assertRejects(
      () =>
        client.transaction(async (tx) => {
          return await tx.query("bad query");
        }),
      DiscQueryError,
    );
    assertEquals(calls, ["begin", "query", "rollback"]);
  } finally {
    restore();
  }
});

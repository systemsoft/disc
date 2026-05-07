import { assertEquals, assertRejects } from "@std/assert";

import { DiscClient } from "./client.ts";
import { DiscQueryError, DiscTransactionError } from "./errors.ts";
import { Transaction } from "./transaction.ts";

// --- Mock fetch helper ---

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url, init));
  };
  return () => {
    globalThis.fetch = original;
  };
}

// --- Helpers ---

function makeTransaction(id = "tx-123"): Transaction {
  const client = new DiscClient();
  return new Transaction(id, client);
}

// --- Tests ---

Deno.test("transaction - initial state is active", () => {
  const tx = makeTransaction();
  assertEquals(tx.getState(), "active");
});

Deno.test("transaction - getId returns the transaction ID", () => {
  const tx = makeTransaction("tx-abc");
  assertEquals(tx.getId(), "tx-abc");
});

Deno.test("transaction - query sends POST with X-Transaction-ID header", async () => {
  let capturedHeaders: Headers | undefined;
  const restore = mockFetch((_url, init) => {
    capturedHeaders = new Headers(init?.headers as HeadersInit);
    return new Response(JSON.stringify({ data: null }));
  });
  try {
    const tx = makeTransaction("tx-123");
    await tx.query("select 1");
    assertEquals(capturedHeaders?.get("X-Transaction-ID"), "tx-123");
  } finally {
    restore();
  }
});

Deno.test("transaction - query passes variables in request body", async () => {
  let capturedBody = "";
  const restore = mockFetch((_url, init) => {
    capturedBody = init?.body as string;
    return new Response(JSON.stringify({ data: null }));
  });
  try {
    const tx = makeTransaction();
    await tx.query("select User filter .id = <uuid>$id", { id: "abc-123" });
    const parsed = JSON.parse(capturedBody);
    assertEquals(parsed.variables.id, "abc-123");
  } finally {
    restore();
  }
});

Deno.test("transaction - query returns data on success", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ data: [{ name: "Ada" }] })));
  try {
    const tx = makeTransaction();
    const result = await tx.query<{ name: string }[]>("select User { name }");
    assertEquals(result, [{ name: "Ada" }]);
  } finally {
    restore();
  }
});

Deno.test("transaction - query throws DiscQueryError on server errors", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      errors: [{ message: "Unknown type 'Foo'" }],
    }))
  );
  try {
    const tx = makeTransaction();
    await assertRejects(
      () => tx.query("select Foo"),
      DiscQueryError,
      "Unknown type 'Foo'",
    );
  } finally {
    restore();
  }
});

Deno.test("transaction - commit sends POST to /transaction/{id}/commit", async () => {
  let capturedUrl = "";
  const restore = mockFetch((url, init) => {
    if ((init?.method ?? "GET") === "POST") {
      capturedUrl = url;
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  try {
    const tx = makeTransaction("tx-123");
    await tx.commit();
    assertEquals(
      capturedUrl,
      "http://localhost:5656/transaction/tx-123/commit",
    );
  } finally {
    restore();
  }
});

Deno.test("transaction - commit changes state to committed", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ ok: true })));
  try {
    const tx = makeTransaction();
    await tx.commit();
    assertEquals(tx.getState(), "committed");
  } finally {
    restore();
  }
});

Deno.test("transaction - rollback sends POST to /transaction/{id}/rollback", async () => {
  let capturedUrl = "";
  const restore = mockFetch((url, init) => {
    if ((init?.method ?? "GET") === "POST") {
      capturedUrl = url;
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  try {
    const tx = makeTransaction("tx-123");
    await tx.rollback();
    assertEquals(
      capturedUrl,
      "http://localhost:5656/transaction/tx-123/rollback",
    );
  } finally {
    restore();
  }
});

Deno.test("transaction - rollback changes state to rolled_back", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ ok: true })));
  try {
    const tx = makeTransaction();
    await tx.rollback();
    assertEquals(tx.getState(), "rolled_back");
  } finally {
    restore();
  }
});

Deno.test("transaction - query after commit throws DiscTransactionError", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ ok: true })));
  try {
    const tx = makeTransaction();
    await tx.commit();
    await assertRejects(
      () => tx.query("select 1"),
      DiscTransactionError,
      "Transaction is committed",
    );
  } finally {
    restore();
  }
});

Deno.test("transaction - query after rollback throws DiscTransactionError", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ ok: true })));
  try {
    const tx = makeTransaction();
    await tx.rollback();
    await assertRejects(
      () => tx.query("select 1"),
      DiscTransactionError,
      "Transaction is rolled_back",
    );
  } finally {
    restore();
  }
});

Deno.test("transaction - commit after commit throws DiscTransactionError", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ ok: true })));
  try {
    const tx = makeTransaction();
    await tx.commit();
    await assertRejects(
      () => tx.commit(),
      DiscTransactionError,
      "Transaction is committed",
    );
  } finally {
    restore();
  }
});

Deno.test("transaction - rollback after commit throws DiscTransactionError", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ ok: true })));
  try {
    const tx = makeTransaction();
    await tx.commit();
    await assertRejects(
      () => tx.rollback(),
      DiscTransactionError,
      "Transaction is committed",
    );
  } finally {
    restore();
  }
});

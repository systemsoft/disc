/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";

import { DiscClient } from "./client.ts";
import { DiscQueryError, DiscTransactionError } from "./errors.ts";
import { Transaction } from "./transaction.ts";

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
    const result = await tx.query<{ name: string; }[]>("select User { name }");
    assertEquals(result, [{ name: "Ada" }]);
  } finally {
    restore();
  }
});

Deno.test("transaction - query throws DiscQueryError on server errors", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      errors: [{ message: "Unknown type 'Foo'" }]
    }))
  );
  try {
    const tx = makeTransaction();
    await assertRejects(
      () => tx.query("select Foo"),
      DiscQueryError,
      "Unknown type 'Foo'"
    );
  } finally {
    restore();
  }
});

Deno.test("transaction - commit sends POST to /transaction/commit", async () => {
  let capturedUrl = "";
  let capturedTxId: string | null = null;
  const restore = mockFetch((url, init) => {
    if ((init?.method ?? "GET") === "POST") {
      capturedUrl = url;
      capturedTxId = new Headers(init?.headers).get("X-Transaction-ID");
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  try {
    const tx = makeTransaction("tx-123");
    await tx.commit();
    assertEquals(capturedUrl, "http://localhost:5656/transaction/commit");
    // The id travels in a header, not the path: it authorizes the
    // transaction, and URLs end up in access and proxy logs.
    assertEquals(capturedTxId, "tx-123");
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

Deno.test("transaction - rollback sends POST to /transaction/rollback", async () => {
  let capturedUrl = "";
  let capturedTxId: string | null = null;
  const restore = mockFetch((url, init) => {
    if ((init?.method ?? "GET") === "POST") {
      capturedUrl = url;
      capturedTxId = new Headers(init?.headers).get("X-Transaction-ID");
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  try {
    const tx = makeTransaction("tx-123");
    await tx.rollback();
    assertEquals(capturedUrl, "http://localhost:5656/transaction/rollback");
    // The id travels in a header, not the path: it authorizes the
    // transaction, and URLs end up in access and proxy logs.
    assertEquals(capturedTxId, "tx-123");
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
      "Transaction is committed"
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
      "Transaction is rolled_back"
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
      "Transaction is committed"
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
      "Transaction is committed"
    );
  } finally {
    restore();
  }
});

// --- A failed statement poisons the transaction (Phase 7, S11) ---

/** Every `/query` fails as PostgreSQL would report a duplicate key; `/transaction/*` succeeds. */
function failingStatementServer(): { calls: string[]; restore: () => void; } {
  const calls: string[] = [];
  const restore = mockFetch(url => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/query") {
      return new Response(
        JSON.stringify({ errors: [{ extensions: { code: "EXECUTION_ERROR", sqlState: "23505" }, message: "duplicate key" }] }),
        { status: 400 }
      );
    }
    return new Response(JSON.stringify({ ok: true }));
  });
  return { calls, restore };
}

Deno.test("transaction - a query that fails on the server marks the transaction failed", async () => {
  const { restore } = failingStatementServer();
  try {
    const tx = makeTransaction();
    await assertRejects(() => tx.query("insert Program { name := 'dup' }"), DiscQueryError);
    assertEquals(tx.getState(), "failed");
  } finally {
    restore();
  }
});

Deno.test("transaction - commit on a failed transaction throws DiscTransactionError without contacting the server", async () => {
  const { calls, restore } = failingStatementServer();
  try {
    const tx = makeTransaction();
    await assertRejects(() => tx.query("insert Program { name := 'dup' }"), DiscQueryError);
    const error = await assertRejects(() => tx.commit(), DiscTransactionError, "Transaction is failed");
    assertInstanceOf(error.cause, DiscQueryError);
    assertEquals(calls, ["/query"]);
    assertEquals(tx.getState(), "failed");
  } finally {
    restore();
  }
});

Deno.test("transaction - a further query on a failed transaction is refused, as PostgreSQL would", async () => {
  const { calls, restore } = failingStatementServer();
  try {
    const tx = makeTransaction();
    await assertRejects(() => tx.query("insert Program { name := 'dup' }"), DiscQueryError);
    await assertRejects(() => tx.query("select 1"), DiscTransactionError, "Transaction is failed");
    assertEquals(calls, ["/query"]);
  } finally {
    restore();
  }
});

Deno.test("transaction - rollback is still allowed on a failed transaction", async () => {
  const { calls, restore } = failingStatementServer();
  try {
    const tx = makeTransaction();
    await assertRejects(() => tx.query("insert Program { name := 'dup' }"), DiscQueryError);
    await tx.rollback();
    assertEquals(tx.getState(), "rolled_back");
    assertEquals(calls, ["/query", "/transaction/rollback"]);
  } finally {
    restore();
  }
});

Deno.test("transaction - a network failure while a statement is in flight also fails the transaction (outcome unknown)", async () => {
  const restore = mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  try {
    const tx = makeTransaction();
    await assertRejects(() => tx.query("insert Program { name := 'x' }"));
    assertEquals(tx.getState(), "failed");
  } finally {
    restore();
  }
});

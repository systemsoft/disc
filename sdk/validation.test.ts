// deno-lint-ignore-file
import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";

import { DiscClient } from "./client.ts";
import { DiscValidationError } from "./errors.ts";
import type { StandardSchemaV1 } from "./types.ts";
import { applyValidator } from "./validation.ts";

// --- Mock fetch helper ---

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return Promise.resolve(handler(url, init));
  };
  return () => {
    globalThis.fetch = original;
  };
}

// --- Standard Schema fixtures (vendor-agnostic, hand-rolled) ---

interface User {
  name: string;
  age: number;
}

const userSchema: StandardSchemaV1<User> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate(value) {
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { name?: unknown; }).name === "string" &&
        typeof (value as { age?: unknown; }).age === "number"
      ) {
        return { value: value as User };
      }
      return {
        issues: [
          { message: "expected { name: string, age: number }", path: [] }
        ]
      };
    }
  }
};

const asyncUserSchema: StandardSchemaV1<User> = {
  "~standard": {
    version: 1,
    vendor: "test-async",
    async validate(value) {
      await Promise.resolve();
      return userSchema["~standard"].validate(value);
    }
  }
};

// --- applyValidator unit tests ---

Deno.test("applyValidator - function returns value", async () => {
  const result = await applyValidator(
    (v: unknown) => v as { ok: true; },
    { ok: true }
  );
  assertEquals(result.ok, true);
});

Deno.test("applyValidator - function throw becomes DiscValidationError", async () => {
  await assertRejects(
    () =>
      applyValidator(() => {
        throw new Error("nope");
      }, {}),
    DiscValidationError,
    "nope"
  );
});

Deno.test("applyValidator - schema success", async () => {
  const u = await applyValidator(userSchema, { name: "Ada", age: 36 });
  assertEquals(u.name, "Ada");
  assertEquals(u.age, 36);
});

Deno.test("applyValidator - schema failure preserves issues", async () => {
  try {
    await applyValidator(userSchema, { name: "Ada" });
    throw new Error("should have thrown");
  } catch (error) {
    assertInstanceOf(error, DiscValidationError);
    assertEquals(error.issues.length, 1);
    assertEquals(error.issues[0].message, "expected { name: string, age: number }");
  }
});

Deno.test("applyValidator - async schema is awaited", async () => {
  const u = await applyValidator(asyncUserSchema, { name: "Lin", age: 28 });
  assertEquals(u.name, "Lin");
});

Deno.test("applyValidator - schema throw becomes DiscValidationError", async () => {
  const throwing: StandardSchemaV1<unknown> = {
    "~standard": {
      version: 1,
      vendor: "broken",
      validate() {
        throw new Error("schema crashed");
      }
    }
  };
  await assertRejects(
    () => applyValidator(throwing, {}),
    DiscValidationError,
    "schema crashed"
  );
});

// --- client.query<T>() integration ---

Deno.test("client.query - validate function transforms data", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ data: { name: "Ada", age: 36 } })));
  try {
    const client = new DiscClient();
    const u = await client.query(
      "select User { name, age } limit 1",
      undefined,
      {
        validate: v => {
          const r = v as { name: string; age: number; };
          return { ...r, name: r.name.toUpperCase() };
        }
      }
    );
    assertEquals(u.name, "ADA");
  } finally {
    restore();
  }
});

Deno.test("client.query - validate schema rejects mismatched response", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ data: { name: "Ada" } })));
  try {
    const client = new DiscClient();
    await assertRejects(
      () =>
        client.query("select User { name } limit 1", undefined, {
          validate: userSchema
        }),
      DiscValidationError
    );
  } finally {
    restore();
  }
});

Deno.test("client.query - validate not run on query errors", async () => {
  let validatorCalled = false;
  const restore = mockFetch(() => new Response(JSON.stringify({ errors: [{ message: "boom" }] })));
  try {
    const client = new DiscClient();
    await assertRejects(() =>
      client.query("bad", undefined, {
        validate: v => {
          validatorCalled = true;
          return v;
        }
      })
    );
    assertEquals(validatorCalled, false);
  } finally {
    restore();
  }
});

Deno.test("client.query - omitted validator preserves cast behavior", async () => {
  const restore = mockFetch(() => new Response(JSON.stringify({ data: { whatever: true } })));
  try {
    const client = new DiscClient();
    // Intentionally lying about the response shape; cast must succeed.
    const u = await client.query<{ name: string; }>(
      "select User { name }"
    );
    assertEquals((u as unknown as { whatever: boolean; }).whatever, true);
  } finally {
    restore();
  }
});

// --- revive option (P1-29) ---

Deno.test("client.query - revive: true converts ISO datetime to Date", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      data: { created_at: "2026-05-05T12:00:00Z", name: "Ada" }
    }))
  );
  try {
    const client = new DiscClient();
    const u = await client.query<{ created_at: Date; name: string; }>(
      "select User { created_at, name }",
      undefined,
      { revive: true }
    );
    assertInstanceOf(u.created_at, Date);
    assertEquals(u.created_at.toISOString(), "2026-05-05T12:00:00.000Z");
    assertEquals(u.name, "Ada");
  } finally {
    restore();
  }
});

Deno.test("client.query - revive runs before validator (validator sees Date)", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      data: { created_at: "2026-05-05T12:00:00Z" }
    }))
  );
  try {
    const client = new DiscClient();
    const out = await client.query<{ created_at: Date; }>(
      "select User { created_at }",
      undefined,
      {
        revive: true,
        validate: (v: unknown) => {
          const obj = v as { created_at: unknown; };
          if (!(obj.created_at instanceof Date)) {
            throw new Error("validator did not see Date");
          }
          return v as { created_at: Date; };
        }
      }
    );
    assertInstanceOf(out.created_at, Date);
  } finally {
    restore();
  }
});

Deno.test("client.query - omitted revive leaves strings alone", async () => {
  const restore = mockFetch(() =>
    new Response(JSON.stringify({
      data: { created_at: "2026-05-05T12:00:00Z" }
    }))
  );
  try {
    const client = new DiscClient();
    const u = await client.query<{ created_at: string; }>(
      "select User { created_at }"
    );
    assertEquals(typeof u.created_at, "string");
  } finally {
    restore();
  }
});

// --- transaction.query<T>() integration ---

Deno.test("transaction.query - validator runs and rejects", async () => {
  const restore = mockFetch(url => {
    if (url.endsWith("/transaction/begin")) {
      return new Response(JSON.stringify({ transactionId: "tx-v" }));
    }
    if (url.endsWith("/query")) {
      return new Response(JSON.stringify({ data: { name: "Ada" } }));
    }
    if (url.includes("/rollback")) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response("nf", { status: 404 });
  });
  try {
    const client = new DiscClient();
    await assertRejects(
      () =>
        client.transaction(tx =>
          tx.query("select User { name }", undefined, {
            validate: userSchema
          })
        ),
      DiscValidationError
    );
  } finally {
    restore();
  }
});

Deno.test("transaction.query - validator success", async () => {
  const restore = mockFetch(url => {
    if (url.endsWith("/transaction/begin")) {
      return new Response(JSON.stringify({ transactionId: "tx-v2" }));
    }
    if (url.endsWith("/query")) {
      return new Response(
        JSON.stringify({ data: { name: "Ada", age: 36 } })
      );
    }
    if (url.includes("/commit")) {
      return new Response(JSON.stringify({ ok: true }));
    }
    return new Response("nf", { status: 404 });
  });
  try {
    const client = new DiscClient();
    const u = await client.transaction(tx =>
      tx.query("select User { name, age }", undefined, {
        validate: userSchema
      })
    );
    assertEquals(u.name, "Ada");
  } finally {
    restore();
  }
});

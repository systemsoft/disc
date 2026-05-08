/**
 * Tests for the auth lifecycle webhook dispatcher and integration
 * with `AuthProvider`.
 * Ports geldata/gel#7813 (gh/geldata#7484).
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";
import { type WebhookConfig, WebhookSender } from "./webhooks.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function makeCapture(): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl = ((
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    } else if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : ""
    });
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ── WebhookSender unit tests ───────────────────────────────────────────

Deno.test("WebhookSender - dispatches to matching subscription only", async () => {
  const { fetchImpl, calls } = makeCapture();
  const subs: WebhookConfig[] = [
    { url: "http://x/identity", events: ["IdentityCreated"] },
    { url: "http://x/login", events: ["IdentityAuthenticated"] }
  ];
  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventType: "IdentityCreated",
    eventId: "e1",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u1"
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "http://x/identity");
  assertEquals(calls[0].method, "POST");
  assertEquals(calls[0].headers["content-type"], "application/json");
  const body = JSON.parse(calls[0].body);
  assertEquals(body.eventType, "IdentityCreated");
  assertEquals(body.identityId, "u1");
});

Deno.test("WebhookSender - dispatches to multiple subscriptions of same event", async () => {
  const { fetchImpl, calls } = makeCapture();
  const subs: WebhookConfig[] = [
    { url: "http://a/", events: ["IdentityCreated"] },
    { url: "http://b/", events: ["IdentityCreated", "IdentityAuthenticated"] }
  ];
  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventType: "IdentityCreated",
    eventId: "e1",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u1"
  });

  assertEquals(calls.length, 2);
  const urls = calls.map(c => c.url).sort();
  assertEquals(urls, ["http://a/", "http://b/"]);
});

Deno.test("WebhookSender - skips dispatch when no subscriptions match", async () => {
  const { fetchImpl, calls } = makeCapture();
  const subs: WebhookConfig[] = [
    { url: "http://x/", events: ["IdentityAuthenticated"] }
  ];
  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventType: "IdentityCreated",
    eventId: "e1",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u1"
  });

  assertEquals(calls.length, 0);
});

Deno.test("WebhookSender - signs body with HMAC-SHA256 hex when secret is set", async () => {
  const { fetchImpl, calls } = makeCapture();
  const subs: WebhookConfig[] = [
    {
      url: "http://x/",
      events: ["IdentityCreated"],
      secret: "shared-webhook-secret"
    }
  ];
  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventType: "IdentityCreated",
    eventId: "fixed-event-id",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u-fixed"
  });

  assertEquals(calls.length, 1);
  const sig = calls[0].headers["x-disc-auth-signature-sha256"];
  assertExists(sig);
  // 64 hex chars = 32 bytes of SHA-256 output.
  assertEquals(sig.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(sig), true);

  // Verify by recomputing.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("shared-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedSig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(calls[0].body)
  );
  const expected = [...new Uint8Array(expectedSig)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  assertEquals(sig, expected);
});

Deno.test("WebhookSender - omits signature header when no secret configured", async () => {
  const { fetchImpl, calls } = makeCapture();
  const subs: WebhookConfig[] = [
    { url: "http://x/", events: ["IdentityCreated"] }
  ];
  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventType: "IdentityCreated",
    eventId: "e1",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u1"
  });

  assertEquals(calls[0].headers["x-disc-auth-signature-sha256"], undefined);
});

Deno.test("WebhookSender - swallows fetch failures so caller is unaffected", async () => {
  const failing: typeof fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
  const sender = new WebhookSender([
    { url: "http://x/", events: ["IdentityCreated"] }
  ], { fetchImpl: failing, synchronous: true });

  // Must not throw. (Logged at warn level by the sender.)
  await sender.dispatch({
    eventType: "IdentityCreated",
    eventId: "e1",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u1"
  });
});

Deno.test("WebhookSender - addListener invokes listener on dispatch (synchronous)", async () => {
  const { fetchImpl } = makeCapture();
  const sender = new WebhookSender([], { fetchImpl, synchronous: true });

  const seen: string[] = [];
  sender.addListener(event => {
    seen.push(event.eventType);
    return Promise.resolve();
  });

  await sender.dispatch({
    eventType: "IdentityCreated",
    eventId: "e1",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u1"
  });

  assertEquals(seen, ["IdentityCreated"]);
});

Deno.test("WebhookSender - addListener receives every event regardless of WebhookConfig filters", async () => {
  const { fetchImpl } = makeCapture();
  const sender = new WebhookSender(
    [{ url: "http://x/", events: ["IdentityCreated"] }], // listener should see more than this filter
    { fetchImpl, synchronous: true }
  );

  const seen: string[] = [];
  sender.addListener(event => {
    seen.push(event.eventType);
    return Promise.resolve();
  });

  await sender.dispatch({
    eventType: "IdentityCreated",
    eventId: "e1",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u1"
  });
  await sender.dispatch({
    eventType: "IdentityAuthenticated",
    eventId: "e2",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u1"
  });

  assertEquals(seen.sort(), ["IdentityAuthenticated", "IdentityCreated"]);
});

Deno.test("WebhookSender - listener errors don't break HTTP webhook dispatch", async () => {
  const { fetchImpl, calls } = makeCapture();
  const sender = new WebhookSender(
    [{ url: "http://x/", events: ["IdentityCreated"] }],
    { fetchImpl, synchronous: true }
  );

  sender.addListener(() => {
    throw new Error("listener boom");
  });

  // Must not throw — listener errors are caught by the sender.
  await sender.dispatch({
    eventType: "IdentityCreated",
    eventId: "e1",
    timestamp: "2026-01-01T00:00:00.000Z",
    identityId: "u1"
  });

  // HTTP fan-out still happened.
  assertEquals(calls.length, 1);
});

// ── AuthProvider integration tests ─────────────────────────────────────

async function makeProvider(
  webhooks: WebhookConfig[],
  fetchImpl: typeof fetch
): Promise<{ provider: AuthProvider; db: TestDatabase; }> {
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      webhooks
    },
    db,
    { fetchImpl, synchronous: true }
  );
  await provider.initialize();
  return { provider, db };
}

Deno.test("AuthProvider - register fires IdentityCreated webhook", async () => {
  const { fetchImpl, calls } = makeCapture();
  const { provider, db } = await makeProvider(
    [{ url: "http://x/", events: ["IdentityCreated"] }],
    fetchImpl
  );

  try {
    await provider.register({
      email: "alice@test.com",
      password: "password123"
    });

    assertEquals(calls.length, 1);
    const body = JSON.parse(calls[0].body);
    assertEquals(body.eventType, "IdentityCreated");
    assertExists(body.identityId);
    assertExists(body.eventId);
    assertExists(body.timestamp);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - register with email verification also fires EmailVerificationRequested", async () => {
  const { fetchImpl, calls } = makeCapture();
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: true,
      webhooks: [{
        url: "http://x/",
        events: ["IdentityCreated", "EmailVerificationRequested"]
      }]
    },
    db,
    { fetchImpl, synchronous: true }
  );
  await provider.initialize();

  try {
    await provider.register({
      email: "bob@test.com",
      password: "password123"
    });

    assertEquals(calls.length, 2);
    const types = calls.map(c => JSON.parse(c.body).eventType).sort();
    assertEquals(types, ["EmailVerificationRequested", "IdentityCreated"]);

    const verifyCall = calls.find(c => JSON.parse(c.body).eventType === "EmailVerificationRequested");
    assertExists(verifyCall);
    const verifyBody = JSON.parse(verifyCall.body);
    assertExists(verifyBody.verificationToken);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - login fires IdentityAuthenticated webhook", async () => {
  const { fetchImpl, calls } = makeCapture();
  const { provider, db } = await makeProvider(
    [{
      url: "http://x/",
      events: ["IdentityCreated", "IdentityAuthenticated"]
    }],
    fetchImpl
  );

  try {
    await provider.register({
      email: "carol@test.com",
      password: "password123"
    });
    calls.length = 0; // discard register webhook

    await provider.login({
      email: "carol@test.com",
      password: "password123"
    });

    assertEquals(calls.length, 1);
    assertEquals(JSON.parse(calls[0].body).eventType, "IdentityAuthenticated");
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - failed login does not fire any webhook", async () => {
  const { fetchImpl, calls } = makeCapture();
  const { provider, db } = await makeProvider(
    [{
      url: "http://x/",
      events: ["IdentityCreated", "IdentityAuthenticated"]
    }],
    fetchImpl
  );

  try {
    await provider.register({
      email: "dave@test.com",
      password: "password123"
    });
    calls.length = 0;

    try {
      await provider.login({
        email: "dave@test.com",
        password: "wrong"
      });
    } catch {
      // expected
    }

    assertEquals(calls.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - resetPasswordRequest fires PasswordResetRequested webhook with token", async () => {
  const { fetchImpl, calls } = makeCapture();
  const { provider, db } = await makeProvider(
    [{
      url: "http://x/",
      events: ["IdentityCreated", "PasswordResetRequested"]
    }],
    fetchImpl
  );

  try {
    await provider.register({
      email: "eve@test.com",
      password: "password123"
    });
    calls.length = 0;

    const resetToken = await provider.resetPasswordRequest("eve@test.com");
    assertExists(resetToken);

    assertEquals(calls.length, 1);
    const body = JSON.parse(calls[0].body);
    assertEquals(body.eventType, "PasswordResetRequested");
    assertEquals(body.resetToken, resetToken);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - resetPasswordRequest for unknown email fires no webhook", async () => {
  const { fetchImpl, calls } = makeCapture();
  const { provider, db } = await makeProvider(
    [{ url: "http://x/", events: ["PasswordResetRequested"] }],
    fetchImpl
  );

  try {
    await provider.resetPasswordRequest("noone@test.com");
    assertEquals(calls.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - requestMagicCode fires MagicCodeRequested webhook with code", async () => {
  const { fetchImpl, calls } = makeCapture();
  const { provider, db } = await makeProvider(
    [{
      url: "http://x/",
      events: ["IdentityCreated", "MagicCodeRequested"]
    }],
    fetchImpl
  );

  try {
    await provider.register({
      email: "grace@test.com",
      password: "password123"
    });
    calls.length = 0;

    const code = await provider.requestMagicCode("grace@test.com");
    assertExists(code);

    assertEquals(calls.length, 1);
    const body = JSON.parse(calls[0].body);
    assertEquals(body.eventType, "MagicCodeRequested");
    assertEquals(body.magicCode, code);
    assertExists(body.identityId);
    assertExists(body.eventId);
    assertExists(body.timestamp);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - requestMagicCode for unknown email fires no webhook", async () => {
  const { fetchImpl, calls } = makeCapture();
  const { provider, db } = await makeProvider(
    [{ url: "http://x/", events: ["MagicCodeRequested"] }],
    fetchImpl
  );

  try {
    await provider.requestMagicCode("ghost@test.com");
    assertEquals(calls.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - no webhooks configured = no dispatch attempts", async () => {
  const { fetchImpl, calls } = makeCapture();
  const { provider, db } = await makeProvider([], fetchImpl);

  try {
    await provider.register({
      email: "frank@test.com",
      password: "password123"
    });
    assertEquals(calls.length, 0);
  } finally {
    await db.close();
  }
});

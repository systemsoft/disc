/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the auth lifecycle webhook dispatcher and integration
 * with `AuthProvider`.
 * Ports geldata/gel#7813 (gh/geldata#7484).
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertExists } from "@std/assert";

/*** UTILITY ------------------------------------------ ***/

import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";
import { WebhookSender, type WebhookConfig } from "./webhooks.ts";

interface CapturedRequest {
  body: string;
  headers: Record<string, string>;
  method: string;
  url: string;
}

/*** RUNTIME ------------------------------------------ ***/

/*** --- WebhookSender unit tests --- ***/

Deno.test("WebhookSender - dispatches to matching subscription only", async () => {
  const { calls, fetchImpl } = makeCapture();

  const subs: WebhookConfig[] = [
    { events: ["IdentityCreated"], url: "http://x/identity" },
    { events: ["IdentityAuthenticated"], url: "http://x/login" }
  ];

  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventId: "e1",
    eventType: "IdentityCreated",
    identityId: "u1",
    timestamp: "2026-01-01T00:00:00.000Z"
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
  const { calls, fetchImpl } = makeCapture();

  const subs: WebhookConfig[] = [
    { events: ["IdentityCreated"], url: "http://a/" },
    { events: ["IdentityCreated", "IdentityAuthenticated"], url: "http://b/" }
  ];

  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventId: "e1",
    eventType: "IdentityCreated",
    identityId: "u1",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  assertEquals(calls.length, 2);
  const urls = calls.map(c => c.url).sort();
  assertEquals(urls, ["http://a/", "http://b/"]);
});

Deno.test("WebhookSender - skips dispatch when no subscriptions match", async () => {
  const { calls, fetchImpl } = makeCapture();

  const subs: WebhookConfig[] = [{ events: ["IdentityAuthenticated"], url: "http://x/" }];
  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventId: "e1",
    eventType: "IdentityCreated",
    identityId: "u1",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  assertEquals(calls.length, 0);
});

Deno.test("WebhookSender - signs body with HMAC-SHA256 hex when secret is set", async () => {
  const { calls, fetchImpl } = makeCapture();

  const subs: WebhookConfig[] = [
    {
      events: ["IdentityCreated"],
      secret: "shared-webhook-secret",
      url: "http://x/"
    }
  ];

  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventId: "fixed-event-id",
    eventType: "IdentityCreated",
    identityId: "u-fixed",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  assertEquals(calls.length, 1);
  const sig = calls[0].headers["x-disc-auth-signature-sha256"];
  assertExists(sig);
  /*** 64 hex chars = 32 bytes of SHA-256 output. ***/
  assertEquals(sig.length, 64);
  assertEquals(/^[0-9a-f]+$/.test(sig), true);

  /*** Verify by recomputing. ***/
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("shared-webhook-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expectedSig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(calls[0].body));

  const expected = [...new Uint8Array(expectedSig)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  assertEquals(sig, expected);
});

Deno.test("WebhookSender - omits signature header when no secret configured", async () => {
  const { calls, fetchImpl } = makeCapture();
  const subs: WebhookConfig[] = [{ events: ["IdentityCreated"], url: "http://x/" }];
  const sender = new WebhookSender(subs, { fetchImpl, synchronous: true });

  await sender.dispatch({
    eventId: "e1",
    eventType: "IdentityCreated",
    identityId: "u1",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  assertEquals(calls[0].headers["x-disc-auth-signature-sha256"], undefined);
});

Deno.test("WebhookSender - swallows fetch failures so caller is unaffected", async () => {
  const failing: typeof fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
  const sender = new WebhookSender([{ events: ["IdentityCreated"], url: "http://x/" }], { fetchImpl: failing, synchronous: true });

  /*** Must not throw. (Logged at warn level by the sender.) ***/
  await sender.dispatch({
    eventId: "e1",
    eventType: "IdentityCreated",
    identityId: "u1",
    timestamp: "2026-01-01T00:00:00.000Z"
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
    eventId: "e1",
    eventType: "IdentityCreated",
    identityId: "u1",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  assertEquals(seen, ["IdentityCreated"]);
});

Deno.test("WebhookSender - addListener receives every event regardless of WebhookConfig filters", async () => {
  const { fetchImpl } = makeCapture();

  const sender = new WebhookSender(
    [{ events: ["IdentityCreated"], url: "http://x/" }], /*** listener should see more than this filter ***/
    { fetchImpl, synchronous: true }
  );

  const seen: string[] = [];

  sender.addListener(event => {
    seen.push(event.eventType);
    return Promise.resolve();
  });

  await sender.dispatch({
    eventId: "e1",
    eventType: "IdentityCreated",
    identityId: "u1",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  await sender.dispatch({
    eventId: "e2",
    eventType: "IdentityAuthenticated",
    identityId: "u1",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  assertEquals(seen.sort(), ["IdentityAuthenticated", "IdentityCreated"]);
});

Deno.test("WebhookSender - listener errors don’t break HTTP webhook dispatch", async () => {
  const { calls, fetchImpl } = makeCapture();

  const sender = new WebhookSender(
    [{ events: ["IdentityCreated"], url: "http://x/" }],
    { fetchImpl, synchronous: true }
  );

  sender.addListener(() => {
    throw new Error("listener boom");
  });

  /*** Must not throw — listener errors are caught by the sender. ***/
  await sender.dispatch({
    eventId: "e1",
    eventType: "IdentityCreated",
    identityId: "u1",
    timestamp: "2026-01-01T00:00:00.000Z"
  });

  /*** HTTP fan-out still happened. ***/
  assertEquals(calls.length, 1);
});

/*** --- AuthProvider integration tests --- ***/

Deno.test("AuthProvider - register fires IdentityCreated webhook", async () => {
  const { calls, fetchImpl } = makeCapture();
  const { db, provider } = await makeProvider([{ events: ["IdentityCreated"], url: "http://x/" }], fetchImpl);

  try {
    await provider.register({ email: "alice@test.com", password: "password123" });
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
  const { calls, fetchImpl } = makeCapture();
  const db = new TestDatabase();
  await db.connect();

  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: true,
      webhooks: [{
        events: ["IdentityCreated", "EmailVerificationRequested"],
        url: "http://x/"
      }]
    },
    db,
    { fetchImpl, synchronous: true }
  );

  await provider.initialize();

  try {
    await provider.register({ email: "bob@test.com", password: "password123" });
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
  const { calls, fetchImpl } = makeCapture();
  const { db, provider } = await makeProvider([{ events: ["IdentityCreated", "IdentityAuthenticated"], url: "http://x/" }], fetchImpl);

  try {
    await provider.register({ email: "carol@test.com", password: "password123" });
    calls.length = 0; /*** discard register webhook ***/
    await provider.login({ email: "carol@test.com", password: "password123" });

    assertEquals(calls.length, 1);
    assertEquals(JSON.parse(calls[0].body).eventType, "IdentityAuthenticated");
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - failed login does not fire any webhook", async () => {
  const { calls, fetchImpl } = makeCapture();
  const { db, provider } = await makeProvider([{ events: ["IdentityCreated", "IdentityAuthenticated"], url: "http://x/" }], fetchImpl);

  try {
    await provider.register({ email: "dave@test.com", password: "password123" });
    calls.length = 0;

    try {
      await provider.login({ email: "dave@test.com", password: "wrong" });
    } catch {
      /*** expected ***/
    }

    assertEquals(calls.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - resetPasswordRequest fires PasswordResetRequested webhook with token", async () => {
  const { calls, fetchImpl } = makeCapture();
  const { db, provider } = await makeProvider([{ events: ["IdentityCreated", "PasswordResetRequested"], url: "http://x/" }], fetchImpl);

  try {
    await provider.register({ email: "eve@test.com", password: "password123" });
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
  const { calls, fetchImpl } = makeCapture();
  const { db, provider } = await makeProvider([{ events: ["PasswordResetRequested"], url: "http://x/" }], fetchImpl);

  try {
    await provider.resetPasswordRequest("noone@test.com");
    assertEquals(calls.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - requestMagicCode fires MagicCodeRequested webhook with code", async () => {
  const { calls, fetchImpl } = makeCapture();
  const { db, provider } = await makeProvider([{ events: ["IdentityCreated", "MagicCodeRequested"], url: "http://x/" }], fetchImpl);

  try {
    await provider.register({ email: "grace@test.com", password: "password123" });
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
  const { calls, fetchImpl } = makeCapture();
  const { db, provider } = await makeProvider([{ events: ["MagicCodeRequested"], url: "http://x/" }], fetchImpl);

  try {
    await provider.requestMagicCode("ghost@test.com");
    assertEquals(calls.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test("AuthProvider - no webhooks configured = no dispatch attempts", async () => {
  const { calls, fetchImpl } = makeCapture();
  const { db, provider } = await makeProvider([], fetchImpl);

  try {
    await provider.register({ email: "frank@test.com", password: "password123" });
    assertEquals(calls.length, 0);
  } finally {
    await db.close();
  }
});

/*** HELPER ------------------------------------------- ***/

function makeCapture(): { calls: CapturedRequest[]; fetchImpl: typeof fetch; } {
  const calls: CapturedRequest[] = [];

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ?
      input :
      input instanceof URL ?
      input.toString() :
      input.url;

    const headers: Record<string, string> = {};

    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    } else if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }

    calls.push({
      body: typeof init?.body === "string" ? init.body : "",
      headers,
      method: init?.method ?? "GET",
      url
    });

    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as typeof fetch;

  return { calls, fetchImpl };
}

async function makeProvider(webhooks: WebhookConfig[], fetchImpl: typeof fetch): Promise<{ db: TestDatabase; provider: AuthProvider; }> {
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

  return { db, provider };
}

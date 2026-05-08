/**
 * Tests for the captcha gate wired into /auth/register and /auth/login.
 * (gh/geldata#7341)
 */

import { assert, assertEquals } from "@std/assert";
import type { CaptchaConfig } from "./captcha.ts";
import { AuthRoutes } from "./integration.ts";
import { AuthMiddleware } from "./middleware.ts";
import { AuthProvider } from "./provider.ts";
import { TestDatabase } from "./test-database.ts";

interface CapturedRequest {
  url: string;
  body: string;
}

function makeFetch(
  responder: (body: string) => Response
): { fetchImpl: typeof fetch; calls: CapturedRequest[]; } {
  const calls: CapturedRequest[] = [];
  const fetchImpl = ((
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body });
    return Promise.resolve(responder(body));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function makeRoutes(
  captcha?: CaptchaConfig,
  fetchImpl?: typeof fetch
): Promise<{
  provider: AuthProvider;
  routes: AuthRoutes;
  db: TestDatabase;
}> {
  const db = new TestDatabase();
  await db.connect();
  const provider = new AuthProvider(
    {
      jwtSecret: "test-secret-key-32-bytes-minimum-len",
      requireEmailVerification: false,
      captcha
    },
    db,
    {},
    fetchImpl ? { fetchImpl } : {}
  );
  await provider.initialize();
  const middleware = new AuthMiddleware(provider);
  const routes = new AuthRoutes(provider, middleware, { rateLimiter: null });
  return { provider, routes, db };
}

// ── No captcha configured: existing behavior preserved ────────────────

Deno.test("register/login — no captcha configured: requests proceed without captchaToken", async () => {
  const { routes, db } = await makeRoutes();
  try {
    const reg = routes.register();
    const regRes = await reg(
      new Request("http://localhost/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "noop@example.com",
          password: "password123"
        })
      })
    );
    assertEquals(regRes.status, 201);
    await regRes.body?.cancel();

    const login = routes.login();
    const loginRes = await login(
      new Request("http://localhost/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "noop@example.com",
          password: "password123"
        })
      })
    );
    assertEquals(loginRes.status, 200);
    await loginRes.body?.cancel();
  } finally {
    await db.close();
  }
});

// ── Captcha configured: register flow ─────────────────────────────────

Deno.test("register — missing captchaToken returns 400 CAPTCHA_REQUIRED", async () => {
  const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const { routes, db } = await makeRoutes(
    { provider: "hcaptcha", secret: "shh" },
    fetchImpl
  );
  try {
    const handler = routes.register();
    const res = await handler(
      new Request("http://localhost/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "user@example.com",
          password: "password123"
        })
      })
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.code, "CAPTCHA_REQUIRED");
  } finally {
    await db.close();
  }
});

Deno.test("register — valid captcha (verifier returns success) proceeds to 201", async () => {
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const { routes, db } = await makeRoutes(
    { provider: "hcaptcha", secret: "shh" },
    fetchImpl
  );
  try {
    const handler = routes.register();
    const res = await handler(
      new Request("http://localhost/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "user@example.com",
          password: "password123",
          captchaToken: "good-token"
        })
      })
    );
    assertEquals(res.status, 201);
    assertEquals(calls.length, 1);
    const params = new URLSearchParams(calls[0].body);
    assertEquals(params.get("response"), "good-token");
    await res.body?.cancel();
  } finally {
    await db.close();
  }
});

Deno.test("register — invalid captcha (verifier returns success: false) returns 403 CAPTCHA_FAILED", async () => {
  const { fetchImpl } = makeFetch(() =>
    new Response(
      JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }),
      { status: 200 }
    )
  );
  const { routes, db } = await makeRoutes(
    { provider: "hcaptcha", secret: "shh" },
    fetchImpl
  );
  try {
    const handler = routes.register();
    const res = await handler(
      new Request("http://localhost/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "user@example.com",
          password: "password123",
          captchaToken: "bad-token"
        })
      })
    );
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.code, "CAPTCHA_FAILED");
    // Provider error codes must NOT leak to the client.
    assert(!("errorCodes" in body));
  } finally {
    await db.close();
  }
});

// ── Captcha configured: login flow ────────────────────────────────────

Deno.test("login — missing captchaToken returns 400 CAPTCHA_REQUIRED", async () => {
  const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const { provider, routes, db } = await makeRoutes(
    { provider: "hcaptcha", secret: "shh" },
    fetchImpl
  );
  try {
    // Pre-register a user so login could otherwise proceed.
    await provider.register({
      email: "u@example.com",
      password: "password123"
    });
    const handler = routes.login();
    const res = await handler(
      new Request("http://localhost/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "u@example.com",
          password: "password123"
        })
      })
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.code, "CAPTCHA_REQUIRED");
  } finally {
    await db.close();
  }
});

Deno.test("login — valid captchaToken proceeds and returns 200", async () => {
  const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const { provider, routes, db } = await makeRoutes(
    { provider: "hcaptcha", secret: "shh" },
    fetchImpl
  );
  try {
    await provider.register({
      email: "u@example.com",
      password: "password123"
    });
    const handler = routes.login();
    const res = await handler(
      new Request("http://localhost/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "u@example.com",
          password: "password123",
          captchaToken: "good-token"
        })
      })
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    await db.close();
  }
});

Deno.test("login — invalid captchaToken returns 403 CAPTCHA_FAILED", async () => {
  const { fetchImpl } = makeFetch(() => new Response(JSON.stringify({ success: false }), { status: 200 }));
  const { provider, routes, db } = await makeRoutes(
    { provider: "hcaptcha", secret: "shh" },
    fetchImpl
  );
  try {
    await provider.register({
      email: "u@example.com",
      password: "password123"
    });
    const handler = routes.login();
    const res = await handler(
      new Request("http://localhost/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "u@example.com",
          password: "password123",
          captchaToken: "bad-token"
        })
      })
    );
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.code, "CAPTCHA_FAILED");
  } finally {
    await db.close();
  }
});

// ── Gate config narrows which endpoints check ─────────────────────────

Deno.test("gate config — endpoints not listed bypass the captcha check", async () => {
  // gate=["register"] only — login should NOT require captchaToken
  const { fetchImpl, calls } = makeFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));
  const { provider, routes, db } = await makeRoutes(
    { provider: "hcaptcha", secret: "shh", gate: ["register"] },
    fetchImpl
  );
  try {
    await provider.register({
      email: "u@example.com",
      password: "password123"
      // captchaToken expected here too — verify with a token to register.
    } as never); // bypass typing: register doesn't take captchaToken on the data type
    // Direct provider register skipped captcha entirely (it's a route-layer gate).
    // Now confirm the login route, which is NOT in gate, bypasses captcha.
    const handler = routes.login();
    const res = await handler(
      new Request("http://localhost/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "u@example.com",
          password: "password123"
        })
      })
    );
    assertEquals(res.status, 200);
    // login isn't gated → no fetch to verifier
    assertEquals(calls.length, 0);
    await res.body?.cancel();
  } finally {
    await db.close();
  }
});

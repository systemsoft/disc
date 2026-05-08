/**
 * Tests for OAuthExtension
 */

import { assertEquals, assertThrows } from "@std/assert";
import { ExtensionConfigError } from "../extensions/errors.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import { OAuthExtension } from "./extension.ts";
import { githubProvider, googleProvider } from "./providers.ts";
import type { OAuthConfig } from "./types.ts";

// ── Helpers ───────────────────────────────────────────────────────────

function makeContext(): ExtensionContext {
  return {
    schema: { types: new Map(), functions: new Map() },
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 5,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function() {
        return this;
      },
      withRequest: function() {
        return this;
      }
    } as unknown as ExtensionContext["logger"]
  };
}

function makeConfig(overrides?: Partial<OAuthConfig>): OAuthConfig {
  return {
    providers: [googleProvider("cid", "csecret", "https://example.com/cb")],
    ...overrides
  };
}

function makeRequest(path: string): Request {
  return new Request(`http://localhost${path}`);
}

// ── Metadata ──────────────────────────────────────────────────────────

Deno.test("OAuthExtension - metadata name is oauth", () => {
  const ext = new OAuthExtension(makeConfig());
  assertEquals(ext.metadata.name, "oauth");
});

Deno.test("OAuthExtension - metadata version is 1.0.0", () => {
  const ext = new OAuthExtension(makeConfig());
  assertEquals(ext.metadata.version, "1.0.0");
});

Deno.test("OAuthExtension - metadata has empty dependencies array", () => {
  const ext = new OAuthExtension(makeConfig());
  assertEquals(ext.metadata.dependencies, []);
});

// ── Constructor validation ─────────────────────────────────────────────

Deno.test("OAuthExtension - constructor throws ExtensionConfigError with empty providers array", () => {
  assertThrows(
    () => new OAuthExtension({ providers: [] }),
    ExtensionConfigError
  );
});

Deno.test("OAuthExtension - constructor throws ExtensionConfigError with no providers key", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => new OAuthExtension({} as any),
    ExtensionConfigError
  );
});

// ── State lifecycle ───────────────────────────────────────────────────

Deno.test("OAuthExtension - state starts as uninitialized", () => {
  const ext = new OAuthExtension(makeConfig());
  assertEquals(ext.state, "uninitialized");
});

Deno.test("OAuthExtension - initialize sets state to ready", async () => {
  const ext = new OAuthExtension(makeConfig());
  await ext.initialize(makeContext());
  assertEquals(ext.state, "ready");
});

// ── Routes ────────────────────────────────────────────────────────────

Deno.test("OAuthExtension - getRoutes includes /providers route", () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const found = routes.find(r => r.path === "/providers" && r.method === "GET");
  assertEquals(found !== undefined, true);
});

Deno.test("OAuthExtension - getRoutes includes authorize route per provider", () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const found = routes.find(r => r.path === "/authorize/google");
  assertEquals(found !== undefined, true);
});

Deno.test("OAuthExtension - getRoutes includes callback route per provider", () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const found = routes.find(r => r.path === "/callback/google");
  assertEquals(found !== undefined, true);
});

Deno.test("OAuthExtension - getRoutes total count is 1 + 2*providers", () => {
  const ext = new OAuthExtension({
    providers: [
      googleProvider("cid", "csecret", "https://example.com/cb"),
      githubProvider("cid2", "csecret2", "https://example.com/cb")
    ]
  });
  // 1 /providers + 2 authorize + 2 callback = 5
  assertEquals(ext.getRoutes().length, 5);
});

// ── /providers handler ────────────────────────────────────────────────

Deno.test("OAuthExtension - /providers handler returns configured provider names", async () => {
  const ext = new OAuthExtension({
    providers: [
      googleProvider("cid", "csecret"),
      githubProvider("cid2", "csecret2")
    ]
  });
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/providers")!;
  const response = await route.handler(makeRequest("/providers"));
  const body = await response.json() as { providers: string[]; };
  assertEquals(body.providers.includes("google"), true);
  assertEquals(body.providers.includes("github"), true);
});

// ── Authorize handler ─────────────────────────────────────────────────

Deno.test("OAuthExtension - authorize route returns url with correct base", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; state: string; };
  assertEquals(
    body.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth"),
    true
  );
});

Deno.test("OAuthExtension - authorize route returns state token", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; state: string; };
  assertEquals(typeof body.state, "string");
  assertEquals(body.state.length > 0, true);
});

Deno.test("OAuthExtension - authorize URL includes client_id param", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; };
  const parsed = new URL(body.url);
  assertEquals(parsed.searchParams.get("client_id"), "cid");
});

Deno.test("OAuthExtension - authorize URL includes scope param", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; };
  const parsed = new URL(body.url);
  assertEquals(parsed.searchParams.has("scope"), true);
});

// ── extraAuthorizeParams (gh/geldata#7752) ────────────────────────────

Deno.test("OAuthExtension - extraAuthorizeParams appended to authorize URL", async () => {
  const provider = googleProvider("cid", "csecret", "https://example.com/cb");
  provider.extraAuthorizeParams = { access_type: "offline", prompt: "consent" };
  const ext = new OAuthExtension({ providers: [provider] });
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; };
  const parsed = new URL(body.url);
  assertEquals(parsed.searchParams.get("access_type"), "offline");
  assertEquals(parsed.searchParams.get("prompt"), "consent");
});

Deno.test("OAuthExtension - extraAuthorizeParams cannot override reserved client_id", () => {
  const provider = googleProvider("cid", "csecret", "https://example.com/cb");
  provider.extraAuthorizeParams = { client_id: "evil" };
  assertThrows(
    () => new OAuthExtension({ providers: [provider] }),
    ExtensionConfigError,
    "client_id"
  );
});

Deno.test("OAuthExtension - extraAuthorizeParams cannot override reserved state", () => {
  const provider = googleProvider("cid", "csecret", "https://example.com/cb");
  provider.extraAuthorizeParams = { state: "evil" };
  assertThrows(
    () => new OAuthExtension({ providers: [provider] }),
    ExtensionConfigError,
    "state"
  );
});

Deno.test("OAuthExtension - extraAuthorizeParams cannot override code_challenge", () => {
  const provider = googleProvider("cid", "csecret", "https://example.com/cb");
  provider.extraAuthorizeParams = { code_challenge: "evil" };
  assertThrows(
    () => new OAuthExtension({ providers: [provider] }),
    ExtensionConfigError,
    "code_challenge"
  );
});

Deno.test("OAuthExtension - extraAuthorizeParams omitted leaves authorize URL unchanged", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; };
  const parsed = new URL(body.url);
  assertEquals(parsed.searchParams.has("access_type"), false);
  assertEquals(parsed.searchParams.has("prompt"), false);
});

// ── Callback handler ──────────────────────────────────────────────────

Deno.test("OAuthExtension - callback returns 400 when code is missing", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/callback/google")!;
  const response = await route.handler(
    makeRequest("/callback/google?state=some-state")
  );
  assertEquals(response.status, 400);
});

Deno.test("OAuthExtension - callback returns 400 when state is missing", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/callback/google")!;
  const response = await route.handler(
    makeRequest("/callback/google?code=auth-code")
  );
  assertEquals(response.status, 400);
});

Deno.test("OAuthExtension - callback returns invalid_state error code", async () => {
  // gh/geldata#8950: structured error shape `{error: {code, message}}`
  // replaces the prior flat `{error: "string"}`.
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/callback/google")!;
  const response = await route.handler(
    makeRequest("/callback/google?code=auth-code&state=invalid-state")
  );
  assertEquals(response.status, 400);
  const body = await response.json() as {
    error: { code: string; message: string; };
  };
  assertEquals(body.error.code, "invalid_state");
});

Deno.test("OAuthExtension - callback forwards provider error in details", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find(r => r.path === "/callback/google")!;
  const response = await route.handler(
    makeRequest("/callback/google?error=access_denied")
  );
  assertEquals(response.status, 400);
  const body = await response.json() as {
    error: { code: string; details?: string; };
  };
  assertEquals(body.error.code, "oauth_provider_error");
  assertEquals(body.error.details, "access_denied");
});

Deno.test("OAuthExtension - callback completes token exchange + userinfo (gh/geldata#7557)", async () => {
  // Mock fetch so the callback actually completes against a stub
  // OAuth provider. Verifies that gh/geldata#7557 wired token exchange
  // and userinfo fetching into the callback (it was a stub previously).
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes("oauth2.googleapis.com/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "test-access-token",
            token_type: "Bearer",
            expires_in: 3600
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    if (u.includes("googleapis.com/oauth2/v3/userinfo")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            sub: "google-user-123",
            email: "ada@example.com",
            name: "Ada Lovelace",
            picture: "https://example.com/ada.jpg"
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;

  try {
    const ext = new OAuthExtension(makeConfig());
    const authRoutes = ext.getRoutes();
    const authRoute = authRoutes.find(r => r.path === "/authorize/google")!;
    const authResp = await authRoute.handler(makeRequest("/authorize/google"));
    const authBody = await authResp.json() as { state: string; };

    const cbRoute = authRoutes.find(r => r.path === "/callback/google")!;
    const response = await cbRoute.handler(
      makeRequest(`/callback/google?code=real-code&state=${authBody.state}`)
    );
    assertEquals(response.status, 200);
    const body = await response.json() as {
      provider: string;
      token: { accessToken: string; tokenType: string; };
      user: { id: string; email: string; name: string; avatarUrl: string; };
    };
    assertEquals(body.provider, "google");
    assertEquals(body.token.accessToken, "test-access-token");
    assertEquals(body.user.id, "google-user-123");
    assertEquals(body.user.email, "ada@example.com");
    assertEquals(body.user.name, "Ada Lovelace");
    assertEquals(body.user.avatarUrl, "https://example.com/ada.jpg");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OAuthExtension - metadata round-trips through authorize → callback (gh/geldata#8841)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
    if (u.includes("token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "tok", token_type: "Bearer" })
        )
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ sub: "u1", email: "e@x.com" }))
    );
  }) as typeof fetch;

  try {
    const ext = new OAuthExtension(makeConfig());
    const authRoutes = ext.getRoutes();
    const authRoute = authRoutes.find(r => r.path === "/authorize/google")!;
    const meta = encodeURIComponent(
      JSON.stringify({ next: "/dashboard", csrf: "abc" })
    );
    const authResp = await authRoute.handler(
      makeRequest(`/authorize/google?metadata=${meta}`)
    );
    const authBody = await authResp.json() as { state: string; };

    const cbRoute = authRoutes.find(r => r.path === "/callback/google")!;
    const response = await cbRoute.handler(
      makeRequest(`/callback/google?code=c&state=${authBody.state}`)
    );
    const body = await response.json() as {
      metadata: { next: string; csrf: string; };
    };
    assertEquals(body.metadata.next, "/dashboard");
    assertEquals(body.metadata.csrf, "abc");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OAuthExtension - rejects oversized metadata (gh/geldata#8841)", async () => {
  const ext = new OAuthExtension(makeConfig());
  const authRoutes = ext.getRoutes();
  const authRoute = authRoutes.find(r => r.path === "/authorize/google")!;
  // 3 KB blob — exceeds the 2 KB cap.
  const huge = encodeURIComponent(JSON.stringify({ blob: "x".repeat(3000) }));
  const response = await authRoute.handler(
    makeRequest(`/authorize/google?metadata=${huge}`)
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string; }; };
  assertEquals(body.error.code, "metadata_too_large");
});

Deno.test("OAuthExtension - rejects malformed metadata (gh/geldata#8841)", async () => {
  const ext = new OAuthExtension(makeConfig());
  const authRoutes = ext.getRoutes();
  const authRoute = authRoutes.find(r => r.path === "/authorize/google")!;
  const response = await authRoute.handler(
    makeRequest("/authorize/google?metadata=not-json")
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string; }; };
  assertEquals(body.error.code, "metadata_invalid");
});

Deno.test("OAuthExtension - rejects metadata that is JSON but not an object", async () => {
  const ext = new OAuthExtension(makeConfig());
  const authRoutes = ext.getRoutes();
  const authRoute = authRoutes.find(r => r.path === "/authorize/google")!;
  const arr = encodeURIComponent("[1,2,3]");
  const response = await authRoute.handler(
    makeRequest(`/authorize/google?metadata=${arr}`)
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: { code: string; }; };
  assertEquals(body.error.code, "metadata_invalid");
});

Deno.test("OAuthExtension - callback maps token-exchange failure to structured error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response("Bad client_secret", {
        status: 400,
        headers: { "Content-Type": "text/plain" }
      })
    )) as typeof fetch;

  try {
    const ext = new OAuthExtension(makeConfig());
    const authRoutes = ext.getRoutes();
    const authRoute = authRoutes.find(r => r.path === "/authorize/google")!;
    const authResp = await authRoute.handler(makeRequest("/authorize/google"));
    const authBody = await authResp.json() as { state: string; };

    const cbRoute = authRoutes.find(r => r.path === "/callback/google")!;
    const response = await cbRoute.handler(
      makeRequest(`/callback/google?code=c&state=${authBody.state}`)
    );
    assertEquals(response.status, 502);
    const body = await response.json() as {
      error: { code: string; details?: string; };
    };
    assertEquals(body.error.code, "token_exchange_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── State manager ─────────────────────────────────────────────────────

Deno.test("OAuthExtension - getStateManager returns manager", () => {
  const ext = new OAuthExtension(makeConfig());
  const manager = ext.getStateManager();
  assertEquals(manager !== null, true);
});

Deno.test("OAuthExtension - state manager validates created states", async () => {
  const ext = new OAuthExtension(makeConfig());
  const manager = ext.getStateManager();
  const oauthState = await manager.createState(
    "google",
    "https://example.com/cb"
  );
  const validated = manager.validateState(oauthState.state);
  assertEquals(validated !== null, true);
  assertEquals(validated!.provider, "google");
});

Deno.test("OAuthExtension - state manager rejects states used twice (one-time use)", async () => {
  const ext = new OAuthExtension(makeConfig());
  const manager = ext.getStateManager();
  const oauthState = await manager.createState(
    "google",
    "https://example.com/cb"
  );
  manager.validateState(oauthState.state);
  const second = manager.validateState(oauthState.state);
  assertEquals(second, null);
});

Deno.test("OAuthExtension - state manager populates PKCE fields (P1-41)", async () => {
  const ext = new OAuthExtension(makeConfig());
  const manager = ext.getStateManager();
  const oauthState = await manager.createState(
    "google",
    "https://example.com/cb"
  );
  // RFC 7636: verifier is 43-128 URL-safe chars; challenge is base64url
  // of SHA-256(verifier) so it's exactly 43 chars.
  assertEquals(typeof oauthState.codeVerifier, "string");
  assertEquals(oauthState.codeVerifier!.length >= 43, true);
  assertEquals(typeof oauthState.codeChallenge, "string");
  assertEquals(oauthState.codeChallenge!.length, 43);
});

// gh/geldata#7026: Disc uses RFC 7636 PKCE param names exclusively at
// the upstream-provider hop. This pins the names so a regression that
// switches to a short alias (`challenge`, `verifier`) trips the test.
Deno.test("OAuthExtension - authorize URL uses RFC 7636 PKCE param names", async () => {
  const ext = new OAuthExtension(makeConfig());
  const route = ext.getRoutes().find(r => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; };
  const parsed = new URL(body.url);

  assertEquals(parsed.searchParams.has("code_challenge"), true);
  assertEquals(parsed.searchParams.get("code_challenge_method"), "S256");
  // Short forms must NOT appear — they'd indicate a regression to a
  // non-RFC name.
  assertEquals(parsed.searchParams.has("challenge"), false);
  assertEquals(parsed.searchParams.has("challenge_method"), false);
});

// gh/geldata#7596: code_challenge forwarded to upstream must be
// unpadded. The state-manager already produces unpadded base64url
// (43 chars for S256 by construction), so this test pins that no
// trailing `=` ever sneaks into the authorize URL.
Deno.test("OAuthExtension - authorize URL forwards unpadded code_challenge", async () => {
  const ext = new OAuthExtension(makeConfig());
  const route = ext.getRoutes().find(r => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; };
  const parsed = new URL(body.url);

  const challenge = parsed.searchParams.get("code_challenge")!;
  assertEquals(challenge.endsWith("="), false);
});

Deno.test("OAuthExtension - state manager rejects expired states", async () => {
  // 1 ms expiry so state expires immediately
  const ext = new OAuthExtension({
    providers: [googleProvider("cid", "csecret")],
    stateExpiryMs: 1
  });
  const manager = ext.getStateManager();
  const oauthState = await manager.createState(
    "google",
    "https://example.com/cb"
  );
  // Wait for expiry
  return new Promise<void>(resolve => {
    setTimeout(() => {
      const result = manager.validateState(oauthState.state);
      assertEquals(result, null);
      resolve();
    }, 10);
  });
});

// ── Database setup ────────────────────────────────────────────────────

Deno.test("OAuthExtension - getDatabaseSetup returns non-empty setupSql", () => {
  const ext = new OAuthExtension(makeConfig());
  const setup = ext.getDatabaseSetup();
  assertEquals(setup.setupSql.length > 0, true);
});

Deno.test("OAuthExtension - getDatabaseSetup setupSql creates disc_oauth_states table", () => {
  const ext = new OAuthExtension(makeConfig());
  const setup = ext.getDatabaseSetup();
  const combined = setup.setupSql.join("\n");
  assertEquals(combined.includes("disc_oauth_states"), true);
});

Deno.test("OAuthExtension - getDatabaseSetup setupSql creates disc_oauth_identities table", () => {
  const ext = new OAuthExtension(makeConfig());
  const setup = ext.getDatabaseSetup();
  const combined = setup.setupSql.join("\n");
  assertEquals(combined.includes("disc_oauth_identities"), true);
});

Deno.test("OAuthExtension - getDatabaseSetup teardownSql drops both tables", () => {
  const ext = new OAuthExtension(makeConfig());
  const setup = ext.getDatabaseSetup();
  const teardown = (setup.teardownSql ?? []).join("\n");
  assertEquals(teardown.includes("disc_oauth_identities"), true);
  assertEquals(teardown.includes("disc_oauth_states"), true);
});

// ── getProvider ───────────────────────────────────────────────────────

Deno.test("OAuthExtension - getProvider returns config for registered provider", () => {
  const ext = new OAuthExtension(makeConfig());
  const provider = ext.getProvider("google");
  assertEquals(provider !== undefined, true);
  assertEquals(provider!.name, "google");
});

Deno.test("OAuthExtension - getProvider returns undefined for unknown provider", () => {
  const ext = new OAuthExtension(makeConfig());
  assertEquals(ext.getProvider("discord"), undefined);
});

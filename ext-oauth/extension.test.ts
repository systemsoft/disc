/**
 * Tests for OAuthExtension
 */

import { assertEquals, assertThrows } from "@std/assert";
import { OAuthExtension } from "./extension.ts";
import { ExtensionConfigError } from "../extensions/errors.ts";
import type { ExtensionContext } from "../extensions/types.ts";
import type { OAuthConfig } from "./types.ts";
import { githubProvider, googleProvider } from "./providers.ts";

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
      enableWebsockets: false,
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function () {
        return this;
      },
      withRequest: function () {
        return this;
      },
    } as unknown as ExtensionContext["logger"],
  };
}

function makeConfig(overrides?: Partial<OAuthConfig>): OAuthConfig {
  return {
    providers: [googleProvider("cid", "csecret", "https://example.com/cb")],
    ...overrides,
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
    ExtensionConfigError,
  );
});

Deno.test("OAuthExtension - constructor throws ExtensionConfigError with no providers key", () => {
  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => new OAuthExtension({} as any),
    ExtensionConfigError,
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
  const found = routes.find((r) =>
    r.path === "/providers" && r.method === "GET"
  );
  assertEquals(found !== undefined, true);
});

Deno.test("OAuthExtension - getRoutes includes authorize route per provider", () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const found = routes.find((r) => r.path === "/authorize/google");
  assertEquals(found !== undefined, true);
});

Deno.test("OAuthExtension - getRoutes includes callback route per provider", () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const found = routes.find((r) => r.path === "/callback/google");
  assertEquals(found !== undefined, true);
});

Deno.test("OAuthExtension - getRoutes total count is 1 + 2*providers", () => {
  const ext = new OAuthExtension({
    providers: [
      googleProvider("cid", "csecret", "https://example.com/cb"),
      githubProvider("cid2", "csecret2", "https://example.com/cb"),
    ],
  });
  // 1 /providers + 2 authorize + 2 callback = 5
  assertEquals(ext.getRoutes().length, 5);
});

// ── /providers handler ────────────────────────────────────────────────

Deno.test("OAuthExtension - /providers handler returns configured provider names", async () => {
  const ext = new OAuthExtension({
    providers: [
      googleProvider("cid", "csecret"),
      githubProvider("cid2", "csecret2"),
    ],
  });
  const routes = ext.getRoutes();
  const route = routes.find((r) => r.path === "/providers")!;
  const response = await route.handler(makeRequest("/providers"));
  const body = await response.json() as { providers: string[] };
  assertEquals(body.providers.includes("google"), true);
  assertEquals(body.providers.includes("github"), true);
});

// ── Authorize handler ─────────────────────────────────────────────────

Deno.test("OAuthExtension - authorize route returns url with correct base", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find((r) => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; state: string };
  assertEquals(
    body.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth"),
    true,
  );
});

Deno.test("OAuthExtension - authorize route returns state token", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find((r) => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string; state: string };
  assertEquals(typeof body.state, "string");
  assertEquals(body.state.length > 0, true);
});

Deno.test("OAuthExtension - authorize URL includes client_id param", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find((r) => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string };
  const parsed = new URL(body.url);
  assertEquals(parsed.searchParams.get("client_id"), "cid");
});

Deno.test("OAuthExtension - authorize URL includes scope param", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find((r) => r.path === "/authorize/google")!;
  const response = await route.handler(makeRequest("/authorize/google"));
  const body = await response.json() as { url: string };
  const parsed = new URL(body.url);
  assertEquals(parsed.searchParams.has("scope"), true);
});

// ── Callback handler ──────────────────────────────────────────────────

Deno.test("OAuthExtension - callback returns 400 when code is missing", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find((r) => r.path === "/callback/google")!;
  const response = await route.handler(
    makeRequest("/callback/google?state=some-state"),
  );
  assertEquals(response.status, 400);
});

Deno.test("OAuthExtension - callback returns 400 when state is missing", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find((r) => r.path === "/callback/google")!;
  const response = await route.handler(
    makeRequest("/callback/google?code=auth-code"),
  );
  assertEquals(response.status, 400);
});

Deno.test("OAuthExtension - callback returns 400 for invalid state", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find((r) => r.path === "/callback/google")!;
  const response = await route.handler(
    makeRequest("/callback/google?code=auth-code&state=invalid-state"),
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: string };
  assertEquals(body.error, "Invalid or expired state");
});

Deno.test("OAuthExtension - callback returns 400 with error query param", async () => {
  const ext = new OAuthExtension(makeConfig());
  const routes = ext.getRoutes();
  const route = routes.find((r) => r.path === "/callback/google")!;
  const response = await route.handler(
    makeRequest("/callback/google?error=access_denied"),
  );
  assertEquals(response.status, 400);
  const body = await response.json() as { error: string };
  assertEquals(body.error.includes("access_denied"), true);
});

Deno.test("OAuthExtension - callback succeeds with valid state and code", async () => {
  const ext = new OAuthExtension(makeConfig());
  // Obtain a real state token via the authorize route
  const authRoutes = ext.getRoutes();
  const authRoute = authRoutes.find((r) => r.path === "/authorize/google")!;
  const authResp = await authRoute.handler(makeRequest("/authorize/google"));
  const authBody = await authResp.json() as { state: string };

  const cbRoute = authRoutes.find((r) => r.path === "/callback/google")!;
  const response = await cbRoute.handler(
    makeRequest(
      `/callback/google?code=real-code&state=${authBody.state}`,
    ),
  );
  assertEquals(response.status, 200);
  const body = await response.json() as {
    message: string;
    code: string;
    provider: string;
  };
  assertEquals(body.message, "OAuth callback received");
  assertEquals(body.code, "real-code");
  assertEquals(body.provider, "google");
});

// ── State manager ─────────────────────────────────────────────────────

Deno.test("OAuthExtension - getStateManager returns manager", () => {
  const ext = new OAuthExtension(makeConfig());
  const manager = ext.getStateManager();
  assertEquals(manager !== null, true);
});

Deno.test("OAuthExtension - state manager validates created states", () => {
  const ext = new OAuthExtension(makeConfig());
  const manager = ext.getStateManager();
  const oauthState = manager.createState("google", "https://example.com/cb");
  const validated = manager.validateState(oauthState.state);
  assertEquals(validated !== null, true);
  assertEquals(validated!.provider, "google");
});

Deno.test("OAuthExtension - state manager rejects states used twice (one-time use)", () => {
  const ext = new OAuthExtension(makeConfig());
  const manager = ext.getStateManager();
  const oauthState = manager.createState("google", "https://example.com/cb");
  manager.validateState(oauthState.state);
  const second = manager.validateState(oauthState.state);
  assertEquals(second, null);
});

Deno.test("OAuthExtension - state manager rejects expired states", () => {
  // 1 ms expiry so state expires immediately
  const ext = new OAuthExtension({
    providers: [googleProvider("cid", "csecret")],
    stateExpiryMs: 1,
  });
  const manager = ext.getStateManager();
  const oauthState = manager.createState("google", "https://example.com/cb");
  // Wait for expiry
  return new Promise<void>((resolve) => {
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

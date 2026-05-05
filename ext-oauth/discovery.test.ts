/**
 * Tests for OIDC discovery document fetching.
 * (gh/geldata#7415, ports geldata/gel#7510)
 */

import { assertEquals, assertRejects } from "@std/assert";
import { buildDiscoveryUrl, fetchOidcDiscovery } from "./discovery.ts";

// ── buildDiscoveryUrl ─────────────────────────────────────────────────

Deno.test("buildDiscoveryUrl - appends well-known path", () => {
  assertEquals(
    buildDiscoveryUrl("https://accounts.example.com"),
    "https://accounts.example.com/.well-known/openid-configuration",
  );
});

Deno.test("buildDiscoveryUrl - strips trailing slash", () => {
  assertEquals(
    buildDiscoveryUrl("https://accounts.example.com/"),
    "https://accounts.example.com/.well-known/openid-configuration",
  );
});

Deno.test("buildDiscoveryUrl - preserves issuer path prefix (RFC 8414 §3)", () => {
  // Keycloak/Zitadel realm-style issuers
  assertEquals(
    buildDiscoveryUrl("https://auth.example.com/realms/main"),
    "https://auth.example.com/realms/main/.well-known/openid-configuration",
  );
});

// ── fetchOidcDiscovery ────────────────────────────────────────────────

function mockFetch(
  responder: (url: string) => Response | Promise<Response>,
): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    return Promise.resolve(responder(url));
  }) as typeof fetch;
}

Deno.test("fetchOidcDiscovery - parses a complete discovery doc", async () => {
  const f = mockFetch(() =>
    new Response(
      JSON.stringify({
        authorization_endpoint: "https://example.com/oauth/authorize",
        issuer: "https://example.com",
        jwks_uri: "https://example.com/.well-known/jwks.json",
        scopes_supported: ["openid", "email", "profile"],
        token_endpoint: "https://example.com/oauth/token",
        userinfo_endpoint: "https://example.com/oauth/userinfo",
      }),
      { status: 200 },
    )
  );

  const doc = await fetchOidcDiscovery("https://example.com", f);
  assertEquals(doc.issuer, "https://example.com");
  assertEquals(doc.authorizationEndpoint, "https://example.com/oauth/authorize");
  assertEquals(doc.tokenEndpoint, "https://example.com/oauth/token");
  assertEquals(doc.userInfoEndpoint, "https://example.com/oauth/userinfo");
  assertEquals(doc.jwksUri, "https://example.com/.well-known/jwks.json");
  assertEquals(doc.scopesSupported, ["openid", "email", "profile"]);
});

Deno.test("fetchOidcDiscovery - hits the well-known URL", async () => {
  let calledUrl: string | undefined;
  const f = mockFetch((url) => {
    calledUrl = url;
    return new Response(
      JSON.stringify({
        authorization_endpoint: "https://example.com/a",
        issuer: "https://example.com",
        token_endpoint: "https://example.com/t",
      }),
      { status: 200 },
    );
  });

  await fetchOidcDiscovery("https://example.com", f);
  assertEquals(
    calledUrl,
    "https://example.com/.well-known/openid-configuration",
  );
});

Deno.test("fetchOidcDiscovery - omits userinfo when issuer doesn't advertise one", async () => {
  const f = mockFetch(() =>
    new Response(
      JSON.stringify({
        authorization_endpoint: "https://example.com/a",
        issuer: "https://example.com",
        token_endpoint: "https://example.com/t",
      }),
      { status: 200 },
    )
  );

  const doc = await fetchOidcDiscovery("https://example.com", f);
  assertEquals(doc.userInfoEndpoint, undefined);
});

Deno.test("fetchOidcDiscovery - throws on HTTP error", async () => {
  const f = mockFetch(() =>
    new Response("not found", { status: 404, statusText: "Not Found" })
  );

  await assertRejects(
    () => fetchOidcDiscovery("https://example.com", f),
    Error,
    "OIDC discovery failed for https://example.com: 404",
  );
});

Deno.test("fetchOidcDiscovery - throws when required endpoints are missing", async () => {
  const f = mockFetch(() =>
    new Response(
      JSON.stringify({ issuer: "https://example.com" }),
      { status: 200 },
    )
  );

  await assertRejects(
    () => fetchOidcDiscovery("https://example.com", f),
    Error,
    "missing required endpoints",
  );
});

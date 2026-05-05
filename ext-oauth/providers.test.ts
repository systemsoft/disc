/**
 * Tests for OAuth provider factory functions
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  appleProvider,
  createOidcProvider,
  facebookProvider,
  genericOidcProvider,
  githubProvider,
  googleProvider,
  keycloakProvider,
  linkedinProvider,
  twitterProvider,
} from "./providers.ts";

// ── googleProvider ────────────────────────────────────────────────────

Deno.test("googleProvider - returns correct name", () => {
  const p = googleProvider("client-id", "client-secret");
  assertEquals(p.name, "google");
});

Deno.test("googleProvider - returns correct authorize and token URLs", () => {
  const p = googleProvider("cid", "csecret");
  assertEquals(
    p.authorizeUrl,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assertEquals(p.tokenUrl, "https://oauth2.googleapis.com/token");
  assertEquals(
    p.userInfoUrl,
    "https://www.googleapis.com/oauth2/v3/userinfo",
  );
});

Deno.test("googleProvider - includes openid email profile scopes", () => {
  const p = googleProvider("cid", "csecret");
  assertEquals(p.scopes.includes("openid"), true);
  assertEquals(p.scopes.includes("email"), true);
  assertEquals(p.scopes.includes("profile"), true);
});

Deno.test("googleProvider - passes through clientId and clientSecret", () => {
  const p = googleProvider("my-client-id", "my-client-secret");
  assertEquals(p.clientId, "my-client-id");
  assertEquals(p.clientSecret, "my-client-secret");
});

Deno.test("googleProvider - sets optional redirectUri when provided", () => {
  const p = googleProvider("cid", "csecret", "https://example.com/callback");
  assertEquals(p.redirectUri, "https://example.com/callback");
});

Deno.test("googleProvider - redirectUri is undefined when omitted", () => {
  const p = googleProvider("cid", "csecret");
  assertEquals(p.redirectUri, undefined);
});

// ── githubProvider ────────────────────────────────────────────────────

Deno.test("githubProvider - returns correct name", () => {
  const p = githubProvider("client-id", "client-secret");
  assertEquals(p.name, "github");
});

Deno.test("githubProvider - returns correct authorize and token URLs", () => {
  const p = githubProvider("cid", "csecret");
  assertEquals(
    p.authorizeUrl,
    "https://github.com/login/oauth/authorize",
  );
  assertEquals(
    p.tokenUrl,
    "https://github.com/login/oauth/access_token",
  );
  assertEquals(p.userInfoUrl, "https://api.github.com/user");
});

Deno.test("githubProvider - includes user:email scope", () => {
  const p = githubProvider("cid", "csecret");
  assertEquals(p.scopes.includes("user:email"), true);
});

Deno.test("githubProvider - sets optional redirectUri when provided", () => {
  const p = githubProvider("cid", "csecret", "https://example.com/callback");
  assertEquals(p.redirectUri, "https://example.com/callback");
});

// ── appleProvider ─────────────────────────────────────────────────────

Deno.test("appleProvider - returns correct name", () => {
  const p = appleProvider("client-id", "client-secret");
  assertEquals(p.name, "apple");
});

Deno.test("appleProvider - returns correct authorize and token URLs", () => {
  const p = appleProvider("cid", "csecret");
  assertEquals(
    p.authorizeUrl,
    "https://appleid.apple.com/auth/authorize",
  );
  assertEquals(p.tokenUrl, "https://appleid.apple.com/auth/token");
  assertEquals(p.userInfoUrl, "https://appleid.apple.com/auth/userinfo");
});

Deno.test("appleProvider - includes name and email scopes", () => {
  const p = appleProvider("cid", "csecret");
  assertEquals(p.scopes.includes("name"), true);
  assertEquals(p.scopes.includes("email"), true);
});

Deno.test("appleProvider - sets optional redirectUri when provided", () => {
  const p = appleProvider("cid", "csecret", "https://example.com/callback");
  assertEquals(p.redirectUri, "https://example.com/callback");
});

// ── twitterProvider (gh/geldata#6728) ──────────────────────────────────

Deno.test("twitterProvider - returns correct name", () => {
  const p = twitterProvider("cid", "csecret");
  assertEquals(p.name, "twitter");
});

Deno.test("twitterProvider - returns correct authorize, token, and userinfo URLs", () => {
  const p = twitterProvider("cid", "csecret");
  assertEquals(p.authorizeUrl, "https://twitter.com/i/oauth2/authorize");
  assertEquals(p.tokenUrl, "https://api.twitter.com/2/oauth2/token");
  assertEquals(p.userInfoUrl, "https://api.twitter.com/2/users/me");
});

Deno.test("twitterProvider - includes tweet.read and users.read scopes", () => {
  const p = twitterProvider("cid", "csecret");
  assertEquals(p.scopes.includes("tweet.read"), true);
  assertEquals(p.scopes.includes("users.read"), true);
});

Deno.test("twitterProvider - sets optional redirectUri when provided", () => {
  const p = twitterProvider("cid", "csecret", "https://example.com/cb");
  assertEquals(p.redirectUri, "https://example.com/cb");
});

// ── facebookProvider (gh/geldata#6727) ─────────────────────────────────

Deno.test("facebookProvider - returns correct name", () => {
  const p = facebookProvider("cid", "csecret");
  assertEquals(p.name, "facebook");
});

Deno.test("facebookProvider - returns correct authorize, token, and userinfo URLs", () => {
  const p = facebookProvider("cid", "csecret");
  assertEquals(p.authorizeUrl, "https://www.facebook.com/v18.0/dialog/oauth");
  assertEquals(p.tokenUrl, "https://graph.facebook.com/v18.0/oauth/access_token");
  assertEquals(p.userInfoUrl, "https://graph.facebook.com/me?fields=id,name,email");
});

Deno.test("facebookProvider - includes email and public_profile scopes", () => {
  const p = facebookProvider("cid", "csecret");
  assertEquals(p.scopes.includes("email"), true);
  assertEquals(p.scopes.includes("public_profile"), true);
});

// ── linkedinProvider (gh/geldata#6726) ─────────────────────────────────

Deno.test("linkedinProvider - returns correct name", () => {
  const p = linkedinProvider("cid", "csecret");
  assertEquals(p.name, "linkedin");
});

Deno.test("linkedinProvider - returns correct authorize, token, and userinfo URLs", () => {
  const p = linkedinProvider("cid", "csecret");
  assertEquals(p.authorizeUrl, "https://www.linkedin.com/oauth/v2/authorization");
  assertEquals(p.tokenUrl, "https://www.linkedin.com/oauth/v2/accessToken");
  assertEquals(p.userInfoUrl, "https://api.linkedin.com/v2/userinfo");
});

Deno.test("linkedinProvider - uses OIDC scopes (openid+profile+email)", () => {
  const p = linkedinProvider("cid", "csecret");
  assertEquals(p.scopes, ["openid", "profile", "email"]);
});

// ── keycloakProvider (gh/geldata#7370) ─────────────────────────────────

Deno.test("keycloakProvider - constructs realm-scoped endpoints", () => {
  const p = keycloakProvider({
    baseUrl: "https://kc.example.com",
    realm: "myrealm",
    clientId: "cid",
    clientSecret: "csecret",
  });
  assertEquals(p.authorizeUrl, "https://kc.example.com/realms/myrealm/protocol/openid-connect/auth");
  assertEquals(p.tokenUrl, "https://kc.example.com/realms/myrealm/protocol/openid-connect/token");
  assertEquals(p.userInfoUrl, "https://kc.example.com/realms/myrealm/protocol/openid-connect/userinfo");
});

Deno.test("keycloakProvider - default name is keycloak", () => {
  const p = keycloakProvider({
    baseUrl: "https://kc.example.com",
    realm: "myrealm",
    clientId: "cid",
    clientSecret: "csecret",
  });
  assertEquals(p.name, "keycloak");
});

Deno.test("keycloakProvider - honors custom name override (multi-realm deployments)", () => {
  const p = keycloakProvider({
    baseUrl: "https://kc.example.com",
    realm: "tenant-a",
    clientId: "cid",
    clientSecret: "csecret",
    name: "kc-tenant-a",
  });
  assertEquals(p.name, "kc-tenant-a");
});

Deno.test("keycloakProvider - strips trailing slash from baseUrl", () => {
  const p = keycloakProvider({
    baseUrl: "https://kc.example.com/",
    realm: "r",
    clientId: "cid",
    clientSecret: "csecret",
  });
  assertEquals(p.authorizeUrl, "https://kc.example.com/realms/r/protocol/openid-connect/auth");
});

Deno.test("keycloakProvider - defaults scopes to openid+email+profile", () => {
  const p = keycloakProvider({
    baseUrl: "https://kc.example.com",
    realm: "r",
    clientId: "cid",
    clientSecret: "csecret",
  });
  assertEquals(p.scopes, ["openid", "email", "profile"]);
});

Deno.test("keycloakProvider - forwards allowedRedirectUris", () => {
  const p = keycloakProvider({
    baseUrl: "https://kc.example.com",
    realm: "r",
    clientId: "cid",
    clientSecret: "csecret",
    allowedRedirectUris: ["https://*.tenant.com/cb"],
  });
  assertEquals(p.allowedRedirectUris, ["https://*.tenant.com/cb"]);
});

// ── genericOidcProvider ───────────────────────────────────────────────
// gh/geldata#7415, ports geldata/gel#7510

Deno.test("genericOidcProvider - passes through name and endpoints", () => {
  const p = genericOidcProvider({
    authorizeUrl: "https://issuer.example.com/oauth/authorize",
    clientId: "cid",
    clientSecret: "csecret",
    issuerUrl: "https://issuer.example.com",
    name: "keycloak",
    tokenUrl: "https://issuer.example.com/oauth/token",
    userInfoUrl: "https://issuer.example.com/oauth/userinfo",
  });

  assertEquals(p.name, "keycloak");
  assertEquals(p.authorizeUrl, "https://issuer.example.com/oauth/authorize");
  assertEquals(p.tokenUrl, "https://issuer.example.com/oauth/token");
  assertEquals(p.userInfoUrl, "https://issuer.example.com/oauth/userinfo");
  assertEquals(p.clientId, "cid");
});

Deno.test("genericOidcProvider - defaults scopes to openid+email+profile", () => {
  const p = genericOidcProvider({
    authorizeUrl: "https://x/a",
    clientId: "cid",
    clientSecret: "csecret",
    issuerUrl: "https://x",
    name: "x",
    tokenUrl: "https://x/t",
    userInfoUrl: "https://x/u",
  });

  assertEquals(p.scopes, ["openid", "email", "profile"]);
});

Deno.test("genericOidcProvider - honors caller-supplied scopes", () => {
  const p = genericOidcProvider({
    authorizeUrl: "https://x/a",
    clientId: "cid",
    clientSecret: "csecret",
    issuerUrl: "https://x",
    name: "x",
    scopes: ["openid", "groups"],
    tokenUrl: "https://x/t",
    userInfoUrl: "https://x/u",
  });

  assertEquals(p.scopes, ["openid", "groups"]);
});

Deno.test("genericOidcProvider - forwards allowedRedirectUris and redirectUri", () => {
  const p = genericOidcProvider({
    allowedRedirectUris: ["https://*.example.com/cb"],
    authorizeUrl: "https://x/a",
    clientId: "cid",
    clientSecret: "csecret",
    issuerUrl: "https://x",
    name: "x",
    redirectUri: "https://app.example.com/cb",
    tokenUrl: "https://x/t",
    userInfoUrl: "https://x/u",
  });

  assertEquals(p.redirectUri, "https://app.example.com/cb");
  assertEquals(p.allowedRedirectUris, ["https://*.example.com/cb"]);
});

// ── createOidcProvider (async, with discovery) ────────────────────────

function mockFetchJson(
  body: unknown,
  status = 200,
): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status }),
    )) as typeof fetch;
}

Deno.test("createOidcProvider - resolves endpoints via discovery", async () => {
  const f = mockFetchJson({
    authorization_endpoint: "https://issuer.example.com/oauth/authorize",
    issuer: "https://issuer.example.com",
    token_endpoint: "https://issuer.example.com/oauth/token",
    userinfo_endpoint: "https://issuer.example.com/oauth/userinfo",
  });

  const p = await createOidcProvider({
    clientId: "cid",
    clientSecret: "csecret",
    issuerUrl: "https://issuer.example.com",
    name: "zitadel",
  }, f);

  assertEquals(p.name, "zitadel");
  assertEquals(p.authorizeUrl, "https://issuer.example.com/oauth/authorize");
  assertEquals(p.tokenUrl, "https://issuer.example.com/oauth/token");
  assertEquals(p.userInfoUrl, "https://issuer.example.com/oauth/userinfo");
});

Deno.test("createOidcProvider - throws when issuer omits userinfo_endpoint", async () => {
  const f = mockFetchJson({
    authorization_endpoint: "https://x/a",
    issuer: "https://x",
    token_endpoint: "https://x/t",
  });

  await assertRejects(
    () =>
      createOidcProvider({
        clientId: "cid",
        clientSecret: "csecret",
        issuerUrl: "https://x",
        name: "minimal",
      }, f),
    Error,
    "does not advertise a userinfo_endpoint",
  );
});

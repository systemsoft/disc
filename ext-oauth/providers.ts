/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * OAuth provider factory functions
 */

import { fetchOidcDiscovery } from "./discovery.ts";
import type { OAuthProviderConfig } from "./types.ts";

export function googleProvider(
  clientId: string,
  clientSecret: string,
  redirectUri?: string
): OAuthProviderConfig {
  return {
    name: "google",
    clientId,
    clientSecret,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scopes: ["openid", "email", "profile"],
    redirectUri
  };
}

export function githubProvider(
  clientId: string,
  clientSecret: string,
  redirectUri?: string
): OAuthProviderConfig {
  return {
    name: "github",
    clientId,
    clientSecret,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: ["user:email"],
    redirectUri
  };
}

export function appleProvider(
  clientId: string,
  clientSecret: string,
  redirectUri?: string
): OAuthProviderConfig {
  return {
    name: "apple",
    clientId,
    clientSecret,
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    userInfoUrl: "https://appleid.apple.com/auth/userinfo",
    scopes: ["name", "email"],
    redirectUri
  };
}

/**
 * X (formerly Twitter) OAuth 2.0 with PKCE. The existing extension
 * already attaches `code_challenge`/`code_challenge_method=S256`, which
 * X requires. (gh/geldata#6728)
 */
export function twitterProvider(
  clientId: string,
  clientSecret: string,
  redirectUri?: string
): OAuthProviderConfig {
  return {
    name: "twitter",
    clientId,
    clientSecret,
    authorizeUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    userInfoUrl: "https://api.twitter.com/2/users/me",
    scopes: ["tweet.read", "users.read"],
    redirectUri
  };
}

/**
 * Facebook Login (Graph API). The default `userInfoUrl` requests `id`,
 * `name`, and `email` — Facebook's `/me` endpoint requires explicit
 * `fields=` to return anything beyond the id. (gh/geldata#6727)
 */
export function facebookProvider(
  clientId: string,
  clientSecret: string,
  redirectUri?: string
): OAuthProviderConfig {
  return {
    name: "facebook",
    clientId,
    clientSecret,
    authorizeUrl: "https://www.facebook.com/v18.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v18.0/oauth/access_token",
    userInfoUrl: "https://graph.facebook.com/me?fields=id,name,email",
    scopes: ["email", "public_profile"],
    redirectUri
  };
}

/**
 * LinkedIn (Sign In with LinkedIn — OIDC profile). Uses the OIDC
 * userinfo endpoint, not the legacy `/v2/me`, so `email_verified` and
 * standard claims work. (gh/geldata#6726)
 */
export function linkedinProvider(
  clientId: string,
  clientSecret: string,
  redirectUri?: string
): OAuthProviderConfig {
  return {
    name: "linkedin",
    clientId,
    clientSecret,
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    userInfoUrl: "https://api.linkedin.com/v2/userinfo",
    scopes: ["openid", "profile", "email"],
    redirectUri
  };
}

export interface KeycloakProviderOptions {
  /** Keycloak base URL, e.g. `https://kc.example.com`. No trailing slash. */
  baseUrl: string;
  /** Realm name (Keycloak namespaces every config under a realm). */
  realm: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  allowedRedirectUris?: string[];
  /** Override scopes. Defaults to `["openid", "email", "profile"]`. */
  scopes?: string[];
  /** Override the `/authorize/<name>` segment. Defaults to `keycloak`. */
  name?: string;
}

/**
 * Keycloak OAuth/OIDC provider. Keycloak realms have predictable
 * endpoint paths so this factory constructs them synchronously without
 * a discovery round-trip — use `createOidcProvider({issuerUrl: ...})`
 * if you'd prefer to fetch `.well-known/openid-configuration`.
 * (gh/geldata#7370)
 */
export function keycloakProvider(
  opts: KeycloakProviderOptions
): OAuthProviderConfig {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const realmBase = `${base}/realms/${opts.realm}/protocol/openid-connect`;
  return {
    allowedRedirectUris: opts.allowedRedirectUris,
    authorizeUrl: `${realmBase}/auth`,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    name: opts.name ?? "keycloak",
    redirectUri: opts.redirectUri,
    scopes: opts.scopes ?? ["openid", "email", "profile"],
    tokenUrl: `${realmBase}/token`,
    userInfoUrl: `${realmBase}/userinfo`
  };
}

// ── Generic OpenID Connect ────────────────────────────────────────────
//
// Ports geldata/gel#7510 (resolves geldata/gel#7415 + #6908 — Zitadel,
// Keycloak, Auth0, Okta, Azure AD, etc.). Works with any provider that
// publishes a compliant `.well-known/openid-configuration` document.

export interface OidcProviderOptions {
  /** Provider name surfaced in `/authorize/<name>` and audit logs. */
  name: string;
  /** OIDC issuer URL (no trailing slash, no `.well-known` suffix). */
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  allowedRedirectUris?: string[];
  /**
   * Override scopes. Defaults to `["openid", "email", "profile"]` —
   * the minimum set every conformant OIDC provider must accept.
   */
  scopes?: string[];
}

/**
 * Synchronous factory for generic OIDC providers when the caller
 * already knows the endpoints (e.g. fetched discovery once at boot
 * and cached in config). Use `createOidcProvider()` for the async
 * discovery-then-build flow.
 */
export function genericOidcProvider(
  opts: OidcProviderOptions & {
    authorizeUrl: string;
    tokenUrl: string;
    userInfoUrl: string;
  }
): OAuthProviderConfig {
  return {
    allowedRedirectUris: opts.allowedRedirectUris,
    authorizeUrl: opts.authorizeUrl,
    clientId: opts.clientId,
    clientSecret: opts.clientSecret,
    name: opts.name,
    redirectUri: opts.redirectUri,
    scopes: opts.scopes ?? ["openid", "email", "profile"],
    tokenUrl: opts.tokenUrl,
    userInfoUrl: opts.userInfoUrl
  };
}

/**
 * Async factory that fetches the issuer's discovery document and
 * builds an `OAuthProviderConfig` from it. Throws if the issuer
 * doesn't expose a `userinfo_endpoint` — disc's flow needs it to
 * resolve user identity. Pass a custom `fetchImpl` for testing.
 */
export async function createOidcProvider(
  opts: OidcProviderOptions,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthProviderConfig> {
  const doc = await fetchOidcDiscovery(opts.issuerUrl, fetchImpl);

  if (!doc.userInfoEndpoint) {
    throw new Error(
      `OIDC provider '${opts.name}' (${opts.issuerUrl}) does not advertise a userinfo_endpoint — disc requires one to resolve user identity`
    );
  }

  return genericOidcProvider({
    ...opts,
    authorizeUrl: doc.authorizationEndpoint,
    tokenUrl: doc.tokenEndpoint,
    userInfoUrl: doc.userInfoEndpoint
  });
}

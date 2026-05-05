/**
 * OAuth provider factory functions
 */

import type { OAuthProviderConfig } from "./types.ts";
import { fetchOidcDiscovery } from "./discovery.ts";

export function googleProvider(
  clientId: string,
  clientSecret: string,
  redirectUri?: string,
): OAuthProviderConfig {
  return {
    name: "google",
    clientId,
    clientSecret,
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scopes: ["openid", "email", "profile"],
    redirectUri,
  };
}

export function githubProvider(
  clientId: string,
  clientSecret: string,
  redirectUri?: string,
): OAuthProviderConfig {
  return {
    name: "github",
    clientId,
    clientSecret,
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: ["user:email"],
    redirectUri,
  };
}

export function appleProvider(
  clientId: string,
  clientSecret: string,
  redirectUri?: string,
): OAuthProviderConfig {
  return {
    name: "apple",
    clientId,
    clientSecret,
    authorizeUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    userInfoUrl: "https://appleid.apple.com/auth/userinfo",
    scopes: ["name", "email"],
    redirectUri,
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
  },
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
    userInfoUrl: opts.userInfoUrl,
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
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthProviderConfig> {
  const doc = await fetchOidcDiscovery(opts.issuerUrl, fetchImpl);

  if (!doc.userInfoEndpoint) {
    throw new Error(
      `OIDC provider '${opts.name}' (${opts.issuerUrl}) does not advertise a userinfo_endpoint — disc requires one to resolve user identity`,
    );
  }

  return genericOidcProvider({
    ...opts,
    authorizeUrl: doc.authorizationEndpoint,
    tokenUrl: doc.tokenEndpoint,
    userInfoUrl: doc.userInfoEndpoint,
  });
}

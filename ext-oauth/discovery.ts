/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * OpenID Connect discovery (RFC 8414 / OpenID-Connect-Discovery 1.0).
 *
 * Fetches `<issuerUrl>/.well-known/openid-configuration` and surfaces the
 * endpoints disc's OAuth flow consumes (`authorization_endpoint`,
 * `token_endpoint`, `userinfo_endpoint`). Used by the generic OIDC
 * factory so users don't have to hand-write three URLs per provider.
 * (gh/geldata#7415, ports geldata/gel#7510)
 */

export interface OidcDiscoveryDoc {
  /** OIDC issuer (`iss` claim, used to validate id_tokens). */
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /**
   * OIDC marks `userinfo_endpoint` as RECOMMENDED, not required. Some
   * issuers (e.g. plain OAuth2 servers behind an OIDC facade) omit it.
   * Disc's user-info fetch will fail loudly if a caller picks such a
   * provider — that's intentional, OIDC without userinfo gives us no
   * user identity.
   */
  userInfoEndpoint?: string;
  jwksUri?: string;
  scopesSupported?: string[];
}

/**
 * Build the well-known URL. Per RFC 8414 §3, the path is appended to
 * the issuer's authority component, preserving the issuer's path
 * prefix (so `https://accounts.example.com/realm/foo` →
 * `https://accounts.example.com/realm/foo/.well-known/openid-configuration`).
 */
export function buildDiscoveryUrl(issuerUrl: string): string {
  const trimmed = issuerUrl.replace(/\/+$/, "");
  return `${trimmed}/.well-known/openid-configuration`;
}

/**
 * Fetch + parse the OIDC discovery document. Throws if the document
 * is unreachable, malformed, or missing required endpoints.
 */
export async function fetchOidcDiscovery(
  issuerUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<OidcDiscoveryDoc> {
  const url = buildDiscoveryUrl(issuerUrl);
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(
      `OIDC discovery failed for ${issuerUrl}: ${response.status} ${response.statusText}`
    );
  }

  const doc = await response.json() as Record<string, unknown>;

  const issuer = doc["issuer"];
  const authorizationEndpoint = doc["authorization_endpoint"];
  const tokenEndpoint = doc["token_endpoint"];

  if (
    typeof issuer !== "string" ||
    typeof authorizationEndpoint !== "string" ||
    typeof tokenEndpoint !== "string"
  ) {
    throw new Error(
      `OIDC discovery doc at ${url} is missing required endpoints (issuer / authorization_endpoint / token_endpoint)`
    );
  }

  return {
    authorizationEndpoint,
    issuer,
    jwksUri: typeof doc["jwks_uri"] === "string" ? doc["jwks_uri"] : undefined,
    scopesSupported: Array.isArray(doc["scopes_supported"]) ?
      doc["scopes_supported"].filter((s): s is string => typeof s === "string") :
      undefined,
    tokenEndpoint,
    userInfoEndpoint: typeof doc["userinfo_endpoint"] === "string" ?
      doc["userinfo_endpoint"] :
      undefined
  };
}

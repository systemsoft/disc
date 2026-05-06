/**
 * OAuth token exchange and user info fetching
 */

import { normalizePkceParam } from "./pkce.ts";
import type { OAuthProviderConfig, OAuthUserInfo } from "./types.ts";

export interface TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
}

export async function exchangeCodeForToken(
  provider: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  // P1-41: PKCE code_verifier is required by providers that received
  // a code_challenge in the authorize redirect. Forward it when the
  // state-manager populated one.
  // gh/geldata#7596: strip RFC 7636-disallowed trailing `=` padding
  // before forwarding. Some clients pad base64url; upstream providers
  // that compare strictly will reject the padded form even though the
  // underlying bytes match.
  if (codeVerifier) {
    body.set("code_verifier", normalizePkceParam(codeVerifier));
  }

  const response = await fetch(provider.tokenUrl, {
    body: body.toString(),
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const data = await response.json() as Record<string, unknown>;
  return {
    accessToken: String(data["access_token"] ?? ""),
    expiresIn: typeof data["expires_in"] === "number" ? data["expires_in"] : undefined,
    tokenType: String(data["token_type"] ?? "Bearer"),
  };
}

export async function fetchUserInfo(
  provider: OAuthProviderConfig,
  accessToken: string,
): Promise<OAuthUserInfo> {
  const response = await fetch(provider.userInfoUrl, {
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`User info fetch failed: ${response.status} ${text}`);
  }

  const data = await response.json() as Record<string, unknown>;

  // Normalize across providers. (gh/geldata#7344)
  //   - OIDC standard: `sub`/`email`/`email_verified`/`name`/`given_name`/
  //     `family_name`/`picture`/`locale`.
  //   - GitHub: `id` / `login` / `avatar_url`.
  //
  // `email_verified` is parsed permissively (some providers send the
  // string `"true"` instead of a JSON boolean — both Apple and a few
  // SAML-bridge providers do this) so downstream code can rely on a
  // boolean. Anything that isn't recognizable as a boolean is dropped
  // rather than coerced to `false` — "absence" is a meaningful state
  // distinct from "unverified".
  const rawEmailVerified = data["email_verified"];
  let emailVerified: boolean | undefined;
  if (typeof rawEmailVerified === "boolean") {
    emailVerified = rawEmailVerified;
  } else if (rawEmailVerified === "true") {
    emailVerified = true;
  } else if (rawEmailVerified === "false") {
    emailVerified = false;
  }

  return {
    avatarUrl: typeof data["picture"] === "string" ? data["picture"] : typeof data["avatar_url"] === "string" ? data["avatar_url"] : undefined,
    email: typeof data["email"] === "string" ? data["email"] : undefined,
    emailVerified,
    familyName: typeof data["family_name"] === "string" ? data["family_name"] : undefined,
    givenName: typeof data["given_name"] === "string" ? data["given_name"] : undefined,
    id: String(data["sub"] ?? data["id"] ?? ""),
    locale: typeof data["locale"] === "string" ? data["locale"] : undefined,
    name: typeof data["name"] === "string" ? data["name"] : typeof data["login"] === "string" ? data["login"] : undefined,
    raw: data,
  };
}

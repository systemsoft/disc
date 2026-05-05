/**
 * OAuth token exchange and user info fetching
 */

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
  if (codeVerifier) {
    body.set("code_verifier", codeVerifier);
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
    expiresIn: typeof data["expires_in"] === "number"
      ? data["expires_in"]
      : undefined,
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

  // Normalize across providers
  return {
    avatarUrl: typeof data["picture"] === "string"
      ? data["picture"]
      : typeof data["avatar_url"] === "string"
      ? data["avatar_url"]
      : undefined,
    email: typeof data["email"] === "string" ? data["email"] : undefined,
    id: String(data["sub"] ?? data["id"] ?? ""),
    name: typeof data["name"] === "string"
      ? data["name"]
      : typeof data["login"] === "string"
      ? data["login"]
      : undefined,
    raw: data,
  };
}

/**
 * OAuth provider factory functions
 */

import type { OAuthProviderConfig } from "./types.ts";

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

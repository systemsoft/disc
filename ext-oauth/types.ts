/**
 * OAuth extension types for Disc database
 */

export interface OAuthProviderConfig {
  name: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
  redirectUri?: string;
}

export interface OAuthConfig {
  providers: OAuthProviderConfig[];
  stateExpiryMs?: number; // default: 600000 (10 minutes)
  defaultRedirectUri?: string;
}

export interface OAuthUserInfo {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  raw: Record<string, unknown>;
}

export interface OAuthState {
  state: string;
  provider: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
  /**
   * PKCE code_verifier (RFC 7636). 43-128 URL-safe chars. Stored server-side
   * when the state is created; replayed back during token exchange as
   * `code_verifier` so the authorization server can verify the original
   * client that started the flow is the one completing it. (P1-41)
   */
  codeVerifier?: string;
  /**
   * SHA-256 hash (base64url) of the code_verifier, sent as
   * `code_challenge` in the initial authorize redirect.
   */
  codeChallenge?: string;
}

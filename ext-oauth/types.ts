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
  /**
   * Fixed callback URI used when no per-request override is supplied
   * and `allowedRedirectUris` is empty/unset. The OAuth provider
   * (Google, GitHub, …) must have this exact value registered in its
   * console.
   */
  redirectUri?: string;
  /**
   * Allowlist of caller-supplied `redirect_uri` query params accepted
   * by `/authorize/<provider>?redirect_uri=…`. Each entry is a literal
   * URI or a wildcard pattern; a single `*` in the host position
   * matches exactly one DNS label, e.g. `https://*.example.com/cb`
   * matches `https://app.example.com/cb` but NOT
   * `https://a.b.example.com/cb` or `https://example.com/cb`.
   * Scheme, port, and path must match exactly. Useful for
   * multi-tenant deployments where every tenant gets a subdomain.
   * (gh/geldata#7468)
   */
  allowedRedirectUris?: string[];
  /**
   * Extra params to append to the authorize URL. Use cases:
   *   - Google: `{ access_type: "offline", prompt: "consent" }` to get
   *     a refresh token + force the consent screen on every login.
   *   - Microsoft Entra: `{ prompt: "select_account" }`.
   *   - Any provider: `{ login_hint: "user@example.com" }`.
   *
   * Reserved param names (`client_id`, `redirect_uri`, `response_type`,
   * `scope`, `state`, `code_challenge`, `code_challenge_method`) are
   * rejected at construction since overriding them would break the flow.
   * (gh/geldata#7752)
   */
  extraAuthorizeParams?: Record<string, string>;
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
  /**
   * Caller-supplied opaque blob carried through the OAuth handshake.
   * The authorize endpoint accepts it as a JSON-encoded `metadata`
   * query param; the callback returns it verbatim in the response.
   * Most common use: a `next` URL the calling app redirects to after
   * the OAuth flow completes. Capped at 2 KB JSON to keep the in-memory
   * state map bounded. (gh/geldata#8841)
   */
  metadata?: Record<string, unknown>;
}

/**
 * Structured error returned by `/authorize` and `/callback` failure
 * paths. `code` is stable for programmatic handling; `message` is
 * user-facing; `details` is operator-facing and may include the
 * upstream provider's error string. (gh/geldata#8950)
 */
export interface OAuthErrorResponse {
  error: {
    code:
      | "missing_parameter"
      | "invalid_state"
      | "redirect_uri_not_allowed"
      | "redirect_uri_override_disabled"
      | "metadata_too_large"
      | "metadata_invalid"
      | "oauth_provider_error"
      | "token_exchange_failed"
      | "userinfo_failed";
    message: string;
    details?: string;
  };
}

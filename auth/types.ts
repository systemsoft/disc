/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Authentication Types and Interfaces
 */

/*** EXPORT ------------------------------------------- ***/

export enum AuthErrorCode {
  EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED",
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  /**
   * Operation invalid for the user’s current state — e.g. trying to
   * upgrade a user that’s already a full identity. (gh/geldata#8750)
   */
  INVALID_OPERATION = "INVALID_OPERATION",
  INVALID_REFRESH_TOKEN = "INVALID_REFRESH_TOKEN",
  INVALID_TOKEN = "INVALID_TOKEN",
  PASSWORD_TOO_WEAK = "PASSWORD_TOO_WEAK",
  REGISTRATION_DISABLED = "REGISTRATION_DISABLED",
  SESSION_EXPIRED = "SESSION_EXPIRED",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  USER_ALREADY_EXISTS = "USER_ALREADY_EXISTS",
  USER_INACTIVE = "USER_INACTIVE",
  USER_NOT_FOUND = "USER_NOT_FOUND"
}

/**
 * Branding fields applied to email templates and the admin UI. All
 * fields are optional; defaults render as a generic "your account"
 * identity. Strict input rules:
 *
 *  - `appName`: 1–80 chars, no CR/LF (would splice email headers).
 *  - `logoUrl` / `darkLogoUrl`: must be `https://` (or `http://` for
 *    `localhost`/`127.0.0.1` in development). `data:`, `javascript:`,
 *    and other schemes are rejected outright (XSS via inline-rendered
 *    HTML emails). 1–2048 chars.
 *  - `brandColor`: 3- or 6-digit hex (`#0af` or `#00aaff`) or a CSS-L4
 *    `oklch(L C H[/ A])` expression (e.g. `oklch(70% 0.15 200)`, with
 *    L/C/H/alpha range-checked). Anything else (named colors, `rgb(...)`,
 *    etc.) is rejected so the value is safe to splat into inline CSS
 *    without an escape pass.
 *
 * Validation errors are thrown at `AuthProvider` construction —
 * deployment refuses to boot with bad branding rather than emitting
 * mangled emails. (gh/geldata#7938)
 */
export interface AuthBrandingConfig {
  appName?: string;
  brandColor?: string;
  darkLogoUrl?: string;
  logoUrl?: string;
}

export interface AuthConfig {
  /**
   * When `true`, `requestMagicLink(email)` for an unknown email persists
   * a token bound to the pending email address; `consumeMagicLink`
   * creates the user on first redemption (active, email_verified=true
   * since they proved email control). When `false` (default),
   * `requestMagicLink` for unknown emails returns a token that’s never
   * persisted — preserves anti-enumeration. (gh/geldata#7311)
   */
  allowImplicitSignup?: boolean;
  allowRegistration?: boolean;
  bcryptRounds?: number;
  /**
   * Branding/identity surface used by built-in email templates and
   * the admin UI. Lets deployments customize the "from" identity
   * without forking the templates. Each field is sanitized at
   * construction (CRLF rejected, scheme-checked, length-capped) so a
   * misconfig fails loud at boot. (gh/geldata#6731 / #6732 / #7938)
   */
  branding?: AuthBrandingConfig;
  /**
   * Pluggable captcha gate (hCaptcha / Cloudflare Turnstile) for
   * sensitive public auth endpoints. When set, the corresponding
   * `AuthRoutes` handlers require a `captchaToken` field on the
   * request body and verify it against the provider before any DB
   * work runs. When omitted, captcha is disabled entirely.
   * (gh/geldata#7341)
   */
  captcha?: import("./captcha.ts").CaptchaConfig;
  /**
   * Base URL the built-in email templates use to construct
   * verification / password-reset / magic-link URLs. Required to
   * enable the SMTP email listener — without it, links would point
   * nowhere. Setting `smtp` without `emailBaseUrl` is a misconfig
   * that’s surfaced at construction.
   */
  emailBaseUrl?: string;
  /**
   * Per-event email-template overrides. Default templates ship in
   * `auth/email-templates.ts`; supply any of `verification`,
   * `passwordReset`, `magicLink` to swap in your own renderer.
   */
  emailTemplates?: import("./email-templates.ts").EmailTemplateOverrides;
  /**
   * JWT signing algorithm. Default `"HS256"` (shared secret). Use
   * `"RS256"` to sign with an RSA private key and let verifiers hold
   * only the public key — useful when downstream services need to
   * verify tokens without the ability to mint them. (P3-04)
   */
  jwtAlgorithm?: "HS256" | "RS256";
  jwtAudience?: string;
  jwtIssuer?: string;
  /**
   * PEM-encoded RSA private key (PKCS#8). Required when
   * `jwtAlgorithm` is `"RS256"`. Used only by token-minting servers;
   * verify-only deployments can omit it provided they never call
   * `register()`/`login()`/`refresh()`.
   */
  jwtPrivateKey?: string;
  /**
   * PEM-encoded RSA public key (SPKI). Required when `jwtAlgorithm`
   * is `"RS256"`. Used to verify tokens.
   */
  jwtPublicKey?: string;
  /**
   * HS256 shared secret. Required when `jwtAlgorithm` is `"HS256"`
   * (the default); ignored under `"RS256"`. Must be at least 32 bytes.
   */
  jwtSecret?: string;
  /**
   * Magic-link URL template used to render the link target in the
   * built-in email template. Supports a single `{token}` placeholder
   * that is replaced with the URL-encoded plaintext token. When
   * omitted, falls back to `${emailBaseUrl}/auth/magic?token=<token>`.
   *
   * Example: `https://app.example.com/auth/magic?token={token}` or
   * `https://app.example.com/login/{token}` for path-style URLs.
   *
   * Validated at construction: must be `https://` (or `http://` for
   * localhost/loopback during development) and must contain the
   * `{token}` placeholder. (gh/geldata#8028, ports geldata/gel#8030)
   */
  magicLinkUrlTemplate?: string;
  /**
   * Cap on simultaneously-active sessions per user. When set and the
   * user already has N active sessions, creating a new session revokes
   * the oldest. Defaults to unlimited. (P2-22)
   */
  maxSessionsPerUser?: number;
  passwordMinLength?: number;
  passwordRequireNumbers?: boolean;
  passwordRequireSpecial?: boolean;
  passwordRequireUppercase?: boolean;
  refreshTokenExpiry?: number; /*** seconds ***/
  requireEmailVerification?: boolean;
  sessionTimeout?: number; /*** seconds ***/
  /**
   * SMTP transport config. Optional — when omitted (and
   * `emailBaseUrl` is set) Disc registers a `NoopMailer` so the
   * email-listener wiring still runs and can be swapped for real
   * SMTP later without code changes. (gh/geldata#8224)
   */
  smtp?: import("../smtp/types.ts").SmtpConfig;
  tokenExpiry?: number; /*** seconds ***/
  /**
   * WebAuthn / passkey relying-party config. When omitted, the
   * `beginWebAuthnRegistration` / `finishWebAuthnRegistration` /
   * `beginWebAuthnLogin` / `finishWebAuthnLogin` methods all throw —
   * apps that don’t want passkeys simply leave this off.
   * (gh/geldata#6725)
   */
  webauthn?: WebAuthnConfig;
  /**
   * Webhook subscriptions for auth lifecycle events. Each entry is
   * delivered fire-and-forget after the relevant event happens
   * (sign-up, login, password reset, email verification). HMAC-SHA256
   * signing is supported per-subscription via `secret`.
   * (gh/geldata#7484, ports geldata/gel#7813)
   */
  webhooks?: import("./webhooks.ts").WebhookConfig[];
}

export interface AuthProvider {
  getUser(userId: string): Promise<User | null>;
  login(credentials: LoginCredentials): Promise<LoginResult>;
  logout(sessionId: string): Promise<void>;
  refresh(refreshToken: string, meta?: RequestMeta): Promise<AuthResponse>;
  register(data: RegisterData): Promise<AuthResponse>;
  /**
   * Re-issue an email-verification token, invalidating the prior one.
   * Silent on unknown / already-verified emails to avoid leaking account
   * state. Returns plaintext for the caller to email; DB stores hash
   * only. (gh/geldata#6503)
   */
  resendVerification(email: string): Promise<string | null>;
  resetPassword(reset_token: string, new_password: string): Promise<void>;
  resetPasswordRequest(email: string): Promise<string>; /*** returns reset token ***/
  revokeAllSessions(userId: string): Promise<void>;
  updatePassword(userId: string, old_password: string, new_password: string): Promise<void>;
  verifyEmail(verification_token: string): Promise<void>;
  verifyToken(token: string): Promise<TokenPayload>;
}

export interface AuthResponse {
  /**
   * Compact identity view — same id/email/createdAt as `user` plus the
   * role-name snapshot. Populated on `register()` so callers can stash
   * the identity without a follow-up `getUser()`. Optional on the type
   * to keep older callers and synthetic anonymous flows source-compatible.
   * (gh/geldata#7275)
   */
  identity?: Identity;
  refreshToken?: string;
  session: Session;
  token: string;
  user: Omit<User, "passwordHash">;
  /**
   * Plaintext email verification token. Only populated on `register()` when
   * `requireEmailVerification: true`. The DB stores only the hash — the
   * plaintext must be delivered to the user out-of-band (typically by the
   * caller emailing it). After register() returns, the plaintext cannot be
   * recovered. (P0-03)
   */
  verificationToken?: string;
}

/**
 * Compact "identity" view returned alongside the full `user` on
 * registration responses. Mirrors Gel’s `ext::auth::Identity` shape so
 * callers porting from Gel get the same record without an extra GET.
 * Includes the role-name snapshot at issue time (same semantics as
 * `TokenPayload.roles`). (gh/geldata#7275)
 */
export interface Identity {
  createdAt: Date;
  email: string;
  emailVerified: boolean;
  id: string;
  /**
   * Role names attached to this identity at the moment the response
   * was issued. Empty array when the user has no roles assigned.
   * Snapshot semantics — roles assigned after the response went out
   * won’t show here.
   */
  roles: string[];
}

export interface LoginCredentials {
  email?: string;
  meta?: RequestMeta;
  password: string;
  username?: string;
}

/**
 * MFA challenge returned from `login()` when the user has TOTP enrolled.
 * The caller has already proven knowledge of the password — they now
 * need to prove possession of the second factor. The challenge token is
 * short-lived (default 5 min) and single-use. (gh/geldata#8186)
 */
export interface MfaChallenge {
  challengeToken: string;
  /** Which factor types the user has enrolled. */
  factors: Array<"totp">;
  mfaRequired: true;
}

export interface PasswordValidationResult {
  errors: string[];
  valid: boolean;
}

export interface RegisterData {
  email: string;
  meta?: RequestMeta;
  metadata?: Record<string, any>;
  password: string;
  username?: string;
}

/**
 * Per-request metadata captured from the HTTP layer and stored on the
 * resulting session row. Drives anomaly detection on `refresh()` (a new
 * IP/User-Agent for the same user emits an `auth.session_refreshed_from_new_ip`
 * audit event) and audit-trail enrichment for the standard auth events.
 * (P2-21)
 */
export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface Session {
  createdAt: Date;
  expiresAt: Date;
  id: string;
  ipAddress?: string;
  lastActivity?: Date;
  refreshToken?: string;
  token: string;
  userAgent?: string;
  userId: string;
}

export interface TokenPayload {
  aud?: string; /*** audience ***/
  email: string;
  exp: number; /*** expires at ***/
  iat: number; /*** issued at ***/
  iss?: string; /*** issuer ***/
  jti?: string; /*** JWT ID for tracking ***/
  /**
   * RBAC role names granted to this user at token-issue time. Restored
   * by `verifyToken()` and surfaced on `AuthContext.roles` so access
   * policies (`has_role()`, `current_role`) and the compilation cache
   * key both see them. Snapshot semantics — roles assigned *after*
   * the token was issued won’t take effect until the user re-logs.
   * (gh/geldata#8177)
   */
  roles?: string[];
  sub: string; /*** user id ***/
  username?: string;
}

/**
 * Returned from `enrollTOTP()` so callers can render the QR code and
 * keep the secret around for `confirmTOTP()`. The secret is base32 —
 * authenticator apps consume it directly, and the URI is what’s
 * normally encoded into a QR.
 */
export interface TotpEnrollment {
  otpauthUri: string;
  secret: string;
}

export interface User {
  active: boolean;
  createdAt: Date;
  email: string;
  emailVerified: boolean;
  id: string;
  /**
   * True for guest identities created via `AuthProvider.loginAnonymous()`.
   * The `email` and `passwordHash` are synthetic placeholders for an
   * anonymous user — they exist to satisfy NOT NULL constraints but
   * neither is usable for sign-in. Flipped to `false` by
   * `upgradeAnonymous()`. (gh/geldata#8750)
   */
  isAnonymous?: boolean;
  metadata?: Record<string, any>;
  passwordHash: string;
  updatedAt: Date;
  username?: string;
}

/**
 * Server config for the WebAuthn ceremonies. `rpId` is the apex domain
 * the credentials are scoped to (must match `window.location.host`’s
 * effective domain). `origin` is what the browser sets in
 * `clientDataJSON.origin` — typically `https://${rpId}` but can include
 * a port for development.
 */
export interface WebAuthnConfig {
  origin: string;
  /**
   * Discoverable-credential preference for `beginWebAuthnRegistration`
   * (gh/geldata#7196). When `true`, the registration ceremony asks the
   * authenticator to create a *resident* (discoverable) credential — the
   * authenticator stores user-handle metadata locally so future logins
   * don’t need the user to type their email first. When `false` or
   * omitted, defaults to `"preferred"` so passkey-capable authenticators
   * still create discoverable credentials when they can but legacy
   * security keys without resident-key storage continue to work.
   *
   * Maps to WebAuthn’s `authenticatorSelection.residentKey`:
   *   `true`  → `"required"` (refuses non-discoverable credentials)
   *   omitted → `"preferred"` (default — discoverable when possible)
   *
   * Login already supports discoverable credentials when `email` is
   * omitted from `beginWebAuthnLogin`; this flag only controls
   * registration.
   */
  requireResidentKey?: boolean;
  rpId: string;
  rpName: string;
}

export interface WebAuthnLoginFinish {
  /** base64url(authenticatorData). */
  authenticatorData: string;
  challengeId: string;
  /** base64url(clientDataJSON). */
  clientDataJSON: string;
  /** base64url; from `credential.id`. */
  credentialId: string;
  /** base64url(signature). */
  signature: string;
}

/**
 * Public-credential-request options for the WebAuthn authentication
 * ceremony. `allowCredentials` is populated when we know which user is
 * logging in (i.e. they typed an email first); empty for discoverable
 * credentials. (gh/geldata#6725)
 */
export interface WebAuthnLoginOptions {
  challengeId: string;
  publicKey: {
    allowCredentials?: Array<{ id: string; type: "public-key"; }>;
    challenge: string;
    rpId: string;
    timeout?: number;
    userVerification?: "required" | "preferred" | "discouraged";
  };
}

export interface WebAuthnRegistrationFinish {
  /** base64url(attestationObject) from the AuthenticatorAttestationResponse. */
  attestationObject: string;
  challengeId: string;
  /** base64url(clientDataJSON). */
  clientDataJSON: string;
  /** base64url; from `credential.id`. */
  credentialId: string;
  /** Optional human-readable label set by the user ("My iPhone"). */
  name?: string;
}

/**
 * Public-credential-creation options for the WebAuthn registration
 * ceremony, plus our own `challengeId` so we can correlate `finish`
 * with `begin` without trusting client-supplied state. Caller hands
 * `publicKey` straight to `navigator.credentials.create({ publicKey })`.
 * (gh/geldata#6725)
 */
export interface WebAuthnRegistrationOptions {
  challengeId: string;
  publicKey: {
    attestation?: "none";
    /**
     * Authenticator selection criteria — surfaces discoverable-credential
     * preference (gh/geldata#7196). `residentKey` is the modern
     * preference field; `requireResidentKey` is its boolean fallback for
     * older browsers that haven’t adopted L2.
     */
    authenticatorSelection?: {
      requireResidentKey?: boolean;
      residentKey?: "discouraged" | "preferred" | "required";
      userVerification?: "discouraged" | "preferred" | "required";
    };
    challenge: string; /*** base64url ***/
    excludeCredentials?: Array<{ id: string; type: "public-key"; }>;
    pubKeyCredParams: Array<{ type: "public-key"; alg: number; }>;
    rp: { id: string; name: string; };
    timeout?: number;
    user: { displayName: string; id: string; name: string; };
  };
}

/**
 * Result of `login()` — either a full authenticated session or an MFA
 * challenge that the caller must complete via `loginWithTOTP()`.
 */
export type LoginResult = AuthResponse | MfaChallenge;

export class AuthError extends Error {
  constructor(message: string, public code: AuthErrorCode, public status_code = 401) {
    super(`${code}: ${message}`);
    this.name = "AuthError";
  }
}

/**
 * Type guard discriminating `LoginResult` into the authenticated
 * `AuthResponse` branch. Use in code paths that expect a successful
 * login (no MFA gate). Pairs with `requireAuthResponse` for tests
 * that want to throw on the unexpected MFA-challenge case rather
 * than narrow with an `if`.
 */
export function isAuthResponse(result: LoginResult): result is AuthResponse {
  return !("mfaRequired" in result) || result.mfaRequired !== true;
}

/**
 * Test/CLI helper: assert that a `LoginResult` is the authenticated
 * branch and throw a clear error if it isn’t. Returns the narrowed
 * `AuthResponse` so callers can chain `result.user`/`.token`/etc.
 * without further narrowing. (Bundle KK)
 */
export function requireAuthResponse(result: LoginResult): AuthResponse {
  if (!isAuthResponse(result))
    throw new Error("expected AuthResponse, got MfaChallenge — caller must complete the MFA flow first");

  return result;
}

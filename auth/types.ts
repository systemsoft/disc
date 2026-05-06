/**
 * Authentication Types and Interfaces
 */

export interface User {
  id: string;
  email: string;
  username?: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
  emailVerified: boolean;
  active: boolean;
  metadata?: Record<string, any>;
  /**
   * True for guest identities created via `AuthProvider.loginAnonymous()`.
   * The `email` and `passwordHash` are synthetic placeholders for an
   * anonymous user — they exist to satisfy NOT NULL constraints but
   * neither is usable for sign-in. Flipped to `false` by
   * `upgradeAnonymous()`. (gh/geldata#8750)
   */
  isAnonymous?: boolean;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  refreshToken?: string;
  createdAt: Date;
  expiresAt: Date;
  lastActivity?: Date;
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthConfig {
  /**
   * JWT signing algorithm. Default `"HS256"` (shared secret). Use
   * `"RS256"` to sign with an RSA private key and let verifiers hold
   * only the public key — useful when downstream services need to
   * verify tokens without the ability to mint them. (P3-04)
   */
  jwtAlgorithm?: "HS256" | "RS256";
  /**
   * HS256 shared secret. Required when `jwtAlgorithm` is `"HS256"`
   * (the default); ignored under `"RS256"`. Must be at least 32 bytes.
   */
  jwtSecret?: string;
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
  jwtIssuer?: string;
  jwtAudience?: string;
  tokenExpiry?: number; // seconds
  refreshTokenExpiry?: number; // seconds
  bcryptRounds?: number;
  sessionTimeout?: number; // seconds
  allowRegistration?: boolean;
  requireEmailVerification?: boolean;
  passwordMinLength?: number;
  passwordRequireUppercase?: boolean;
  passwordRequireNumbers?: boolean;
  passwordRequireSpecial?: boolean;
  /**
   * Cap on simultaneously-active sessions per user. When set and the
   * user already has N active sessions, creating a new session revokes
   * the oldest. Defaults to unlimited. (P2-22)
   */
  maxSessionsPerUser?: number;
  /**
   * Webhook subscriptions for auth lifecycle events. Each entry is
   * delivered fire-and-forget after the relevant event happens
   * (sign-up, login, password reset, email verification). HMAC-SHA256
   * signing is supported per-subscription via `secret`.
   * (gh/geldata#7484, ports geldata/gel#7813)
   */
  webhooks?: import("./webhooks.ts").WebhookConfig[];
  /**
   * WebAuthn / passkey relying-party config. When omitted, the
   * `beginWebAuthnRegistration` / `finishWebAuthnRegistration` /
   * `beginWebAuthnLogin` / `finishWebAuthnLogin` methods all throw —
   * apps that don't want passkeys simply leave this off.
   * (gh/geldata#6725)
   */
  webauthn?: WebAuthnConfig;
  /**
   * SMTP transport config. Optional — when omitted (and
   * `emailBaseUrl` is set) Disc registers a `NoopMailer` so the
   * email-listener wiring still runs and can be swapped for real
   * SMTP later without code changes. (gh/geldata#8224)
   */
  smtp?: import("../smtp/types.ts").SmtpConfig;
  /**
   * Per-event email-template overrides. Default templates ship in
   * `auth/email-templates.ts`; supply any of `verification`,
   * `passwordReset`, `magicLink` to swap in your own renderer.
   */
  emailTemplates?: import("./email-templates.ts").EmailTemplateOverrides;
  /**
   * Base URL the built-in email templates use to construct
   * verification / password-reset / magic-link URLs. Required to
   * enable the SMTP email listener — without it, links would point
   * nowhere. Setting `smtp` without `emailBaseUrl` is a misconfig
   * that's surfaced at construction.
   */
  emailBaseUrl?: string;
  /**
   * Pluggable captcha gate (hCaptcha / Cloudflare Turnstile) for
   * sensitive public auth endpoints. When set, the corresponding
   * `AuthRoutes` handlers require a `captchaToken` field on the
   * request body and verify it against the provider before any DB
   * work runs. When omitted, captcha is disabled entirely.
   * (gh/geldata#7341)
   */
  captcha?: import("./captcha.ts").CaptchaConfig;
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

export interface LoginCredentials {
  email?: string;
  username?: string;
  password: string;
  meta?: RequestMeta;
}

export interface RegisterData {
  email: string;
  password: string;
  username?: string;
  metadata?: Record<string, any>;
  meta?: RequestMeta;
}

export interface TokenPayload {
  sub: string; // user id
  email: string;
  username?: string;
  iat: number; // issued at
  exp: number; // expires at
  iss?: string; // issuer
  aud?: string; // audience
  jti?: string; // JWT ID for tracking
  /**
   * RBAC role names granted to this user at token-issue time. Restored
   * by `verifyToken()` and surfaced on `AuthContext.roles` so access
   * policies (`has_role()`, `current_role`) and the compilation cache
   * key both see them. Snapshot semantics — roles assigned *after*
   * the token was issued won't take effect until the user re-logs.
   * (gh/geldata#8177)
   */
  roles?: string[];
}

/**
 * Compact "identity" view returned alongside the full `user` on
 * registration responses. Mirrors Gel's `ext::auth::Identity` shape so
 * callers porting from Gel get the same record without an extra GET.
 * Includes the role-name snapshot at issue time (same semantics as
 * `TokenPayload.roles`). (gh/geldata#7275)
 */
export interface Identity {
  id: string;
  email: string;
  createdAt: Date;
  emailVerified: boolean;
  /**
   * Role names attached to this identity at the moment the response
   * was issued. Empty array when the user has no roles assigned.
   * Snapshot semantics — roles assigned after the response went out
   * won't show here.
   */
  roles: string[];
}

export interface AuthResponse {
  user: Omit<User, "passwordHash">;
  session: Session;
  token: string;
  refreshToken?: string;
  /**
   * Plaintext email verification token. Only populated on `register()` when
   * `requireEmailVerification: true`. The DB stores only the hash — the
   * plaintext must be delivered to the user out-of-band (typically by the
   * caller emailing it). After register() returns, the plaintext cannot be
   * recovered. (P0-03)
   */
  verificationToken?: string;
  /**
   * Compact identity view — same id/email/createdAt as `user` plus the
   * role-name snapshot. Populated on `register()` so callers can stash
   * the identity without a follow-up `getUser()`. Optional on the type
   * to keep older callers and synthetic anonymous flows source-compatible.
   * (gh/geldata#7275)
   */
  identity?: Identity;
}

/**
 * MFA challenge returned from `login()` when the user has TOTP enrolled.
 * The caller has already proven knowledge of the password — they now
 * need to prove possession of the second factor. The challenge token is
 * short-lived (default 5 min) and single-use. (gh/geldata#8186)
 */
export interface MfaChallenge {
  mfaRequired: true;
  challengeToken: string;
  /** Which factor types the user has enrolled. */
  factors: Array<"totp">;
}

/**
 * Result of `login()` — either a full authenticated session or an MFA
 * challenge that the caller must complete via `loginWithTOTP()`.
 */
export type LoginResult = AuthResponse | MfaChallenge;

/**
 * Returned from `enrollTOTP()` so callers can render the QR code and
 * keep the secret around for `confirmTOTP()`. The secret is base32 —
 * authenticator apps consume it directly, and the URI is what's
 * normally encoded into a QR.
 */
export interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
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
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    challenge: string; // base64url
    pubKeyCredParams: Array<{ type: "public-key"; alg: number }>;
    timeout?: number;
    attestation?: "none";
    excludeCredentials?: Array<{ id: string; type: "public-key" }>;
  };
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
    rpId: string;
    challenge: string;
    timeout?: number;
    allowCredentials?: Array<{ id: string; type: "public-key" }>;
    userVerification?: "required" | "preferred" | "discouraged";
  };
}

export interface WebAuthnRegistrationFinish {
  challengeId: string;
  /** base64url; from `credential.id`. */
  credentialId: string;
  /** base64url(attestationObject) from the AuthenticatorAttestationResponse. */
  attestationObject: string;
  /** base64url(clientDataJSON). */
  clientDataJSON: string;
  /** Optional human-readable label set by the user ("My iPhone"). */
  name?: string;
}

export interface WebAuthnLoginFinish {
  challengeId: string;
  /** base64url; from `credential.id`. */
  credentialId: string;
  /** base64url(authenticatorData). */
  authenticatorData: string;
  /** base64url(clientDataJSON). */
  clientDataJSON: string;
  /** base64url(signature). */
  signature: string;
}

/**
 * Server config for the WebAuthn ceremonies. `rpId` is the apex domain
 * the credentials are scoped to (must match `window.location.host`'s
 * effective domain). `origin` is what the browser sets in
 * `clientDataJSON.origin` — typically `https://${rpId}` but can include
 * a port for development.
 */
export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  origin: string;
}

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

export interface AuthProvider {
  login(credentials: LoginCredentials): Promise<LoginResult>;
  register(data: RegisterData): Promise<AuthResponse>;
  logout(sessionId: string): Promise<void>;
  refresh(refreshToken: string, meta?: RequestMeta): Promise<AuthResponse>;
  verifyToken(token: string): Promise<TokenPayload>;
  getUser(userId: string): Promise<User | null>;
  updatePassword(
    userId: string,
    old_password: string,
    new_password: string,
  ): Promise<void>;
  resetPasswordRequest(email: string): Promise<string>; // returns reset token
  resetPassword(reset_token: string, new_password: string): Promise<void>;
  /**
   * Re-issue an email-verification token, invalidating the prior one.
   * Silent on unknown / already-verified emails to avoid leaking account
   * state. Returns plaintext for the caller to email; DB stores hash
   * only. (gh/geldata#6503)
   */
  resendVerification(email: string): Promise<string | null>;
  verifyEmail(verification_token: string): Promise<void>;
  revokeAllSessions(userId: string): Promise<void>;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public code: AuthErrorCode,
    public status_code = 401,
  ) {
    super(`${code}: ${message}`);
    this.name = "AuthError";
  }
}

export enum AuthErrorCode {
  INVALID_CREDENTIALS = "INVALID_CREDENTIALS",
  USER_NOT_FOUND = "USER_NOT_FOUND",
  USER_ALREADY_EXISTS = "USER_ALREADY_EXISTS",
  INVALID_TOKEN = "INVALID_TOKEN",
  TOKEN_EXPIRED = "TOKEN_EXPIRED",
  SESSION_EXPIRED = "SESSION_EXPIRED",
  EMAIL_NOT_VERIFIED = "EMAIL_NOT_VERIFIED",
  PASSWORD_TOO_WEAK = "PASSWORD_TOO_WEAK",
  REGISTRATION_DISABLED = "REGISTRATION_DISABLED",
  INVALID_REFRESH_TOKEN = "INVALID_REFRESH_TOKEN",
  USER_INACTIVE = "USER_INACTIVE",
  /**
   * Operation invalid for the user's current state — e.g. trying to
   * upgrade a user that's already a full identity. (gh/geldata#8750)
   */
  INVALID_OPERATION = "INVALID_OPERATION",
}

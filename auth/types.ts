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
}

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

export interface AuthProvider {
  login(credentials: LoginCredentials): Promise<AuthResponse>;
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

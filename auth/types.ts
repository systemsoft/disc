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
  jwtSecret: string;
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
}

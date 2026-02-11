/**
 * Authentication Types and Interfaces
 */

export interface User {
  id: string;
  email: string;
  username?: string;
  password_hash: string;
  created_at: Date;
  updated_at: Date;
  email_verified: boolean;
  active: boolean;
  metadata?: Record<string, any>;
}

export interface Session {
  id: string;
  user_id: string;
  token: string;
  refresh_token?: string;
  created_at: Date;
  expires_at: Date;
  last_activity?: Date;
  ip_address?: string;
  user_agent?: string;
}

export interface AuthConfig {
  jwt_secret: string;
  jwt_issuer?: string;
  jwt_audience?: string;
  token_expiry?: number; // seconds
  refresh_token_expiry?: number; // seconds
  bcrypt_rounds?: number;
  session_timeout?: number; // seconds
  allow_registration?: boolean;
  require_email_verification?: boolean;
  password_min_length?: number;
  password_require_uppercase?: boolean;
  password_require_numbers?: boolean;
  password_require_special?: boolean;
}

export interface LoginCredentials {
  email?: string;
  username?: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  username?: string;
  metadata?: Record<string, any>;
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
  user: Omit<User, "password_hash">;
  session: Session;
  token: string;
  refresh_token?: string;
}

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

export interface AuthProvider {
  login(credentials: LoginCredentials): Promise<AuthResponse>;
  register(data: RegisterData): Promise<AuthResponse>;
  logout(session_id: string): Promise<void>;
  refresh(refresh_token: string): Promise<AuthResponse>;
  verify_token(token: string): Promise<TokenPayload>;
  get_user(user_id: string): Promise<User | null>;
  update_password(user_id: string, old_password: string, new_password: string): Promise<void>;
  reset_password_request(email: string): Promise<string>; // returns reset token
  reset_password(reset_token: string, new_password: string): Promise<void>;
  verify_email(verification_token: string): Promise<void>;
  revoke_all_sessions(user_id: string): Promise<void>;
}

export class AuthError extends Error {
  constructor(
    message: string,
    public code: AuthErrorCode,
    public status_code = 401,
  ) {
    super(message);
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
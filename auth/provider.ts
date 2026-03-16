/**
 * Authentication Provider Implementation
 */

import * as bcrypt from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
import { create, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { DatabaseInterface } from "./database-interface.ts";
import {
  AuthConfig,
  AuthError,
  AuthErrorCode,
  AuthProvider as IAuthProvider,
  AuthResponse,
  LoginCredentials,
  PasswordValidationResult,
  RegisterData,
  Session,
  TokenPayload,
  User,
} from "./types.ts";

export class AuthProvider implements IAuthProvider {
  private config: Required<AuthConfig>;
  private db: DatabaseInterface;
  private cryptoKey?: CryptoKey;

  constructor(config: AuthConfig, db: DatabaseInterface) {
    this.config = {
      jwt_secret: config.jwt_secret,
      jwt_issuer: config.jwt_issuer || "disc",
      jwt_audience: config.jwt_audience || "disc-api",
      token_expiry: config.token_expiry ?? 3600, // 1 hour
      refresh_token_expiry: config.refresh_token_expiry ?? 604800, // 7 days
      bcrypt_rounds: config.bcrypt_rounds ?? 12,
      session_timeout: config.session_timeout ?? 3600,
      allow_registration: config.allow_registration ?? true,
      require_email_verification: config.require_email_verification ?? false,
      password_min_length: config.password_min_length || 8,
      password_require_uppercase: config.password_require_uppercase ?? false,
      password_require_numbers: config.password_require_numbers ?? false,
      password_require_special: config.password_require_special ?? false,
    };
    this.db = db;
  }

  async initialize(): Promise<void> {
    // Create crypto key for JWT signing
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.config.jwt_secret);
    this.cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );

    // Create tables if they don't exist
    await this.createTables();
  }

  private async createTables(): Promise<void> {
    // Users table
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        email_verified BOOLEAN DEFAULT FALSE,
        active BOOLEAN DEFAULT TRUE,
        metadata TEXT,
        verification_token TEXT,
        reset_token TEXT,
        reset_token_expires TIMESTAMP
      )
    `);

    // Sessions table
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT UNIQUE NOT NULL,
        refresh_token TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        last_activity TIMESTAMP,
        ip_address TEXT,
        user_agent TEXT,
        revoked BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Indexes
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
  }

  async register(data: RegisterData): Promise<AuthResponse> {
    if (!this.config.allow_registration) {
      throw new AuthError(
        "Registration is disabled",
        AuthErrorCode.REGISTRATION_DISABLED,
        403
      );
    }

    // Validate password
    const passwordValidation = this.validatePassword(data.password);
    if (!passwordValidation.valid) {
      throw new AuthError(
        passwordValidation.errors.join(", "),
        AuthErrorCode.PASSWORD_TOO_WEAK,
        400
      );
    }

    // Check if user exists
    const existing = await this.db.query(
      "SELECT id FROM users WHERE email = ? OR (username = ? AND username IS NOT NULL)",
      [data.email, data.username || null]
    );

    if (existing.rows.length > 0) {
      throw new AuthError(
        "User already exists",
        AuthErrorCode.USER_ALREADY_EXISTS,
        409
      );
    }

    // Hash password
    const salt = await bcrypt.genSalt(this.config.bcrypt_rounds);
    const passwordHash = await bcrypt.hash(data.password, salt);

    // Create user
    const userId = this.generateId();
    const verificationToken = this.config.require_email_verification
      ? this.generateToken()
      : null;

    await this.db.execute(`
      INSERT INTO users (
        id, email, username, password_hash, email_verified, 
        metadata, verification_token
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      userId,
      data.email,
      data.username || null,
      passwordHash,
      !this.config.require_email_verification,
      data.metadata ? JSON.stringify(data.metadata) : null,
      verificationToken,
    ]);

    // Get created user
    const user = await this.get_user(userId);
    if (!user) {
      throw new Error("Failed to create user");
    }

    // Create session
    const session = await this.createSession(userId);

    // Generate tokens
    const token = await this.generateJWT(user);
    const refreshToken = this.generateToken();

    // Update session with tokens
    await this.db.execute(
      "UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?",
      [token, refreshToken, session.id]
    );

    session.token = token;
    session.refresh_token = refreshToken;

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refresh_token: refreshToken,
    };
  }

  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    // Find user by email or username
    const query = credentials.email
      ? "SELECT * FROM users WHERE email = ?"
      : "SELECT * FROM users WHERE username = ?";
    const param = credentials.email || credentials.username;

    const result = await this.db.query(query, [param]);
    
    if (result.rows.length === 0) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404
      );
    }

    const user = this.rowToUser(result.rows[0]);

    // Check if user is active
    if (!user.active) {
      throw new AuthError(
        "User account is inactive",
        AuthErrorCode.USER_INACTIVE,
        403
      );
    }

    // Check email verification
    if (this.config.require_email_verification && !user.email_verified) {
      throw new AuthError(
        "Email not verified",
        AuthErrorCode.EMAIL_NOT_VERIFIED,
        403
      );
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(credentials.password, user.password_hash);
    if (!passwordMatch) {
      throw new AuthError(
        "Invalid credentials",
        AuthErrorCode.INVALID_CREDENTIALS,
        401
      );
    }

    // Create session
    const session = await this.createSession(user.id);

    // Generate tokens
    const token = await this.generateJWT(user);
    const refreshToken = this.generateToken();

    // Update session with tokens
    await this.db.execute(
      "UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?",
      [token, refreshToken, session.id]
    );

    session.token = token;
    session.refresh_token = refreshToken;

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refresh_token: refreshToken,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.execute(
      "UPDATE sessions SET revoked = TRUE WHERE id = ?",
      [sessionId]
    );
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    // Find session by refresh token
    const result = await this.db.query(
      `SELECT s.*, u.* FROM sessions s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.refresh_token = ? AND s.revoked = FALSE`,
      [refreshToken]
    );

    if (result.rows.length === 0) {
      throw new AuthError(
        "Invalid refresh token",
        AuthErrorCode.INVALID_REFRESH_TOKEN,
        401
      );
    }

    const row = result.rows[0];
    const user = this.rowToUser(row);
    const oldSessionId = row.id;

    // Revoke old session
    await this.db.execute(
      "UPDATE sessions SET revoked = TRUE WHERE id = ?",
      [oldSessionId]
    );

    // Create new session
    const session = await this.createSession(user.id);

    // Generate new tokens
    const token = await this.generateJWT(user);
    const newRefreshToken = this.generateToken();

    // Update session with tokens
    await this.db.execute(
      "UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?",
      [token, newRefreshToken, session.id]
    );

    session.token = token;
    session.refresh_token = newRefreshToken;

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refresh_token: newRefreshToken,
    };
  }

  async verify_token(token: string): Promise<TokenPayload> {
    if (!this.cryptoKey) {
      throw new Error("Auth provider not initialized");
    }

    try {
      // Verify JWT
      const rawPayload = await verify(token, this.cryptoKey);
      const payload = rawPayload as unknown as TokenPayload;

      // Check if session exists and is not revoked
      const result = await this.db.query(
        "SELECT id FROM sessions WHERE token = ? AND revoked = FALSE",
        [token]
      );

      if (result.rows.length === 0) {
        throw new AuthError(
          "Session expired or revoked",
          AuthErrorCode.SESSION_EXPIRED,
          401
        );
      }

      // Check expiration
      if (payload.exp && payload.exp <= Math.floor(Date.now() / 1000)) {
        throw new AuthError(
          "Token expired",
          AuthErrorCode.TOKEN_EXPIRED,
          401
        );
      }

      return payload;
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      // Check if the djwt library threw an expiration error
      const errorMsg = error instanceof Error ? error.message.toLowerCase() : "";
      if (errorMsg.includes("expired") || errorMsg.includes("exp")) {
        throw new AuthError(
          "Token expired",
          AuthErrorCode.TOKEN_EXPIRED,
          401
        );
      }
      throw new AuthError(
        "Invalid token",
        AuthErrorCode.INVALID_TOKEN,
        401
      );
    }
  }

  async get_user(userId: string): Promise<User | null> {
    const result = await this.db.query(
      "SELECT * FROM users WHERE id = ?",
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToUser(result.rows[0]);
  }

  async update_password(
    userId: string,
    oldPassword: string,
    newPassword: string
  ): Promise<void> {
    const user = await this.get_user(userId);
    if (!user) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404
      );
    }

    // Verify old password
    const passwordMatch = await bcrypt.compare(oldPassword, user.password_hash);
    if (!passwordMatch) {
      throw new AuthError(
        "Invalid credentials",
        AuthErrorCode.INVALID_CREDENTIALS,
        401
      );
    }

    // Validate new password
    const passwordValidation = this.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new AuthError(
        passwordValidation.errors.join(", "),
        AuthErrorCode.PASSWORD_TOO_WEAK,
        400
      );
    }

    // Hash new password
    const newSalt = await bcrypt.genSalt(this.config.bcrypt_rounds);
    const newPasswordHash = await bcrypt.hash(newPassword, newSalt);

    // Update password
    await this.db.execute(
      "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [newPasswordHash, userId]
    );

    // Revoke all sessions
    await this.revoke_all_sessions(userId);
  }

  async reset_password_request(email: string): Promise<string> {
    const result = await this.db.query(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );

    if (result.rows.length === 0) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404
      );
    }

    const userId = result.rows[0].id;
    const resetToken = this.generateToken();
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await this.db.execute(
      "UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
      [resetToken, expires.toISOString(), userId]
    );

    return resetToken;
  }

  async reset_password(resetToken: string, newPassword: string): Promise<void> {
    const result = await this.db.query(
      "SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > CURRENT_TIMESTAMP",
      [resetToken]
    );

    if (result.rows.length === 0) {
      throw new AuthError(
        "Invalid or expired reset token",
        AuthErrorCode.INVALID_TOKEN,
        400
      );
    }

    const userId = result.rows[0].id;

    // Validate new password
    const passwordValidation = this.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new AuthError(
        passwordValidation.errors.join(", "),
        AuthErrorCode.PASSWORD_TOO_WEAK,
        400
      );
    }

    // Hash new password
    const resetSalt = await bcrypt.genSalt(this.config.bcrypt_rounds);
    const passwordHash = await bcrypt.hash(newPassword, resetSalt);

    // Update password and clear reset token
    await this.db.execute(
      `UPDATE users SET password_hash = ?, reset_token = NULL, 
       reset_token_expires = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [passwordHash, userId]
    );

    // Revoke all sessions
    await this.revoke_all_sessions(userId);
  }

  async verify_email(verificationToken: string): Promise<void> {
    const result = await this.db.query(
      "SELECT id FROM users WHERE verification_token = ?",
      [verificationToken]
    );

    if (result.rows.length === 0) {
      throw new AuthError(
        "Invalid verification token",
        AuthErrorCode.INVALID_TOKEN,
        400
      );
    }

    await this.db.execute(
      `UPDATE users SET email_verified = TRUE, verification_token = NULL, 
       updated_at = CURRENT_TIMESTAMP WHERE verification_token = ?`,
      [verificationToken]
    );
  }

  async revoke_all_sessions(userId: string): Promise<void> {
    await this.db.execute(
      "UPDATE sessions SET revoked = TRUE WHERE user_id = ?",
      [userId]
    );
  }

  private async createSession(userId: string): Promise<Session> {
    const sessionId = this.generateId();
    const expiresAt = new Date(Date.now() + this.config.session_timeout * 1000);

    await this.db.execute(`
      INSERT INTO sessions (
        id, user_id, token, expires_at
      ) VALUES (?, ?, ?, ?)
    `, [sessionId, userId, "", expiresAt.toISOString()]);

    return {
      id: sessionId,
      user_id: userId,
      token: "",
      created_at: new Date(),
      expires_at: expiresAt,
    };
  }

  private async generateJWT(user: User): Promise<string> {
    if (!this.cryptoKey) {
      throw new Error("Auth provider not initialized");
    }

    const now = Math.floor(Date.now() / 1000);
    const payload: TokenPayload = {
      sub: user.id,
      email: user.email,
      username: user.username,
      iat: now,
      exp: now + this.config.token_expiry,
      iss: this.config.jwt_issuer,
      aud: this.config.jwt_audience,
      jti: this.generateId(),
    };

    return await create({ alg: "HS256", typ: "JWT" }, payload as any, this.cryptoKey);
  }

  private validatePassword(password: string): PasswordValidationResult {
    const errors: string[] = [];

    if (password.length < this.config.password_min_length) {
      errors.push(`Password must be at least ${this.config.password_min_length} characters`);
    }

    if (this.config.password_require_uppercase && !/[A-Z]/.test(password)) {
      errors.push("Password must contain at least one uppercase letter");
    }

    if (this.config.password_require_numbers && !/[0-9]/.test(password)) {
      errors.push("Password must contain at least one number");
    }

    if (this.config.password_require_special && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
      errors.push("Password must contain at least one special character");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private rowToUser(row: any): User {
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      password_hash: row.password_hash,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      email_verified: Boolean(row.email_verified),
      active: Boolean(row.active),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private sanitizeUser(user: User): Omit<User, "password_hash"> {
    const { password_hash, ...sanitized } = user;
    return sanitized;
  }

  private generateId(): string {
    return crypto.randomUUID();
  }

  private generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }
}
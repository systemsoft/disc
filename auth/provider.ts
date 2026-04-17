/**
 * Authentication Provider Implementation
 */

import * as bcrypt from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
import { create, verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { DatabaseInterface } from "./database-interface.ts";
import { getLogger } from "../lib/logger.ts";

const authLogger = getLogger("auth");
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
      jwtSecret: config.jwtSecret,
      jwtIssuer: config.jwtIssuer || "disc",
      jwtAudience: config.jwtAudience || "disc-api",
      tokenExpiry: config.tokenExpiry ?? 3600, // 1 hour
      refreshTokenExpiry: config.refreshTokenExpiry ?? 604800, // 7 days
      bcryptRounds: config.bcryptRounds ?? 12,
      sessionTimeout: config.sessionTimeout ?? 3600,
      allowRegistration: config.allowRegistration ?? true,
      requireEmailVerification: config.requireEmailVerification ?? false,
      passwordMinLength: config.passwordMinLength || 8,
      passwordRequireUppercase: config.passwordRequireUppercase ?? false,
      passwordRequireNumbers: config.passwordRequireNumbers ?? false,
      passwordRequireSpecial: config.passwordRequireSpecial ?? false,
    };
    this.db = db;
  }

  async initialize(): Promise<void> {
    // Create crypto key for JWT signing. (P3-04: HS256 with a shared
    // secret is the default; RS256 support — asymmetric keys so
    // verifiers don't need the signing secret — is planned. To rotate
    // an HS256 secret today: stand up a parallel server with the new
    // secret, migrate traffic, and invalidate old sessions via
    // `UPDATE sessions SET revoked = TRUE`. The rotation doesn't need
    // application-level coordination because sessions also carry a
    // server-side revoked flag that verifyToken checks.)
    const encoder = new TextEncoder();
    const keyData = encoder.encode(this.config.jwtSecret);
    if (keyData.length < 32) {
      throw new Error(
        `AuthProvider: jwtSecret must be at least 32 bytes for HS256; got ${keyData.length}`,
      );
    }
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
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`,
    );
  }

  async register(data: RegisterData): Promise<AuthResponse> {
    if (!this.config.allowRegistration) {
      throw new AuthError(
        "Registration is disabled",
        AuthErrorCode.REGISTRATION_DISABLED,
        403,
      );
    }

    // Validate password
    const passwordValidation = this.validatePassword(data.password);
    if (!passwordValidation.valid) {
      throw new AuthError(
        passwordValidation.errors.join(", "),
        AuthErrorCode.PASSWORD_TOO_WEAK,
        400,
      );
    }

    // Check if user exists
    const existing = await this.db.query(
      "SELECT id FROM users WHERE email = ? OR (username = ? AND username IS NOT NULL)",
      [data.email, data.username || null],
    );

    if (existing.rows.length > 0) {
      throw new AuthError(
        "User already exists",
        AuthErrorCode.USER_ALREADY_EXISTS,
        409,
      );
    }

    // Hash password
    const salt = await bcrypt.genSalt(this.config.bcryptRounds);
    const passwordHash = await bcrypt.hash(data.password, salt);

    // Create user
    const userId = this.generateId();
    const verificationToken = this.config.requireEmailVerification
      ? this.generateToken()
      : null;
    // Store only the hash; plaintext is returned to the caller for emailing.
    const verificationTokenHash = verificationToken
      ? await this.hashToken(verificationToken)
      : null;

    await this.db.execute(
      `
      INSERT INTO users (
        id, email, username, password_hash, email_verified,
        metadata, verification_token
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      [
        userId,
        data.email,
        data.username || null,
        passwordHash,
        !this.config.requireEmailVerification,
        data.metadata ? JSON.stringify(data.metadata) : null,
        verificationTokenHash,
      ],
    );

    // Get created user
    const user = await this.getUser(userId);
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
      [token, refreshToken, session.id],
    );

    session.token = token;
    session.refreshToken = refreshToken;

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refreshToken: refreshToken,
      // Plaintext for the caller to email; DB has the hash.
      ...(verificationToken ? { verificationToken } : {}),
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
      // P1-35: generic error — don't leak whether the email exists.
      // Returning USER_NOT_FOUND vs INVALID_CREDENTIALS lets attackers
      // probe valid accounts.
      this.auditEvent("login_failed", null, {
        reason: "no_such_user",
        email: credentials.email,
      });
      throw new AuthError(
        "Invalid credentials",
        AuthErrorCode.INVALID_CREDENTIALS,
        401,
      );
    }

    const user = this.rowToUser(result.rows[0]);

    // Check if user is active
    if (!user.active) {
      throw new AuthError(
        "User account is inactive",
        AuthErrorCode.USER_INACTIVE,
        403,
      );
    }

    // Check email verification
    if (this.config.requireEmailVerification && !user.emailVerified) {
      throw new AuthError(
        "Email not verified",
        AuthErrorCode.EMAIL_NOT_VERIFIED,
        403,
      );
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(
      credentials.password,
      user.passwordHash,
    );
    if (!passwordMatch) {
      throw new AuthError(
        "Invalid credentials",
        AuthErrorCode.INVALID_CREDENTIALS,
        401,
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
      [token, refreshToken, session.id],
    );

    session.token = token;
    session.refreshToken = refreshToken;

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refreshToken: refreshToken,
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.execute(
      "UPDATE sessions SET revoked = TRUE WHERE id = ?",
      [sessionId],
    );
    this.auditEvent("session_revoked", null, { sessionId, reason: "logout" });
  }

  async refresh(refreshToken: string): Promise<AuthResponse> {
    // Find session by refresh token
    // Use explicit columns with aliases to avoid duplicate field names
    // (both sessions and users have id, createdAt)
    const result = await this.db.query(
      `SELECT s.id AS session_id, s.user_id, s.refresh_token, s.revoked,
              u.id, u.email, u.username, u.password_hash,
              u.created_at, u.updated_at, u.email_verified, u.active, u.metadata
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.refresh_token = ? AND s.revoked = FALSE`,
      [refreshToken],
    );

    if (result.rows.length === 0) {
      throw new AuthError(
        "Invalid refresh token",
        AuthErrorCode.INVALID_REFRESH_TOKEN,
        401,
      );
    }

    const row = result.rows[0];
    const user = this.rowToUser(row);
    const oldSessionId = row.session_id;

    // Revoke old session
    await this.db.execute(
      "UPDATE sessions SET revoked = TRUE WHERE id = ?",
      [oldSessionId],
    );

    // Create new session
    const session = await this.createSession(user.id);

    // Generate new tokens
    const token = await this.generateJWT(user);
    const newRefreshToken = this.generateToken();

    // Update session with tokens
    await this.db.execute(
      "UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?",
      [token, newRefreshToken, session.id],
    );

    session.token = token;
    session.refreshToken = newRefreshToken;

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refreshToken: newRefreshToken,
    };
  }

  async verifyToken(token: string): Promise<TokenPayload> {
    if (!this.cryptoKey) {
      throw new Error("Auth provider not initialized");
    }

    try {
      // Verify JWT
      const rawPayload = await verify(token, this.cryptoKey);
      const payload = rawPayload as unknown as TokenPayload;

      // Check session: exists, not revoked, AND server-side expires_at is in
      // the future (P1-33 — previously only the JWT exp claim was checked,
      // so a stolen token remained usable until its JWT exp regardless of
      // server-side revocation timing).
      const result = await this.db.query(
        `SELECT id FROM sessions
           WHERE token = ?
             AND revoked = FALSE
             AND expires_at > CURRENT_TIMESTAMP`,
        [token],
      );

      if (result.rows.length === 0) {
        throw new AuthError(
          "Session expired or revoked",
          AuthErrorCode.SESSION_EXPIRED,
          401,
        );
      }

      // Check JWT expiration (separate from server-side expires_at —
      // clients may have a shorter JWT lifetime than the session record).
      if (payload.exp && payload.exp <= Math.floor(Date.now() / 1000)) {
        throw new AuthError(
          "Token expired",
          AuthErrorCode.TOKEN_EXPIRED,
          401,
        );
      }

      // Stamp last_activity so inactivity-based reaping can work.
      // Best-effort — verification succeeds even if this UPDATE fails.
      await this.db.execute(
        "UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE id = ?",
        [result.rows[0].id],
      ).catch(() => {});

      return payload;
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      // Check if the djwt library threw an expiration error
      const errorMsg = error instanceof Error
        ? error.message.toLowerCase()
        : "";
      if (errorMsg.includes("expired") || errorMsg.includes("exp")) {
        throw new AuthError(
          "Token expired",
          AuthErrorCode.TOKEN_EXPIRED,
          401,
        );
      }
      throw new AuthError(
        "Invalid token",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
  }

  async getUser(userId: string): Promise<User | null> {
    const result = await this.db.query(
      "SELECT * FROM users WHERE id = ?",
      [userId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.rowToUser(result.rows[0]);
  }

  async updatePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.getUser(userId);
    if (!user) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }

    // Verify old password
    const passwordMatch = await bcrypt.compare(oldPassword, user.passwordHash);
    if (!passwordMatch) {
      throw new AuthError(
        "Invalid credentials",
        AuthErrorCode.INVALID_CREDENTIALS,
        401,
      );
    }

    // Validate new password
    const passwordValidation = this.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new AuthError(
        passwordValidation.errors.join(", "),
        AuthErrorCode.PASSWORD_TOO_WEAK,
        400,
      );
    }

    // Hash new password
    const newSalt = await bcrypt.genSalt(this.config.bcryptRounds);
    const newPasswordHash = await bcrypt.hash(newPassword, newSalt);

    // Update password
    await this.db.execute(
      "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [newPasswordHash, userId],
    );

    // Revoke all sessions
    await this.revokeAllSessions(userId);
  }

  async resetPasswordRequest(email: string): Promise<string> {
    const result = await this.db.query(
      "SELECT id FROM users WHERE email = ?",
      [email],
    );

    if (result.rows.length === 0) {
      // P1-35: don't leak whether the email is registered. Return a
      // non-plaintext sentinel — callers treat a non-empty return as
      // "we'll email you if the account exists", matching standard practice.
      return "";
    }

    const userId = result.rows[0].id;
    const resetToken = this.generateToken();
    const resetTokenHash = await this.hashToken(resetToken);
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await this.db.execute(
      "UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
      [resetTokenHash, expires.toISOString(), userId],
    );

    // Return plaintext to caller (they send it via email); only the hash
    // is in the DB. (P0-03)
    return resetToken;
  }

  async resetPassword(resetToken: string, newPassword: string): Promise<void> {
    const resetTokenHash = await this.hashToken(resetToken);
    const result = await this.db.query(
      "SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > CURRENT_TIMESTAMP",
      [resetTokenHash],
    );

    if (result.rows.length === 0) {
      throw new AuthError(
        "Invalid or expired reset token",
        AuthErrorCode.INVALID_TOKEN,
        400,
      );
    }

    const userId = result.rows[0].id;

    // Validate new password
    const passwordValidation = this.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new AuthError(
        passwordValidation.errors.join(", "),
        AuthErrorCode.PASSWORD_TOO_WEAK,
        400,
      );
    }

    // Hash new password
    const resetSalt = await bcrypt.genSalt(this.config.bcryptRounds);
    const passwordHash = await bcrypt.hash(newPassword, resetSalt);

    // Update password and clear reset token
    await this.db.execute(
      `UPDATE users SET password_hash = ?, reset_token = NULL,
       reset_token_expires = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [passwordHash, userId],
    );

    // Revoke all sessions
    await this.revokeAllSessions(userId);
  }

  async verifyEmail(verificationToken: string): Promise<void> {
    const verificationTokenHash = await this.hashToken(verificationToken);
    const result = await this.db.query(
      "SELECT id FROM users WHERE verification_token = ?",
      [verificationTokenHash],
    );

    if (result.rows.length === 0) {
      throw new AuthError(
        "Invalid verification token",
        AuthErrorCode.INVALID_TOKEN,
        400,
      );
    }

    await this.db.execute(
      `UPDATE users SET email_verified = TRUE, verification_token = NULL,
       updated_at = CURRENT_TIMESTAMP WHERE verification_token = ?`,
      [verificationTokenHash],
    );
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.db.execute(
      "UPDATE sessions SET revoked = TRUE WHERE user_id = ?",
      [userId],
    );
  }

  private async createSession(
    userId: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ): Promise<Session> {
    const sessionId = this.generateId();
    const expiresAt = new Date(Date.now() + this.config.sessionTimeout * 1000);

    // P2-22: cap concurrent sessions per user. If maxSessionsPerUser is
    // set and the user is already at the cap, revoke the oldest session
    // before creating a new one. This bounds credential-stuffing blast
    // radius without breaking legitimate multi-device use.
    const maxSessions = this.config.maxSessionsPerUser;
    if (typeof maxSessions === "number" && maxSessions > 0) {
      const active = await this.db.query(
        `SELECT id FROM sessions
           WHERE user_id = ?
             AND revoked = FALSE
             AND expires_at > CURRENT_TIMESTAMP
           ORDER BY created_at ASC`,
        [userId],
      );
      if (active.rows.length >= maxSessions) {
        const toRevoke = active.rows
          .slice(0, active.rows.length - maxSessions + 1)
          .map((row) => row.id);
        for (const oldId of toRevoke) {
          await this.db.execute(
            "UPDATE sessions SET revoked = TRUE WHERE id = ?",
            [oldId],
          );
        }
      }
    }

    await this.db.execute(
      `
      INSERT INTO sessions (
        id, user_id, token, expires_at, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
      [
        sessionId,
        userId,
        "",
        expiresAt.toISOString(),
        // P2-21: persist IP + User-Agent so anomaly detection downstream
        // (and the audit log below) has something to work with. Missing
        // metadata is stored as NULL.
        meta?.ipAddress ?? null,
        meta?.userAgent ?? null,
      ],
    );

    // P2-23: audit the creation. Best-effort — failures in the audit
    // log must never break session creation.
    this.auditEvent("session_created", userId, {
      sessionId,
      ipAddress: meta?.ipAddress,
    });

    return {
      id: sessionId,
      userId: userId,
      token: "",
      createdAt: new Date(),
      expiresAt: expiresAt,
    };
  }

  /**
   * Structured audit event. Writes to the shared logger at info level with
   * a stable `event=auth.<name>` prefix so log aggregators can filter on
   * auth events. Best-effort: failures in logging never propagate. (P2-23)
   */
  private auditEvent(
    event: string,
    userId: string | null,
    details: Record<string, unknown> = {},
  ): void {
    try {
      authLogger.info(`auth.${event}`, {
        event,
        userId: userId ?? "anonymous",
        ...details,
      });
    } catch {
      // swallow
    }
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
      exp: now + this.config.tokenExpiry,
      iss: this.config.jwtIssuer,
      aud: this.config.jwtAudience,
      jti: this.generateId(),
    };

    return await create(
      { alg: "HS256", typ: "JWT" },
      payload as any,
      this.cryptoKey,
    );
  }

  private validatePassword(password: string): PasswordValidationResult {
    const errors: string[] = [];

    if (password.length < this.config.passwordMinLength) {
      errors.push(
        `Password must be at least ${this.config.passwordMinLength} characters`,
      );
    }

    if (this.config.passwordRequireUppercase && !/[A-Z]/.test(password)) {
      errors.push("Password must contain at least one uppercase letter");
    }

    if (this.config.passwordRequireNumbers && !/[0-9]/.test(password)) {
      errors.push("Password must contain at least one number");
    }

    if (
      this.config.passwordRequireSpecial &&
      !/[!@#$%^&*(),.?":{}|<>]/.test(password)
    ) {
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
      passwordHash: row.password_hash,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      emailVerified: Boolean(row.email_verified),
      active: Boolean(row.active),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private sanitizeUser(user: User): Omit<User, "passwordHash"> {
    const { passwordHash: _passwordHash, ...sanitized } = user;
    return sanitized;
  }

  private generateId(): string {
    return crypto.randomUUID();
  }

  private generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Hash a reset/verification token before storing it.
   *
   * Tokens are 32 random bytes (256 bits) → high-entropy, so SHA-256 suffices
   * (unlike passwords, we don't need a slow hash). Storing only the hash
   * ensures that a DB leak can't be used to reset other users' passwords
   * or bypass email verification — the attacker would need the original
   * plaintext token, which was only sent to the user's email. (P0-03)
   */
  private async hashToken(plaintext: string): Promise<string> {
    const bytes = new TextEncoder().encode(plaintext);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

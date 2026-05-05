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
  RequestMeta,
  Session,
  TokenPayload,
  User,
} from "./types.ts";

/**
 * Conditional config fields whose presence depends on `jwtAlgorithm`:
 *  - HS256 needs `jwtSecret`
 *  - RS256 needs `jwtPrivateKey` + `jwtPublicKey`
 * They're excluded from the defaults map (no sensible default) and
 * validated at runtime in `initialize()`.
 */
type ConditionalAuthFields = "jwtSecret" | "jwtPrivateKey" | "jwtPublicKey";

/**
 * Resolved config after defaults merge — every non-conditional field is
 * required (so the constructor can rely on it without fallbacks), while
 * the algorithm-specific keys remain optional and are checked in
 * `initialize()`.
 */
type ResolvedAuthConfig =
  & Required<Omit<AuthConfig, ConditionalAuthFields>>
  & Pick<AuthConfig, ConditionalAuthFields>;

/**
 * Defaults applied to every non-conditional `AuthConfig` field. Typed as
 * `Omit<Required<AuthConfig>, ConditionalAuthFields>` so adding a new
 * optional field to `AuthConfig` is a compile error until it's defaulted
 * here — the field-by-field merge that previously dropped
 * `maxSessionsPerUser` silently can no longer recur.
 */
const AUTH_CONFIG_DEFAULTS: Omit<Required<AuthConfig>, ConditionalAuthFields> =
  {
    jwtAlgorithm: "HS256",
    jwtIssuer: "disc",
    jwtAudience: "disc-api",
    tokenExpiry: 3600, // 1 hour
    refreshTokenExpiry: 604800, // 7 days
    bcryptRounds: 12,
    sessionTimeout: 3600,
    allowRegistration: true,
    requireEmailVerification: false,
    passwordMinLength: 8,
    passwordRequireUppercase: false,
    passwordRequireNumbers: false,
    passwordRequireSpecial: false,
    // 0 disables the cap (unlimited sessions).
    maxSessionsPerUser: 0,
  };

export class AuthProvider implements IAuthProvider {
  private config: ResolvedAuthConfig;
  private db: DatabaseInterface;
  // Separate sign / verify keys: same CryptoKey under HS256, distinct
  // RSA private / public CryptoKeys under RS256.
  private signKey?: CryptoKey;
  private verifyKey?: CryptoKey;
  // Pre-computed bcrypt hash used by `login()` to equalize response time
  // when the supplied email/username doesn't exist. Without this, an
  // attacker can enumerate valid accounts by stopwatch — wrong-password
  // takes ~100ms (bcrypt.compare), no-such-user returns in ~1ms.
  // Hashed once at init using the configured cost so the dummy compare
  // takes the same time as a real one. (gh/geldata#9137)
  private dummyPasswordHash?: string;

  constructor(config: AuthConfig, db: DatabaseInterface) {
    // Merge defaults with user config, dropping `undefined` values from
    // `config` so an explicitly-undefined optional doesn't shadow the
    // default.
    const overrides: Partial<AuthConfig> = {};
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) {
        (overrides as Record<string, unknown>)[key] = value;
      }
    }
    this.config = {
      ...AUTH_CONFIG_DEFAULTS,
      ...overrides,
    } as ResolvedAuthConfig;
    this.db = db;
  }

  async initialize(): Promise<void> {
    // gh/geldata#7006: validate every config value up-front so a misconfig
    // surfaces at boot with a clear error, not as an opaque bcrypt /
    // JWT crash on the first auth request.
    validateAuthConfig(this.config);

    // P3-04: HS256 (shared secret) is the default; RS256 (asymmetric
    // keys, so verifiers don't need the signing secret) is opt-in via
    // `jwtAlgorithm: "RS256"`. To rotate an HS256 secret: stand up a
    // parallel server with the new secret, migrate traffic, and revoke
    // old sessions via `UPDATE sessions SET revoked = TRUE`. RS256
    // rotation works the same way at the verifier layer — distribute
    // the new public key first, then start signing with the new
    // private key, then revoke.
    if (this.config.jwtAlgorithm === "RS256") {
      const { signKey, verifyKey } = await importRsaKeys(
        this.config.jwtPrivateKey,
        this.config.jwtPublicKey,
      );
      this.signKey = signKey;
      this.verifyKey = verifyKey;
    } else {
      const hmacKey = await importHmacKey(this.config.jwtSecret);
      this.signKey = hmacKey;
      this.verifyKey = hmacKey;
    }

    // Pre-compute the dummy hash for login-timing equalization. Done
    // here (not in the constructor) because bcrypt.hash returns a
    // promise. (gh/geldata#9137)
    const dummySalt = await bcrypt.genSalt(this.config.bcryptRounds);
    this.dummyPasswordHash = await bcrypt.hash(
      "disc-timing-mitigation-not-a-real-password",
      dummySalt,
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
    const session = await this.createSession(userId, data.meta);

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

    this.auditEvent("registered", userId, {
      sessionId: session.id,
      ipAddress: data.meta?.ipAddress,
      requireEmailVerification: this.config.requireEmailVerification,
    });

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
      // gh/geldata#9137: also burn ~one bcrypt round against the dummy
      // hash so an attacker can't distinguish "no such user" (fast
      // DB-only) from "wrong password" (slow bcrypt) by stopwatch.
      await this.runDummyCompare(credentials.password);
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

    // Check if user is active. Burn a dummy compare so the timing
    // matches the wrong-password path. (gh/geldata#9137)
    if (!user.active) {
      await this.runDummyCompare(credentials.password);
      throw new AuthError(
        "User account is inactive",
        AuthErrorCode.USER_INACTIVE,
        403,
      );
    }

    // Check email verification (same timing rationale).
    if (this.config.requireEmailVerification && !user.emailVerified) {
      await this.runDummyCompare(credentials.password);
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
    const session = await this.createSession(user.id, credentials.meta);

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

    this.auditEvent("login_succeeded", user.id, {
      sessionId: session.id,
      ipAddress: credentials.meta?.ipAddress,
    });

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

  async refresh(
    refreshToken: string,
    meta?: RequestMeta,
  ): Promise<AuthResponse> {
    // Find session by refresh token. Pull `ip_address` and `user_agent`
    // alongside the rest so we can flag a refresh from a new origin.
    const result = await this.db.query(
      `SELECT s.id AS session_id, s.user_id, s.refresh_token, s.revoked,
              s.ip_address AS prev_ip_address,
              s.user_agent AS prev_user_agent,
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
    const prevIp: string | null = row.prev_ip_address ?? null;
    const prevUa: string | null = row.prev_user_agent ?? null;

    // Anomaly signal: a refresh that arrives from a different IP or User-
    // Agent than the prior session row hints at token theft. We don't
    // block — that would break legitimate mobile-to-wifi handoffs — but
    // we surface a structured audit event so operators can correlate.
    // (P2-21)
    if (meta?.ipAddress && prevIp && meta.ipAddress !== prevIp) {
      this.auditEvent("session_refreshed_from_new_ip", user.id, {
        sessionId: oldSessionId,
        previousIp: prevIp,
        currentIp: meta.ipAddress,
      });
    }
    if (meta?.userAgent && prevUa && meta.userAgent !== prevUa) {
      this.auditEvent("session_refreshed_from_new_user_agent", user.id, {
        sessionId: oldSessionId,
        previousUserAgent: prevUa,
        currentUserAgent: meta.userAgent,
      });
    }

    // Revoke old session
    await this.db.execute(
      "UPDATE sessions SET revoked = TRUE WHERE id = ?",
      [oldSessionId],
    );

    // Create new session — carry forward the new request's IP/UA so the
    // *next* refresh can compare against the most recent origin, not
    // the one from registration.
    const session = await this.createSession(user.id, meta);

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

    this.auditEvent("session_refreshed", user.id, {
      sessionId: session.id,
      previousSessionId: oldSessionId,
      ipAddress: meta?.ipAddress,
    });

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refreshToken: newRefreshToken,
    };
  }

  async verifyToken(token: string): Promise<TokenPayload> {
    if (!this.verifyKey) {
      throw new Error("Auth provider not initialized");
    }

    try {
      // Verify JWT
      const rawPayload = await verify(token, this.verifyKey);
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
        // Audit the structured failure so a stream of SESSION_EXPIRED /
        // TOKEN_EXPIRED events is visible to operators alongside the
        // other auth-event audit log.
        this.auditEvent("token_verification_failed", null, {
          code: error.code,
        });
        throw error;
      }
      // Check if the djwt library threw an expiration error
      const errorMsg = error instanceof Error
        ? error.message.toLowerCase()
        : "";
      if (errorMsg.includes("expired") || errorMsg.includes("exp")) {
        this.auditEvent("token_verification_failed", null, {
          code: AuthErrorCode.TOKEN_EXPIRED,
        });
        throw new AuthError(
          "Token expired",
          AuthErrorCode.TOKEN_EXPIRED,
          401,
        );
      }
      this.auditEvent("token_verification_failed", null, {
        code: AuthErrorCode.INVALID_TOKEN,
      });
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

    this.auditEvent("password_updated", userId);

    // Revoke all sessions
    await this.revokeAllSessions(userId);
  }

  async resetPasswordRequest(email: string): Promise<string> {
    const result = await this.db.query(
      "SELECT id, email_verified FROM users WHERE email = ?",
      [email],
    );

    if (result.rows.length === 0) {
      // P1-35: don't leak whether the email is registered. Return a
      // non-plaintext sentinel — callers treat a non-empty return as
      // "we'll email you if the account exists", matching standard practice.
      // Audit the no-op so brute-force probing is still visible — the
      // event explicitly records `userId: null`.
      this.auditEvent("password_reset_requested", null, {
        result: "no_such_user",
      });
      return "";
    }

    const userId = result.rows[0].id;

    // gh/geldata#6502: when verification is mandatory, an unverified
    // account is by definition unreachable — anyone holding the typo'd
    // email could otherwise complete the reset and seize the account.
    // Same silent-return shape as no-such-user so callers can't tell
    // verified-vs-unverified by response.
    if (
      this.config.requireEmailVerification &&
      !result.rows[0].email_verified
    ) {
      this.auditEvent("password_reset_requested", userId, {
        result: "unverified_account_blocked",
      });
      return "";
    }

    const resetToken = this.generateToken();
    const resetTokenHash = await this.hashToken(resetToken);
    const expires = new Date(Date.now() + 3600000); // 1 hour

    await this.db.execute(
      "UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
      [resetTokenHash, expires.toISOString(), userId],
    );

    this.auditEvent("password_reset_requested", userId);

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

    this.auditEvent("password_reset", userId);

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

    const userId = result.rows[0].id;

    await this.db.execute(
      `UPDATE users SET email_verified = TRUE, verification_token = NULL,
       updated_at = CURRENT_TIMESTAMP WHERE verification_token = ?`,
      [verificationTokenHash],
    );

    this.auditEvent("email_verified", userId);
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.db.execute(
      "UPDATE sessions SET revoked = TRUE WHERE user_id = ?",
      [userId],
    );
    this.auditEvent("sessions_revoked_all", userId);
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
          this.auditEvent("session_revoked", userId, {
            sessionId: oldId,
            reason: "max_sessions_per_user",
          });
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
    if (!this.signKey) {
      throw new Error(
        this.config.jwtAlgorithm === "RS256"
          ? "Auth provider configured for verify-only (no jwtPrivateKey) — cannot mint tokens"
          : "Auth provider not initialized",
      );
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
      { alg: this.config.jwtAlgorithm, typ: "JWT" },
      payload as any,
      this.signKey,
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

  /**
   * Run `bcrypt.compare` against the pre-computed dummy hash. Used by
   * `login()` on every short-circuit path (no such user, inactive,
   * unverified) so an attacker can't distinguish those from a real
   * wrong-password attempt by response time. (gh/geldata#9137)
   *
   * The result is intentionally discarded — we don't care whether
   * dummy compare matches; we only care that bcrypt did the work.
   */
  private async runDummyCompare(input: string): Promise<void> {
    if (!this.dummyPasswordHash) return;
    await bcrypt.compare(input, this.dummyPasswordHash);
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

/**
 * Validate every numeric / enum field in `AuthConfig` so a bad config
 * fails at `initialize()` rather than at the first auth request. Each
 * error message points to the offending field plus the allowed range,
 * so an operator can fix the config without reading the source.
 *
 * Algorithm-specific keys (`jwtSecret`, `jwtPrivateKey`, `jwtPublicKey`)
 * are still validated downstream by `importHmacKey` / `importRsaKeys`,
 * since those have richer per-algorithm semantics. (gh/geldata#7006)
 */
function validateAuthConfig(config: ResolvedAuthConfig): void {
  // bcrypt rejects rounds outside [4, 31]; the practical upper bound
  // (rounds=15 is already ~1s/hash on commodity hardware) is what we
  // enforce — beyond that, registration becomes a DoS amplifier.
  if (
    !Number.isInteger(config.bcryptRounds) ||
    config.bcryptRounds < 4 ||
    config.bcryptRounds > 15
  ) {
    throw new Error(
      `AuthProvider: bcryptRounds must be an integer in [4, 15]; got ${config.bcryptRounds}`,
    );
  }

  if (config.tokenExpiry <= 0 || !Number.isFinite(config.tokenExpiry)) {
    throw new Error(
      `AuthProvider: tokenExpiry must be a positive number of seconds; got ${config.tokenExpiry}`,
    );
  }

  if (
    config.refreshTokenExpiry <= 0 ||
    !Number.isFinite(config.refreshTokenExpiry)
  ) {
    throw new Error(
      `AuthProvider: refreshTokenExpiry must be a positive number of seconds; got ${config.refreshTokenExpiry}`,
    );
  }

  if (config.refreshTokenExpiry < config.tokenExpiry) {
    throw new Error(
      `AuthProvider: refreshTokenExpiry (${config.refreshTokenExpiry}s) must be ≥ tokenExpiry (${config.tokenExpiry}s) — refresh tokens shorter than access tokens defeat the purpose`,
    );
  }

  if (config.sessionTimeout <= 0 || !Number.isFinite(config.sessionTimeout)) {
    throw new Error(
      `AuthProvider: sessionTimeout must be a positive number of seconds; got ${config.sessionTimeout}`,
    );
  }

  if (
    !Number.isInteger(config.passwordMinLength) ||
    config.passwordMinLength < 1
  ) {
    throw new Error(
      `AuthProvider: passwordMinLength must be a positive integer; got ${config.passwordMinLength}`,
    );
  }

  if (
    !Number.isInteger(config.maxSessionsPerUser) ||
    config.maxSessionsPerUser < 0
  ) {
    throw new Error(
      `AuthProvider: maxSessionsPerUser must be a non-negative integer (0 disables the cap); got ${config.maxSessionsPerUser}`,
    );
  }

  // jwtAlgorithm is type-checked at compile time, but TypeScript's
  // type narrowing doesn't survive untrusted JSON config.
  if (
    config.jwtAlgorithm !== "HS256" &&
    config.jwtAlgorithm !== "RS256"
  ) {
    throw new Error(
      `AuthProvider: jwtAlgorithm must be "HS256" or "RS256"; got ${
        JSON.stringify(config.jwtAlgorithm)
      }`,
    );
  }

  if (typeof config.jwtIssuer !== "string" || config.jwtIssuer.length === 0) {
    throw new Error(
      "AuthProvider: jwtIssuer must be a non-empty string",
    );
  }

  if (
    typeof config.jwtAudience !== "string" ||
    config.jwtAudience.length === 0
  ) {
    throw new Error(
      "AuthProvider: jwtAudience must be a non-empty string",
    );
  }
}

/**
 * Import an HS256 HMAC key from a shared secret. Enforces a 32-byte
 * minimum (RFC 7518 §3.2 recommends ≥ key-length bits, i.e. 256 for
 * SHA-256) so weak secrets are caught at startup, not at first verify.
 */
async function importHmacKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) {
    throw new Error(
      "AuthProvider: jwtSecret is required when jwtAlgorithm is HS256",
    );
  }
  const keyData = new TextEncoder().encode(secret);
  if (keyData.length < 32) {
    throw new Error(
      `AuthProvider: jwtSecret must be at least 32 bytes for HS256; got ${keyData.length}`,
    );
  }
  return await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
}

/**
 * Import an RS256 sign/verify pair from PEM-encoded keys. Private key
 * must be PKCS#8 (`BEGIN PRIVATE KEY`); public key must be SPKI
 * (`BEGIN PUBLIC KEY`). RFC 7518 §3.3 mandates ≥ 2048-bit modulus —
 * not enforced here because Web Crypto doesn't expose modulus length
 * post-import; document the requirement and trust the operator.
 */
async function importRsaKeys(
  privateKeyPem: string | undefined,
  publicKeyPem: string | undefined,
): Promise<{ signKey: CryptoKey; verifyKey: CryptoKey }> {
  if (!publicKeyPem) {
    throw new Error(
      "AuthProvider: jwtPublicKey is required when jwtAlgorithm is RS256",
    );
  }
  if (!privateKeyPem) {
    throw new Error(
      "AuthProvider: jwtPrivateKey is required when jwtAlgorithm is RS256 (verify-only deployments are not yet supported)",
    );
  }

  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

  const signKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(privateKeyPem, "PRIVATE KEY"),
    algorithm,
    false,
    ["sign"],
  );
  const verifyKey = await crypto.subtle.importKey(
    "spki",
    pemToBytes(publicKeyPem, "PUBLIC KEY"),
    algorithm,
    true,
    ["verify"],
  );

  return { signKey, verifyKey };
}

/**
 * Strip PEM armor (`-----BEGIN <label>-----` / `-----END <label>-----`)
 * and base64-decode the body to raw DER bytes. Throws on a missing or
 * mismatched label — operators see the issue at startup instead of
 * `crypto.subtle.importKey` returning the opaque "data is not valid".
 */
function pemToBytes(
  pem: string,
  expectedLabel: string,
): Uint8Array<ArrayBuffer> {
  const begin = `-----BEGIN ${expectedLabel}-----`;
  const end = `-----END ${expectedLabel}-----`;
  const startIdx = pem.indexOf(begin);
  const endIdx = pem.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(
      `AuthProvider: PEM key missing '${begin}' / '${end}' armor — got ${
        pem.slice(0, 30)
      }…`,
    );
  }
  const body = pem.slice(startIdx + begin.length, endIdx)
    .replace(/[\r\n\s]+/g, "");
  const binary = atob(body);
  // Allocate a fresh ArrayBuffer (not ArrayBufferLike) so the returned
  // Uint8Array satisfies WebCrypto's `BufferSource` parameter — Deno's
  // strict TypeScript lib rejects the default `new Uint8Array(N)`
  // because its inferred buffer type widens to ArrayBufferLike.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

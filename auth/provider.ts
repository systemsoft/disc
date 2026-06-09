/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Authentication Provider Implementation
 */

/*** IMPORT ------------------------------------------- ***/

import * as bcrypt from "@da/bcrypt";
import { create, verify } from "@zaubrik/djwt";

/*** UTILITY ------------------------------------------ ***/

import { AuthProviderMfa } from "./provider-mfa.ts";
import { createMailer } from "../smtp/mailer.ts";
import { DatabaseInterface } from "./database-interface.ts";
import { EmailEventListener } from "./email-listener.ts";
import { getLogger } from "../lib/logger.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { validateBranding, validateMagicLinkUrlTemplate } from "./branding.ts";

import {
  createCaptchaVerifier,
  type CaptchaVerifier,
  type RemoteCaptchaVerifierOptions
} from "./captcha.ts";

import {
  importHmacKey,
  importRsaKeys,
  validateAuthConfig,
  type ConditionalAuthFields,
  type ResolvedAuthConfig
} from "./provider-helpers.ts";

import {
  newEventId,
  newEventTimestamp,
  WebhookSender,
  type WebhookEvent,
  type WebhookSenderOptions
} from "./webhooks.ts";

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
  type LoginResult
} from "./types.ts";

const authLogger = getLogger("auth");

/**
 * Defaults applied to every non-conditional `AuthConfig` field. Typed as
 * `Omit<Required<AuthConfig>, ConditionalAuthFields>` so adding a new
 * optional field to `AuthConfig` is a compile error until it’s defaulted
 * here — the field-by-field merge that previously dropped
 * `maxSessionsPerUser` silently can no longer recur.
 */
const AUTH_CONFIG_DEFAULTS: Omit<Required<AuthConfig>, ConditionalAuthFields> = {
  /*** Off by default — preserves anti-enumeration on `requestMagicLink`. Operators opt in when they
       want passwordless first-time signup through the magic-link flow. (gh/geldata#7311) ***/
  allowImplicitSignup: false,
  allowRegistration: true,
  bcryptRounds: 12,
  jwtAlgorithm: "HS256",
  jwtAudience: "disc-api",
  jwtIssuer: "disc",
  /*** 0 disables the cap (unlimited sessions). ***/
  maxSessionsPerUser: 0,
  passwordMinLength: 8,
  passwordRequireNumbers: false,
  passwordRequireSpecial: false,
  passwordRequireUppercase: false,
  refreshTokenExpiry: 604800, /*** 7 days ***/
  requireEmailVerification: false,
  sessionTimeout: 3600,
  tokenExpiry: 3600, /*** 1 hour ***/
  webhooks: []
};

/*** EXPORT ------------------------------------------- ***/

export class AuthProvider extends AuthProviderMfa implements IAuthProvider {
  /*** Pluggable captcha gate for public auth endpoints. Always present; when no `captcha` config
       is supplied, this is a `NoopCaptchaVerifier` that reports `isGated() === false` for every
       endpoint so route handlers can call it unconditionally. (gh/geldata#7341) ***/
  public readonly captchaVerifier: CaptchaVerifier;
  protected config: ResolvedAuthConfig;
  protected db: DatabaseInterface;
  /*** Pre-computed bcrypt hash used by `login()` to equalize response time when the supplied
       email/username doesn’t exist. Without this, an attacker can enumerate valid accounts by
       stopwatch — wrong-password takes ~100ms (bcrypt.compare), no-such-user returns in ~1ms.
       Hashed once at init using the configured cost so the dummy compare takes the same time as a
       real one. (gh/geldata#9137) ***/
  private dummyPasswordHash?: string;
  /*** Separate sign / verify keys: same CryptoKey under HS256, distinct RSA private / public
       CryptoKeys under RS256. ***/
  private signKey?: CryptoKey;
  private verifyKey?: CryptoKey;
  /*** Auth lifecycle webhook dispatcher. Always present; when no subscriptions are configured,
       `dispatch()` is a no-op. (gh/geldata#7484, ports geldata/gel#7813) ***/
  private webhookSender: WebhookSender;

  constructor(
    config: AuthConfig,
    db: DatabaseInterface,
    webhookOptions: WebhookSenderOptions = {},
    captchaOptions: RemoteCaptchaVerifierOptions = {}
  ) {
    super();

    /*** Merge defaults with user config, dropping `undefined` values from `config` so an
         explicitly-undefined optional doesn’t shadow the default. ***/
    const overrides: Partial<AuthConfig> = {};

    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined)
        (overrides as Record<string, unknown>)[key] = value;
    }

    this.config = {
      ...AUTH_CONFIG_DEFAULTS,
      ...overrides
    } as ResolvedAuthConfig;

    /*** gh/geldata#7938 / #8028: branding + magic-link URL template are validated at construction
         so a misconfig (CRLF in `appName`, `javascript:` logo, missing `{token}` placeholder, etc.)
         refuses to boot rather than emitting mangled or unsafe email later. ***/
    validateBranding(this.config.branding);
    validateMagicLinkUrlTemplate(this.config.magicLinkUrlTemplate);

    this.db = db;
    this.webhookSender = new WebhookSender(this.config.webhooks ?? [], webhookOptions);
    this.captchaVerifier = createCaptchaVerifier(this.config.captcha, captchaOptions);

    /*** Wire the in-process SMTP email listener if either side of the pair is configured.
         `createMailer(undefined)` returns a `NoopMailer`, so setting just `emailBaseUrl` is enough
         to dry-run the wiring; production deployments set both. Refusing to register without
         `emailBaseUrl` is intentional — the templates can’t construct usable links without it, so
         surface the misconfig at construction rather than hiding it until the first dispatch. ***/
    if (this.config.smtp || this.config.emailBaseUrl) {
      if (!this.config.emailBaseUrl) {
        authLogger.error("smtp configured without emailBaseUrl — refusing to register email listener (templates need a base URL to construct links)");
      } else {
        const mailer = createMailer(this.config.smtp);

        const listener = new EmailEventListener({
          baseUrl: this.config.emailBaseUrl,
          branding: this.config.branding,
          magicLinkUrlTemplate: this.config.magicLinkUrlTemplate,
          mailer,
          resolveRecipient: identityId => this.resolveEmailRecipient(identityId),
          templates: this.config.emailTemplates
        });

        this.webhookSender.addListener(listener.handle.bind(listener));
      }
    }
  }

  /**
   * Admin override for setting a user’s password without their old one.
   * Locates the user by id or email. Used by `disc admin set-password`.
   * Same `validatePassword()` rules apply, and existing sessions are
   * revoked so the rotated password takes effect everywhere.
   * (gh/geldata#5383, #6454, #1119, #4209)
   */
  async adminSetPassword(userIdOrEmail: string, newPassword: string): Promise<void> {
    const passwordValidation = this.validatePassword(newPassword);

    if (!passwordValidation.valid)
      throw new AuthError(passwordValidation.errors.join(", "), AuthErrorCode.PASSWORD_TOO_WEAK, 400);

    /*** Look up by id or email (email is unique) ***/
    const lookup = await this.db.query("SELECT id FROM users WHERE id = ? OR email = ?", [userIdOrEmail, userIdOrEmail]);

    if (lookup.rows.length === 0)
      throw new AuthError(`User not found: ${userIdOrEmail}`, AuthErrorCode.USER_NOT_FOUND, 404);

    const userId = lookup.rows[0].id as string;
    const newSalt = await bcrypt.genSalt(this.config.bcryptRounds);
    const newPasswordHash = await bcrypt.hash(newPassword, newSalt);

    await this.db.execute(
      "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [newPasswordHash, userId]
    );

    this.auditEvent("password_admin_set", userId);
    /*** Revoke all sessions so the rotated password is the only valid one. ***/
    await this.revokeAllSessions(userId);
  }

  /**
   * Grant `roleName` to `userId`. Idempotent — granting a role twice
   * does not create duplicate rows. Throws if the role doesn’t exist
   * or the user doesn’t exist (so callers see a real error instead of
   * a silent no-op).
   */
  async assignRole(userId: string, roleName: string): Promise<void> {
    const role = await this.db.query("SELECT name FROM roles WHERE name = ?", [roleName]);

    if (role.rows.length === 0)
      throw new AuthError(`Role not found: ${roleName}`, AuthErrorCode.INVALID_OPERATION, 404);

    const user = await this.db.query("SELECT id FROM users WHERE id = ?", [userId]);

    if (user.rows.length === 0)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

    const existing = await this.db.query("SELECT user_id FROM user_roles WHERE user_id = ? AND role_name = ?", [userId, roleName]);

    if (existing.rows.length > 0)
      return;

    await this.db.execute("INSERT INTO user_roles (user_id, role_name) VALUES (?, ?)", [userId, roleName]);
    this.auditEvent("role_assigned", userId, { role: roleName });
  }

  /**
   * Redeem a magic-link token and complete login. Single-use — the
   * row’s `consumed_at` is set on success. If the user has TOTP
   * enrolled, returns an `MfaChallenge` instead of a session, matching
   * the password-login flow (gh/geldata#8186 Phase A): magic-link
   * proves "user has the email", TOTP proves "user has the device".
   */
  async consumeMagicLink(token: string, meta?: RequestMeta): Promise<LoginResult> {
    const tokenHash = await this.hashToken(token);

    const result = await this.db.query(
      `SELECT user_id, expires_at, consumed_at
       FROM magic_link_tokens
       WHERE token_hash = ?`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      /*** Fall through to the implicit-signup table (gh/geldata#7311). When `allowImplicitSignup`
           is on, `requestMagicLink` for an unknown email persists
           into `magic_link_signup_tokens`. ***/
      return await this.consumeMagicLinkSignup(tokenHash, meta);
    }

    const row = result.rows[0];

    if (row.consumed_at)
      throw new AuthError("Magic link already used", AuthErrorCode.INVALID_TOKEN, 401);

    if (new Date(row.expires_at).getTime() < Date.now())
      throw new AuthError("Magic link expired", AuthErrorCode.TOKEN_EXPIRED, 401);

    /*** Burn the link before issuing anything. Even if the MFA challenge step fails, the link is
         single-use — the user requests a new one. ***/
    await this.db.execute("UPDATE magic_link_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE token_hash = ?", [tokenHash]);

    const user = await this.getUser(row.user_id);

    if (!user || !user.active || user.isAnonymous)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

    if (await this.hasConfirmedTOTP(user.id)) {
      const challenge = await this.issueMfaChallenge(user.id);
      this.auditEvent("magic_link_mfa_challenge_issued", user.id, { ipAddress: meta?.ipAddress });

      return challenge;
    }

    this.auditEvent("magic_link_consumed", user.id, { ipAddress: meta?.ipAddress });
    return await this.completeLogin(user, meta);
  }

  /**
   * Register a new role in the role registry. Idempotent — if the role
   * already exists with the same description, this is a no-op; if the
   * description differs, the existing description is updated.
   */
  async createRole(name: string, description?: string): Promise<void> {
    const existing = await this.db.query("SELECT name FROM roles WHERE name = ?", [name]);

    if (existing.rows.length > 0) {
      await this.db.execute("UPDATE roles SET description = ? WHERE name = ?", [description ?? null, name]);
      return;
    }

    await this.db.execute("INSERT INTO roles (name, description) VALUES (?, ?)", [name, description ?? null]);
    this.auditEvent("role_created", null, { role: name });
  }

  /**
   * Remove a role from the registry. ON DELETE CASCADE clears any
   * `user_roles` rows that referenced it.
   */
  async deleteRole(name: string): Promise<void> {
    await this.db.execute("DELETE FROM roles WHERE name = ?", [name]);
    this.auditEvent("role_deleted", null, { role: name });
  }

  async getUser(userId: string): Promise<User | null> {
    const result = await this.db.query("SELECT * FROM users WHERE id = ?", [userId]);

    if (result.rows.length === 0)
      return null;

    return this.rowToUser(result.rows[0]);
  }

  /** Return every role currently held by `userId`. */
  async getUserRoles(userId: string): Promise<string[]> {
    const result = await this.db.query("SELECT role_name FROM user_roles WHERE user_id = ? ORDER BY role_name", [userId]);
    return result.rows.map(r => r.role_name);
  }

  async initialize(): Promise<void> {
    /*** gh/geldata#7006: validate every config value up-front so a misconfig surfaces at boot with
         a clear error, not as an opaque bcrypt / JWT crash on the first auth request. ***/
    validateAuthConfig(this.config);

    /*** P3-04: HS256 (shared secret) is the default; RS256 (asymmetric keys, so verifiers don’t
         need the signing secret) is opt-in via `jwtAlgorithm: "RS256"`. To rotate an HS256 secret:
         stand up a parallel server with the new secret, migrate traffic, and revoke old sessions
         via `UPDATE sessions SET revoked = TRUE`. RS256 rotation works the same way at the verifier
         layer — distribute the new public key first, then start signing with the new private key,
         then revoke. ***/
    if (this.config.jwtAlgorithm === "RS256") {
      const { signKey, verifyKey } = await importRsaKeys(this.config.jwtPrivateKey, this.config.jwtPublicKey);
      this.signKey = signKey;
      this.verifyKey = verifyKey;
    } else {
      const hmacKey = await importHmacKey(this.config.jwtSecret);
      this.signKey = hmacKey;
      this.verifyKey = hmacKey;
    }

    /*** Pre-compute the dummy hash for login-timing equalization. Done here (not in the constructor)
         because bcrypt.hash returns a promise. (gh/geldata#9137) ***/
    const dummySalt = await bcrypt.genSalt(this.config.bcryptRounds);
    this.dummyPasswordHash = await bcrypt.hash("disc-timing-mitigation-not-a-real-password", dummySalt);

    /*** Create tables if they don’t exist ***/
    await this.createTables();
  }

  /** List every registered role. */
  async listRoles(): Promise<Array<{ name: string; description?: string; }>> {
    const result = await this.db.query("SELECT name, description FROM roles ORDER BY name", []);

    return result.rows.map(r => ({
      description: r.description ?? undefined,
      name: r.name
    }));
  }

  async login(credentials: LoginCredentials): Promise<LoginResult> {
    /*** Find user by email or username ***/
    const query = credentials.email ?
      "SELECT * FROM users WHERE email = ?" :
      "SELECT * FROM users WHERE username = ?";

    const param = credentials.email || credentials.username;
    const result = await this.db.query(query, [param]);

    if (result.rows.length === 0) {
      /*** P1-35: generic error — don’t leak whether the email exists. gh/geldata#9137: also burn
           ~one bcrypt round against the dummy hash so an attacker can’t distinguish "no such user"
           (fast DB-only) from "wrong password" (slow bcrypt) by stopwatch. ***/
      await this.runDummyCompare(credentials.password);

      this.auditEvent("login_failed", null, { email: credentials.email, reason: "no_such_user" });
      throw new AuthError("Invalid credentials", AuthErrorCode.INVALID_CREDENTIALS, 401);
    }

    const user = this.rowToUser(result.rows[0]);

    /*** Check if user is active. Burn a dummy compare so the timing matches the wrong-password
         path. (gh/geldata#9137) ***/
    if (!user.active) {
      await this.runDummyCompare(credentials.password);
      throw new AuthError("User account is inactive", AuthErrorCode.USER_INACTIVE, 403);
    }

    /*** Anonymous identities don’t have a real password. Reject in the same shape as
         wrong-credentials (no leak of identity kind), burning a dummy compare for
         timing parity. (gh/geldata#8750) ***/
    if (user.isAnonymous) {
      await this.runDummyCompare(credentials.password);
      throw new AuthError("Invalid credentials", AuthErrorCode.INVALID_CREDENTIALS, 401);
    }

    /*** Check email verification (same timing rationale). ***/
    if (this.config.requireEmailVerification && !user.emailVerified) {
      await this.runDummyCompare(credentials.password);
      throw new AuthError("Email not verified", AuthErrorCode.EMAIL_NOT_VERIFIED, 403);
    }

    /*** Verify password ***/
    const passwordMatch = await bcrypt.compare(credentials.password, user.passwordHash);

    if (!passwordMatch)
      throw new AuthError("Invalid credentials", AuthErrorCode.INVALID_CREDENTIALS, 401);

    /*** MFA gate (gh/geldata#8186): if the user has TOTP enrolled and confirmed, password alone is
         not enough — issue a short-lived challenge token and bail. The caller must complete the
         login via `loginWithTOTP(challengeToken, code)`. ***/
    if (await this.hasConfirmedTOTP(user.id)) {
      const challenge = await this.issueMfaChallenge(user.id);
      this.auditEvent("login_mfa_challenge_issued", user.id, { ipAddress: credentials.meta?.ipAddress });

      return challenge;
    }

    return await this.completeLogin(user, credentials.meta);
  }

  /**
   * Mint a fresh anonymous (guest) identity and an authenticated
   * session for it. The user row exists but cannot sign in via
   * `login()` — the `email` and `password_hash` fields are synthetic.
   * Callers typically store the returned token in an HTTP-only cookie
   * and later call `upgradeAnonymous()` once the user signs up for
   * a full account. (gh/geldata#8750)
   */
  async loginAnonymous(meta?: RequestMeta): Promise<AuthResponse> {
    const userId = this.generateId();
    /*** Synthetic email + password to preserve NOT NULL invariants without forcing a schema
         migration. The email’s TLD `.invalid` (RFC 6761) prevents collision with real
         addresses; the password hash is derived from a high-entropy random string that is
         immediately forgotten so the row can never be signed into. ***/
    const syntheticEmail = `anonymous-${userId}@disc.invalid`;
    const syntheticSecret = this.generateToken();
    const salt = await bcrypt.genSalt(this.config.bcryptRounds);
    const syntheticHash = await bcrypt.hash(syntheticSecret, salt);

    await this.db.execute(
      `
      INSERT INTO users (
        id, email, username, password_hash, email_verified, is_anonymous
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
      [userId, syntheticEmail, null, syntheticHash, false, true]
    );

    const user = await this.getUser(userId);

    if (!user)
      throw new Error("Failed to create anonymous identity");

    const session = await this.createSession(userId, meta);
    const token = await this.generateJWT(user);
    const refreshToken = this.generateToken();

    await this.db.execute("UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?", [token, refreshToken, session.id]);
    session.token = token;
    session.refreshToken = refreshToken;

    this.auditEvent("registered_anonymous", userId, { ipAddress: meta?.ipAddress, sessionId: session.id });

    this.fireWebhook({
      eventId: newEventId(),
      eventType: "IdentityCreated",
      identityId: userId,
      timestamp: newEventTimestamp()
    });

    return {
      refreshToken,
      session,
      token,
      user: this.sanitizeUser(user)
    };
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.execute("UPDATE sessions SET revoked = TRUE WHERE id = ?", [sessionId]);
    this.auditEvent("session_revoked", null, { sessionId, reason: "logout" });
  }

  async refresh(refreshToken: string, meta?: RequestMeta): Promise<AuthResponse> {
    /*** Find session by refresh token. Pull `ip_address` and `user_agent` alongside the rest so we
         can flag a refresh from a new origin. ***/
    const result = await this.db.query(
      `SELECT s.id AS session_id, s.user_id, s.refresh_token, s.revoked,
              s.ip_address AS prev_ip_address,
              s.user_agent AS prev_user_agent,
              u.id, u.email, u.username, u.password_hash,
              u.created_at, u.updated_at, u.email_verified, u.active, u.metadata
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.refresh_token = ? AND s.revoked = FALSE`,
      [refreshToken]
    );

    if (result.rows.length === 0)
      throw new AuthError("Invalid refresh token", AuthErrorCode.INVALID_REFRESH_TOKEN, 401);

    const row = result.rows[0];
    const user = this.rowToUser(row);
    const oldSessionId = row.session_id;
    const prevIp: string | null = row.prev_ip_address ?? null;
    const prevUa: string | null = row.prev_user_agent ?? null;

    /*** Anomaly signal: a refresh that arrives from a different IP or User-Agent than the prior
         session row hints at token theft. We don’t block — that would break legitimate
         mobile-to-wifi handoffs — but we surface a structured audit event so operators can
         correlate. (P2-21) ***/
    if (meta?.ipAddress && prevIp && meta.ipAddress !== prevIp) {
      this.auditEvent("session_refreshed_from_new_ip", user.id, {
        currentIp: meta.ipAddress,
        previousIp: prevIp,
        sessionId: oldSessionId
      });
    }

    if (meta?.userAgent && prevUa && meta.userAgent !== prevUa) {
      this.auditEvent("session_refreshed_from_new_user_agent", user.id, {
        currentUserAgent: meta.userAgent,
        previousUserAgent: prevUa,
        sessionId: oldSessionId
      });
    }

    /*** Revoke old session ***/
    await this.db.execute("UPDATE sessions SET revoked = TRUE WHERE id = ?", [oldSessionId]);

    /*** Create new session — carry forward the new request’s IP/UA so the *next* refresh can
         compare against the most recent origin, not the one from registration. ***/
    const session = await this.createSession(user.id, meta);

    /*** Generate new tokens ***/
    const token = await this.generateJWT(user);
    const newRefreshToken = this.generateToken();

    /*** Update session with tokens ***/
    await this.db.execute("UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?", [token, newRefreshToken, session.id]);

    session.token = token;
    session.refreshToken = newRefreshToken;

    this.auditEvent("session_refreshed", user.id, {
      ipAddress: meta?.ipAddress,
      previousSessionId: oldSessionId,
      sessionId: session.id
    });

    return {
      refreshToken: newRefreshToken,
      session,
      token,
      user: this.sanitizeUser(user)
    };
  }

  async register(data: RegisterData): Promise<AuthResponse> {
    if (!this.config.allowRegistration)
      throw new AuthError("Registration is disabled", AuthErrorCode.REGISTRATION_DISABLED, 403);

    /*** Validate password ***/
    const passwordValidation = this.validatePassword(data.password);

    if (!passwordValidation.valid)
      throw new AuthError(passwordValidation.errors.join(", "), AuthErrorCode.PASSWORD_TOO_WEAK, 400);

    /*** Check if user exists ***/
    const existing = await this.db.query(
      "SELECT id FROM users WHERE email = ? OR (username = ? AND username IS NOT NULL)",
      [data.email, data.username || null]
    );

    if (existing.rows.length > 0)
      throw new AuthError("User already exists", AuthErrorCode.USER_ALREADY_EXISTS, 409);

    /*** Hash password ***/
    const salt = await bcrypt.genSalt(this.config.bcryptRounds);
    const passwordHash = await bcrypt.hash(data.password, salt);

    /*** Create user ***/
    const userId = this.generateId();

    const verificationToken = this.config.requireEmailVerification ?
      this.generateToken() :
      null;

    /*** Store only the hash; plaintext is returned to the caller for emailing. ***/
    const verificationTokenHash = verificationToken ?
      await this.hashToken(verificationToken) :
      null;

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
        verificationTokenHash
      ]
    );

    /*** Get created user ***/
    const user = await this.getUser(userId);

    if (!user)
      throw new Error("Failed to create user");

    /*** Create session ***/
    const session = await this.createSession(userId, data.meta);

    /*** Generate tokens ***/
    const token = await this.generateJWT(user);
    const refreshToken = this.generateToken();

    /*** Update session with tokens ***/
    await this.db.execute("UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?", [token, refreshToken, session.id]);

    session.token = token;
    session.refreshToken = refreshToken;

    this.auditEvent("registered", userId, {
      ipAddress: data.meta?.ipAddress,
      requireEmailVerification: this.config.requireEmailVerification,
      sessionId: session.id
    });

    /*** Webhook: a new identity exists. Fire before EmailVerificationRequested so receivers see
         them in causal order. (gh/geldata#7484, ports geldata/gel#7813) ***/
    this.fireWebhook({
      eventId: newEventId(),
      eventType: "IdentityCreated",
      identityId: userId,
      timestamp: newEventTimestamp()
    });

    if (verificationToken) {
      this.fireWebhook({
        eventId: newEventId(),
        eventType: "EmailVerificationRequested",
        identityId: userId,
        timestamp: newEventTimestamp(),
        verificationToken
      });
    }

    /*** gh/geldata#7275: return the identity alongside the session so callers don’t need a
         follow-up `getUser()` to stash the new identity record. Roles are read once at issue
         time — snapshot semantics match `TokenPayload.roles`. ***/
    const roles = await this.getUserRoles(userId);

    const identity = {
      createdAt: user.createdAt,
      email: user.email,
      emailVerified: user.emailVerified,
      id: user.id,
      roles
    };

    return {
      identity,
      refreshToken: refreshToken,
      session,
      token,
      user: this.sanitizeUser(user),
      /*** Plaintext for the caller to email; DB has the hash. ***/
      ...(verificationToken ? { verificationToken } : {})
    };
  }

  /**
   * Mint a passwordless login token for the user with this email and
   * return the plaintext. Caller is expected to deliver it via email
   * (the link target redeems via `consumeMagicLink`). Tokens expire in
   * 15 minutes by default.
   *
   * Anti-enumeration: when no user matches, the call still succeeds and
   * returns a plaintext token — the token is never persisted, so it
   * can never be redeemed. This keeps the success/failure timing and
   * response shape identical to the happy path. (Same rationale as
   * P1-35 generic-error handling on login.)
   */
  async requestMagicLink(email: string, meta?: RequestMeta): Promise<string> {
    const plaintext = this.generateToken();
    const result = await this.db.query("SELECT id, active, is_anonymous FROM users WHERE email = ?", [email]);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); /*** 15 min ***/

    if (result.rows.length > 0 && result.rows[0].active && !result.rows[0].is_anonymous) {
      const tokenHash = await this.hashToken(plaintext);

      await this.db.execute(
        `INSERT INTO magic_link_tokens (token_hash, user_id, expires_at, ip_address)
         VALUES (?, ?, ?, ?)`,
        [
          tokenHash,
          result.rows[0].id,
          expiresAt.toISOString(),
          meta?.ipAddress ?? null
        ]
      );

      this.auditEvent("magic_link_requested", result.rows[0].id, { ipAddress: meta?.ipAddress });

      this.fireWebhook({
        eventId: newEventId(),
        eventType: "MagicLinkRequested",
        identityId: result.rows[0].id,
        magicLinkToken: plaintext,
        timestamp: newEventTimestamp()
      });
    } else if (this.config.allowImplicitSignup) {
      /*** Implicit-signup path (gh/geldata#7311). Persist the token bound to the pending email;
           `consumeMagicLink` creates the user on redemption. Same response shape and timing as
           the existing path, so the toggle is invisible to a network observer. ***/
      const tokenHash = await this.hashToken(plaintext);

      await this.db.execute(
        `INSERT INTO magic_link_signup_tokens (token_hash, pending_email, expires_at, ip_address)
         VALUES (?, ?, ?, ?)`,
        [
          tokenHash,
          email,
          expiresAt.toISOString(),
          meta?.ipAddress ?? null
        ]
      );

      this.auditEvent("magic_link_signup_requested", null, { email, ipAddress: meta?.ipAddress });

      this.fireWebhook({
        eventType: "MagicLinkSignupRequested",
        eventId: newEventId(),
        timestamp: newEventTimestamp(),
        pendingEmail: email,
        magicLinkToken: plaintext
      });
    } else {
      this.auditEvent("magic_link_requested", null, {
        email,
        ipAddress: meta?.ipAddress,
        result: "no_such_user"
      });
    }

    return plaintext;
  }

  /**
   * Issue a fresh email-verification token for an unverified account and
   * fire `EmailVerificationRequested` so the email-listener can resend
   * the message. The previous token is invalidated by overwrite — only
   * the most recent plaintext maps to the stored hash. (gh/geldata#6503)
   *
   * Silent on unknown email or already-verified accounts: returning a
   * differentiated error would leak account existence and verification
   * state. Returns the plaintext to the caller (same posture as
   * `register()`); the DB only ever stores the hash.
   */
  async resendVerification(email: string): Promise<string | null> {
    const result = await this.db.query("SELECT id, email_verified FROM users WHERE email = ?", [email]);

    if (result.rows.length === 0)
      return null;

    const row = result.rows[0];

    if (row.email_verified)
      return null;

    const userId = row.id;
    const verificationToken = this.generateToken();
    const verificationTokenHash = await this.hashToken(verificationToken);

    /*** Overwrite the stored hash. The previous token’s hash is gone, so verifyEmail() with the old
         plaintext will now fail with INVALID_TOKEN — exactly the desired invalidation. ***/
    await this.db.execute(
      `UPDATE users SET verification_token = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [verificationTokenHash, userId]
    );

    this.auditEvent("email_verification_resent", userId);

    this.fireWebhook({
      eventId: newEventId(),
      eventType: "EmailVerificationRequested",
      identityId: userId,
      timestamp: newEventTimestamp(),
      verificationToken
    });

    return verificationToken;
  }

  async resetPassword(resetToken: string, newPassword: string): Promise<void> {
    const resetTokenHash = await this.hashToken(resetToken);

    const result = await this.db.query(
      "SELECT id FROM users WHERE reset_token = ? AND reset_token_expires > CURRENT_TIMESTAMP",
      [resetTokenHash]
    );

    if (result.rows.length === 0)
      throw new AuthError("Invalid or expired reset token", AuthErrorCode.INVALID_TOKEN, 400);

    const userId = result.rows[0].id;

    /*** Validate new password ***/
    const passwordValidation = this.validatePassword(newPassword);

    if (!passwordValidation.valid)
      throw new AuthError(passwordValidation.errors.join(", "), AuthErrorCode.PASSWORD_TOO_WEAK, 400);

    /*** Hash new password ***/
    const resetSalt = await bcrypt.genSalt(this.config.bcryptRounds);
    const passwordHash = await bcrypt.hash(newPassword, resetSalt);

    /*** Update password and clear reset token ***/
    await this.db.execute(
      `UPDATE users SET password_hash = ?, reset_token = NULL,
       reset_token_expires = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [passwordHash, userId]
    );

    this.auditEvent("password_reset", userId);
    /*** Revoke all sessions ***/
    await this.revokeAllSessions(userId);
  }

  async resetPasswordRequest(email: string): Promise<string> {
    const result = await this.db.query("SELECT id, email_verified FROM users WHERE email = ?", [email]);

    if (result.rows.length === 0) {
      /*** P1-35: don’t leak whether the email is registered. Return a non-plaintext sentinel —
           callers treat a non-empty return as "we’ll email you if the account exists", matching
           standard practice. Audit the no-op so brute-force probing is still visible — the event
           explicitly records `userId: null`. ***/
      this.auditEvent("password_reset_requested", null, { result: "no_such_user" });
      return "";
    }

    const userId = result.rows[0].id;

    /*** gh/geldata#6502: when verification is mandatory, an unverified account is by definition
         unreachable — anyone holding the typo’d email could otherwise complete the reset and seize
         the account. Same silent-return shape as no-such-user so callers can’t tell
         verified-vs-unverified by response. ***/
    if (this.config.requireEmailVerification && !result.rows[0].email_verified) {
      this.auditEvent("password_reset_requested", userId, { result: "unverified_account_blocked" });
      return "";
    }

    const resetToken = this.generateToken();
    const resetTokenHash = await this.hashToken(resetToken);
    const expires = new Date(Date.now() + 3600000); /*** 1 hour ***/

    await this.db.execute(
      "UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?",
      [resetTokenHash, expires.toISOString(), userId]
    );

    this.auditEvent("password_reset_requested", userId);

    this.fireWebhook({
      eventId: newEventId(),
      eventType: "PasswordResetRequested",
      identityId: userId,
      resetToken,
      timestamp: newEventTimestamp()
    });

    /*** Return plaintext to caller (they send it via email); only the hash is in the
         DB. (P0-03) ***/
    return resetToken;
  }

  /**
   * Locate a user by id or email and return the canonical id, or null
   * when no match exists. Used by admin tooling to translate
   * user-supplied selectors (often email) into the row id.
   */
  async resolveUserId(userIdOrEmail: string): Promise<string | null> {
    const result = await this.db.query("SELECT id FROM users WHERE id = ? OR email = ?", [userIdOrEmail, userIdOrEmail]);

    if (result.rows.length === 0)
      return null;

    return result.rows[0].id as string;
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.db.execute("UPDATE sessions SET revoked = TRUE WHERE user_id = ?", [userId]);
    this.auditEvent("sessions_revoked_all", userId);
  }

  /**
   * Revoke `roleName` from `userId`. No-op if the user doesn’t have
   * the role (matches the audit semantics — the post-condition is
   * "user does not have role X" regardless of starting state).
   */
  async revokeRole(userId: string, roleName: string): Promise<void> {
    await this.db.execute("DELETE FROM user_roles WHERE user_id = ? AND role_name = ?", [userId, roleName]);
    this.auditEvent("role_revoked", userId, { role: roleName });
  }

  async updatePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.getUser(userId);

    if (!user)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

    /*** Verify old password ***/
    const passwordMatch = await bcrypt.compare(oldPassword, user.passwordHash);

    if (!passwordMatch)
      throw new AuthError("Invalid credentials", AuthErrorCode.INVALID_CREDENTIALS, 401);

    /*** Validate new password ***/
    const passwordValidation = this.validatePassword(newPassword);

    if (!passwordValidation.valid)
      throw new AuthError(passwordValidation.errors.join(", "), AuthErrorCode.PASSWORD_TOO_WEAK, 400);

    /*** Hash new password ***/
    const newSalt = await bcrypt.genSalt(this.config.bcryptRounds);
    const newPasswordHash = await bcrypt.hash(newPassword, newSalt);

    /*** Update password ***/
    await this.db.execute(
      "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [newPasswordHash, userId]
    );

    this.auditEvent("password_updated", userId);
    /*** Revoke all sessions ***/
    await this.revokeAllSessions(userId);
  }

  /**
   * Promote a previously-anonymous identity to a full user. Replaces
   * the synthetic email + password_hash with real credentials, flips
   * `is_anonymous` to false, and reuses the existing user id so
   * downstream rows that reference it (carts, drafts, etc.) keep
   * working. The caller’s app code is responsible for any cross-row
   * "merge with existing user" logic — this call only mutates the
   * single anonymous row in place. (gh/geldata#8750)
   *
   * Throws if the id doesn’t exist or already belongs to a non-anonymous
   * identity.
   */
  async upgradeAnonymous(anonymousUserId: string, data: RegisterData): Promise<AuthResponse> {
    /*** Validate password before doing any work. ***/
    const passwordValidation = this.validatePassword(data.password);

    if (!passwordValidation.valid)
      throw new AuthError(passwordValidation.errors.join(", "), AuthErrorCode.PASSWORD_TOO_WEAK, 400);

    const lookup = await this.db.query("SELECT id, is_anonymous FROM users WHERE id = ?", [anonymousUserId]);

    if (lookup.rows.length === 0)
      throw new AuthError("Anonymous identity not found", AuthErrorCode.USER_NOT_FOUND, 404);

    if (!lookup.rows[0].is_anonymous)
      throw new AuthError("User is not an anonymous identity", AuthErrorCode.INVALID_OPERATION, 400);

    /*** Refuse if the target email is already taken by someone else. ***/
    const existing = await this.db.query(
      "SELECT id FROM users WHERE (email = ? OR (username = ? AND username IS NOT NULL)) AND id != ?",
      [data.email, data.username || null, anonymousUserId]
    );

    if (existing.rows.length > 0)
      throw new AuthError("User already exists", AuthErrorCode.USER_ALREADY_EXISTS, 409);

    const salt = await bcrypt.genSalt(this.config.bcryptRounds);
    const passwordHash = await bcrypt.hash(data.password, salt);

    const verificationToken = this.config.requireEmailVerification ?
      this.generateToken() :
      null;

    const verificationTokenHash = verificationToken ?
      await this.hashToken(verificationToken) :
      null;

    await this.db.execute(
      `
      UPDATE users
         SET email = ?, username = ?, password_hash = ?,
             email_verified = ?, metadata = ?, verification_token = ?,
             is_anonymous = FALSE, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `,
      [
        data.email,
        data.username || null,
        passwordHash,
        !this.config.requireEmailVerification,
        data.metadata ? JSON.stringify(data.metadata) : null,
        verificationTokenHash,
        anonymousUserId
      ]
    );

    const user = await this.getUser(anonymousUserId);

    if (!user)
      throw new Error("User vanished after upgrade");

    /*** Mint fresh tokens; the old session keeps working but the new identity gets a fresh JWT
         reflecting the real email. ***/
    const session = await this.createSession(user.id, data.meta);
    const token = await this.generateJWT(user);
    const refreshToken = this.generateToken();

    await this.db.execute("UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?", [token, refreshToken, session.id]);

    session.token = token;
    session.refreshToken = refreshToken;

    this.auditEvent("upgraded_anonymous", user.id, { ipAddress: data.meta?.ipAddress, sessionId: session.id });

    if (verificationToken) {
      this.fireWebhook({
        eventId: newEventId(),
        eventType: "EmailVerificationRequested",
        identityId: user.id,
        timestamp: newEventTimestamp(),
        verificationToken
      });
    }

    return {
      refreshToken,
      session,
      token,
      user: this.sanitizeUser(user),
      ...(verificationToken ? { verificationToken } : {})
    };
  }

  /** True iff `userId` has been granted `roleName`. */
  async userHasRole(userId: string, roleName: string): Promise<boolean> {
    const result = await this.db.query("SELECT 1 FROM user_roles WHERE user_id = ? AND role_name = ?", [userId, roleName]);
    return result.rows.length > 0;
  }

  async verifyEmail(verificationToken: string): Promise<void> {
    const verificationTokenHash = await this.hashToken(verificationToken);
    const result = await this.db.query("SELECT id FROM users WHERE verification_token = ?", [verificationTokenHash]);

    if (result.rows.length === 0)
      throw new AuthError("Invalid verification token", AuthErrorCode.INVALID_TOKEN, 400);

    const userId = result.rows[0].id;

    await this.db.execute(
      `UPDATE users SET email_verified = TRUE, verification_token = NULL,
       updated_at = CURRENT_TIMESTAMP WHERE verification_token = ?`,
      [verificationTokenHash]
    );

    this.auditEvent("email_verified", userId);

    this.fireWebhook({
      eventId: newEventId(),
      eventType: "EmailVerified",
      identityId: userId,
      timestamp: newEventTimestamp()
    });
  }

  /**
   * Redeem a magic-code submission and complete login. Lookup is
   * scoped by `email` (not just `token_hash`) because 6 digits = 1M
   * possibilities — far smaller than magic-link’s 32-byte token space.
   * Combined with per-IP rate-limiting at the HTTP layer and the
   * 5-attempt lockout below, brute-force is infeasible.
   *
   * Lockout: every wrong-code submission against a non-expired,
   * non-consumed row increments `attempts`. When the counter reaches
   * 5, the row is marked consumed (`consumed_at` set) — the user must
   * request a fresh code. Each new `requestMagicCode` insert resets
   * the counter trivially because it inserts a new row; old rows are
   * simply ignored or expired.
   *
   * MFA: matches `consumeMagicLink` — if the user has TOTP enrolled,
   * an `MfaChallenge` is returned instead of a session and the code
   * is burned regardless. (gh/geldata#7367)
   */
  async verifyMagicCode(email: string, code: string, meta?: RequestMeta): Promise<LoginResult> {
    const tokenHash = await this.hashToken(code);
    const userResult = await this.db.query("SELECT id, active, is_anonymous FROM users WHERE email = ?", [email]);

    /*** Anti-enumeration: do a dummy hash for unknown emails so the wall-clock posture matches the
         happy path. Same rationale as `runDummyCompare` for password login
         (P1-35 / gh/geldata#9137). ***/
    if (userResult.rows.length === 0 || !userResult.rows[0].active || userResult.rows[0].is_anonymous) {
      await this.hashToken(code);
      throw new AuthError("Invalid or expired code", AuthErrorCode.INVALID_TOKEN, 401);
    }

    const userId = userResult.rows[0].id;
    /*** Look for the most recent matching code for this user. We scope by user_id rather than
         relying on token_hash alone — the 1M possibility space makes a global hash lookup an
         unacceptable brute-force surface. ***/
    const codeResult = await this.db.query(
      `SELECT id, expires_at, consumed_at, attempts
       FROM magic_code_tokens
       WHERE user_id = ? AND token_hash = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, tokenHash]
    );

    if (codeResult.rows.length === 0) {
      /*** Wrong code — find the most recent live row for this user and bump its attempt counter.
           Lockout after 5 by burning the row. ***/
      const liveResult = await this.db.query(
        `SELECT id, attempts, expires_at
         FROM magic_code_tokens
         WHERE user_id = ? AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId]
      );

      if (liveResult.rows.length > 0 && new Date(liveResult.rows[0].expires_at).getTime() > Date.now()) {
        const newAttempts = Number(liveResult.rows[0].attempts) + 1;

        if (newAttempts >= 5) {
          await this.db.execute(
            `UPDATE magic_code_tokens
             SET attempts = ?, consumed_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [newAttempts, liveResult.rows[0].id]
          );

          this.auditEvent("magic_code_lockout", userId, { ipAddress: meta?.ipAddress });
        } else {
          await this.db.execute("UPDATE magic_code_tokens SET attempts = ? WHERE id = ?", [newAttempts, liveResult.rows[0].id]);
        }
      }

      this.auditEvent("magic_code_invalid", userId, { ipAddress: meta?.ipAddress });
      throw new AuthError("Invalid or expired code", AuthErrorCode.INVALID_TOKEN, 401);
    }

    const row = codeResult.rows[0];

    if (row.consumed_at) {
      this.auditEvent("magic_code_invalid", userId, { ipAddress: meta?.ipAddress, reason: "consumed" });
      throw new AuthError("Code already used", AuthErrorCode.INVALID_TOKEN, 401);
    }

    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.auditEvent("magic_code_invalid", userId, { ipAddress: meta?.ipAddress, reason: "expired" });
      throw new AuthError("Code expired", AuthErrorCode.TOKEN_EXPIRED, 401);
    }

    /*** Burn the code before issuing anything. Even if the MFA challenge step fails downstream, the
         code is single-use — the user requests a new one. ***/
    await this.db.execute("UPDATE magic_code_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
    const user = await this.getUser(userId);

    if (!user || !user.active || user.isAnonymous)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

    if (await this.hasConfirmedTOTP(user.id)) {
      const challenge = await this.issueMfaChallenge(user.id);
      this.auditEvent("magic_code_mfa_challenge_issued", user.id, { ipAddress: meta?.ipAddress });

      return challenge;
    }

    this.auditEvent("magic_code_consumed", user.id, { ipAddress: meta?.ipAddress });

    return await this.completeLogin(user, meta);
  }

  async verifyToken(token: string): Promise<TokenPayload> {
    if (!this.verifyKey)
      throw new Error("Auth provider not initialized");

    try {
      /*** Verify JWT ***/
      const rawPayload = await verify(token, this.verifyKey);
      const payload = rawPayload as unknown as TokenPayload;

      /*** Check session: exists, not revoked, AND server-side expires_at is in the future (P1-33 —
           previously only the JWT exp claim was checked, so a stolen token remained usable until
           its JWT exp regardless of server-side revocation timing). ***/
      const result = await this.db.query(
        `SELECT id FROM sessions
           WHERE token = ?
             AND revoked = FALSE
             AND expires_at > CURRENT_TIMESTAMP`,
        [token]
      );

      if (result.rows.length === 0)
        throw new AuthError("Session expired or revoked", AuthErrorCode.SESSION_EXPIRED, 401);

      /*** Check JWT expiration (separate from server-side expires_at — clients may have a shorter
           JWT lifetime than the session record). ***/
      if (payload.exp && payload.exp <= Math.floor(Date.now() / 1000))
        throw new AuthError("Token expired", AuthErrorCode.TOKEN_EXPIRED, 401);

      /*** Stamp last_activity so inactivity-based reaping can work. Best-effort — verification
           succeeds even if this UPDATE fails. ***/
      await this
        .db
        .execute("UPDATE sessions SET last_activity = CURRENT_TIMESTAMP WHERE id = ?", [result.rows[0].id])
        .catch(() => {});

      return payload;
    } catch (error) {
      if (error instanceof AuthError) {
        /*** Audit the structured failure so a stream of SESSION_EXPIRED / TOKEN_EXPIRED events is
             visible to operators alongside the other auth-event audit log. ***/
        this.auditEvent("token_verification_failed", null, { code: error.code });
        throw error;
      }

      /*** Check if the djwt library threw an expiration error ***/
      const errorMsg = error instanceof Error ?
        error.message.toLowerCase() :
        "";

      if (errorMsg.includes("expired") || errorMsg.includes("exp")) {
        this.auditEvent("token_verification_failed", null, { code: AuthErrorCode.TOKEN_EXPIRED });
        throw new AuthError("Token expired", AuthErrorCode.TOKEN_EXPIRED, 401);
      }

      this.auditEvent("token_verification_failed", null, { code: AuthErrorCode.INVALID_TOKEN });
      throw new AuthError("Invalid token", AuthErrorCode.INVALID_TOKEN, 401);
    }
  }

  /*** PRIVATE ------------------------------------------ ***/

  /**
   * Structured audit event. Writes to the shared logger at info level with
   * a stable `event=auth.<name>` prefix so log aggregators can filter on
   * auth events. Best-effort: failures in logging never propagate. (P2-23)
   */
  protected auditEvent(event: string, userId: string | null, details: Record<string, unknown> = {}): void {
    try {
      authLogger.info(`auth.${event}`, {
        event,
        userId: userId ?? "anonymous",
        ...details
      });
    } catch {
      /*** swallow ***/
    }
  }

  /**
   * Internal: shared "create session + mint JWT + audit + webhook" path.
   * Used by both the password-only `login()` and the MFA-completing
   * `loginWithTOTP()` so they emit the same events and shape.
   */
  protected async completeLogin(user: User, meta?: RequestMeta): Promise<AuthResponse> {
    const session = await this.createSession(user.id, meta);
    const token = await this.generateJWT(user);
    const refreshToken = this.generateToken();

    await this.db.execute("UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?", [token, refreshToken, session.id]);

    session.token = token;
    session.refreshToken = refreshToken;

    this.auditEvent("login_succeeded", user.id, {
      ipAddress: meta?.ipAddress,
      sessionId: session.id
    });

    this.fireWebhook({
      eventId: newEventId(),
      eventType: "IdentityAuthenticated",
      identityId: user.id,
      timestamp: newEventTimestamp()
    });

    return {
      refreshToken,
      session,
      token,
      user: this.sanitizeUser(user)
    };
  }

  /**
   * Implicit-signup branch for `consumeMagicLink` (gh/geldata#7311).
   * Looks up the token in `magic_link_signup_tokens`; if found and
   * valid, creates the user (active, email_verified=true since the
   * email round-trip just proved control), burns the token, and
   * completes login. The error path matches the regular magic-link
   * flow so a token from neither table looks identical to a normal
   * "invalid or expired" failure.
   */
  private async consumeMagicLinkSignup(tokenHash: string, meta?: RequestMeta): Promise<LoginResult> {
    const result = await this.db.query(
      `SELECT pending_email, expires_at, consumed_at
       FROM magic_link_signup_tokens
       WHERE token_hash = ?`,
      [tokenHash]
    );

    if (result.rows.length === 0)
      throw new AuthError("Invalid or expired magic link", AuthErrorCode.INVALID_TOKEN, 401);

    const row = result.rows[0];

    if (row.consumed_at)
      throw new AuthError("Magic link already used", AuthErrorCode.INVALID_TOKEN, 401);

    if (new Date(row.expires_at).getTime() < Date.now())
      throw new AuthError("Magic link expired", AuthErrorCode.TOKEN_EXPIRED, 401);

    /*** Race-safe ordering: burn the token first, then create the user. If a parallel redemption
         arrived, the second UPDATE finds `consumed_at` already set and the second
         consumeMagicLinkSignup call returns "already used". ***/
    await this.db.execute("UPDATE magic_link_signup_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE token_hash = ?", [tokenHash]);

    /*** It’s possible the user registered via another path between requestMagicLink and consume —
         if so, fall through to login on the existing record rather than failing
         the redemption. ***/
    const existing = await this.db.query("SELECT id, active, is_anonymous FROM users WHERE email = ?", [row.pending_email]);
    let userId: string;

    if (existing.rows.length > 0 && existing.rows[0].active && !existing.rows[0].is_anonymous) {
      userId = existing.rows[0].id;
    } else {
      userId = this.generateId();
      await this.db.execute(
        `INSERT INTO users (id, email, password_hash, email_verified, active)
         VALUES (?, ?, ?, ?, ?)`,
        [userId, row.pending_email, "", true, true]
      );

      this.auditEvent("identity_created", userId, { ipAddress: meta?.ipAddress, via: "magic_link_signup" });

      this.fireWebhook({
        eventId: newEventId(),
        eventType: "IdentityCreated",
        identityId: userId,
        timestamp: newEventTimestamp()
      });
    }

    const user = await this.getUser(userId);

    if (!user)
      throw new AuthError("User not found after signup", AuthErrorCode.USER_NOT_FOUND, 500);

    this.auditEvent("magic_link_signup_consumed", userId, { ipAddress: meta?.ipAddress });
    return await this.completeLogin(user, meta);
  }

  private async createSession(userId: string, meta?: { ipAddress?: string; userAgent?: string; }): Promise<Session> {
    const sessionId = this.generateId();
    const expiresAt = new Date(Date.now() + this.config.sessionTimeout * 1000);
    /*** P2-22: cap concurrent sessions per user. If maxSessionsPerUser is set and the user is
         already at the cap, revoke the oldest session before creating a new one. This bounds
         credential-stuffing blast radius without breaking legitimate multi-device use. ***/
    const maxSessions = this.config.maxSessionsPerUser;

    if (typeof maxSessions === "number" && maxSessions > 0) {
      const active = await this.db.query(
        `SELECT id FROM sessions
           WHERE user_id = ?
             AND revoked = FALSE
             AND expires_at > CURRENT_TIMESTAMP
           ORDER BY created_at ASC`,
        [userId]
      );

      if (active.rows.length >= maxSessions) {
        const toRevoke = active
          .rows
          .slice(0, active.rows.length - maxSessions + 1)
          .map(row => row.id);

        for (const oldId of toRevoke) {
          await this.db.execute("UPDATE sessions SET revoked = TRUE WHERE id = ?", [oldId]);
          this.auditEvent("session_revoked", userId, { reason: "max_sessions_per_user", sessionId: oldId });
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
        /*** P2-21: persist IP + User-Agent so anomaly detection downstream (and the audit log
             below) has something to work with. Missing metadata is stored as NULL.***/
        meta?.ipAddress ?? null,
        meta?.userAgent ?? null
      ]
    );

    /*** P2-23: audit the creation. Best-effort — failures in the audit log must never break
         session creation. ***/
    this.auditEvent("session_created", userId, { ipAddress: meta?.ipAddress, sessionId });

    return {
      createdAt: new Date(),
      expiresAt: expiresAt,
      id: sessionId,
      token: "",
      userId: userId
    };
  }

  private async createTables(): Promise<void> {
    /*** Users table. ***/
    /*** `is_anonymous` (gh/geldata#8750): guest identities live in the same row but synth their
         email + password_hash to keep the existing NOT NULL invariants. `loginAnonymous()` mints
         them; `upgradeAnonymous()` flips them into full users by replacing email + password_hash
         and toggling the flag. ***/
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
        is_anonymous BOOLEAN DEFAULT FALSE,
        metadata TEXT,
        verification_token TEXT,
        reset_token TEXT,
        reset_token_expires TIMESTAMP
      )
    `);

    /*** Idempotent column addition for instances that pre-date the anonymous-identity feature. Both
         Postgres and SQLite-style backends accept `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in
         recent versions; if a backend rejects this, the catch keeps initialize() going (the feature
         simply won’t work). ***/
    try {
      await this.db.execute(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT FALSE`);
    } catch {
      /*** pre-existing column, or backend doesn’t support IF NOT EXISTS for ADD COLUMN; either case
           is fine here. ***/
    }

    /*** Sessions table ***/
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

    /*** WebAuthn credentials (gh/geldata#6725) — one row per registered passkey. `credential_id` is
         base64url; `public_key_jwk` is the JSON form of the COSE key (we re-import on each verify).
         Counter is monotonic per-credential — the authenticator increments it on every signature so
         we can detect cloned credentials. ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS webauthn_credentials (
        credential_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        public_key_jwk TEXT NOT NULL,
        alg INTEGER NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0,
        name TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    /*** WebAuthn ceremony challenges (gh/geldata#6725) — short-lived, single-use. `purpose`
         distinguishes register vs login because the verification path treats them differently.
         `user_id` is null for login challenges that don’t bind to a known user yet (we look up by
         credential id on finish).

         Cascade rule (gh/geldata#7103): when a registered user is deleted, any in-flight register
         challenges bound to them have to go too. Login challenges with `user_id IS NULL` aren’t
         affected — PG’s FK semantics ignore null on the reference side. ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS webauthn_challenges (
        id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        purpose TEXT NOT NULL,
        user_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    /*** Idempotent FK add for instances that pre-date the cascade rule (gh/geldata#7103). The DO
         block first scrubs any orphan rows (challenges referencing a now-deleted user) so the ADD
         CONSTRAINT can’t fail validation, then adds the constraint if it isn’t already there. Safe
         to run on every startup — a no-op once the constraint exists. ***/
    try {
      await this.db.execute(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'webauthn_challenges_user_id_fkey'
          ) THEN
            DELETE FROM webauthn_challenges
            WHERE user_id IS NOT NULL
              AND user_id NOT IN (SELECT id FROM users);
            ALTER TABLE webauthn_challenges
              ADD CONSTRAINT webauthn_challenges_user_id_fkey
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
          END IF;
        END $$;
      `);
    } catch {
      /*** Backend lacks DO-block support (non-PG). The CREATE TABLE above already carries the
           inline FK, so fresh deployments are correct; legacy rows on a non-PG backend are out
           of scope. ***/
    }

    /*** Recovery codes (gh/geldata#8186) — single-use codes the user saves at MFA setup time and
         uses to bypass TOTP if they lose their device. Stored hashed (SHA-256, parallel to other
         token hashing in this module). Plain `used_at` marker rather than deletion so we can audit
         "this user burned a recovery code at T" without keeping a separate event table
         in line. ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    /*** Magic-link tokens (gh/geldata#8186) — one row per outstanding request. Stored hashed
         (parallel to reset/verify tokens, P0-03); the plaintext is delivered to the user once via
         email and never reproducible. Single-use: `consumed_at` set on redemption. ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS magic_link_tokens (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP,
        ip_address TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    /*** Implicit-signup magic-link tokens (gh/geldata#7311). Separate table so
         `magic_link_tokens.user_id` stays NOT NULL — no ALTER COLUMN dance for existing
         deployments. When `allowImplicitSignup` is on and `requestMagicLink` is called for an
         unknown email, the token lands here; `consumeMagicLink` creates the user
         on redemption. ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS magic_link_signup_tokens (
        token_hash TEXT PRIMARY KEY,
        pending_email TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP,
        ip_address TEXT
      )
    `);

    /*** Magic-code tokens (gh/geldata#7367) — passwordless email-delivered 6-digit codes, the
         SMS-friendly sibling of magic-link. Stored hashed; lookup is scoped by `user_id` to keep
         the 1M-possibility brute-force surface infeasible. `attempts` counts wrong-code submissions
         for the row; ≥5 marks the row consumed (locked out until the user requests a
         fresh code). ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS magic_code_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP,
        attempts INTEGER NOT NULL DEFAULT 0,
        ip_address TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    /*** MFA TOTP table (gh/geldata#8186) — one row per user when TOTP is enrolled. `confirmed_at`
         distinguishes pending enrollments (user scanned the QR but hasn’t proven they can read
         codes from it) from active MFA. `secret` is base32 — we store it plaintext because
         PG-at-rest encryption is the operator’s job and re-encrypting on every verify would
         gut performance. ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS mfa_totp (
        user_id TEXT PRIMARY KEY,
        secret TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    /*** MFA challenge table (gh/geldata#8186) — short-lived password-verified-but-MFA-pending
         tokens. The user has typed the right password; they now need to prove possession of the
         second factor. Tokens are stored hashed (parallel to reset/verify token handling at P0-03)
         and expire fast (default 5 min). ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS mfa_challenges (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    /*** Roles table — a small registry of named roles that users can be assigned to.
         (gh/geldata#8177) Roles themselves carry only a name and an optional description;
         permissions are encoded in access policies (`has_role("admin")`) rather than persisted
         per-role, matching disc’s policy-driven model. ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS roles (
        name TEXT PRIMARY KEY,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    /*** user_roles join — many-to-many. ON DELETE CASCADE on both sides so role removal and user
         deletion both clean up the assignments. ***/
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id TEXT NOT NULL,
        role_name TEXT NOT NULL,
        granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, role_name),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (role_name) REFERENCES roles(name) ON DELETE CASCADE
      )
    `);

    /*** Indexes ***/
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_user_roles_role_name ON user_roles(role_name)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user_id ON mfa_challenges(user_id)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expires_at ON mfa_challenges(expires_at)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_magic_link_user_id ON magic_link_tokens(user_id)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_magic_link_expires_at ON magic_link_tokens(expires_at)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_magic_code_user_id ON magic_code_tokens(user_id)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_magic_code_expires_at ON magic_code_tokens(expires_at)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes(user_id)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id ON webauthn_credentials(user_id)`);
    await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires_at ON webauthn_challenges(expires_at)`);
  }

  /**
   * Fire a lifecycle webhook. Wraps `webhookSender.dispatch()` with
   * logging-only error handling — webhook failures must never surface
   * to the auth caller. (gh/geldata#7484, ports geldata/gel#7813)
   */
  private fireWebhook(event: WebhookEvent): void {
    void this.webhookSender.dispatch(event).catch(err => {
      authLogger.warn("webhook dispatch errored", {
        error: err instanceof Error ? err.message : String(err),
        eventType: event.eventType
      });
    });
  }

  protected generateId(): string {
    return crypto.randomUUID();
  }

  private async generateJWT(user: User): Promise<string> {
    if (!this.signKey) {
      throw new Error(
        this.config.jwtAlgorithm === "RS256" ?
          "Auth provider configured for verify-only (no jwtPrivateKey) — cannot mint tokens" :
          "Auth provider not initialized"
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const roles = await this.getUserRoles(user.id);

    const payload: TokenPayload = {
      aud: this.config.jwtAudience,
      email: user.email,
      exp: now + this.config.tokenExpiry,
      iat: now,
      iss: this.config.jwtIssuer,
      jti: this.generateId(),
      sub: user.id,
      username: user.username
    };

    if (roles.length > 0)
      payload.roles = roles;

    return await create({ alg: this.config.jwtAlgorithm, typ: "JWT" }, payload as any, this.signKey);
  }

  /**
   * Generate a uniformly-distributed zero-padded numeric code of the
   * requested length. Implemented by drawing `Uint32` samples and
   * rejecting any value above the largest multiple of `10^digits` that
   * fits in `2^32`. A naive `% 10^digits` over `Uint32` has a small
   * but real bias toward the lower buckets — for 6 digits the bias is
   * tiny but it’s free to do this correctly.
   *
   * Used by `requestMagicCode` (gh/geldata#7367); `digits` is at most
   * 9 in practice (10^10 doesn’t fit in `Uint32`).
   */
  private generateNumericCode(digits: number): string {
    if (digits < 1 || digits > 9)
      throw new Error(`generateNumericCode: digits must be 1..9 (got ${digits})`);

    const modulus = 10 ** digits;
    /*** Largest multiple of `modulus` that fits in 2^32. Anything ≥ this threshold is rejected to
         keep the post-mod distribution uniform. ***/
    const limit = Math.floor(0x1_0000_0000 / modulus) * modulus;
    const buf = new Uint32Array(1);

    while (true) {
      crypto.getRandomValues(buf);

      if (buf[0] < limit)
        return String(buf[0] % modulus).padStart(digits, "0");
    }
  }

  protected generateToken(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);

    return Array
      .from(bytes)
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * Hash a reset/verification token before storing it.
   *
   * Tokens are 32 random bytes (256 bits) → high-entropy, so SHA-256 suffices
   * (unlike passwords, we don’t need a slow hash). Storing only the hash
   * ensures that a DB leak can’t be used to reset other users’ passwords
   * or bypass email verification — the attacker would need the original
   * plaintext token, which was only sent to the user’s email. (P0-03)
   */
  protected async hashToken(plaintext: string): Promise<string> {
    return await sha256Hex(plaintext);
  }

  /**
   * Mint a passwordless 6-digit login code for the user with this
   * email and return the plaintext. Caller is expected to deliver it
   * via email/SMS (the user types it back into the app to log in via
   * `verifyMagicCode`). Codes expire in 10 minutes by default —
   * shorter than magic-link’s 15 because human-typed codes shouldn’t
   * sit around in inboxes.
   *
   * Anti-enumeration: when no user matches, the call still succeeds
   * and returns a plaintext code — the row is never persisted, so the
   * code can never be redeemed. Same response-shape and timing posture
   * as `requestMagicLink` and `login()` (gh/geldata#9137).
   */
  async requestMagicCode(email: string, meta?: RequestMeta): Promise<string> {
    const code = this.generateNumericCode(6);
    const result = await this.db.query("SELECT id, active, is_anonymous FROM users WHERE email = ?", [email]);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); /*** 10 min ***/

    if (result.rows.length > 0 && result.rows[0].active && !result.rows[0].is_anonymous) {
      const tokenHash = await this.hashToken(code);

      await this.db.execute(
        `INSERT INTO magic_code_tokens (id, token_hash, user_id, expires_at, attempts, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          this.generateId(),
          tokenHash,
          result.rows[0].id,
          expiresAt.toISOString(),
          0,
          meta?.ipAddress ?? null
        ]
      );

      this.auditEvent("magic_code_requested", result.rows[0].id, { ipAddress: meta?.ipAddress });

      this.fireWebhook({
        eventId: newEventId(),
        eventType: "MagicCodeRequested",
        identityId: result.rows[0].id,
        magicCode: code,
        timestamp: newEventTimestamp()
      });
    } else {
      this.auditEvent("magic_code_requested", null, {
        email,
        ipAddress: meta?.ipAddress,
        result: "no_such_user"
      });
    }

    return code;
  }

  /**
   * Map an `identityId` to the recipient email used by the SMTP
   * email listener. Returns `null` for unknown ids and for anonymous
   * identities (their email is a synthetic placeholder; messaging
   * them would dead-letter at best). Used as the
   * `resolveRecipient` callback on `EmailEventListener`.
   */
  private async resolveEmailRecipient(identityId: string): Promise<string | null> {
    const result = await this.db.query("SELECT email, is_anonymous FROM users WHERE id = ?", [identityId]);

    if (result.rows.length === 0)
      return null;

    const row = result.rows[0];

    if (row.is_anonymous)
      return null;

    return typeof row.email === "string" && row.email.length > 0 ?
      row.email :
      null;
  }

  private rowToUser(row: any): User {
    return {
      active: Boolean(row.active),
      createdAt: new Date(row.created_at),
      email: row.email,
      emailVerified: Boolean(row.email_verified),
      id: row.id,
      isAnonymous: row.is_anonymous === undefined ?
        false :
        Boolean(row.is_anonymous),
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      passwordHash: row.password_hash,
      updatedAt: new Date(row.updated_at),
      username: row.username
    };
  }

  /**
   * Run `bcrypt.compare` against the pre-computed dummy hash. Used by
   * `login()` on every short-circuit path (no such user, inactive,
   * unverified) so an attacker can’t distinguish those from a real
   * wrong-password attempt by response time. (gh/geldata#9137)
   *
   * The result is intentionally discarded — we don’t care whether
   * dummy compare matches; we only care that bcrypt did the work.
   */
  private async runDummyCompare(input: string): Promise<void> {
    if (!this.dummyPasswordHash)
      return;

    await bcrypt.compare(input, this.dummyPasswordHash);
  }

  private sanitizeUser(user: User): Omit<User, "passwordHash"> {
    const { passwordHash: _passwordHash, ...sanitized } = user;
    return sanitized;
  }

  private validatePassword(password: string): PasswordValidationResult {
    const errors: string[] = [];

    if (password.length < this.config.passwordMinLength)
      errors.push(`Password must be at least ${this.config.passwordMinLength} characters`);

    if (this.config.passwordRequireUppercase && !/[A-Z]/.test(password))
      errors.push("Password must contain at least one uppercase letter");

    if (this.config.passwordRequireNumbers && !/[0-9]/.test(password))
      errors.push("Password must contain at least one number");

    if (this.config.passwordRequireSpecial && !/[!@#$%^&*(),.?":{}|<>]/.test(password))
      errors.push("Password must contain at least one special character");

    return {
      errors,
      valid: errors.length === 0
    };
  }
}

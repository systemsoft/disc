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
  type LoginResult,
  type MfaChallenge,
  PasswordValidationResult,
  RegisterData,
  RequestMeta,
  Session,
  TokenPayload,
  type TotpEnrollment,
  User,
  type WebAuthnLoginFinish,
  type WebAuthnLoginOptions,
  type WebAuthnRegistrationFinish,
  type WebAuthnRegistrationOptions,
} from "./types.ts";
import { newEventId, newEventTimestamp, type WebhookEvent, WebhookSender, type WebhookSenderOptions } from "./webhooks.ts";
import { type CaptchaVerifier, createCaptchaVerifier, type RemoteCaptchaVerifierOptions } from "./captcha.ts";
import { buildOtpauthUri, generateSecret as generateTotpSecret, verifyTOTP } from "./totp.ts";
import * as webAuthn from "./webauthn.ts";
import { createMailer } from "../smtp/mailer.ts";
import { EmailEventListener } from "./email-listener.ts";

/**
 * Conditional config fields whose presence depends on `jwtAlgorithm`:
 *  - HS256 needs `jwtSecret`
 *  - RS256 needs `jwtPrivateKey` + `jwtPublicKey`
 * They're excluded from the defaults map (no sensible default) and
 * validated at runtime in `initialize()`.
 */
type ConditionalAuthFields =
  | "jwtSecret"
  | "jwtPrivateKey"
  | "jwtPublicKey"
  | "webauthn"
  | "smtp"
  | "emailTemplates"
  | "emailBaseUrl"
  | "captcha";

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
const AUTH_CONFIG_DEFAULTS: Omit<Required<AuthConfig>, ConditionalAuthFields> = {
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
  webhooks: [],
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
  // Auth lifecycle webhook dispatcher. Always present; when no
  // subscriptions are configured, `dispatch()` is a no-op.
  // (gh/geldata#7484, ports geldata/gel#7813)
  private webhookSender: WebhookSender;
  // Pluggable captcha gate for public auth endpoints. Always present;
  // when no `captcha` config is supplied, this is a `NoopCaptchaVerifier`
  // that reports `isGated() === false` for every endpoint so route
  // handlers can call it unconditionally. (gh/geldata#7341)
  public readonly captchaVerifier: CaptchaVerifier;

  constructor(
    config: AuthConfig,
    db: DatabaseInterface,
    webhookOptions: WebhookSenderOptions = {},
    captchaOptions: RemoteCaptchaVerifierOptions = {},
  ) {
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
    this.webhookSender = new WebhookSender(
      this.config.webhooks ?? [],
      webhookOptions,
    );
    this.captchaVerifier = createCaptchaVerifier(
      this.config.captcha,
      captchaOptions,
    );

    // Wire the in-process SMTP email listener if either side of the
    // pair is configured. `createMailer(undefined)` returns a
    // `NoopMailer`, so setting just `emailBaseUrl` is enough to
    // dry-run the wiring; production deployments set both.
    // Refusing to register without `emailBaseUrl` is intentional —
    // the templates can't construct usable links without it, so
    // surface the misconfig at construction rather than hiding it
    // until the first dispatch.
    if (this.config.smtp || this.config.emailBaseUrl) {
      if (!this.config.emailBaseUrl) {
        authLogger.error(
          "smtp configured without emailBaseUrl — refusing to register email listener (templates need a base URL to construct links)",
        );
      } else {
        const mailer = createMailer(this.config.smtp);
        const listener = new EmailEventListener({
          baseUrl: this.config.emailBaseUrl,
          mailer,
          resolveRecipient: (identityId) => this.resolveEmailRecipient(identityId),
          templates: this.config.emailTemplates,
        });
        this.webhookSender.addListener(listener.handle.bind(listener));
      }
    }
  }

  /**
   * Map an `identityId` to the recipient email used by the SMTP
   * email listener. Returns `null` for unknown ids and for anonymous
   * identities (their email is a synthetic placeholder; messaging
   * them would dead-letter at best). Used as the
   * `resolveRecipient` callback on `EmailEventListener`.
   */
  private async resolveEmailRecipient(identityId: string): Promise<string | null> {
    const result = await this.db.query(
      "SELECT email, is_anonymous FROM users WHERE id = ?",
      [identityId],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row.is_anonymous) return null;
    return typeof row.email === "string" && row.email.length > 0 ? row.email : null;
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
    // Users table.
    //
    // `is_anonymous` (gh/geldata#8750): guest identities live in the
    // same row but synth their email + password_hash to keep the
    // existing NOT NULL invariants. `loginAnonymous()` mints them;
    // `upgradeAnonymous()` flips them into full users by replacing
    // email + password_hash and toggling the flag.
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

    // Idempotent column addition for instances that pre-date the
    // anonymous-identity feature. Both Postgres and SQLite-style
    // backends accept `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in
    // recent versions; if a backend rejects this, the catch keeps
    // initialize() going (the feature simply won't work).
    try {
      await this.db.execute(
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT FALSE`,
      );
    } catch {
      // pre-existing column, or backend doesn't support IF NOT EXISTS
      // for ADD COLUMN; either case is fine here.
    }

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

    // WebAuthn credentials (gh/geldata#6725) — one row per registered
    // passkey. `credential_id` is base64url; `public_key_jwk` is the
    // JSON form of the COSE key (we re-import on each verify). Counter
    // is monotonic per-credential — the authenticator increments it on
    // every signature so we can detect cloned credentials.
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

    // WebAuthn ceremony challenges (gh/geldata#6725) — short-lived,
    // single-use. `purpose` distinguishes register vs login because the
    // verification path treats them differently. `user_id` is null for
    // login challenges that don't bind to a known user yet (we look up
    // by credential id on finish).
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS webauthn_challenges (
        id TEXT PRIMARY KEY,
        challenge TEXT NOT NULL,
        purpose TEXT NOT NULL,
        user_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        consumed_at TIMESTAMP
      )
    `);

    // Recovery codes (gh/geldata#8186) — single-use codes the user
    // saves at MFA setup time and uses to bypass TOTP if they lose
    // their device. Stored hashed (SHA-256, parallel to other token
    // hashing in this module). Plain `used_at` marker rather than
    // deletion so we can audit "this user burned a recovery code at
    // T" without keeping a separate event table in line.
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS recovery_codes (
        code_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Magic-link tokens (gh/geldata#8186) — one row per outstanding
    // request. Stored hashed (parallel to reset/verify tokens, P0-03);
    // the plaintext is delivered to the user once via email and never
    // reproducible. Single-use: `consumed_at` set on redemption.
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

    // Magic-code tokens (gh/geldata#7367) — passwordless email-delivered
    // 6-digit codes, the SMS-friendly sibling of magic-link. Stored
    // hashed; lookup is scoped by `user_id` to keep the 1M-possibility
    // brute-force surface infeasible. `attempts` counts wrong-code
    // submissions for the row; ≥5 marks the row consumed (locked out
    // until the user requests a fresh code).
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

    // MFA TOTP table (gh/geldata#8186) — one row per user when TOTP
    // is enrolled. `confirmed_at` distinguishes pending enrollments
    // (user scanned the QR but hasn't proven they can read codes from
    // it) from active MFA. `secret` is base32 — we store it plaintext
    // because PG-at-rest encryption is the operator's job and re-
    // encrypting on every verify would gut performance.
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS mfa_totp (
        user_id TEXT PRIMARY KEY,
        secret TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // MFA challenge table (gh/geldata#8186) — short-lived
    // password-verified-but-MFA-pending tokens. The user has typed the
    // right password; they now need to prove possession of the second
    // factor. Tokens are stored hashed (parallel to reset/verify token
    // handling at P0-03) and expire fast (default 5 min).
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

    // Roles table — a small registry of named roles that users can be
    // assigned to. (gh/geldata#8177) Roles themselves carry only a name
    // and an optional description; permissions are encoded in access
    // policies (`has_role("admin")`) rather than persisted per-role,
    // matching disc's policy-driven model.
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS roles (
        name TEXT PRIMARY KEY,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // user_roles join — many-to-many. ON DELETE CASCADE on both sides so
    // role removal and user deletion both clean up the assignments.
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
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles(user_id)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_user_roles_role_name ON user_roles(role_name)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user_id ON mfa_challenges(user_id)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_mfa_challenges_expires_at ON mfa_challenges(expires_at)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_magic_link_user_id ON magic_link_tokens(user_id)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_magic_link_expires_at ON magic_link_tokens(expires_at)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_magic_code_user_id ON magic_code_tokens(user_id)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_magic_code_expires_at ON magic_code_tokens(expires_at)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_recovery_codes_user_id ON recovery_codes(user_id)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_id ON webauthn_credentials(user_id)`,
    );
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires_at ON webauthn_challenges(expires_at)`,
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
    const verificationToken = this.config.requireEmailVerification ? this.generateToken() : null;
    // Store only the hash; plaintext is returned to the caller for emailing.
    const verificationTokenHash = verificationToken ? await this.hashToken(verificationToken) : null;

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

    // Webhook: a new identity exists. Fire before EmailVerificationRequested
    // so receivers see them in causal order.
    // (gh/geldata#7484, ports geldata/gel#7813)
    this.fireWebhook({
      eventType: "IdentityCreated",
      eventId: newEventId(),
      timestamp: newEventTimestamp(),
      identityId: userId,
    });

    if (verificationToken) {
      this.fireWebhook({
        eventType: "EmailVerificationRequested",
        eventId: newEventId(),
        timestamp: newEventTimestamp(),
        identityId: userId,
        verificationToken,
      });
    }

    // gh/geldata#7275: return the identity alongside the session so
    // callers don't need a follow-up `getUser()` to stash the new
    // identity record. Roles are read once at issue time — snapshot
    // semantics match `TokenPayload.roles`.
    const roles = await this.getUserRoles(userId);
    const identity = {
      id: user.id,
      email: user.email,
      createdAt: user.createdAt,
      emailVerified: user.emailVerified,
      roles,
    };

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refreshToken: refreshToken,
      identity,
      // Plaintext for the caller to email; DB has the hash.
      ...(verificationToken ? { verificationToken } : {}),
    };
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
    // Synthetic email + password to preserve NOT NULL invariants
    // without forcing a schema migration. The email's TLD `.invalid`
    // (RFC 6761) prevents collision with real addresses; the password
    // hash is derived from a high-entropy random string that is
    // immediately forgotten so the row can never be signed into.
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
      [userId, syntheticEmail, null, syntheticHash, false, true],
    );

    const user = await this.getUser(userId);
    if (!user) {
      throw new Error("Failed to create anonymous identity");
    }

    const session = await this.createSession(userId, meta);
    const token = await this.generateJWT(user);
    const refreshToken = this.generateToken();
    await this.db.execute(
      "UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?",
      [token, refreshToken, session.id],
    );
    session.token = token;
    session.refreshToken = refreshToken;

    this.auditEvent("registered_anonymous", userId, {
      sessionId: session.id,
      ipAddress: meta?.ipAddress,
    });

    this.fireWebhook({
      eventType: "IdentityCreated",
      eventId: newEventId(),
      timestamp: newEventTimestamp(),
      identityId: userId,
    });

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refreshToken,
    };
  }

  /**
   * Promote a previously-anonymous identity to a full user. Replaces
   * the synthetic email + password_hash with real credentials, flips
   * `is_anonymous` to false, and reuses the existing user id so
   * downstream rows that reference it (carts, drafts, etc.) keep
   * working. The caller's app code is responsible for any cross-row
   * "merge with existing user" logic — this call only mutates the
   * single anonymous row in place. (gh/geldata#8750)
   *
   * Throws if the id doesn't exist or already belongs to a non-anonymous
   * identity.
   */
  async upgradeAnonymous(
    anonymousUserId: string,
    data: RegisterData,
  ): Promise<AuthResponse> {
    // Validate password before doing any work.
    const passwordValidation = this.validatePassword(data.password);
    if (!passwordValidation.valid) {
      throw new AuthError(
        passwordValidation.errors.join(", "),
        AuthErrorCode.PASSWORD_TOO_WEAK,
        400,
      );
    }

    const lookup = await this.db.query(
      "SELECT id, is_anonymous FROM users WHERE id = ?",
      [anonymousUserId],
    );
    if (lookup.rows.length === 0) {
      throw new AuthError(
        "Anonymous identity not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }
    if (!lookup.rows[0].is_anonymous) {
      throw new AuthError(
        "User is not an anonymous identity",
        AuthErrorCode.INVALID_OPERATION,
        400,
      );
    }

    // Refuse if the target email is already taken by someone else.
    const existing = await this.db.query(
      "SELECT id FROM users WHERE (email = ? OR (username = ? AND username IS NOT NULL)) AND id != ?",
      [data.email, data.username || null, anonymousUserId],
    );
    if (existing.rows.length > 0) {
      throw new AuthError(
        "User already exists",
        AuthErrorCode.USER_ALREADY_EXISTS,
        409,
      );
    }

    const salt = await bcrypt.genSalt(this.config.bcryptRounds);
    const passwordHash = await bcrypt.hash(data.password, salt);
    const verificationToken = this.config.requireEmailVerification ? this.generateToken() : null;
    const verificationTokenHash = verificationToken ? await this.hashToken(verificationToken) : null;

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
        anonymousUserId,
      ],
    );

    const user = await this.getUser(anonymousUserId);
    if (!user) {
      throw new Error("User vanished after upgrade");
    }

    // Mint fresh tokens; the old session keeps working but the new
    // identity gets a fresh JWT reflecting the real email.
    const session = await this.createSession(user.id, data.meta);
    const token = await this.generateJWT(user);
    const refreshToken = this.generateToken();
    await this.db.execute(
      "UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?",
      [token, refreshToken, session.id],
    );
    session.token = token;
    session.refreshToken = refreshToken;

    this.auditEvent("upgraded_anonymous", user.id, {
      sessionId: session.id,
      ipAddress: data.meta?.ipAddress,
    });

    if (verificationToken) {
      this.fireWebhook({
        eventType: "EmailVerificationRequested",
        eventId: newEventId(),
        timestamp: newEventTimestamp(),
        identityId: user.id,
        verificationToken,
      });
    }

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refreshToken,
      ...(verificationToken ? { verificationToken } : {}),
    };
  }

  async login(credentials: LoginCredentials): Promise<LoginResult> {
    // Find user by email or username
    const query = credentials.email ? "SELECT * FROM users WHERE email = ?" : "SELECT * FROM users WHERE username = ?";
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

    // Anonymous identities don't have a real password. Reject in the
    // same shape as wrong-credentials (no leak of identity kind),
    // burning a dummy compare for timing parity. (gh/geldata#8750)
    if (user.isAnonymous) {
      await this.runDummyCompare(credentials.password);
      throw new AuthError(
        "Invalid credentials",
        AuthErrorCode.INVALID_CREDENTIALS,
        401,
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

    // MFA gate (gh/geldata#8186): if the user has TOTP enrolled and
    // confirmed, password alone is not enough — issue a short-lived
    // challenge token and bail. The caller must complete the login via
    // `loginWithTOTP(challengeToken, code)`.
    if (await this.hasConfirmedTOTP(user.id)) {
      const challenge = await this.issueMfaChallenge(user.id);
      this.auditEvent("login_mfa_challenge_issued", user.id, {
        ipAddress: credentials.meta?.ipAddress,
      });
      return challenge;
    }

    return await this.completeLogin(user, credentials.meta);
  }

  /**
   * Internal: shared "create session + mint JWT + audit + webhook" path.
   * Used by both the password-only `login()` and the MFA-completing
   * `loginWithTOTP()` so they emit the same events and shape.
   */
  private async completeLogin(
    user: User,
    meta?: RequestMeta,
  ): Promise<AuthResponse> {
    const session = await this.createSession(user.id, meta);
    const token = await this.generateJWT(user);
    const refreshToken = this.generateToken();
    await this.db.execute(
      "UPDATE sessions SET token = ?, refresh_token = ? WHERE id = ?",
      [token, refreshToken, session.id],
    );
    session.token = token;
    session.refreshToken = refreshToken;

    this.auditEvent("login_succeeded", user.id, {
      sessionId: session.id,
      ipAddress: meta?.ipAddress,
    });

    this.fireWebhook({
      eventType: "IdentityAuthenticated",
      eventId: newEventId(),
      timestamp: newEventTimestamp(),
      identityId: user.id,
    });

    return {
      user: this.sanitizeUser(user),
      session,
      token,
      refreshToken,
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
      const errorMsg = error instanceof Error ? error.message.toLowerCase() : "";
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

  /**
   * Admin override for setting a user's password without their old one.
   * Locates the user by id or email. Used by `disc admin set-password`.
   * Same `validatePassword()` rules apply, and existing sessions are
   * revoked so the rotated password takes effect everywhere.
   * (gh/geldata#5383, #6454, #1119, #4209)
   */
  async adminSetPassword(
    userIdOrEmail: string,
    newPassword: string,
  ): Promise<void> {
    const passwordValidation = this.validatePassword(newPassword);
    if (!passwordValidation.valid) {
      throw new AuthError(
        passwordValidation.errors.join(", "),
        AuthErrorCode.PASSWORD_TOO_WEAK,
        400,
      );
    }

    // Look up by id or email (email is unique)
    const lookup = await this.db.query(
      "SELECT id FROM users WHERE id = ? OR email = ?",
      [userIdOrEmail, userIdOrEmail],
    );
    if (lookup.rows.length === 0) {
      throw new AuthError(
        `User not found: ${userIdOrEmail}`,
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }
    const userId = lookup.rows[0].id as string;

    const newSalt = await bcrypt.genSalt(this.config.bcryptRounds);
    const newPasswordHash = await bcrypt.hash(newPassword, newSalt);

    await this.db.execute(
      "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [newPasswordHash, userId],
    );

    this.auditEvent("password_admin_set", userId);

    // Revoke all sessions so the rotated password is the only valid one.
    await this.revokeAllSessions(userId);
  }

  /**
   * Locate a user by id or email and return the canonical id, or null
   * when no match exists. Used by admin tooling to translate
   * user-supplied selectors (often email) into the row id.
   */
  async resolveUserId(userIdOrEmail: string): Promise<string | null> {
    const result = await this.db.query(
      "SELECT id FROM users WHERE id = ? OR email = ?",
      [userIdOrEmail, userIdOrEmail],
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].id as string;
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

    this.fireWebhook({
      eventType: "PasswordResetRequested",
      eventId: newEventId(),
      timestamp: newEventTimestamp(),
      identityId: userId,
      resetToken,
    });

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
    const result = await this.db.query(
      "SELECT id, email_verified FROM users WHERE email = ?",
      [email],
    );

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row.email_verified) return null;

    const userId = row.id;
    const verificationToken = this.generateToken();
    const verificationTokenHash = await this.hashToken(verificationToken);

    // Overwrite the stored hash. The previous token's hash is gone, so
    // verifyEmail() with the old plaintext will now fail with
    // INVALID_TOKEN — exactly the desired invalidation.
    await this.db.execute(
      `UPDATE users SET verification_token = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [verificationTokenHash, userId],
    );

    this.auditEvent("email_verification_resent", userId);

    this.fireWebhook({
      eventType: "EmailVerificationRequested",
      eventId: newEventId(),
      timestamp: newEventTimestamp(),
      identityId: userId,
      verificationToken,
    });

    return verificationToken;
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

    this.fireWebhook({
      eventType: "EmailVerified",
      eventId: newEventId(),
      timestamp: newEventTimestamp(),
      identityId: userId,
    });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.db.execute(
      "UPDATE sessions SET revoked = TRUE WHERE user_id = ?",
      [userId],
    );
    this.auditEvent("sessions_revoked_all", userId);
  }

  // ── Roles & RBAC (gh/geldata#8177) ─────────────────────────────────

  /**
   * Register a new role in the role registry. Idempotent — if the role
   * already exists with the same description, this is a no-op; if the
   * description differs, the existing description is updated.
   */
  async createRole(name: string, description?: string): Promise<void> {
    const existing = await this.db.query(
      "SELECT name FROM roles WHERE name = ?",
      [name],
    );
    if (existing.rows.length > 0) {
      await this.db.execute(
        "UPDATE roles SET description = ? WHERE name = ?",
        [description ?? null, name],
      );
      return;
    }
    await this.db.execute(
      "INSERT INTO roles (name, description) VALUES (?, ?)",
      [name, description ?? null],
    );
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

  /** List every registered role. */
  async listRoles(): Promise<Array<{ name: string; description?: string }>> {
    const result = await this.db.query(
      "SELECT name, description FROM roles ORDER BY name",
      [],
    );
    return result.rows.map((r) => ({
      name: r.name,
      description: r.description ?? undefined,
    }));
  }

  /**
   * Grant `roleName` to `userId`. Idempotent — granting a role twice
   * does not create duplicate rows. Throws if the role doesn't exist
   * or the user doesn't exist (so callers see a real error instead of
   * a silent no-op).
   */
  async assignRole(userId: string, roleName: string): Promise<void> {
    const role = await this.db.query(
      "SELECT name FROM roles WHERE name = ?",
      [roleName],
    );
    if (role.rows.length === 0) {
      throw new AuthError(
        `Role not found: ${roleName}`,
        AuthErrorCode.INVALID_OPERATION,
        404,
      );
    }
    const user = await this.db.query(
      "SELECT id FROM users WHERE id = ?",
      [userId],
    );
    if (user.rows.length === 0) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }
    const existing = await this.db.query(
      "SELECT user_id FROM user_roles WHERE user_id = ? AND role_name = ?",
      [userId, roleName],
    );
    if (existing.rows.length > 0) return;
    await this.db.execute(
      "INSERT INTO user_roles (user_id, role_name) VALUES (?, ?)",
      [userId, roleName],
    );
    this.auditEvent("role_assigned", userId, { role: roleName });
  }

  /**
   * Revoke `roleName` from `userId`. No-op if the user doesn't have
   * the role (matches the audit semantics — the post-condition is
   * "user does not have role X" regardless of starting state).
   */
  async revokeRole(userId: string, roleName: string): Promise<void> {
    await this.db.execute(
      "DELETE FROM user_roles WHERE user_id = ? AND role_name = ?",
      [userId, roleName],
    );
    this.auditEvent("role_revoked", userId, { role: roleName });
  }

  /** Return every role currently held by `userId`. */
  async getUserRoles(userId: string): Promise<string[]> {
    const result = await this.db.query(
      "SELECT role_name FROM user_roles WHERE user_id = ? ORDER BY role_name",
      [userId],
    );
    return result.rows.map((r) => r.role_name);
  }

  /** True iff `userId` has been granted `roleName`. */
  async userHasRole(userId: string, roleName: string): Promise<boolean> {
    const result = await this.db.query(
      "SELECT 1 FROM user_roles WHERE user_id = ? AND role_name = ?",
      [userId, roleName],
    );
    return result.rows.length > 0;
  }

  // ── MFA / TOTP (gh/geldata#8186) ───────────────────────────────────

  /**
   * Begin TOTP enrollment for a user. Generates a fresh base32 secret
   * and stores it in `mfa_totp` with `confirmed_at = NULL` — until the
   * user proves they can produce a valid code (via `confirmTOTP`), the
   * secret is just sitting there and the login flow ignores it.
   *
   * Calling enroll twice resets the secret. The old QR code becomes
   * invalid the moment a new secret is written; this is intentional —
   * the user clicked "set up MFA" again, presumably because they lost
   * the previous setup.
   */
  async enrollTOTP(userId: string): Promise<TotpEnrollment> {
    const userResult = await this.db.query(
      "SELECT id, email, username FROM users WHERE id = ?",
      [userId],
    );
    if (userResult.rows.length === 0) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }
    const user = userResult.rows[0];
    const secret = generateTotpSecret();

    const existing = await this.db.query(
      "SELECT user_id FROM mfa_totp WHERE user_id = ?",
      [userId],
    );
    if (existing.rows.length > 0) {
      await this.db.execute(
        "UPDATE mfa_totp SET secret = ?, confirmed_at = NULL WHERE user_id = ?",
        [secret, userId],
      );
    } else {
      await this.db.execute(
        "INSERT INTO mfa_totp (user_id, secret) VALUES (?, ?)",
        [userId, secret],
      );
    }

    const otpauthUri = buildOtpauthUri({
      issuer: this.config.jwtIssuer || "Disc",
      accountName: user.username || user.email,
      secret,
    });
    this.auditEvent("totp_enrollment_started", userId);
    return { secret, otpauthUri };
  }

  /**
   * Complete TOTP enrollment by verifying that the user can read codes
   * from their authenticator app. On success, marks the secret as
   * confirmed — subsequent logins must include a TOTP code.
   *
   * Throws `INVALID_CREDENTIALS` (401) on a wrong code so probing the
   * code space hits the same error shape as a wrong password.
   */
  async confirmTOTP(userId: string, code: string): Promise<void> {
    const result = await this.db.query(
      "SELECT secret FROM mfa_totp WHERE user_id = ?",
      [userId],
    );
    if (result.rows.length === 0) {
      throw new AuthError(
        "TOTP not enrolled",
        AuthErrorCode.INVALID_OPERATION,
        400,
      );
    }
    const offset = await verifyTOTP(result.rows[0].secret, code);
    if (offset === null) {
      this.auditEvent("totp_confirm_failed", userId);
      throw new AuthError(
        "Invalid TOTP code",
        AuthErrorCode.INVALID_CREDENTIALS,
        401,
      );
    }
    await this.db.execute(
      "UPDATE mfa_totp SET confirmed_at = CURRENT_TIMESTAMP WHERE user_id = ?",
      [userId],
    );
    this.auditEvent("totp_confirmed", userId);
  }

  /**
   * Disable TOTP for a user. The row is deleted, not just flagged —
   * keeps a fresh `enrollTOTP()` from accidentally re-using a
   * compromised secret. The caller is responsible for whatever
   * authorization gate makes sense (typically: re-prompt for password).
   */
  async disableTOTP(userId: string): Promise<void> {
    await this.db.execute(
      "DELETE FROM mfa_totp WHERE user_id = ?",
      [userId],
    );
    this.auditEvent("totp_disabled", userId);
  }

  /**
   * Complete an MFA-gated login by submitting the TOTP code.
   * `challengeToken` is the plaintext token returned from `login()`'s
   * `MfaChallenge`. On success, returns a normal `AuthResponse`. On
   * failure, the challenge stays valid (until expiry) so users can
   * retry typos — but each individual code is rate-limited by the
   * 30-second TOTP step plus the auth-route per-IP limiter.
   */
  async loginWithTOTP(
    challengeToken: string,
    code: string,
    meta?: RequestMeta,
  ): Promise<AuthResponse> {
    const tokenHash = await this.hashToken(challengeToken);
    const result = await this.db.query(
      `SELECT user_id, expires_at, consumed_at
       FROM mfa_challenges
       WHERE token_hash = ?`,
      [tokenHash],
    );
    if (result.rows.length === 0) {
      throw new AuthError(
        "Invalid or expired MFA challenge",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    const row = result.rows[0];
    if (row.consumed_at) {
      throw new AuthError(
        "MFA challenge already used",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    const expiresAt = new Date(row.expires_at);
    if (expiresAt.getTime() < Date.now()) {
      throw new AuthError(
        "MFA challenge expired",
        AuthErrorCode.TOKEN_EXPIRED,
        401,
      );
    }

    const totp = await this.db.query(
      "SELECT secret FROM mfa_totp WHERE user_id = ?",
      [row.user_id],
    );
    if (totp.rows.length === 0) {
      // User disabled MFA between password-step and code-step. Be
      // conservative — fail closed rather than promote.
      throw new AuthError(
        "MFA not configured",
        AuthErrorCode.INVALID_OPERATION,
        400,
      );
    }
    const offset = await verifyTOTP(totp.rows[0].secret, code);
    if (offset === null) {
      this.auditEvent("login_mfa_failed", row.user_id, {
        ipAddress: meta?.ipAddress,
      });
      throw new AuthError(
        "Invalid TOTP code",
        AuthErrorCode.INVALID_CREDENTIALS,
        401,
      );
    }

    // Burn the challenge before issuing the session. A consumed_at
    // marker keeps the row around for forensics but blocks reuse.
    await this.db.execute(
      "UPDATE mfa_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE token_hash = ?",
      [tokenHash],
    );

    const user = await this.getUser(row.user_id);
    if (!user) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }
    return await this.completeLogin(user, meta);
  }

  /** Internal: does the user have a confirmed TOTP enrollment? */
  private async hasConfirmedTOTP(userId: string): Promise<boolean> {
    const result = await this.db.query(
      "SELECT 1 FROM mfa_totp WHERE user_id = ? AND confirmed_at IS NOT NULL",
      [userId],
    );
    return result.rows.length > 0;
  }

  /**
   * Internal: mint a single-use MFA challenge token, store its hash,
   * and return the plaintext bundled into an `MfaChallenge` for the
   * caller to relay back via `loginWithTOTP`.
   */
  private async issueMfaChallenge(userId: string): Promise<MfaChallenge> {
    const plaintext = this.generateToken();
    const tokenHash = await this.hashToken(plaintext);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min
    await this.db.execute(
      `INSERT INTO mfa_challenges (token_hash, user_id, expires_at)
       VALUES (?, ?, ?)`,
      [tokenHash, userId, expiresAt.toISOString()],
    );
    return {
      mfaRequired: true,
      challengeToken: plaintext,
      factors: ["totp"],
    };
  }

  // ── Magic links (gh/geldata#8186) ──────────────────────────────────

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
  async requestMagicLink(
    email: string,
    meta?: RequestMeta,
  ): Promise<string> {
    const plaintext = this.generateToken();
    const result = await this.db.query(
      "SELECT id, active, is_anonymous FROM users WHERE email = ?",
      [email],
    );
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    if (
      result.rows.length > 0 &&
      result.rows[0].active &&
      !result.rows[0].is_anonymous
    ) {
      const tokenHash = await this.hashToken(plaintext);
      await this.db.execute(
        `INSERT INTO magic_link_tokens (token_hash, user_id, expires_at, ip_address)
         VALUES (?, ?, ?, ?)`,
        [
          tokenHash,
          result.rows[0].id,
          expiresAt.toISOString(),
          meta?.ipAddress ?? null,
        ],
      );
      this.auditEvent("magic_link_requested", result.rows[0].id, {
        ipAddress: meta?.ipAddress,
      });
      this.fireWebhook({
        eventType: "MagicLinkRequested",
        eventId: newEventId(),
        timestamp: newEventTimestamp(),
        identityId: result.rows[0].id,
        magicLinkToken: plaintext,
      });
    } else {
      this.auditEvent("magic_link_requested", null, {
        result: "no_such_user",
        email,
        ipAddress: meta?.ipAddress,
      });
    }
    return plaintext;
  }

  /**
   * Redeem a magic-link token and complete login. Single-use — the
   * row's `consumed_at` is set on success. If the user has TOTP
   * enrolled, returns an `MfaChallenge` instead of a session, matching
   * the password-login flow (gh/geldata#8186 Phase A): magic-link
   * proves "user has the email", TOTP proves "user has the device".
   */
  async consumeMagicLink(
    token: string,
    meta?: RequestMeta,
  ): Promise<LoginResult> {
    const tokenHash = await this.hashToken(token);
    const result = await this.db.query(
      `SELECT user_id, expires_at, consumed_at
       FROM magic_link_tokens
       WHERE token_hash = ?`,
      [tokenHash],
    );
    if (result.rows.length === 0) {
      throw new AuthError(
        "Invalid or expired magic link",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    const row = result.rows[0];
    if (row.consumed_at) {
      throw new AuthError(
        "Magic link already used",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new AuthError(
        "Magic link expired",
        AuthErrorCode.TOKEN_EXPIRED,
        401,
      );
    }

    // Burn the link before issuing anything. Even if the MFA challenge
    // step fails, the link is single-use — the user requests a new one.
    await this.db.execute(
      "UPDATE magic_link_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE token_hash = ?",
      [tokenHash],
    );

    const user = await this.getUser(row.user_id);
    if (!user || !user.active || user.isAnonymous) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }

    if (await this.hasConfirmedTOTP(user.id)) {
      const challenge = await this.issueMfaChallenge(user.id);
      this.auditEvent("magic_link_mfa_challenge_issued", user.id, {
        ipAddress: meta?.ipAddress,
      });
      return challenge;
    }

    this.auditEvent("magic_link_consumed", user.id, {
      ipAddress: meta?.ipAddress,
    });
    return await this.completeLogin(user, meta);
  }

  // ── Magic codes (gh/geldata#7367) ──────────────────────────────────

  /**
   * Mint a passwordless 6-digit login code for the user with this
   * email and return the plaintext. Caller is expected to deliver it
   * via email/SMS (the user types it back into the app to log in via
   * `verifyMagicCode`). Codes expire in 10 minutes by default —
   * shorter than magic-link's 15 because human-typed codes shouldn't
   * sit around in inboxes.
   *
   * Anti-enumeration: when no user matches, the call still succeeds
   * and returns a plaintext code — the row is never persisted, so the
   * code can never be redeemed. Same response-shape and timing posture
   * as `requestMagicLink` and `login()` (gh/geldata#9137).
   */
  async requestMagicCode(
    email: string,
    meta?: RequestMeta,
  ): Promise<string> {
    const code = this.generateNumericCode(6);
    const result = await this.db.query(
      "SELECT id, active, is_anonymous FROM users WHERE email = ?",
      [email],
    );
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min
    if (
      result.rows.length > 0 &&
      result.rows[0].active &&
      !result.rows[0].is_anonymous
    ) {
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
          meta?.ipAddress ?? null,
        ],
      );
      this.auditEvent("magic_code_requested", result.rows[0].id, {
        ipAddress: meta?.ipAddress,
      });
      this.fireWebhook({
        eventType: "MagicCodeRequested",
        eventId: newEventId(),
        timestamp: newEventTimestamp(),
        identityId: result.rows[0].id,
        magicCode: code,
      });
    } else {
      this.auditEvent("magic_code_requested", null, {
        result: "no_such_user",
        email,
        ipAddress: meta?.ipAddress,
      });
    }
    return code;
  }

  /**
   * Redeem a magic-code submission and complete login. Lookup is
   * scoped by `email` (not just `token_hash`) because 6 digits = 1M
   * possibilities — far smaller than magic-link's 32-byte token space.
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
  async verifyMagicCode(
    email: string,
    code: string,
    meta?: RequestMeta,
  ): Promise<LoginResult> {
    const tokenHash = await this.hashToken(code);
    const userResult = await this.db.query(
      "SELECT id, active, is_anonymous FROM users WHERE email = ?",
      [email],
    );

    // Anti-enumeration: do a dummy hash for unknown emails so the
    // wall-clock posture matches the happy path. Same rationale as
    // `runDummyCompare` for password login (P1-35 / gh/geldata#9137).
    if (
      userResult.rows.length === 0 ||
      !userResult.rows[0].active ||
      userResult.rows[0].is_anonymous
    ) {
      await this.hashToken(code);
      throw new AuthError(
        "Invalid or expired code",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }

    const userId = userResult.rows[0].id;

    // Look for the most recent matching code for this user. We scope
    // by user_id rather than relying on token_hash alone — the 1M
    // possibility space makes a global hash lookup an unacceptable
    // brute-force surface.
    const codeResult = await this.db.query(
      `SELECT id, expires_at, consumed_at, attempts
       FROM magic_code_tokens
       WHERE user_id = ? AND token_hash = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, tokenHash],
    );

    if (codeResult.rows.length === 0) {
      // Wrong code — find the most recent live row for this user and
      // bump its attempt counter. Lockout after 5 by burning the row.
      const liveResult = await this.db.query(
        `SELECT id, attempts, expires_at
         FROM magic_code_tokens
         WHERE user_id = ? AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId],
      );
      if (
        liveResult.rows.length > 0 &&
        new Date(liveResult.rows[0].expires_at).getTime() > Date.now()
      ) {
        const newAttempts = Number(liveResult.rows[0].attempts) + 1;
        if (newAttempts >= 5) {
          await this.db.execute(
            `UPDATE magic_code_tokens
             SET attempts = ?, consumed_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [newAttempts, liveResult.rows[0].id],
          );
          this.auditEvent("magic_code_lockout", userId, {
            ipAddress: meta?.ipAddress,
          });
        } else {
          await this.db.execute(
            "UPDATE magic_code_tokens SET attempts = ? WHERE id = ?",
            [newAttempts, liveResult.rows[0].id],
          );
        }
      }
      this.auditEvent("magic_code_invalid", userId, {
        ipAddress: meta?.ipAddress,
      });
      throw new AuthError(
        "Invalid or expired code",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }

    const row = codeResult.rows[0];
    if (row.consumed_at) {
      this.auditEvent("magic_code_invalid", userId, {
        ipAddress: meta?.ipAddress,
        reason: "consumed",
      });
      throw new AuthError(
        "Code already used",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      this.auditEvent("magic_code_invalid", userId, {
        ipAddress: meta?.ipAddress,
        reason: "expired",
      });
      throw new AuthError(
        "Code expired",
        AuthErrorCode.TOKEN_EXPIRED,
        401,
      );
    }

    // Burn the code before issuing anything. Even if the MFA challenge
    // step fails downstream, the code is single-use — the user
    // requests a new one.
    await this.db.execute(
      "UPDATE magic_code_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [row.id],
    );

    const user = await this.getUser(userId);
    if (!user || !user.active || user.isAnonymous) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }

    if (await this.hasConfirmedTOTP(user.id)) {
      const challenge = await this.issueMfaChallenge(user.id);
      this.auditEvent("magic_code_mfa_challenge_issued", user.id, {
        ipAddress: meta?.ipAddress,
      });
      return challenge;
    }

    this.auditEvent("magic_code_consumed", user.id, {
      ipAddress: meta?.ipAddress,
    });
    return await this.completeLogin(user, meta);
  }

  // ── Recovery codes (gh/geldata#8186) ───────────────────────────────

  /**
   * (Re)generate a fresh batch of recovery codes for the user. Returns
   * the plaintext array — this is the *only* time the user can see
   * them; they're stored hashed. Calling this again invalidates every
   * previous code (including unused ones), matching the standard
   * "regenerate codes" UX where the user clicks the button after
   * losing their old printout.
   *
   * Default count is 8, mirroring what GitHub / GitLab / Google use.
   */
  async generateRecoveryCodes(
    userId: string,
    count = 8,
  ): Promise<string[]> {
    const userResult = await this.db.query(
      "SELECT id FROM users WHERE id = ?",
      [userId],
    );
    if (userResult.rows.length === 0) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }
    if (count < 1 || count > 50) {
      throw new AuthError(
        "count must be between 1 and 50",
        AuthErrorCode.INVALID_OPERATION,
        400,
      );
    }

    // Wipe any existing codes — `generateRecoveryCodes` always means
    // "issue a new set", never "append to the existing set".
    await this.db.execute(
      "DELETE FROM recovery_codes WHERE user_id = ?",
      [userId],
    );

    const plaintext: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = generateRecoveryCode();
      plaintext.push(code);
      const hash = await this.hashToken(code);
      await this.db.execute(
        "INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)",
        [hash, userId],
      );
    }

    this.auditEvent("recovery_codes_generated", userId, { count });
    return plaintext;
  }

  /** How many recovery codes does the user have left to burn? */
  async recoveryCodesRemaining(userId: string): Promise<number> {
    const result = await this.db.query(
      "SELECT code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL",
      [userId],
    );
    return result.rows.length;
  }

  /**
   * Burn a recovery code. Used by `loginWithRecoveryCode` and exposed
   * publicly for callers who want to verify outside the login flow
   * (e.g. step-up auth before account-deletion). Returns true on
   * successful consumption, false on bad / already-used code.
   *
   * Constant-time-ish: looks up the hash, which is by primary key, so
   * present-vs-absent is a B-tree lookup either way.
   */
  async consumeRecoveryCode(
    userId: string,
    code: string,
  ): Promise<boolean> {
    const hash = await this.hashToken(normalizeRecoveryCode(code));
    const result = await this.db.query(
      "SELECT user_id, used_at FROM recovery_codes WHERE code_hash = ?",
      [hash],
    );
    if (result.rows.length === 0) return false;
    const row = result.rows[0];
    if (row.user_id !== userId) return false;
    if (row.used_at) return false;
    await this.db.execute(
      "UPDATE recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE code_hash = ?",
      [hash],
    );
    this.auditEvent("recovery_code_consumed", userId);
    return true;
  }

  /**
   * Complete an MFA-gated login by submitting a recovery code instead
   * of a TOTP code. Same challenge-token shape as `loginWithTOTP`. On
   * success, burns the code and the challenge.
   */
  async loginWithRecoveryCode(
    challengeToken: string,
    code: string,
    meta?: RequestMeta,
  ): Promise<AuthResponse> {
    const tokenHash = await this.hashToken(challengeToken);
    const result = await this.db.query(
      `SELECT user_id, expires_at, consumed_at
       FROM mfa_challenges
       WHERE token_hash = ?`,
      [tokenHash],
    );
    if (result.rows.length === 0) {
      throw new AuthError(
        "Invalid or expired MFA challenge",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    const row = result.rows[0];
    if (row.consumed_at) {
      throw new AuthError(
        "MFA challenge already used",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new AuthError(
        "MFA challenge expired",
        AuthErrorCode.TOKEN_EXPIRED,
        401,
      );
    }

    const burned = await this.consumeRecoveryCode(row.user_id, code);
    if (!burned) {
      this.auditEvent("login_recovery_code_failed", row.user_id, {
        ipAddress: meta?.ipAddress,
      });
      throw new AuthError(
        "Invalid recovery code",
        AuthErrorCode.INVALID_CREDENTIALS,
        401,
      );
    }

    await this.db.execute(
      "UPDATE mfa_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE token_hash = ?",
      [tokenHash],
    );

    const user = await this.getUser(row.user_id);
    if (!user) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }
    return await this.completeLogin(user, meta);
  }

  // ── WebAuthn / passkeys (gh/geldata#6725) ──────────────────────────

  /**
   * Begin the WebAuthn registration ceremony. Mints a fresh challenge,
   * persists it (with `purpose = "register"` and a 5-min expiry), and
   * returns the `PublicKeyCredentialCreationOptions` payload that the
   * caller hands to `navigator.credentials.create({ publicKey })`.
   *
   * `userId` is required because passkeys are user-scoped; pre-existing
   * credentials are listed under `excludeCredentials` so the
   * authenticator refuses to re-register the same key.
   */
  async beginWebAuthnRegistration(
    userId: string,
  ): Promise<WebAuthnRegistrationOptions> {
    if (!this.config.webauthn) {
      throw new AuthError(
        "WebAuthn not configured (set AuthConfig.webauthn)",
        AuthErrorCode.INVALID_OPERATION,
        500,
      );
    }
    const userResult = await this.db.query(
      "SELECT id, email, username FROM users WHERE id = ?",
      [userId],
    );
    if (userResult.rows.length === 0) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }
    const user = userResult.rows[0];
    const challenge = randomBytes(32);
    const challengeId = this.generateId();
    await this.db.execute(
      `INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        challengeId,
        webAuthn.base64UrlEncode(challenge),
        "register",
        userId,
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      ],
    );
    const existing = await this.db.query(
      "SELECT credential_id FROM webauthn_credentials WHERE user_id = ?",
      [userId],
    );
    this.auditEvent("webauthn_registration_started", userId);
    return {
      challengeId,
      publicKey: {
        rp: {
          id: this.config.webauthn.rpId,
          name: this.config.webauthn.rpName,
        },
        user: {
          id: user.id,
          name: user.email,
          displayName: user.username || user.email,
        },
        challenge: webAuthn.base64UrlEncode(challenge),
        pubKeyCredParams: [{ type: "public-key", alg: webAuthn.COSE_ALG_ES256 }],
        timeout: 60000,
        attestation: "none",
        excludeCredentials: existing.rows.map((r) => ({
          id: r.credential_id,
          type: "public-key" as const,
        })),
      },
    };
  }

  /**
   * Finish registration: parse the attestation object, verify the
   * client data, and persist the credential. The challenge row is
   * burned even on success (single-use) and on every error path that
   * read it.
   */
  async finishWebAuthnRegistration(
    finish: WebAuthnRegistrationFinish,
  ): Promise<{ credentialId: string }> {
    if (!this.config.webauthn) {
      throw new AuthError(
        "WebAuthn not configured",
        AuthErrorCode.INVALID_OPERATION,
        500,
      );
    }
    const challenge = await this.consumeWebAuthnChallenge(
      finish.challengeId,
      "register",
    );
    if (!challenge.user_id) {
      throw new AuthError(
        "Registration challenge has no user binding",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }

    const attestationBytes = webAuthn.base64UrlDecode(finish.attestationObject);
    const clientDataBytes = webAuthn.base64UrlDecode(finish.clientDataJSON);

    webAuthn.verifyClientData({
      clientDataJSON: clientDataBytes,
      expectedChallenge: webAuthn.base64UrlDecode(challenge.challenge),
      expectedOrigin: this.config.webauthn.origin,
      expectedType: "webauthn.create",
    });

    const parsed = webAuthn.parseAttestationObject(attestationBytes);
    const expectedRpHash = await webAuthn.hashRpId(this.config.webauthn.rpId);
    if (!byteArraysEqual(parsed.rpIdHash, expectedRpHash)) {
      throw new AuthError(
        "WebAuthn rpIdHash mismatch",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    if (parsed.fmt !== "none" && parsed.fmt !== "packed") {
      throw new AuthError(
        `Unsupported attestation format: ${parsed.fmt}`,
        AuthErrorCode.INVALID_OPERATION,
        400,
      );
    }

    const credentialIdB64 = webAuthn.base64UrlEncode(parsed.credentialId);
    if (credentialIdB64 !== finish.credentialId) {
      throw new AuthError(
        "credentialId mismatch between client and authenticatorData",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }

    await this.db.execute(
      `INSERT INTO webauthn_credentials
        (credential_id, user_id, public_key_jwk, alg, counter, name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        credentialIdB64,
        challenge.user_id,
        JSON.stringify(parsed.publicKey.jwk),
        parsed.publicKey.alg,
        parsed.counter,
        finish.name ?? null,
      ],
    );
    this.auditEvent("webauthn_registered", challenge.user_id, {
      credentialId: credentialIdB64,
    });
    return { credentialId: credentialIdB64 };
  }

  /**
   * Begin the WebAuthn login ceremony. If `email` is provided we look
   * up the user's credentials to scope `allowCredentials`; otherwise
   * we issue an unscoped challenge (discoverable-credential / username-
   * less flows).
   */
  async beginWebAuthnLogin(email?: string): Promise<WebAuthnLoginOptions> {
    if (!this.config.webauthn) {
      throw new AuthError(
        "WebAuthn not configured",
        AuthErrorCode.INVALID_OPERATION,
        500,
      );
    }
    const challenge = randomBytes(32);
    const challengeId = this.generateId();

    let userId: string | null = null;
    let allowCredentials: Array<{ id: string; type: "public-key" }> = [];
    if (email) {
      const userResult = await this.db.query(
        "SELECT id FROM users WHERE email = ? AND active = ?",
        [email, true],
      );
      if (userResult.rows.length > 0) {
        userId = userResult.rows[0].id;
        const creds = await this.db.query(
          "SELECT credential_id FROM webauthn_credentials WHERE user_id = ?",
          [userId],
        );
        allowCredentials = creds.rows.map((r) => ({
          id: r.credential_id,
          type: "public-key" as const,
        }));
      }
    }

    await this.db.execute(
      `INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        challengeId,
        webAuthn.base64UrlEncode(challenge),
        "login",
        userId,
        new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      ],
    );

    return {
      challengeId,
      publicKey: {
        rpId: this.config.webauthn.rpId,
        challenge: webAuthn.base64UrlEncode(challenge),
        timeout: 60000,
        allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
        userVerification: "preferred",
      },
    };
  }

  /**
   * Finish login: verify the assertion signature, validate counter
   * monotonicity (cloning detection), and either issue a session or —
   * if the user has TOTP confirmed — return an MfaChallenge so the
   * second factor still gates them. (Phase A composition.)
   */
  async finishWebAuthnLogin(
    finish: WebAuthnLoginFinish,
    meta?: RequestMeta,
  ): Promise<LoginResult> {
    if (!this.config.webauthn) {
      throw new AuthError(
        "WebAuthn not configured",
        AuthErrorCode.INVALID_OPERATION,
        500,
      );
    }
    const challenge = await this.consumeWebAuthnChallenge(
      finish.challengeId,
      "login",
    );

    const credResult = await this.db.query(
      `SELECT user_id, public_key_jwk, alg, counter
       FROM webauthn_credentials WHERE credential_id = ?`,
      [finish.credentialId],
    );
    if (credResult.rows.length === 0) {
      throw new AuthError(
        "Unknown credential",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    const cred = credResult.rows[0];

    // If begin() bound a userId, the credential must belong to them.
    if (challenge.user_id && cred.user_id !== challenge.user_id) {
      throw new AuthError(
        "Credential does not belong to the challenged user",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }

    const authData = webAuthn.base64UrlDecode(finish.authenticatorData);
    const clientDataJSON = webAuthn.base64UrlDecode(finish.clientDataJSON);
    const signature = webAuthn.base64UrlDecode(finish.signature);

    webAuthn.verifyClientData({
      clientDataJSON,
      expectedChallenge: webAuthn.base64UrlDecode(challenge.challenge),
      expectedOrigin: this.config.webauthn.origin,
      expectedType: "webauthn.get",
    });

    const parsed = webAuthn.parseAuthenticatorData(authData);
    const expectedRpHash = await webAuthn.hashRpId(this.config.webauthn.rpId);
    if (!byteArraysEqual(parsed.rpIdHash, expectedRpHash)) {
      throw new AuthError(
        "WebAuthn rpIdHash mismatch",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }

    const verified = await webAuthn.verifyAssertionSignature({
      publicKey: {
        alg: cred.alg,
        jwk: JSON.parse(cred.public_key_jwk),
      },
      authData,
      clientDataJSON,
      signature,
    });
    if (!verified) {
      this.auditEvent("webauthn_signature_failed", cred.user_id, {
        ipAddress: meta?.ipAddress,
      });
      throw new AuthError(
        "WebAuthn signature did not verify",
        AuthErrorCode.INVALID_CREDENTIALS,
        401,
      );
    }

    // Counter monotonicity (cloning detection per W3C §6.1.1). A
    // counter of 0 from the authenticator means the device doesn't
    // implement counters — accept it but never bump the stored value.
    if (parsed.counter !== 0) {
      if (parsed.counter <= cred.counter) {
        this.auditEvent("webauthn_counter_regression", cred.user_id, {
          stored: cred.counter,
          received: parsed.counter,
        });
        throw new AuthError(
          "WebAuthn counter regression — possible cloned credential",
          AuthErrorCode.INVALID_TOKEN,
          401,
        );
      }
      await this.db.execute(
        `UPDATE webauthn_credentials
         SET counter = ?, last_used_at = CURRENT_TIMESTAMP
         WHERE credential_id = ?`,
        [parsed.counter, finish.credentialId],
      );
    } else {
      await this.db.execute(
        `UPDATE webauthn_credentials
         SET last_used_at = CURRENT_TIMESTAMP
         WHERE credential_id = ?`,
        [finish.credentialId],
      );
    }

    const user = await this.getUser(cred.user_id);
    if (!user || !user.active || user.isAnonymous) {
      throw new AuthError(
        "User not found",
        AuthErrorCode.USER_NOT_FOUND,
        404,
      );
    }

    if (await this.hasConfirmedTOTP(user.id)) {
      const challengeOut = await this.issueMfaChallenge(user.id);
      this.auditEvent("webauthn_mfa_challenge_issued", user.id, {
        ipAddress: meta?.ipAddress,
      });
      return challengeOut;
    }

    this.auditEvent("webauthn_login_succeeded", user.id, {
      ipAddress: meta?.ipAddress,
    });
    return await this.completeLogin(user, meta);
  }

  /** Remove a passkey from the user's account. */
  async deleteWebAuthnCredential(
    userId: string,
    credentialId: string,
  ): Promise<void> {
    await this.db.execute(
      "DELETE FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?",
      [userId, credentialId],
    );
    this.auditEvent("webauthn_credential_deleted", userId, { credentialId });
  }

  /** List the user's registered passkeys. */
  async listWebAuthnCredentials(userId: string): Promise<
    Array<{
      credentialId: string;
      name: string | null;
      createdAt: string;
      lastUsedAt: string | null;
    }>
  > {
    const result = await this.db.query(
      `SELECT credential_id, name, created_at, last_used_at
       FROM webauthn_credentials
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId],
    );
    return result.rows.map((r) => ({
      credentialId: r.credential_id,
      name: r.name ?? null,
      createdAt: String(r.created_at),
      lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    }));
  }

  /**
   * Fetch + validate (and burn) a WebAuthn ceremony challenge. Throws
   * on missing / consumed / expired / wrong-purpose.
   */
  private async consumeWebAuthnChallenge(
    challengeId: string,
    purpose: "register" | "login",
  ): Promise<{ challenge: string; user_id: string | null }> {
    const result = await this.db.query(
      `SELECT challenge, purpose, user_id, expires_at, consumed_at
       FROM webauthn_challenges WHERE id = ?`,
      [challengeId],
    );
    if (result.rows.length === 0) {
      throw new AuthError(
        "Unknown WebAuthn challenge",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    const row = result.rows[0];
    if (row.consumed_at) {
      throw new AuthError(
        "WebAuthn challenge already used",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    if (row.purpose !== purpose) {
      throw new AuthError(
        "WebAuthn challenge purpose mismatch",
        AuthErrorCode.INVALID_TOKEN,
        401,
      );
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw new AuthError(
        "WebAuthn challenge expired",
        AuthErrorCode.TOKEN_EXPIRED,
        401,
      );
    }
    await this.db.execute(
      "UPDATE webauthn_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?",
      [challengeId],
    );
    return { challenge: row.challenge, user_id: row.user_id ?? null };
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

  /**
   * Fire a lifecycle webhook. Wraps `webhookSender.dispatch()` with
   * logging-only error handling — webhook failures must never surface
   * to the auth caller. (gh/geldata#7484, ports geldata/gel#7813)
   */
  private fireWebhook(event: WebhookEvent): void {
    void this.webhookSender.dispatch(event).catch((err) => {
      authLogger.warn("webhook dispatch errored", {
        eventType: event.eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
    const roles = await this.getUserRoles(user.id);
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
    if (roles.length > 0) payload.roles = roles;

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
      isAnonymous: row.is_anonymous === undefined ? false : Boolean(row.is_anonymous),
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
   * Generate a uniformly-distributed zero-padded numeric code of the
   * requested length. Implemented by drawing `Uint32` samples and
   * rejecting any value above the largest multiple of `10^digits` that
   * fits in `2^32`. A naive `% 10^digits` over `Uint32` has a small
   * but real bias toward the lower buckets — for 6 digits the bias is
   * tiny but it's free to do this correctly.
   *
   * Used by `requestMagicCode` (gh/geldata#7367); `digits` is at most
   * 9 in practice (10^10 doesn't fit in `Uint32`).
   */
  private generateNumericCode(digits: number): string {
    if (digits < 1 || digits > 9) {
      throw new Error(`generateNumericCode: digits must be 1..9 (got ${digits})`);
    }
    const modulus = 10 ** digits;
    // Largest multiple of `modulus` that fits in 2^32. Anything ≥ this
    // threshold is rejected to keep the post-mod distribution uniform.
    const limit = Math.floor(0x1_0000_0000 / modulus) * modulus;
    const buf = new Uint32Array(1);
    while (true) {
      crypto.getRandomValues(buf);
      if (buf[0] < limit) {
        return String(buf[0] % modulus).padStart(digits, "0");
      }
    }
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

// ── WebAuthn helpers (gh/geldata#6725) ────────────────────────────────

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function byteArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── Recovery-code helpers (gh/geldata#8186) ───────────────────────────

// Crockford-ish base32: alphanum minus visually-confusing 0/O, 1/I/L,
// and U (which the original spec drops to avoid accidental profanity).
// 25 codes in the alphabet × 10 chars = ~58 bits of entropy. Plenty
// for codes also gated by a 5-min MFA challenge window.
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate one human-readable recovery code formatted as
 * `XXXXX-XXXXX` (10 chars, dash for legibility on a printed card).
 */
function generateRecoveryCode(): string {
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  let raw = "";
  for (let i = 0; i < buf.length; i++) {
    raw += RECOVERY_ALPHABET[buf[i] % RECOVERY_ALPHABET.length];
  }
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Normalize user input: uppercase, strip every non-alphanumeric char
 * (so `xxxxx-xxxxx`, `XXXXX XXXXX`, `xxxxxxxxxx` all match the same
 * stored hash). Then re-insert the dash so the hash input is canonical.
 */
function normalizeRecoveryCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (cleaned.length !== 10) return input; // let the lookup fail
  return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`;
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
      `AuthProvider: jwtAlgorithm must be "HS256" or "RS256"; got ${JSON.stringify(config.jwtAlgorithm)}`,
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
      `AuthProvider: PEM key missing '${begin}' / '${end}' armor — got ${pem.slice(0, 30)}…`,
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

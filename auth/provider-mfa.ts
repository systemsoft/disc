/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * MFA layer of the authentication provider: TOTP enrollment and
 * verification, recovery codes, and WebAuthn (passkey) ceremonies.
 * `AuthProvider` (provider.ts) extends this class and implements the
 * abstract members declared at the top.
 */

/*** UTILITY ------------------------------------------ ***/

import * as webAuthn from "./webauthn.ts";
import { buildOtpauthUri, generateSecret as generateTotpSecret, verifyTOTP } from "./totp.ts";
import { DatabaseInterface } from "./database-interface.ts";

import {
  byteArraysEqual,
  generateRecoveryCode,
  normalizeRecoveryCode,
  randomBytes,
  type ResolvedAuthConfig
} from "./provider-helpers.ts";

import {
  AuthError,
  AuthErrorCode,
  AuthResponse,
  RequestMeta,
  User,
  type LoginResult,
  type MfaChallenge,
  type TotpEnrollment,
  type WebAuthnLoginFinish,
  type WebAuthnLoginOptions,
  type WebAuthnRegistrationFinish,
  type WebAuthnRegistrationOptions
} from "./types.ts";

/*** EXPORT ------------------------------------------- ***/

export abstract class AuthProviderMfa {
  /*** Shared state owned and initialized by `AuthProvider` (provider.ts). ***/
  protected abstract config: ResolvedAuthConfig;
  protected abstract db: DatabaseInterface;

  /*** Cross-layer methods implemented by `AuthProvider` (provider.ts). ***/
  protected abstract auditEvent(event: string, userId: string | null, details?: Record<string, unknown>): void;
  protected abstract completeLogin(user: User, meta?: RequestMeta): Promise<AuthResponse>;
  protected abstract generateId(): string;
  protected abstract generateToken(): string;
  abstract getUser(userId: string): Promise<User | null>;
  protected abstract hashToken(plaintext: string): Promise<string>;

  /**
   * Begin the WebAuthn login ceremony. If `email` is provided we look
   * up the user’s credentials to scope `allowCredentials`; otherwise
   * we issue an unscoped challenge (discoverable-credential / username-
   * less flows).
   */
  async beginWebAuthnLogin(email?: string): Promise<WebAuthnLoginOptions> {
    if (!this.config.webauthn)
      throw new AuthError("WebAuthn not configured", AuthErrorCode.INVALID_OPERATION, 500);

    const challenge = randomBytes(32);
    const challengeId = this.generateId();
    let allowCredentials: Array<{ id: string; type: "public-key"; }> = [];
    let userId: string | null = null;

    if (email) {
      const userResult = await this.db.query("SELECT id FROM users WHERE email = ? AND active = ?", [email, true]);

      if (userResult.rows.length > 0) {
        userId = userResult.rows[0].id;
        const creds = await this.db.query("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?", [userId]);

        allowCredentials = creds.rows.map(r => ({
          id: r.credential_id,
          type: "public-key" as const
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
        new Date(Date.now() + 5 * 60 * 1000).toISOString()
      ]
    );

    return {
      challengeId,
      publicKey: {
        allowCredentials: allowCredentials.length > 0 ?
          allowCredentials :
          undefined,
        challenge: webAuthn.base64UrlEncode(challenge),
        rpId: this.config.webauthn.rpId,
        timeout: 60000,
        userVerification: "preferred"
      }
    };
  }

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
  async beginWebAuthnRegistration(userId: string): Promise<WebAuthnRegistrationOptions> {
    if (!this.config.webauthn)
      throw new AuthError("WebAuthn not configured (set AuthConfig.webauthn)", AuthErrorCode.INVALID_OPERATION, 500);

    const userResult = await this.db.query("SELECT id, email, username FROM users WHERE id = ?", [userId]);

    if (userResult.rows.length === 0)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

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
        new Date(Date.now() + 5 * 60 * 1000).toISOString()
      ]
    );

    const existing = await this.db.query("SELECT credential_id FROM webauthn_credentials WHERE user_id = ?", [userId]);
    this.auditEvent("webauthn_registration_started", userId);

    /*** Discoverable-credential preference (gh/geldata#7196). Defaults to `"preferred"` so
         passkey-capable authenticators store user-handle metadata locally — future logins can then
         start without the user typing their email first. Operators can flip
         `webauthn.requireResidentKey` to `true` to refuse non-resident
         authenticators outright. ***/
    const requireResident = this.config.webauthn.requireResidentKey === true;

    return {
      challengeId,
      publicKey: {
        attestation: "none",
        authenticatorSelection: {
          requireResidentKey: requireResident,
          residentKey: requireResident ? "required" : "preferred",
          userVerification: "preferred"
        },
        challenge: webAuthn.base64UrlEncode(challenge),
        excludeCredentials: existing.rows.map(r => ({
          id: r.credential_id,
          type: "public-key" as const
        })),
        pubKeyCredParams: [{
          alg: webAuthn.COSE_ALG_ES256,
          type: "public-key"
        }],
        rp: {
          id: this.config.webauthn.rpId,
          name: this.config.webauthn.rpName
        },
        timeout: 60000,
        user: {
          displayName: user.username || user.email,
          id: user.id,
          name: user.email
        }
      }
    };
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
    const result = await this.db.query("SELECT secret FROM mfa_totp WHERE user_id = ?", [userId]);

    if (result.rows.length === 0)
      throw new AuthError("TOTP not enrolled", AuthErrorCode.INVALID_OPERATION, 400);

    const offset = await verifyTOTP(result.rows[0].secret, code);

    if (offset === null) {
      this.auditEvent("totp_confirm_failed", userId);
      throw new AuthError("Invalid TOTP code", AuthErrorCode.INVALID_CREDENTIALS, 401);
    }

    await this.db.execute("UPDATE mfa_totp SET confirmed_at = CURRENT_TIMESTAMP WHERE user_id = ?", [userId]);
    this.auditEvent("totp_confirmed", userId);
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
  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const hash = await this.hashToken(normalizeRecoveryCode(code));
    const result = await this.db.query("SELECT user_id, used_at FROM recovery_codes WHERE code_hash = ?", [hash]);

    if (result.rows.length === 0)
      return false;

    const row = result.rows[0];

    if (row.user_id !== userId)
      return false;

    if (row.used_at)
      return false;

    await this.db.execute("UPDATE recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE code_hash = ?", [hash]);
    this.auditEvent("recovery_code_consumed", userId);

    return true;
  }

  /** Remove a passkey from the user’s account. */
  async deleteWebAuthnCredential(userId: string, credentialId: string): Promise<void> {
    await this.db.execute("DELETE FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?", [userId, credentialId]);
    this.auditEvent("webauthn_credential_deleted", userId, { credentialId });
  }

  /**
   * Disable TOTP for a user. The row is deleted, not just flagged —
   * keeps a fresh `enrollTOTP()` from accidentally re-using a
   * compromised secret. The caller is responsible for whatever
   * authorization gate makes sense (typically: re-prompt for password).
   */
  async disableTOTP(userId: string): Promise<void> {
    await this.db.execute("DELETE FROM mfa_totp WHERE user_id = ?", [userId]);
    this.auditEvent("totp_disabled", userId);
  }

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
    const userResult = await this.db.query("SELECT id, email, username FROM users WHERE id = ?", [userId]);

    if (userResult.rows.length === 0)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

    const user = userResult.rows[0];
    const secret = generateTotpSecret();

    const existing = await this.db.query("SELECT user_id FROM mfa_totp WHERE user_id = ?", [userId]);

    if (existing.rows.length > 0)
      await this.db.execute("UPDATE mfa_totp SET secret = ?, confirmed_at = NULL WHERE user_id = ?", [secret, userId]);
    else
      await this.db.execute("INSERT INTO mfa_totp (user_id, secret) VALUES (?, ?)", [userId, secret]);

    const otpauthUri = buildOtpauthUri({
      accountName: user.username || user.email,
      issuer: this.config.jwtIssuer || "Disc",
      secret
    });

    this.auditEvent("totp_enrollment_started", userId);
    return { otpauthUri, secret };
  }

  /**
   * Finish login: verify the assertion signature, validate counter
   * monotonicity (cloning detection), and either issue a session or —
   * if the user has TOTP confirmed — return an MfaChallenge so the
   * second factor still gates them. (Phase A composition.)
   */
  async finishWebAuthnLogin(finish: WebAuthnLoginFinish, meta?: RequestMeta): Promise<LoginResult> {
    if (!this.config.webauthn)
      throw new AuthError("WebAuthn not configured", AuthErrorCode.INVALID_OPERATION, 500);

    const challenge = await this.consumeWebAuthnChallenge(finish.challengeId, "login");

    const credResult = await this.db.query(
      `SELECT user_id, public_key_jwk, alg, counter
       FROM webauthn_credentials WHERE credential_id = ?`,
      [finish.credentialId]
    );

    if (credResult.rows.length === 0)
      throw new AuthError("Unknown credential", AuthErrorCode.INVALID_TOKEN, 401);

    const cred = credResult.rows[0];

    /*** If begin() bound a userId, the credential must belong to them. ***/
    if (challenge.user_id && cred.user_id !== challenge.user_id)
      throw new AuthError("Credential does not belong to the challenged user", AuthErrorCode.INVALID_TOKEN, 401);

    const authData = webAuthn.base64UrlDecode(finish.authenticatorData);
    const clientDataJSON = webAuthn.base64UrlDecode(finish.clientDataJSON);
    const signature = webAuthn.base64UrlDecode(finish.signature);

    webAuthn.verifyClientData({
      clientDataJSON,
      expectedChallenge: webAuthn.base64UrlDecode(challenge.challenge),
      expectedOrigin: this.config.webauthn.origin,
      expectedType: "webauthn.get"
    });

    const parsed = webAuthn.parseAuthenticatorData(authData);
    const expectedRpHash = await webAuthn.hashRpId(this.config.webauthn.rpId);

    if (!byteArraysEqual(parsed.rpIdHash, expectedRpHash))
      throw new AuthError("WebAuthn rpIdHash mismatch", AuthErrorCode.INVALID_TOKEN, 401);

    const verified = await webAuthn.verifyAssertionSignature({
      publicKey: {
        alg: cred.alg,
        jwk: JSON.parse(cred.public_key_jwk)
      },
      authData,
      clientDataJSON,
      signature
    });

    if (!verified) {
      this.auditEvent("webauthn_signature_failed", cred.user_id, { ipAddress: meta?.ipAddress });
      throw new AuthError("WebAuthn signature did not verify", AuthErrorCode.INVALID_CREDENTIALS, 401);
    }

    /*** Counter monotonicity (cloning detection per W3C §6.1.1). A counter of 0 from the
         authenticator means the device doesn’t implement counters — accept it but never
         bump the stored value. ***/
    if (parsed.counter !== 0) {
      if (parsed.counter <= cred.counter) {
        this.auditEvent("webauthn_counter_regression", cred.user_id, { received: parsed.counter, stored: cred.counter });
        throw new AuthError("WebAuthn counter regression — possible cloned credential", AuthErrorCode.INVALID_TOKEN, 401);
      }

      await this.db.execute(
        `UPDATE webauthn_credentials
         SET counter = ?, last_used_at = CURRENT_TIMESTAMP
         WHERE credential_id = ?`,
        [parsed.counter, finish.credentialId]
      );
    } else {
      await this.db.execute(
        `UPDATE webauthn_credentials
         SET last_used_at = CURRENT_TIMESTAMP
         WHERE credential_id = ?`,
        [finish.credentialId]
      );
    }

    const user = await this.getUser(cred.user_id);

    if (!user || !user.active || user.isAnonymous)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

    if (await this.hasConfirmedTOTP(user.id)) {
      const challengeOut = await this.issueMfaChallenge(user.id);
      this.auditEvent("webauthn_mfa_challenge_issued", user.id, { ipAddress: meta?.ipAddress });

      return challengeOut;
    }

    this.auditEvent("webauthn_login_succeeded", user.id, { ipAddress: meta?.ipAddress });
    return await this.completeLogin(user, meta);
  }

  /**
   * Finish registration: parse the attestation object, verify the
   * client data, and persist the credential. The challenge row is
   * burned even on success (single-use) and on every error path that
   * read it.
   */
  async finishWebAuthnRegistration(finish: WebAuthnRegistrationFinish): Promise<{ credentialId: string; }> {
    if (!this.config.webauthn)
      throw new AuthError("WebAuthn not configured", AuthErrorCode.INVALID_OPERATION, 500);

    const challenge = await this.consumeWebAuthnChallenge(finish.challengeId, "register");

    if (!challenge.user_id)
      throw new AuthError("Registration challenge has no user binding", AuthErrorCode.INVALID_TOKEN, 401);

    const attestationBytes = webAuthn.base64UrlDecode(finish.attestationObject);
    const clientDataBytes = webAuthn.base64UrlDecode(finish.clientDataJSON);

    webAuthn.verifyClientData({
      clientDataJSON: clientDataBytes,
      expectedChallenge: webAuthn.base64UrlDecode(challenge.challenge),
      expectedOrigin: this.config.webauthn.origin,
      expectedType: "webauthn.create"
    });

    const parsed = webAuthn.parseAttestationObject(attestationBytes);
    const expectedRpHash = await webAuthn.hashRpId(this.config.webauthn.rpId);

    if (!byteArraysEqual(parsed.rpIdHash, expectedRpHash))
      throw new AuthError("WebAuthn rpIdHash mismatch", AuthErrorCode.INVALID_TOKEN, 401);

    if (parsed.fmt !== "none" && parsed.fmt !== "packed")
      throw new AuthError(`Unsupported attestation format: ${parsed.fmt}`, AuthErrorCode.INVALID_OPERATION, 400);

    const credentialIdB64 = webAuthn.base64UrlEncode(parsed.credentialId);

    if (credentialIdB64 !== finish.credentialId)
      throw new AuthError("credentialId mismatch between client and authenticatorData", AuthErrorCode.INVALID_TOKEN, 401);

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
        finish.name ?? null
      ]
    );

    this.auditEvent("webauthn_registered", challenge.user_id, { credentialId: credentialIdB64 });
    return { credentialId: credentialIdB64 };
  }

  /**
   * (Re)generate a fresh batch of recovery codes for the user. Returns
   * the plaintext array — this is the *only* time the user can see
   * them; they’re stored hashed. Calling this again invalidates every
   * previous code (including unused ones), matching the standard
   * "regenerate codes" UX where the user clicks the button after
   * losing their old printout.
   *
   * Default count is 8, mirroring what GitHub / GitLab / Google use.
   */
  async generateRecoveryCodes(userId: string, count = 8): Promise<string[]> {
    const userResult = await this.db.query("SELECT id FROM users WHERE id = ?", [userId]);

    if (userResult.rows.length === 0)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

    if (count < 1 || count > 50)
      throw new AuthError("count must be between 1 and 50", AuthErrorCode.INVALID_OPERATION, 400);

    /*** Wipe any existing codes — `generateRecoveryCodes` always means "issue a new set", never
         "append to the existing set". ***/
    await this.db.execute("DELETE FROM recovery_codes WHERE user_id = ?", [userId]);
    const plaintext: string[] = [];

    for (let i = 0; i < count; i++) {
      const code = generateRecoveryCode();
      plaintext.push(code);

      const hash = await this.hashToken(code);
      await this.db.execute("INSERT INTO recovery_codes (code_hash, user_id) VALUES (?, ?)", [hash, userId]);
    }

    this.auditEvent("recovery_codes_generated", userId, { count });
    return plaintext;
  }

  /** List the user’s registered passkeys. */
  async listWebAuthnCredentials(userId: string): Promise<
    Array<{
      createdAt: string;
      credentialId: string;
      lastUsedAt: string | null;
      name: string | null;
    }>
  > {
    const result = await this.db.query(
      `SELECT credential_id, name, created_at, last_used_at
       FROM webauthn_credentials
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [userId]
    );

    return result.rows.map(r => ({
      createdAt: String(r.created_at),
      credentialId: r.credential_id,
      lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
      name: r.name ?? null
    }));
  }

  /**
   * Complete an MFA-gated login by submitting a recovery code instead
   * of a TOTP code. Same challenge-token shape as `loginWithTOTP`. On
   * success, burns the code and the challenge.
   */
  async loginWithRecoveryCode(challengeToken: string, code: string, meta?: RequestMeta): Promise<AuthResponse> {
    const tokenHash = await this.hashToken(challengeToken);

    const result = await this.db.query(
      `SELECT user_id, expires_at, consumed_at
       FROM mfa_challenges
       WHERE token_hash = ?`,
      [tokenHash]
    );

    if (result.rows.length === 0)
      throw new AuthError("Invalid or expired MFA challenge", AuthErrorCode.INVALID_TOKEN, 401);

    const row = result.rows[0];

    if (row.consumed_at)
      throw new AuthError("MFA challenge already used", AuthErrorCode.INVALID_TOKEN, 401);

    if (new Date(row.expires_at).getTime() < Date.now())
      throw new AuthError("MFA challenge expired", AuthErrorCode.TOKEN_EXPIRED, 401);

    const burned = await this.consumeRecoveryCode(row.user_id, code);

    if (!burned) {
      this.auditEvent("login_recovery_code_failed", row.user_id, { ipAddress: meta?.ipAddress });
      throw new AuthError("Invalid recovery code", AuthErrorCode.INVALID_CREDENTIALS, 401);
    }

    await this.db.execute("UPDATE mfa_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE token_hash = ?", [tokenHash]);
    const user = await this.getUser(row.user_id);

    if (!user)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

    return await this.completeLogin(user, meta);
  }

  /**
   * Complete an MFA-gated login by submitting the TOTP code.
   * `challengeToken` is the plaintext token returned from `login()`’s
   * `MfaChallenge`. On success, returns a normal `AuthResponse`. On
   * failure, the challenge stays valid (until expiry) so users can
   * retry typos — but each individual code is rate-limited by the
   * 30-second TOTP step plus the auth-route per-IP limiter.
   */
  async loginWithTOTP(challengeToken: string, code: string, meta?: RequestMeta): Promise<AuthResponse> {
    const tokenHash = await this.hashToken(challengeToken);

    const result = await this.db.query(
      `SELECT user_id, expires_at, consumed_at
       FROM mfa_challenges
       WHERE token_hash = ?`,
      [tokenHash]
    );

    if (result.rows.length === 0)
      throw new AuthError("Invalid or expired MFA challenge", AuthErrorCode.INVALID_TOKEN, 401);

    const row = result.rows[0];

    if (row.consumed_at)
      throw new AuthError("MFA challenge already used", AuthErrorCode.INVALID_TOKEN, 401);

    const expiresAt = new Date(row.expires_at);

    if (expiresAt.getTime() < Date.now())
      throw new AuthError("MFA challenge expired", AuthErrorCode.TOKEN_EXPIRED, 401);

    const totp = await this.db.query("SELECT secret FROM mfa_totp WHERE user_id = ?", [row.user_id]);

    if (totp.rows.length === 0) {
      /*** User disabled MFA between password-step and code-step. Be conservative — fail closed
           rather than promote. ***/
      throw new AuthError("MFA not configured", AuthErrorCode.INVALID_OPERATION, 400);
    }

    const offset = await verifyTOTP(totp.rows[0].secret, code);

    if (offset === null) {
      this.auditEvent("login_mfa_failed", row.user_id, { ipAddress: meta?.ipAddress });
      throw new AuthError("Invalid TOTP code", AuthErrorCode.INVALID_CREDENTIALS, 401);
    }

    /*** Burn the challenge before issuing the session. A consumed_at marker keeps the row around
         for forensics but blocks reuse. ***/
    await this.db.execute("UPDATE mfa_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE token_hash = ?", [tokenHash]);

    const user = await this.getUser(row.user_id);

    if (!user)
      throw new AuthError("User not found", AuthErrorCode.USER_NOT_FOUND, 404);

    return await this.completeLogin(user, meta);
  }

  /** How many recovery codes does the user have left to burn? */
  async recoveryCodesRemaining(userId: string): Promise<number> {
    const result = await this.db.query("SELECT code_hash FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", [userId]);
    return result.rows.length;
  }

  /**
   * Fetch + validate (and burn) a WebAuthn ceremony challenge. Throws
   * on missing / consumed / expired / wrong-purpose.
   */
  private async consumeWebAuthnChallenge(
    challengeId: string,
    purpose: "login" | "register"
  ): Promise<{ challenge: string; user_id: string | null; }> {
    const result = await this.db.query(
      `SELECT challenge, purpose, user_id, expires_at, consumed_at
       FROM webauthn_challenges WHERE id = ?`,
      [challengeId]
    );

    if (result.rows.length === 0)
      throw new AuthError("Unknown WebAuthn challenge", AuthErrorCode.INVALID_TOKEN, 401);

    const row = result.rows[0];

    if (row.consumed_at)
      throw new AuthError("WebAuthn challenge already used", AuthErrorCode.INVALID_TOKEN, 401);

    if (row.purpose !== purpose)
      throw new AuthError("WebAuthn challenge purpose mismatch", AuthErrorCode.INVALID_TOKEN, 401);

    if (new Date(row.expires_at).getTime() < Date.now())
      throw new AuthError("WebAuthn challenge expired", AuthErrorCode.TOKEN_EXPIRED, 401);

    await this.db.execute("UPDATE webauthn_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = ?", [challengeId]);

    return {
      challenge: row.challenge,
      user_id: row.user_id ?? null
    };
  }

  /** Does the user have a confirmed TOTP enrollment? */
  protected async hasConfirmedTOTP(userId: string): Promise<boolean> {
    const result = await this.db.query("SELECT 1 FROM mfa_totp WHERE user_id = ? AND confirmed_at IS NOT NULL", [userId]);
    return result.rows.length > 0;
  }

  /**
   * Internal: mint a single-use MFA challenge token, store its hash,
   * and return the plaintext bundled into an `MfaChallenge` for the
   * caller to relay back via `loginWithTOTP`.
   */
  protected async issueMfaChallenge(userId: string): Promise<MfaChallenge> {
    const plaintext = this.generateToken();
    const tokenHash = await this.hashToken(plaintext);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); /*** 5 min ***/
    await this.db.execute(
      `INSERT INTO mfa_challenges (token_hash, user_id, expires_at)
       VALUES (?, ?, ?)`,
      [tokenHash, userId, expiresAt.toISOString()]
    );

    return {
      challengeToken: plaintext,
      factors: ["totp"],
      mfaRequired: true
    };
  }
}

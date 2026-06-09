/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Module-level helpers for the authentication provider: resolved-config
 * types and validation, JWT key import, and recovery-code utilities.
 * Shared by `AuthProvider` (provider.ts) and `AuthProviderMfa`
 * (provider-mfa.ts).
 */

/*** UTILITY ------------------------------------------ ***/

import { AuthConfig } from "./types.ts";

/**
 * Conditional config fields whose presence depends on `jwtAlgorithm`:
 *  - HS256 needs `jwtSecret`
 *  - RS256 needs `jwtPrivateKey` + `jwtPublicKey`
 * They’re excluded from the defaults map (no sensible default) and
 * validated at runtime in `initialize()`.
 */
export type ConditionalAuthFields =
  | "branding"
  | "captcha"
  | "emailBaseUrl"
  | "emailTemplates"
  | "jwtPrivateKey"
  | "jwtPublicKey"
  | "jwtSecret"
  | "magicLinkUrlTemplate"
  | "smtp"
  | "webauthn";

/**
 * Resolved config after defaults merge — every non-conditional field is
 * required (so the constructor can rely on it without fallbacks), while
 * the algorithm-specific keys remain optional and are checked in
 * `initialize()`.
 */
export type ResolvedAuthConfig = Required<Omit<AuthConfig, ConditionalAuthFields>> & Pick<AuthConfig, ConditionalAuthFields>;

/*** Crockford-ish base32: alphanum minus visually-confusing 0/O, 1/I/L, and U (which the original
     spec drops to avoid accidental profanity). 25 codes in the alphabet × 10 chars = ~58 bits of
     entropy. Plenty for codes also gated by a 5-min MFA challenge window. ***/
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/*** EXPORT ------------------------------------------- ***/

export function byteArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

/**
 * Generate one human-readable recovery code formatted as
 * `XXXXX-XXXXX` (10 chars, dash for legibility on a printed card).
 */
export function generateRecoveryCode(): string {
  const buf = new Uint8Array(10);
  let raw = "";
  crypto.getRandomValues(buf);

  for (let i = 0; i < buf.length; i++) {
    raw += RECOVERY_ALPHABET[buf[i] % RECOVERY_ALPHABET.length];
  }

  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

/**
 * Import an HS256 HMAC key from a shared secret. Enforces a 32-byte
 * minimum (RFC 7518 §3.2 recommends ≥ key-length bits, i.e. 256 for
 * SHA-256) so weak secrets are caught at startup, not at first verify.
 */
export async function importHmacKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret)
    throw new Error("AuthProvider: jwtSecret is required when jwtAlgorithm is HS256");

  const keyData = new TextEncoder().encode(secret);

  if (keyData.length < 32)
    throw new Error(`AuthProvider: jwtSecret must be at least 32 bytes for HS256; got ${keyData.length}`);

  return await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
}

/**
 * Import an RS256 sign/verify pair from PEM-encoded keys. Private key
 * must be PKCS#8 (`BEGIN PRIVATE KEY`); public key must be SPKI
 * (`BEGIN PUBLIC KEY`). RFC 7518 §3.3 mandates ≥ 2048-bit modulus —
 * not enforced here because Web Crypto doesn’t expose modulus length
 * post-import; document the requirement and trust the operator.
 */
export async function importRsaKeys(
  privateKeyPem: string | undefined,
  publicKeyPem: string | undefined
): Promise<{ signKey: CryptoKey; verifyKey: CryptoKey; }> {
  if (!publicKeyPem)
    throw new Error("AuthProvider: jwtPublicKey is required when jwtAlgorithm is RS256");

  if (!privateKeyPem)
    throw new Error("AuthProvider: jwtPrivateKey is required when jwtAlgorithm is RS256 (verify-only deployments are not yet supported)");

  const algorithm = { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" } as const;

  const signKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(privateKeyPem, "PRIVATE KEY"),
    algorithm,
    false,
    ["sign"]
  );

  const verifyKey = await crypto.subtle.importKey(
    "spki",
    pemToBytes(publicKeyPem, "PUBLIC KEY"),
    algorithm,
    true,
    ["verify"]
  );

  return { signKey, verifyKey };
}

/**
 * Normalize user input: uppercase, strip every non-alphanumeric char
 * (so `xxxxx-xxxxx`, `XXXXX XXXXX`, `xxxxxxxxxx` all match the same
 * stored hash). Then re-insert the dash so the hash input is canonical.
 */
export function normalizeRecoveryCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, "");

  if (cleaned.length !== 10)
    return input; /*** let the lookup fail ***/

  return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`;
}

/**
 * Strip PEM armor (`-----BEGIN <label>-----` / `-----END <label>-----`)
 * and base64-decode the body to raw DER bytes. Throws on a missing or
 * mismatched label — operators see the issue at startup instead of
 * `crypto.subtle.importKey` returning the opaque "data is not valid".
 */
export function pemToBytes(pem: string, expectedLabel: string): Uint8Array<ArrayBuffer> {
  const begin = `-----BEGIN ${expectedLabel}-----`;
  const end = `-----END ${expectedLabel}-----`;
  const startIdx = pem.indexOf(begin);
  const endIdx = pem.indexOf(end);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx)
    throw new Error(`AuthProvider: PEM key missing "${begin}" / "${end}" armor — got ${pem.slice(0, 30)}…`);

  const body = pem
    .slice(startIdx + begin.length, endIdx)
    .replace(/[\r\n\s]+/g, "");

  const binary = atob(body);

  /*** Allocate a fresh ArrayBuffer (not ArrayBufferLike) so the returned Uint8Array satisfies
       WebCrypto’s `BufferSource` parameter — Deno’s strict TypeScript lib rejects the default
       `new Uint8Array(N)` because its inferred buffer type widens to ArrayBufferLike. ***/
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);

  return out;
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
export function validateAuthConfig(config: ResolvedAuthConfig): void {
  /*** bcrypt rejects rounds outside [4, 31]; the practical upper bound (rounds=15 is already
       ~1s/hash on commodity hardware) is what we enforce — beyond that, registration becomes a
       DoS amplifier. ***/
  if (!Number.isInteger(config.bcryptRounds) || config.bcryptRounds < 4 || config.bcryptRounds > 15)
    throw new Error(`AuthProvider: bcryptRounds must be an integer in [4, 15]; got ${config.bcryptRounds}`);

  if (config.tokenExpiry <= 0 || !Number.isFinite(config.tokenExpiry))
    throw new Error(`AuthProvider: tokenExpiry must be a positive number of seconds; got ${config.tokenExpiry}`);

  if (config.refreshTokenExpiry <= 0 || !Number.isFinite(config.refreshTokenExpiry))
    throw new Error(`AuthProvider: refreshTokenExpiry must be a positive number of seconds; got ${config.refreshTokenExpiry}`);

  if (config.refreshTokenExpiry < config.tokenExpiry) {
    throw new Error(
      `AuthProvider: refreshTokenExpiry (${config.refreshTokenExpiry}s) must be ≥ tokenExpiry (${config.tokenExpiry}s) — refresh tokens shorter than access tokens defeat the purpose`
    );
  }

  if (config.sessionTimeout <= 0 || !Number.isFinite(config.sessionTimeout))
    throw new Error(`AuthProvider: sessionTimeout must be a positive number of seconds; got ${config.sessionTimeout}`);

  if (!Number.isInteger(config.passwordMinLength) || config.passwordMinLength < 1)
    throw new Error(`AuthProvider: passwordMinLength must be a positive integer; got ${config.passwordMinLength}`);

  if (!Number.isInteger(config.maxSessionsPerUser) || config.maxSessionsPerUser < 0)
    throw new Error(`AuthProvider: maxSessionsPerUser must be a non-negative integer (0 disables the cap); got ${config.maxSessionsPerUser}`);

  /*** jwtAlgorithm is type-checked at compile time, but TypeScript’s type narrowing doesn’t
       survive untrusted JSON config. ***/
  if (config.jwtAlgorithm !== "HS256" && config.jwtAlgorithm !== "RS256")
    throw new Error(`AuthProvider: jwtAlgorithm must be "HS256" or "RS256"; got ${JSON.stringify(config.jwtAlgorithm)}`);

  if (typeof config.jwtIssuer !== "string" || config.jwtIssuer.length === 0)
    throw new Error("AuthProvider: jwtIssuer must be a non-empty string");

  if (typeof config.jwtAudience !== "string" || config.jwtAudience.length === 0)
    throw new Error("AuthProvider: jwtAudience must be a non-empty string");
}

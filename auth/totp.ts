/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Time-based One-Time Password (TOTP) — RFC 6238 + RFC 4226.
 *
 * Pure crypto module: no DB I/O, no auth state. Used by AuthProvider
 * for MFA enrollment and verification (gh/geldata#8186).
 *
 * Defaults match what authenticator apps (Google Authenticator,
 * 1Password, Authy, etc.) expect: SHA-1, 30-second step, 6 digits.
 * Don’t change them without also updating the `otpauth://` URI fields
 * — apps assume the defaults when fields are omitted.
 */

/*** UTILITY ------------------------------------------ ***/

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_ALGORITHM: "SHA-1" | "SHA-256" | "SHA-512" = "SHA-1";
const DEFAULT_DIGITS = 6;
const DEFAULT_STEP_SECONDS = 30;
/*** Allow ±1 step on verification. RFC 6238 §6 calls this out: clock drift between client and
     server is real, and refusing to ever look at the previous/next window is hostile UX. ***/
const DEFAULT_WINDOW = 1;

/*** EXPORT ------------------------------------------- ***/

/** Decode an RFC 4648 base32 string (case-insensitive, padding-tolerant). */
export function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;

  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);

    if (idx < 0)
      throw new Error(`Invalid base32 character: ${ch}`);

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return new Uint8Array(out);
}

/** Encode a byte array as RFC 4648 base32 (no padding — TOTP convention). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let out = "";
  let value = 0;

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;

    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0)
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

/**
 * Build an `otpauth://totp/...` URI suitable for a QR code. Issuer and
 * label are URL-encoded so spaces and special characters in app/user
 * names work.
 */
export function buildOtpauthUri(opts: {
  accountName: string;
  algorithm?: "SHA1" | "SHA256" | "SHA512";
  digits?: number;
  issuer: string;
  secret: string;
  stepSeconds?: number;
}): string {
  const issuer = encodeURIComponent(opts.issuer);
  const account = encodeURIComponent(opts.accountName);
  const params = new URLSearchParams();
  params.set("secret", opts.secret);
  params.set("issuer", opts.issuer);

  if (opts.digits && opts.digits !== DEFAULT_DIGITS)
    params.set("digits", String(opts.digits));

  if (opts.stepSeconds && opts.stepSeconds !== DEFAULT_STEP_SECONDS)
    params.set("period", String(opts.stepSeconds));

  if (opts.algorithm && opts.algorithm !== "SHA1")
    params.set("algorithm", opts.algorithm);

  return `otpauth://totp/${issuer}:${account}?${params.toString()}`;
}

/**
 * Generate a fresh TOTP secret. 20 bytes = 160 bits = the SHA-1 block
 * size, which is what RFC 6238 recommends.
 */
export function generateSecret(byteLength = 20): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return base32Encode(bytes);
}

/**
 * Compute the TOTP code for a given moment.
 *
 * `secret` is base32-encoded. `timestampMs` defaults to the current
 * wall-clock time; pass it explicitly when running tests against
 * RFC test vectors.
 */
export async function generateTOTP(
  secret: string,
  options: {
    algorithm?: "SHA-1" | "SHA-256" | "SHA-512";
    digits?: number;
    stepSeconds?: number;
    timestampMs?: number;
  } = {}
): Promise<string> {
  const digits = options.digits ?? DEFAULT_DIGITS;
  const stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS;
  const algorithm = options.algorithm ?? DEFAULT_ALGORITHM;
  const counter = Math.floor((options.timestampMs ?? Date.now()) / 1000 / stepSeconds);

  return await hotp(base32Decode(secret), counter, digits, algorithm);
}

/**
 * Verify a user-supplied code against the secret. Constant-time within
 * the allowed window. Returns the matched window offset (0 = current
 * step, -1 = previous, +1 = next) or `null` on no match.
 */
export async function verifyTOTP(
  secret: string,
  code: string,
  options: {
    algorithm?: "SHA-1" | "SHA-256" | "SHA-512";
    digits?: number;
    stepSeconds?: number;
    timestampMs?: number;
    window?: number;
  } = {}
): Promise<number | null> {
  const digits = options.digits ?? DEFAULT_DIGITS;
  const stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS;
  const window = options.window ?? DEFAULT_WINDOW;
  const algorithm = options.algorithm ?? DEFAULT_ALGORITHM;
  const cleaned = code.replace(/\s+/g, "");

  if (!/^\d+$/.test(cleaned) || cleaned.length !== digits)
    return null;

  const baseCounter = Math.floor((options.timestampMs ?? Date.now()) / 1000 / stepSeconds);
  const key = base32Decode(secret);

  /*** Walk the window comparing in constant time per slot. We *do* return early after the first
       match — leaking which slot matched is not a meaningful side channel (an attacker submitting a
       guess already knows when they sent it). ***/
  for (let offset = -window; offset <= window; offset++) {
    const candidate = await hotp(key, baseCounter + offset, digits, algorithm);

    if (constantTimeEqualStr(candidate, cleaned))
      return offset;
  }

  return null;
}

/*** HELPER ------------------------------------------- ***/

function constantTimeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return diff === 0;
}

async function hotp(
  key: Uint8Array,
  counter: number,
  digits: number,
  algorithm: "SHA-1" | "SHA-256" | "SHA-512"
): Promise<string> {
  /*** Counter as 8-byte big-endian. ***/
  const counterBytes = new Uint8Array(8);
  /*** JS bitwise ops are 32-bit; split into hi/lo halves so we don’t truncate counters past 2^32
       (unlikely with 30s steps, but cheap). ***/
  const hi = Math.floor(counter / 0x100000000);
  const lo = counter >>> 0;
  new DataView(counterBytes.buffer).setUint32(0, hi, false);
  new DataView(counterBytes.buffer).setUint32(4, lo, false);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"]
  );

  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBytes as BufferSource));

  /*** Dynamic truncation (RFC 4226 §5.3). ***/
  const offset = sig[sig.length - 1] & 0x0f;

  const code = ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);

  return String(code % 10 ** digits).padStart(digits, "0");
}

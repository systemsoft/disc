/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * WebAuthn / FIDO2 — passkey registration + authentication.
 * (gh/geldata#6725)
 *
 * Pure module: parses CBOR / COSE / authenticatorData blobs, verifies
 * signatures. No DB I/O, no auth state — `AuthProvider` composes this
 * into the registration / authentication ceremonies.
 *
 * Scope this iteration:
 * - ES256 (P-256, ECDSA + SHA-256). Covers Apple / Google passkeys and
 *   most YubiKey configurations.
 * - Attestation formats `"none"` (no attestation) and `"packed"` (the
 *   format every authenticator must support per the W3C spec). We
 *   verify the COSE public key + credential id match the
 *   authenticator-supplied attestation but do NOT verify the
 *   attestation certificate chain — that’s relevant only when the
 *   relying party wants to enforce specific authenticator brands,
 *   which most apps do not.
 *
 * Out of scope (future): RS256 / EdDSA, Apple / Android-key / TPM /
 * fido-u2f attestation formats, conditional UI, discoverable-
 * credential username-less flows.
 */

/*** UTILITY ------------------------------------------ ***/

const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

interface AuthDataWithCredential {
  counter: number;
  credentialId: Uint8Array;
  flags: number;
  publicKey: ParsedPublicKey;
  rpIdHash: Uint8Array;
}

class CborReader {
  pos = 0;

  constructor(public bytes: Uint8Array) {}

  next(): CborValue {
    const initialByte = this.bytes[this.pos++];
    const major = initialByte >> 5;
    const info = initialByte & 0x1f;
    const value = this.readArgument(info);

    switch (major) {
      case 0: {
        /*** unsigned int ***/
        return value;
      }

      case 1: {
        /*** negative int ***/
        return -1 - value;
      }

      case 2: {
        /*** byte string ***/
        const slice = this.bytes.slice(this.pos, this.pos + value);
        this.pos += value;

        return slice;
      }

      case 3: {
        /*** text string ***/
        const slice = this.bytes.slice(this.pos, this.pos + value);
        this.pos += value;

        return new TextDecoder().decode(slice);
      }

      case 4: {
        /*** array ***/
        const out: CborValue[] = [];

        for (let i = 0; i < value; i++) {
          out.push(this.next());
        }

        return out;
      }

      case 5: {
        /*** map ***/
        const m: CborMap = new Map();

        for (let i = 0; i < value; i++) {
          const k = this.next();
          const v = this.next();
          m.set(k, v);
        }

        return m;
      }

      case 7: {
        /*** simple ***/
        if (info === 20)
          return false;

        if (info === 21)
          return true;

        if (info === 22)
          return null;

        throw new Error(`Unsupported CBOR simple value: ${info}`);
      }

      default: {
        throw new Error(`Unsupported CBOR major type: ${major}`);
      }
    }
  }

  /*** PRIVATE ------------------------------------------ ***/

  private readArgument(info: number): number {
    if (info < 24)
      return info;

    if (info === 24)
      return this.bytes[this.pos++];

    if (info === 25) {
      const v = (this.bytes[this.pos] << 8) | this.bytes[this.pos + 1];
      this.pos += 2;

      return v;
    }

    if (info === 26) {
      const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4);
      this.pos += 4;

      return view.getUint32(0, false);
    }

    throw new Error(`Unsupported CBOR length info: ${info}`);
  }
}

/*** EXPORT ------------------------------------------- ***/

/*** Minimal subset of RFC 8949: unsigned integers, negative integers, byte strings (definite
     length), text strings (definite length), arrays, maps, and false/true/null. WebAuthn never
     uses tags or floats in the structures we care about, so they’re not implemented.

     CborMap is a JS Map keyed by the decoded key (number, string, etc.). ***/

export type CborValue =
  | number
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | CborMap;

export type CborMap = Map<CborValue, CborValue>;

/** COSE algorithm identifier for ES256 (RFC 8152 §8.1). */
export const COSE_ALG_ES256 = -7;
/** authenticatorData flag bits (W3C §6.1). UP/UV/AT exposed for callers. */
export const FLAG_USER_PRESENT = 0x01;
export const FLAG_USER_VERIFIED = 0x04;

export interface ParsedAssertion {
  authData: Uint8Array;
  counter: number;
  flags: number;
  /** RP ID hash extracted from authenticatorData[0..32]. */
  rpIdHash: Uint8Array;
  /** Raw signature blob from the authenticator. */
  signature: Uint8Array;
}

export interface ParsedAttestation {
  attStmt: CborMap;
  /**
   * Raw authenticatorData bytes — needed for the registration-ceremony
   * signature check on attestation formats other than "none".
   */
  authData: Uint8Array;
  counter: number;
  credentialId: Uint8Array;
  fmt: string;
  /** Stored on the credential row; serialized as base64 in the DB. */
  publicKey: ParsedPublicKey;
  rpIdHash: Uint8Array;
}

export interface ParsedPublicKey {
  alg: number;
  /** Raw bytes for re-import via crypto.subtle. JWK form for ES256. */
  jwk: JsonWebKey;
}

export function decodeCbor(bytes: Uint8Array): CborValue {
  return new CborReader(bytes).next();
}

export function base64UrlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }

  return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Hash the relying-party ID (typically the apex domain) for comparison
 * against `authData[0..32]`.
 */
export async function hashRpId(rpId: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(rpId);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/**
 * Parse an `attestationObject` produced by `navigator.credentials.create`.
 * The object is a CBOR map with `fmt`, `authData`, `attStmt`.
 */
export function parseAttestationObject(attestationObjectBytes: Uint8Array): ParsedAttestation {
  const obj = decodeCbor(attestationObjectBytes) as CborMap;
  const fmt = obj.get("fmt");
  const authData = obj.get("authData");
  const attStmt = obj.get("attStmt");

  if (typeof fmt !== "string")
    throw new Error("Invalid attestationObject.fmt");

  if (!(authData instanceof Uint8Array))
    throw new Error("Invalid attestationObject.authData");

  if (!(attStmt instanceof Map))
    throw new Error("Invalid attestationObject.attStmt");

  const parsed = parseAuthenticatorDataWithCredential(authData);

  return {
    attStmt: attStmt as CborMap,
    authData,
    counter: parsed.counter,
    credentialId: parsed.credentialId,
    fmt,
    publicKey: parsed.publicKey,
    rpIdHash: parsed.rpIdHash
  };
}

/**
 * Parse the `authenticatorData` bytes from an authentication ceremony
 * response. Unlike the registration variant, this one doesn’t carry
 * attestedCredentialData — just rpIdHash + flags + counter (+ optional
 * extensions, which we ignore).
 */
export function parseAuthenticatorData(authData: Uint8Array): {
  counter: number;
  flags: number;
  rpIdHash: Uint8Array;
} {
  if (authData.length < 37)
    throw new Error("authenticatorData too short");

  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);

  return {
    counter: view.getUint32(33, false),
    flags: authData[32],
    rpIdHash: authData.slice(0, 32)
  };
}

/**
 * Verify the assertion signature against the stored credential’s
 * public key. The signed data is `authData || sha256(clientDataJSON)`.
 */
export async function verifyAssertionSignature(opts: {
  authData: Uint8Array;
  clientDataJSON: Uint8Array;
  publicKey: ParsedPublicKey;
  signature: Uint8Array;
}): Promise<boolean> {
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", opts.clientDataJSON as BufferSource));
  const signedData = concat(opts.authData, clientDataHash);
  const key = await importCoseKey(opts.publicKey);
  /*** ES256 raw signatures from authenticators are DER-encoded ECDSA (r,s sequences). WebCrypto
       wants raw r||s 64-byte form; convert. ***/
  const rawSig = derToRawEcdsaSignature(opts.signature);

  return await crypto.subtle.verify(
    { hash: "SHA-256", name: "ECDSA" },
    key,
    rawSig as BufferSource,
    signedData as BufferSource
  );
}

/**
 * Parse `clientDataJSON` and assert that the embedded challenge,
 * origin, and type match what we expect for this ceremony. Returns the
 * parsed object so callers can pull out additional fields if needed.
 */
export function verifyClientData(opts: {
  clientDataJSON: Uint8Array;
  expectedChallenge: Uint8Array;
  expectedOrigin: string;
  expectedType: "webauthn.create" | "webauthn.get";
}): { challenge: string; origin: string; type: string; } {
  const text = new TextDecoder().decode(opts.clientDataJSON);
  const parsed = JSON.parse(text) as { challenge: string; origin: string; type: string; };

  if (parsed.type !== opts.expectedType)
    throw new Error(`clientData.type mismatch: expected ${opts.expectedType}, got ${parsed.type}`);

  if (parsed.origin !== opts.expectedOrigin)
    throw new Error(`clientData.origin mismatch: expected ${opts.expectedOrigin}, got ${parsed.origin}`);

  const decodedChallenge = base64UrlDecode(parsed.challenge);

  if (!byteArraysEqual(decodedChallenge, opts.expectedChallenge))
    throw new Error("clientData.challenge mismatch");

  return parsed;
}

/*** HELPER ------------------------------------------- ***/

function byteArraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false;

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;

  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }

  return out;
}

/**
 * Convert a DER-encoded ECDSA signature (sequence of r, s integers) to
 * raw r||s 64-byte form expected by WebCrypto. WebAuthn authenticators
 * emit DER per the WebAuthn §6.5 reference.
 */
function derToRawEcdsaSignature(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30)
    throw new Error("DER signature: missing SEQUENCE");

  /*** der[1] = sequence length (we don’t validate against bounds; trust trim below) ***/
  let i = 2;

  if (der[i] !== 0x02)
    throw new Error("DER signature: missing INTEGER (r)");

  const rLen = der[i + 1];
  const rRaw = der.slice(i + 2, i + 2 + rLen);
  i += 2 + rLen;

  if (der[i] !== 0x02)
    throw new Error("DER signature: missing INTEGER (s)");

  const sLen = der[i + 1];
  const sRaw = der.slice(i + 2, i + 2 + sLen);

  /*** Strip leading 0x00 (DER sign bit) and left-pad to 32 bytes. ***/
  const r = stripAndPad(rRaw, 32);
  const s = stripAndPad(sRaw, 32);
  return concat(r, s);
}

async function importCoseKey(key: ParsedPublicKey): Promise<CryptoKey> {
  if (key.alg !== COSE_ALG_ES256)
    throw new Error(`Cannot import alg ${key.alg}`);

  return await crypto.subtle.importKey(
    "jwk",
    key.jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
}

function parseAuthenticatorDataWithCredential(authData: Uint8Array): AuthDataWithCredential {
  if (authData.length < 37)
    throw new Error("authenticatorData too short");

  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const counter = view.getUint32(33, false);

  if (!(flags & FLAG_ATTESTED_CREDENTIAL_DATA))
    throw new Error("authenticatorData missing attested credential data — registration ceremony requires AT flag");

  /*** attestedCredentialData layout:
       aaguid (16) | credentialIdLength (2) | credentialId | COSE pubkey ***/
  if (authData.length < 37 + 16 + 2)
    throw new Error("attestedCredentialData truncated");

  const credIdLen = view.getUint16(37 + 16, false);
  const credIdStart = 37 + 16 + 2;
  const credIdEnd = credIdStart + credIdLen;

  if (authData.length < credIdEnd)
    throw new Error("credentialId extends past authData");

  const credentialId = authData.slice(credIdStart, credIdEnd);
  const remainder = authData.slice(credIdEnd);
  const cose = decodeCbor(remainder) as CborMap;
  const publicKey = parseCoseKey(cose);

  return { counter, credentialId, flags, publicKey, rpIdHash };
}

function parseCoseKey(cose: CborMap): ParsedPublicKey {
  /*** COSE key map (RFC 8152): kty (1), alg (3), crv (-1), x (-2), y (-3) ***/
  const kty = cose.get(1);
  const alg = cose.get(3);

  if (typeof kty !== "number" || typeof alg !== "number")
    throw new Error("COSE key missing kty/alg");

  if (alg !== COSE_ALG_ES256)
    throw new Error(`Unsupported COSE alg: ${alg} (only ES256/-7 supported)`);

  if (kty !== 2)
    throw new Error(`Expected EC2 key (kty=2), got ${kty}`);

  const crv = cose.get(-1);
  const x = cose.get(-2);
  const y = cose.get(-3);

  if (crv !== 1)
    throw new Error(`Expected P-256 curve (crv=1), got ${crv}`);

  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array))
    throw new Error("COSE key x/y must be byte strings");

  return {
    alg,
    jwk: {
      crv: "P-256",
      ext: true,
      kty: "EC",
      x: base64UrlEncode(x),
      y: base64UrlEncode(y)
    }
  };
}

function stripAndPad(bytes: Uint8Array, length: number): Uint8Array {
  /*** Strip leading 0x00s introduced by DER sign-bit padding. ***/
  let start = 0;

  while (start < bytes.length - 1 && bytes[start] === 0) {
    start++;
  }

  const stripped = bytes.slice(start);

  if (stripped.length === length)
    return stripped;

  if (stripped.length > length)
    throw new Error("DER integer too long for fixed-width raw signature");

  const padded = new Uint8Array(length);
  padded.set(stripped, length - stripped.length);

  return padded;
}

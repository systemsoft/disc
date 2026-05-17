/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Test-only helpers for constructing WebAuthn ceremony payloads.
 * Encodes CBOR / COSE / authenticatorData the same way a real
 * authenticator would, given a JS-controlled keypair. Only used by
 * `auth/webauthn.test.ts` and `auth/webauthn-flow.test.ts`.
 *
 * Not exported from `auth/mod.ts`. Real production code never needs to
 * fabricate these blobs — the browser’s authenticator does it.
 */

/*** UTILITY ------------------------------------------ ***/

import { base64UrlEncode } from "./webauthn.ts";

/*** EXPORT ------------------------------------------- ***/

export interface BuildAuthDataOpts {
  /** Provide for registration ceremonies; omit for assertions. */
  attestedCredential?: {
    aaguid?: Uint8Array;
    cosePublicKey: Uint8Array;
    credentialId: Uint8Array;
  };
  counter?: number;
  flags?: number;
  rpId: string;
}

export interface TestKeyPair {
  /** COSE-encoded public key — exactly what an authenticator embeds. */
  cosePublicKey: Uint8Array;
  privateKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}

export function buildAttestationObject(opts: {
  attStmt?: Map<unknown, unknown>;
  authData: Uint8Array;
  fmt?: "none" | "packed";
}): Uint8Array {
  const fmt = opts.fmt ?? "none";
  const attStmt = opts.attStmt ?? new Map();

  const obj = new Map<string, unknown>([
    ["fmt", fmt],
    ["attStmt", attStmt],
    ["authData", opts.authData]
  ]);

  return encodeCbor(obj);
}

export async function buildAuthenticatorData(opts: BuildAuthDataOpts): Promise<Uint8Array> {
  const rpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(opts.rpId) as BufferSource));
  /*** UP=1 + (AT=1 if registration) + UV=1 (we always say verified for tests). ***/
  let flags = opts.flags ?? 0x05; /*** UP + UV ***/

  if (opts.attestedCredential)
    flags |= 0x40; /*** AT ***/

  const counter = opts.counter ?? 0;
  const counterBytes = new Uint8Array(4);
  new DataView(counterBytes.buffer).setUint32(0, counter, false);
  let out = concat(rpIdHash, new Uint8Array([flags]), counterBytes);

  if (opts.attestedCredential) {
    const aaguid = opts.attestedCredential.aaguid ?? new Uint8Array(16);
    const credLenBytes = new Uint8Array(2);

    new DataView(credLenBytes.buffer).setUint16(0, opts.attestedCredential.credentialId.length, false);

    out = concat(
      out,
      aaguid,
      credLenBytes,
      opts.attestedCredential.credentialId,
      opts.attestedCredential.cosePublicKey
    );
  }

  return out;
}

export function buildClientDataJSON(opts: {
  challenge: Uint8Array;
  origin: string;
  type: "webauthn.create" | "webauthn.get";
}): Uint8Array {
  const obj = {
    challenge: base64UrlEncode(opts.challenge),
    origin: opts.origin,
    type: opts.type
  };

  return new TextEncoder().encode(JSON.stringify(obj));
}

export function encodeCbor(value: unknown): Uint8Array {
  const parts: Uint8Array[] = [];
  encode(value, parts);

  return concat(...parts);
}

export async function generateTestKeyPair(): Promise<TestKeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const x = base64UrlDecodeStrict(jwk.x!);
  const y = base64UrlDecodeStrict(jwk.y!);

  const cose = new Map<number, unknown>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y]
  ]);

  return {
    cosePublicKey: encodeCbor(cose),
    privateKey: pair.privateKey,
    publicKeyJwk: jwk
  };
}

export async function signAssertion(opts: {
  authData: Uint8Array;
  clientDataJSON: Uint8Array;
  privateKey: CryptoKey;
}): Promise<Uint8Array> {
  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", opts.clientDataJSON as BufferSource));
  const signed = concat(opts.authData, clientDataHash);

  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { hash: "SHA-256", name: "ECDSA" },
      opts.privateKey,
      signed as BufferSource
    )
  );

  /*** WebCrypto returns raw r||s, but real authenticators emit DER. Re-encode so we exercise
       the parser. ***/
  return rawToDerEcdsaSignature(raw);
}

/*** HELPER ------------------------------------------- ***/

function base64UrlDecodeStrict(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }

  return out;
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

function derInteger(bytes: Uint8Array): Uint8Array {
  /*** DER integers are signed; if the high bit of the first byte is set, prepend 0x00 so it’s not
       interpreted as negative. ***/
  let val = bytes;
  /*** Strip leading zeros first (DER prefers minimal length). ***/
  let start = 0;

  while (start < val.length - 1 && val[start] === 0) {
    start++;
  }

  val = val.slice(start);

  if (val[0] & 0x80)
    val = concat(new Uint8Array([0x00]), val);

  return concat(new Uint8Array([0x02, val.length]), val);
}

function encode(value: unknown, out: Uint8Array[]): void {
  if (typeof value === "number" && Number.isInteger(value)) {
    if (value >= 0)
      out.push(encodeHead(0, value));
    else
      out.push(encodeHead(1, -1 - value));

    return;
  }

  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    out.push(encodeHead(3, bytes.length));
    out.push(bytes);

    return;
  }

  if (value instanceof Uint8Array) {
    out.push(encodeHead(2, value.length));
    out.push(value);

    return;
  }

  if (Array.isArray(value)) {
    out.push(encodeHead(4, value.length));

    for (const v of value) {
      encode(v, out);
    }

    return;
  }

  if (value instanceof Map) {
    out.push(encodeHead(5, value.size));

    for (const [k, v] of value) {
      encode(k, out);
      encode(v, out);
    }

    return;
  }

  if (value === false) {
    out.push(new Uint8Array([0xf4]));
    return;
  }

  if (value === true) {
    out.push(new Uint8Array([0xf5]));
    return;
  }

  if (value === null) {
    out.push(new Uint8Array([0xf6]));
    return;
  }

  throw new Error(`Unsupported CBOR value: ${typeof value}`);
}

function encodeHead(major: number, n: number): Uint8Array {
  if (n < 24)
    return new Uint8Array([(major << 5) | n]);

  if (n < 0x100)
    return new Uint8Array([(major << 5) | 24, n]);

  if (n < 0x10000)
    return new Uint8Array([(major << 5) | 25, n >> 8, n & 0xff]);

  if (n < 0x100000000) {
    const buf = new Uint8Array(5);
    buf[0] = (major << 5) | 26;
    new DataView(buf.buffer).setUint32(1, n, false);

    return buf;
  }

  throw new Error("integer too large for our test CBOR encoder");
}

function rawToDerEcdsaSignature(raw: Uint8Array): Uint8Array {
  const r = raw.slice(0, 32);
  const s = raw.slice(32);
  const rDer = derInteger(r);
  const sDer = derInteger(s);
  const seqLen = rDer.length + sDer.length;

  return concat(new Uint8Array([0x30, seqLen]), rDer, sDer);
}

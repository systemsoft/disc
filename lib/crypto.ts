/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Shared WebCrypto helpers.
 *
 * Centralizes the SHA-256 / HMAC plumbing that auth/, ext-oauth/,
 * protocol/, and lib/file-storage/ previously each hand-rolled:
 * TextEncoder instantiation, `BufferSource` casts, raw-key import for
 * HMAC, and hex encoding of digests.
 *
 * All helpers accept `Uint8Array | string`; strings are UTF-8 encoded.
 */

/*** IMPORT ------------------------------------------- ***/

import { encodeHex } from "@std/encoding";

/*** PROGRAM ------------------------------------------ ***/

/** Supported HMAC hash algorithms (WebCrypto identifiers). */
export type HmacHash = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

const textEncoder = new TextEncoder();

function toBytes(data: Uint8Array | string): BufferSource {
  return (typeof data === "string" ? textEncoder.encode(data) : data) as BufferSource;
}

/** SHA-256 digest of `data`, as raw bytes. */
export async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(data));
  return new Uint8Array(digest);
}

/** SHA-256 digest of `data`, as a lowercase hex string. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  return encodeHex(await sha256(data));
}

/** HMAC signature of `data` under `key` with the given hash, as raw bytes. */
export async function hmac(
  hash: HmacHash,
  key: Uint8Array | string,
  data: Uint8Array | string
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    toBytes(key),
    { hash, name: "HMAC" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, toBytes(data));
  return new Uint8Array(sig);
}

/** HMAC-SHA-256 signature of `data` under `key`, as raw bytes. */
export function hmacSha256(
  key: Uint8Array | string,
  data: Uint8Array | string
): Promise<Uint8Array> {
  return hmac("SHA-256", key, data);
}

/**
 * Constant-time comparison of two byte arrays: every byte is visited
 * whatever the first mismatch, so timing does not reveal how long a
 * matching prefix was. Unequal lengths compare unequal (the length
 * itself is not hidden — compare digests, not raw secrets, when the
 * secret's length must stay private; see `sha256Equal`).
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Whether two secrets are equal, decided on their SHA-256 digests in
 * constant time. Hashing first means the comparison always runs over
 * 32 bytes, so neither the length of the expected secret nor the
 * position of the first differing byte leaks through timing.
 */
export async function sha256Equal(
  a: Uint8Array | string,
  b: Uint8Array | string
): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([sha256(a), sha256(b)]);
  return constantTimeEqual(digestA, digestB);
}

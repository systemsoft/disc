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

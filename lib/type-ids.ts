/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Stable object type ids. Gel gives every schema type a persistent id (the
 * binary protocol's implicit `__tid__`); Disc stores none, so a type's id is
 * a version 5 UUID of its qualified name (`default::Author`) in Disc's own
 * namespace: the same across restarts and servers, and changed only by
 * renaming the type.
 */

import { crypto } from "@std/crypto";

/*** The namespace of Disc's object type ids. ***/
const DISC_TYPE_ID_NAMESPACE = "45c249b2-3d01-48aa-8e8f-5bdf7ac18ef9";

/*** The id of the object type `qualifiedName` (`default::Author`, `shop::Order`). ***/
export function objectTypeId(qualifiedName: string): string {
  return uuidV5(DISC_TYPE_ID_NAMESPACE, qualifiedName);
}

/*** RFC 9562's name-based UUID (version 5, SHA-1) of `name` in `namespace`. ***/
export function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Uint8Array.from(namespace.replace(/-/g, "").match(/../g)!, hex => parseInt(hex, 16));
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes);
  input.set(nameBytes, namespaceBytes.length);
  const bytes = new Uint8Array(crypto.subtle.digestSync("SHA-1", input)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * BigInt JSON serialization shim.
 *
 * The Postgres driver maps `bigint` (int8) columns to JS `BigInt`. Native
 * `JSON.stringify` throws on BigInt by default, so any query response that
 * carries an `int64` property crashes the HTTP / WebSocket / SSE handler
 * with "Do not know how to serialize a BigInt".
 *
 * Installing `BigInt.prototype.toJSON` once at startup makes every
 * `JSON.stringify` call across the codebase Just Work. We prefer Number
 * when the value fits in `Number.MAX_SAFE_INTEGER` (so most counters and
 * 0/1 booleans round-trip as JSON numbers — unchanged client-side
 * behavior) and fall back to string only for the rare 2^53+ value, which
 * a JSON consumer would otherwise lose precision on anyway.
 *
 * Importing this module triggers the install — keep it side-effecting and
 * import it once at the top of the server entry (`server/server.ts`).
 */

declare global {
  interface BigInt {
    toJSON(): number | string;
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

(BigInt.prototype as unknown as { toJSON(): number | string; }).toJSON = function() {
  const value = this as unknown as bigint;
  if (value >= MIN_SAFE && value <= MAX_SAFE) {
    return Number(value);
  }
  return value.toString();
};

export {};

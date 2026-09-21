/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Driver rows → JSON-safe rows.
 *
 * This is THE place where values PostgreSQL's driver hands back, but JSON has
 * no form for, get their wire representation. Every row a protocol handler
 * puts in a response goes through `normalizeRows`, at the point where
 * `result.rows` becomes response data — so it runs on compiled-query cache
 * hits too, unlike anything keyed on the query AST. A new driver type that
 * needs a wire form (`bytes`/`Uint8Array` → base64) is one more case in
 * `normalizeValue`.
 *
 * int64 (D13): deno-postgres decodes `int8` as `bigint`, which
 * `JSON.stringify` rejects ("Do not know how to serialize a BigInt"). That made
 * a bare insert/update (`RETURNING *`) or `select count(…)` answer HTTP 500
 * after the statement had already run. The wire form matches what the rest of
 * the stack already does for int64: a JSON number while it is exact (what a
 * shape's `jsonb_build_object` yields), a numeric string beyond ±(2^53 − 1)
 * (what the SDK's `parseInt64` / `reviveResponse` turn back into a `bigint`).
 * A large value is never rounded into a number.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/*** Only column values and PostgreSQL arrays are visited: json/jsonb columns arrive already
     JSON-decoded and cannot hold a driver type, so they are passed through by reference. ***/
function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  return value;
}

export function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      out[column] = normalizeValue(value);
    }
    return out;
  });
}

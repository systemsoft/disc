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
 * after the statement had already run. The wire form is Gel's, the one a
 * shape's `jsonb_build_object` yields: a JSON number with every digit. Beyond
 * ±(2^53 − 1) it is written raw (`JSON.rawJSON`), so it is never rounded; the
 * SDK reads such a number as a numeric string, which `parseInt64` /
 * `reviveResponse` turn back into a `bigint`.
 *
 * numeric: `bigint` and `decimal` are PostgreSQL `numeric`, which deno-postgres
 * decodes as its text. By the column's type OID (`columnTypes`) it is written
 * as that text, raw — an exact JSON number, as in a shape and in Gel.
 * (`NaN`/`Infinity`, which JSON has no number for, stay strings.)
 *
 * bytes (D9): deno-postgres decodes `bytea` as `Uint8Array`, which
 * `JSON.stringify` writes as `{"0":31,"1":139,…}`. The wire form is base64
 * (RFC 4648, no line breaks) — the same one a shape renders in SQL and the one
 * the SDK's `parseBytes` decodes. Unshaped rows only: `RETURNING *`, a bare
 * path select, `select <bytes>$p`.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { rawJsonNumber } from "../lib/exact-json.ts";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/*** PostgreSQL type OIDs of `numeric` and `numeric[]`. ***/
const NUMERIC_OIDS = new Set([1700, 1231]);

/*** A numeric column's text (or array of them) as exact JSON numbers. ***/
function numericValue(value: unknown): unknown {
  if (typeof value === "string") {
    return rawJsonNumber(value);
  }
  return Array.isArray(value) ? value.map(numericValue) : value;
}

/*** Only column values and PostgreSQL arrays are visited: json/jsonb columns arrive already
     JSON-decoded and cannot hold a driver type, so they are passed through by reference. ***/
function normalizeValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : rawJsonNumber(value.toString());
  }
  if (value instanceof Uint8Array) {
    return encodeBase64(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeValue);
  }
  return value;
}

export function normalizeRows(rows: Record<string, unknown>[], columnTypes: Record<string, number> = {}): Record<string, unknown>[] {
  return rows.map(row => {
    const out: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      out[column] = NUMERIC_OIDS.has(columnTypes[column]) ? numericValue(value) : normalizeValue(value);
    }
    return out;
  });
}

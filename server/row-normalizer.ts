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
 * `decimal` and `bigint` never hold NaN or ±Infinity (a cast that would make
 * one fails; see `finiteNumeric` in compiler/compiler-expressions.ts).
 *
 * float (`float32`/`float64`): deno-postgres decodes `float4`/`float8` as their
 * text too. By the column's type OID it is written as a JSON number, as in a
 * shape. NaN and ±Infinity, which a float does hold and JSON has no number
 * for, stay the strings "NaN", "Infinity", "-Infinity": PostgreSQL's JSON form
 * (`to_jsonb`), which a shape answers with too, as does Gel's JSON output.
 *
 * bytes (D9): deno-postgres decodes `bytea` as `Uint8Array`, which
 * `JSON.stringify` writes as `{"0":31,"1":139,…}`. The wire form is base64
 * (RFC 4648, no line breaks) — the same one a shape renders in SQL and the one
 * the SDK's `parseBytes` decodes. Unshaped rows only: `RETURNING *`, a bare
 * path select, `select <bytes>$p`.
 *
 * local datetime / local date (`timestamp`, `date`): deno-postgres decodes
 * both as a `Date` in the server's local time zone, which JSON.stringify writes
 * as a UTC instant — a bare insert or update answered `cal::local_date`
 * `2026-01-15` as `2026-01-15T08:00:00.000Z` on a server at UTC−8. By the
 * column's type OID they are written as their wall-clock text instead, as a
 * shape writes them (`2026-01-15T10:20:30`, `2026-01-15`).
 *
 * interval array (`array<duration>` and the `cal::` durations): deno-postgres
 * leaves an `interval[]` as PostgreSQL's array text (`{PT1H,PT-2M}`). By the
 * column's type OID it is written as a JSON array of each element's text, as
 * a shape writes it. Connections use `intervalstyle = iso_8601`
 * (lib/database.ts), whose text never needs quoting in an array.
 */

import { encodeBase64 } from "@std/encoding/base64";
import { rawJsonNumber } from "../lib/exact-json.ts";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/*** PostgreSQL type OIDs of `numeric` and `numeric[]`. ***/
const NUMERIC_OIDS = new Set([1700, 1231]);

/*** PostgreSQL type OIDs of `float4`, `float8`, `float4[]` and `float8[]`. ***/
const FLOAT_OIDS = new Set([700, 701, 1021, 1022]);

/**
 * A float column's text (or array of them) as JSON numbers; NaN and ±Infinity
 * stay strings. deno-postgres decodes `float4` as a number already, which
 * JSON.stringify would write as null when it is not finite.
 */
function floatValue(value: unknown): unknown {
  if (typeof value === "string") {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  return Array.isArray(value) ? value.map(floatValue) : value;
}

/*** A numeric column's text (or array of them) as exact JSON numbers. ***/
function numericValue(value: unknown): unknown {
  if (typeof value === "string") {
    return rawJsonNumber(value);
  }
  return Array.isArray(value) ? value.map(numericValue) : value;
}

/*** PostgreSQL type OIDs of `timestamp` and `timestamp[]` (`cal::local_datetime`). ***/
const TIMESTAMP_OIDS = new Set([1114, 1115]);

/*** PostgreSQL type OIDs of `date` and `date[]` (`cal::local_date`). ***/
const DATE_OIDS = new Set([1082, 1182]);

/*** PostgreSQL type OID of `interval[]`. ***/
const INTERVAL_ARRAY_OID = 1187;

/*** An `interval[]` column's array text (`{PT1H,NULL}`) as an array of its elements' text. ***/
function intervalArrayValue(value: unknown): unknown {
  if (typeof value !== "string" || !value.startsWith("{")) {
    return value;
  }
  const body = value.slice(1, -1);
  return body === "" ? [] : body.split(",").map(element => element === "NULL" ? null : element);
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * A `timestamp` or `date` column (or array of them) as its wall-clock text.
 * deno-postgres decodes both as a `Date` in the server's local time zone (and
 * ±infinity as ±Infinity), which JSON.stringify would write as a UTC instant —
 * another day or hour than the stored one. The local fields give the stored
 * value back, written as a shape writes it (`2026-01-15T10:20:30.5`,
 * `2026-01-15`); the driver keeps milliseconds, so microseconds are lost here.
 */
function localValue(value: unknown, withTime: boolean): unknown {
  if (value instanceof Date) {
    const date = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
    if (!withTime) {
      return date;
    }
    const ms = value.getMilliseconds() === 0 ? "" : `.${pad(value.getMilliseconds(), 3)}`.replace(/0+$/, "");
    return `${date}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}${ms}`;
  }
  if (value === Infinity || value === -Infinity) {
    return value > 0 ? "infinity" : "-infinity";
  }
  return Array.isArray(value) ? value.map(item => localValue(item, withTime)) : value;
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
      const oid = columnTypes[column];
      out[column] = NUMERIC_OIDS.has(oid) ?
        numericValue(value) :
        FLOAT_OIDS.has(oid) ?
        floatValue(value) :
        TIMESTAMP_OIDS.has(oid) || DATE_OIDS.has(oid) ?
        localValue(value, TIMESTAMP_OIDS.has(oid)) :
        oid === INTERVAL_ARRAY_OID ?
        intervalArrayValue(value) :
        normalizeValue(value);
    }
    return out;
  });
}

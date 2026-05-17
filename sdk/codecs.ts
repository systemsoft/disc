/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Wire-format codecs for `Date`, `bigint`, and `Uint8Array`. (P1-29)
 *
 * The Disc HTTP query envelope is plain JSON, so values that have no JSON
 * primitive equivalent — `Date`, `bigint`, byte arrays — arrive as strings:
 *
 *   - `datetime` / `local_datetime` → ISO-8601 string
 *   - `int64` / `bigint`            → numeric string (precision > 2^53)
 *   - `bytes`                       → base64 string
 *
 * Without revival, these survive as strings forever, which is the right
 * default (silent type coercion is worse than visible strings). When
 * callers want richer types, they can:
 *
 *   1. Reach for one helper at known field paths:
 *
 *      ```ts
 *      const u = await client.query<{ created_at: string }>("…");
 *      const createdAt = parseDateTime(u.created_at);
 *      ```
 *
 *   2. Or pass `{ revive: true }` to walk the response and revive every
 *      string that *unambiguously* looks like one of the above:
 *
 *      ```ts
 *      const rows = await client.query<Row[]>("…", undefined, { revive: true });
 *      // rows[0].created_at is now a Date
 *      ```
 *
 *      Auto-revival is conservative: it only matches ISO-8601 with a date
 *      *and* time component, and only converts numeric strings that exceed
 *      `Number.MAX_SAFE_INTEGER`. Plain `"2026-05-05"` and small integers
 *      pass through unchanged.
 *
 *   3. Or use a Standard Schema validator (Zod / Valibot / …) with a
 *      transform — the most explicit and type-safe option.
 */

const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

const NUMERIC_STRING_REGEX = /^-?\d+$/;

/**
 * Parse an ISO-8601 datetime string into a `Date`.
 * Returns `undefined` if the input is not a valid ISO-8601 datetime.
 */
export function parseDateTime(value: string): Date | undefined {
  if (!ISO_DATETIME_REGEX.test(value)) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

/**
 * Parse a numeric string into a `bigint`.
 * Returns `undefined` if the input is not a base-10 integer string.
 */
export function parseInt64(value: string): bigint | undefined {
  if (!NUMERIC_STRING_REGEX.test(value)) {
    return undefined;
  }
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

/**
 * Decode a base64 string into a `Uint8Array`.
 * Returns `undefined` on malformed input.
 */
export function parseBytes(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Encode a `Uint8Array` back into a base64 string for outbound payloads
 * (e.g. variables in `client.query(eql, { blob: encodeBytes(buf) })`).
 */
export function encodeBytes(value: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < value.length; i++) {
    binary += String.fromCharCode(value[i]);
  }
  return btoa(binary);
}

export interface ReviveOptions {
  /** Convert ISO-8601 datetime strings to `Date`. Default: true. */
  dates?: boolean;
  /** Convert numeric strings exceeding `Number.MAX_SAFE_INTEGER` to `bigint`. Default: true. */
  bigints?: boolean;
}

/**
 * Walk `value` recursively and revive strings that unambiguously match a
 * known wire format. Returns a new structure — input is not mutated.
 *
 * Auto-revival deliberately avoids `bytes`: base64 strings collide with
 * arbitrary text too often. Use `parseBytes()` at the call site instead.
 */
export function reviveResponse<T = unknown>(
  value: unknown,
  options: ReviveOptions = {}
): T {
  const dates = options.dates ?? true;
  const bigints = options.bigints ?? true;
  return walk(value, dates, bigints) as T;
}

function walk(value: unknown, dates: boolean, bigints: boolean): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    if (dates && ISO_DATETIME_REGEX.test(value)) {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) {
        return new Date(ms);
      }
    }
    if (bigints && NUMERIC_STRING_REGEX.test(value)) {
      try {
        const big = BigInt(value);
        if (big > Number.MAX_SAFE_INTEGER || big < -Number.MAX_SAFE_INTEGER) {
          return big;
        }
      } catch {
        // fall through to return original string
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => walk(item, dates, bigints));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = walk(v, dates, bigints);
    }
    return out;
  }
  return value;
}

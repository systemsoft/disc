/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * JSON numbers that keep every digit.
 *
 * `bigint`, `decimal` and `int64` values reach JSON with more digits than a
 * double holds (`12345678901234567890`, `0.1000000000000000055511151231257827`,
 * `9007199254740993`). `JSON.parse` rounds them. Here a number that a double
 * cannot hold exactly becomes `JSON.rawJSON(source)` instead: `JSON.stringify`
 * writes its source text back out unchanged, so a value read from PostgreSQL
 * leaves the server with the digits PostgreSQL gave it. Every other number
 * stays a plain JS number.
 *
 * `JSON.rawJSON` and the reviver's `context.source` are ES2026 (JSON.parse
 * source text access); Deno has both, TypeScript's lib does not yet declare
 * them, so they are typed here.
 */

/*** A JSON number: the grammar of RFC 8259. NaN and Infinity are not JSON. ***/
const JSON_NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

const JSON_INTEGER = /^-?\d+$/;

type SourceReviver = (key: string, value: unknown, context?: { source?: string; }) => unknown;

const parseWithSource = JSON.parse as (text: string, reviver: SourceReviver) => unknown;

const { isRawJSON, rawJSON } = JSON as unknown as {
  isRawJSON(value: unknown): value is { rawJSON: string; };
  rawJSON(text: string): unknown;
};

/**
 * A number's value as `<sign><significant digits>e<exponent>`, so `1.50`,
 * `1.5` and `15e-1` compare equal. `null` when `text` is not a JSON number.
 */
function canonicalNumber(text: string): string | null {
  const match = JSON_NUMBER.exec(text);
  if (!match) {
    return null;
  }
  const [, sign, whole, fraction = "", exponent = "0"] = match;
  const digits = (whole + fraction).replace(/^0+/, "");
  const significant = digits.replace(/0+$/, "");
  if (significant === "") {
    return "0";
  }
  const power = Number(exponent) - fraction.length + digits.length - significant.length;
  return `${sign}${significant}e${power}`;
}

/**
 * Whether the double `value`, parsed from the JSON number `source`, holds it
 * exactly: an integer is a safe integer, any other number prints back to the
 * same value (`0.1` does; `0.1000000000000000055511151231257827` does not).
 */
export function isExactNumber(source: string, value: number): boolean {
  if (JSON_INTEGER.test(source)) {
    return Number.isSafeInteger(value);
  }
  const canonical = canonicalNumber(source);
  return canonical !== null && canonical === canonicalNumber(String(value));
}

/**
 * `JSON.rawJSON(text)` when `text` is a JSON number; otherwise `text` itself
 * (`NaN`, `Infinity` — which PostgreSQL's numeric has and JSON does not).
 */
export function rawJsonNumber(text: string): unknown {
  return JSON_NUMBER.test(text) ? rawJSON(text) : text;
}

/*** The source text of a `JSON.rawJSON` value (`"12345678901234567890"`); any other value as is. ***/
export function unwrapRawJson(value: unknown): unknown {
  return isRawJSON(value) ? value.rawJSON : value;
}

/**
 * `JSON.parse`, except a number a double cannot hold exactly becomes
 * `JSON.rawJSON(source)`, which `JSON.stringify` writes back digit for digit.
 */
export function parseExactJson(text: string): unknown {
  return parseWithSource(text, (_key, value, context) => {
    if (typeof value === "number" && context?.source !== undefined && !isExactNumber(context.source, value)) {
      return rawJSON(context.source);
    }
    return value;
  });
}

/*** Whether `value` is, or (in an array) holds, an exact JSON number from `parseExactJson`. ***/
export function hasRawJson(value: unknown): boolean {
  return isRawJSON(value) || (Array.isArray(value) && value.some(hasRawJson));
}

/*** `value` with every exact JSON number replaced by its digits, for binding as a query parameter. ***/
export function unwrapExactNumbers(value: unknown): unknown {
  return Array.isArray(value) ? value.map(unwrapExactNumbers) : unwrapRawJson(value);
}

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * JSON numbers that keep every digit, for `/query` results.
 *
 * The server sends `bigint`, `decimal` and `int64` as exact JSON numbers
 * (`12345678901234567890`, `0.1000000000000000055511151231257827`,
 * `9007199254740993`); `response.json()` rounds them through a double. Here a
 * number whose digits a JS number would print differently becomes an
 * `ExactNumber` holding the text the server sent (so a decimal's `1.50` also
 * shows as `1.50`); every other number stays a plain JS number. Mirrors the
 * server's `lib/exact-json.ts`.
 *
 * Reading a number's source text (the reviver's `context.source`) and
 * writing it back (`JSON.rawJSON`) are ES2026: Chrome 114+, Firefox 135+,
 * Safari 18.4+. Older browsers parse as plain `JSON.parse` does.
 */

/*** UTILITY ------------------------------------------ ***/

type SourceReviver = (key: string, value: unknown, context?: { source?: string; }) => unknown;

const parseWithSource = JSON.parse as (text: string, reviver: SourceReviver) => unknown;
const rawJSON = (JSON as unknown as { rawJSON?: (text: string) => unknown; }).rawJSON;

/*** EXPORT ------------------------------------------- ***/

/**
 * A JSON number kept as the text the server sent. `String()` gives its
 * digits; `JSON.stringify` writes it back as the same JSON number (as a string
 * of its digits where `JSON.rawJSON` is missing, which the server also reads
 * exactly for a typed parameter).
 */
export class ExactNumber {
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
  }

  toJSON(): unknown {
    return rawJSON ? rawJSON(this.#text) : this.#text;
  }

  toString(): string {
    return this.#text;
  }
}

/**
 * `JSON.parse`, except a number a JS number would print differently from its
 * source text becomes an `ExactNumber` of that text.
 */
export function parseExactJson(text: string): unknown {
  return parseWithSource(text, (_key, value, context) => {
    if (typeof value === "number" && context?.source !== undefined && context.source !== String(value))
      return new ExactNumber(context.source);

    return value;
  });
}

/**
 * The value to send for the number typed as `text`: a JS number when it holds
 * `text` exactly, else an `ExactNumber` that goes out digit for digit.
 * Callers validate `text` as a number first.
 */
export function exactNumberValue(text: string): number | ExactNumber {
  const n = Number(text);
  return String(n) === text ? n : new ExactNumber(text);
}

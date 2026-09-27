/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The escapes of a quoted EdgeQL string or bytes literal, as Gel reads them
 * (edgeql-parser `unquote_string` / `unquote_bytes`). Shared by the EdgeQL and
 * SDL lexers, which hand over a literal's body (what is between its quotes).
 *
 * A string reads `\\ \' \" \b \f \n \r \t`, `\xHH` (a non-null ASCII
 * character: a `str` is PostgreSQL text, which holds no NUL), `\uHHHH`,
 * `\UHHHHHHHH`, and a backslash before a line break, which drops the break
 * and the whitespace after it. A bytes literal reads the same, but `\xHH` is
 * any byte and there is no `\u`/`\U`; its other characters must be ASCII.
 * Any other escape is an error, as in Gel.
 */

import { SourceLocation, SyntaxError } from "./errors.ts";

const SIMPLE_ESCAPES: Record<string, string> = {
  "\"": "\"",
  "'": "'",
  "\\": "\\",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t"
};

/*** `ch` as Rust's `escape_debug` writes it in Gel's messages (`\t`, `\n`, …). ***/
function escapeDebug(ch: string): string {
  const named: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", "\\": "\\\\", "'": "\\'", "\"": "\\\"" };
  return named[ch] ?? ch;
}

/*** The body of `\` at `i` in `body` when it is a line continuation: the index after the break and the whitespace that follows it; else -1. ***/
function continuationEnd(body: string, i: number): number {
  const next = body[i + 1];
  if (next !== "\n" && next !== "\r") {
    return -1;
  }
  let end = i + 2;
  while (end < body.length && /\s/.test(body[end])) {
    end++;
  }
  return end;
}

/**
 * The value of a quoted string literal whose body is `body`. `location` is
 * the literal's, where a bad escape is reported (Gel points at the literal).
 */
export function unquoteString(body: string, location: SourceLocation): string {
  const fail = (sequence: string, note = ""): never => {
    throw new SyntaxError(`invalid string literal: invalid escape sequence '\\${sequence}'${note}`, { location });
  };
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const continued = continuationEnd(body, i);
    if (continued >= 0) {
      i = continued;
      continue;
    }
    const next = body[i + 1];
    if (next in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[next];
      i += 2;
    } else if (next === "x") {
      const hex = body.slice(i + 2, i + 4);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        fail(`x${hex}`);
      }
      const code = parseInt(hex, 16);
      if (code === 0 || code > 0x7f) {
        fail(`x${code.toString(16)}`, " (only non-null ascii allowed)");
      }
      out += String.fromCharCode(code);
      i += 4;
    } else if (next === "u" || next === "U") {
      const digits = next === "u" ? 4 : 8;
      const hex = body.slice(i + 2, i + 2 + digits);
      const code = /^[0-9a-fA-F]+$/.test(hex) && hex.length === digits ? parseInt(hex, 16) : -1;
      // A surrogate or a value past U+10FFFF is no character (Rust's `char::from_u32`).
      if (code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        fail(`${next}${hex}`);
      }
      out += String.fromCodePoint(code);
      i += 2 + digits;
    } else {
      fail(escapeDebug(next ?? ""));
    }
  }
  return out;
}

/**
 * The bytes of a `b'…'` literal whose body is `body`, as a binary string (one
 * character per byte, each 0–255). `raw` (`br'…'`) reads no escapes.
 */
export function unquoteBytes(body: string, raw: boolean, location: SourceLocation): string {
  const nonAscii = [...body].find(ch => ch.codePointAt(0)! > 0x7f);
  if (nonAscii !== undefined) {
    throw new SyntaxError(
      `invalid bytes literal: character '${nonAscii}' is unexpected, only ascii chars are allowed in bytes literals`,
      { location }
    );
  }
  if (raw) {
    return body;
  }
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    const continued = continuationEnd(body, i);
    if (continued >= 0) {
      i = continued;
      continue;
    }
    const next = body[i + 1];
    if (next in SIMPLE_ESCAPES) {
      out += SIMPLE_ESCAPES[next];
      i += 2;
    } else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 2, i + 4))) {
      out += String.fromCharCode(parseInt(body.slice(i + 2, i + 4), 16));
      i += 4;
    } else {
      const sequence = next === "x" ? `x${body.slice(i + 2, i + 4)}` : escapeDebug(next ?? "");
      throw new SyntaxError(`invalid bytes literal: invalid escape sequence '\\${sequence}'`, { location });
    }
  }
  return out;
}

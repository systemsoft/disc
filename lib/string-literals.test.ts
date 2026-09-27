/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * String and bytes literal escapes, as Gel 7.1 reads them. Each expected value
 * and error message is what a Gel 7.1 server answers for the same literal.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { EdgeQLLexer } from "../edgeql/lexer.ts";
import { SDLLexer } from "../schema/lexer.ts";
import { TokenType } from "../edgeql/tokens.ts";
import { SyntaxError } from "./errors.ts";

/*** The first token of `source`, lexed as EdgeQL. ***/
function token(source: string): { type: string; value: string; } {
  const [first] = new EdgeQLLexer(source).tokenize();
  return { type: first.type, value: first.value };
}

const str = (value: string) => ({ type: TokenType.STRING, value });
const bytes = (value: string) => ({ type: TokenType.BYTES, value });

Deno.test("string literal escapes are Gel's", () => {
  assertEquals(token(String.raw`'a\x41b'`), str("aAb"));
  assertEquals(token(String.raw`'x\u00e9y\U0001F600'`), str("xéy😀"));
  assertEquals(token(String.raw`'a\bb\fc\n\r\t'`), str("a\bb\fc\n\r\t"));
  assertEquals(token(String.raw`'\\ \' \"'`), str(`\\ ' "`));
  assertEquals(token(String.raw`"a\"b"`), str(`a"b`));
  assertEquals(token("'a\\\n     b'"), str("ab"));
  assertEquals(token("'ab\ncd'"), str("ab\ncd"));
  assertEquals(token(String.raw`'\x7f'`), str("\x7f"));
});

Deno.test("invalid string escapes are Gel's errors", () => {
  const cases: [string, string][] = [
    [String.raw`'\x00'`, String.raw`invalid string literal: invalid escape sequence '\x0' (only non-null ascii allowed)`],
    [String.raw`'\x80'`, String.raw`invalid string literal: invalid escape sequence '\x80' (only non-null ascii allowed)`],
    [String.raw`'caf\xE9'`, String.raw`invalid string literal: invalid escape sequence '\xe9' (only non-null ascii allowed)`],
    [String.raw`'a\x4'`, String.raw`invalid string literal: invalid escape sequence '\x4'`],
    [String.raw`'a\x4g'`, String.raw`invalid string literal: invalid escape sequence '\x4g'`],
    [String.raw`'\u00'`, String.raw`invalid string literal: invalid escape sequence '\u00'`],
    [String.raw`'\ud800'`, String.raw`invalid string literal: invalid escape sequence '\ud800'`],
    [String.raw`'a\qb'`, String.raw`invalid string literal: invalid escape sequence '\q'`],
    [String.raw`'a\$b'`, String.raw`invalid string literal: invalid escape sequence '\$'`]
  ];
  for (const [source, message] of cases) {
    assertThrows(() => token(source), SyntaxError, message, source);
  }
});

Deno.test("raw and dollar-quoted strings read no escapes", () => {
  assertEquals(token(String.raw`r'a\nb'`), str(String.raw`a\nb`));
  assertEquals(token(String.raw`r'a\'`), str("a\\"));
  assertEquals(token("$$a\\nb$$"), str("a\\nb"));
  assertEquals(token("$tag$x$$y$tag$"), str("x$$y"));
  assertThrows(() => token("$1a$x$1a$"), SyntaxError, "dollar quote must not start with a digit");
  assertThrows(() => token("$$"), SyntaxError, "unterminated string started with $$");
  // `$name` is still a parameter.
  assertEquals(token("$name").type, TokenType.PARAMETER);
});

Deno.test("bytes literals hold exact bytes", () => {
  assertEquals(token(String.raw`b'\x00\xff\n'`), bytes("\x00\xff\n"));
  assertEquals(token(String.raw`b"q\"'"`), bytes(`q"'`));
  assertEquals(token("b'a\\\n   b'"), bytes("ab"));
  assertEquals(token(String.raw`br'\x00'`), bytes(String.raw`\x00`));
  assertEquals(token(String.raw`rb'x'`), bytes("x"));
  assertEquals(token(String.raw`br'\'`), bytes("\\"));
  assertEquals(token("b''"), bytes(""));
});

Deno.test("invalid bytes literals are Gel's errors", () => {
  assertThrows(() => token("b'é'"), SyntaxError, "invalid bytes literal: character 'é' is unexpected, only ascii chars are allowed in bytes literals");
  assertThrows(() => token(String.raw`b'\q'`), SyntaxError, String.raw`invalid bytes literal: invalid escape sequence '\q'`);
  assertThrows(() => token(String.raw`b'\u0041'`), SyntaxError, String.raw`invalid bytes literal: invalid escape sequence '\u'`);
  assertThrows(() => token(String.raw`b'\X41'`), SyntaxError, String.raw`invalid bytes literal: invalid escape sequence '\X'`);
});

Deno.test("SDL string literals read the same escapes", () => {
  const [first] = new SDLLexer(String.raw`'a\x41\u00e9\
    b'`)
    .tokenize();
  assertEquals(first.value, "aAéb");
  assertThrows(() => new SDLLexer(String.raw`'\x00'`).tokenize(), SyntaxError, "only non-null ascii allowed");
});

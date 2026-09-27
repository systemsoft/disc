/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * EdgeQL Lexer - Tokenizes EdgeQL source code
 */

import { SourceLocation, SyntaxError } from "../lib/errors.ts";
import { unquoteBytes, unquoteString } from "../lib/string-literals.ts";
import {
  createToken,
  KEYWORDS,
  RESERVED_KEYWORDS,
  Token,
  TokenType
} from "./tokens.ts";

export class EdgeQLLexer {
  private source: string;
  private pos: number = 0;
  private line: number = 1;
  private column: number = 1;
  private tokens: Token[] = [];

  constructor(source: string) {
    this.source = source;
  }

  tokenize(): Token[] {
    while (this.pos < this.source.length) {
      this.skipWhitespaceAndComments();

      if (this.pos >= this.source.length) {
        break;
      }

      const token = this.nextToken();
      if (
        token && token.type !== TokenType.WHITESPACE &&
        token.type !== TokenType.COMMENT
      ) {
        this.tokens.push(token);
      }
    }

    this.tokens.push(createToken(
      TokenType.EOF,
      "",
      this.line,
      this.column,
      this.pos
    ));

    return this.tokens;
  }

  private nextToken(): Token | null {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    const ch = this.peek();

    if (ch === null) {
      return null;
    }

    // Triple-quoted string literals (""" or ''' for multi-line strings).
    // Must be checked BEFORE plain string literals. (P1-06)
    if (
      (ch === "\"" && this.peekAhead(1) === "\"" && this.peekAhead(2) === "\"") ||
      (ch === "'" && this.peekAhead(1) === "'" && this.peekAhead(2) === "'")
    ) {
      return this.scanTripleQuotedString(ch);
    }

    // String literals (single and double quotes)
    if (ch === "\"" || ch === "'") {
      return this.scanString();
    }

    // Raw string literals (r"..." or r'...')
    if (
      ch === "r" && (this.peekAhead(1) === "\"" || this.peekAhead(1) === "'")
    ) {
      return this.scanRawString();
    }

    // Bytes literals (b"...", b'...', and raw br'...' / rb'...')
    const isQuote = (c: string | null): boolean => c === "\"" || c === "'";
    if (
      (ch === "b" && isQuote(this.peekAhead(1))) ||
      (((ch === "b" && this.peekAhead(1) === "r") || (ch === "r" && this.peekAhead(1) === "b")) && isQuote(this.peekAhead(2)))
    ) {
      return this.scanBytesLiteral();
    }

    // Backtick identifiers
    if (ch === "`") {
      return this.scanBacktickIdent();
    }

    // Numbers
    if (this.isDigit(ch)) {
      return this.scanNumber();
    }

    // Identifiers and keywords
    if (this.isIdentStart(ch)) {
      return this.scanIdentOrKeyword();
    }

    // Dollar-quoted strings ($$...$$, $tag$...$tag$), else parameters
    if (ch === "$") {
      return this.scanDollarString() ?? this.scanParameter();
    }

    // Type cast <type>
    if (ch === "<" && this.isIdentStart(this.peekAhead(1))) {
      const lookahead = this.scanTypeCast();
      if (lookahead) {
        return lookahead;
      }
    }

    // Operators and punctuation
    switch (ch) {
      case ":":
        this.advance();
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.ASSIGN,
            ":=",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === ":") {
          this.advance();
          return createToken(
            TokenType.NAMESPACE,
            "::",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.COLON,
          ":",
          startLine,
          startColumn,
          startPos
        );

      case "-":
        this.advance();
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.SUBASSIGN,
            "-=",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === ">") {
          this.advance();
          return createToken(
            TokenType.ARROW,
            "->",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === "|" && this.peekAhead(1) === "-") {
          this.advance(); // consume |
          this.advance(); // consume -
          return createToken(
            TokenType.RANGE_ADJACENT,
            "-|-",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.MINUS,
          "-",
          startLine,
          startColumn,
          startPos
        );

      case "+":
        this.advance();
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.ADDASSIGN,
            "+=",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === "+") {
          this.advance();
          return createToken(
            TokenType.CONCAT,
            "++",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.PLUS,
          "+",
          startLine,
          startColumn,
          startPos
        );

      case "*":
        this.advance();
        if (this.peek() === "*") {
          this.advance();
          return createToken(
            TokenType.POW,
            "**",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.STAR,
          "*",
          startLine,
          startColumn,
          startPos
        );

      case "/":
        this.advance();
        if (this.peek() === "/") {
          this.advance();
          return createToken(
            TokenType.FLOORDIV,
            "//",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.SLASH,
          "/",
          startLine,
          startColumn,
          startPos
        );

      case "?":
        this.advance();
        if (this.peek() === "?") {
          this.advance();
          return createToken(
            TokenType.COALESCE,
            "??",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.NOTDISTINCTFROM,
            "?=",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === "!" && this.peekAhead(1) === "=") {
          this.advance();
          this.advance();
          return createToken(
            TokenType.DISTINCTFROM,
            "?!=",
            startLine,
            startColumn,
            startPos
          );
        }
        throw new SyntaxError(`Unexpected character '?'`, {
          location: { line: startLine, column: startColumn, offset: startPos }
        });

      case ".":
        this.advance();
        if (this.peek() === "<") {
          this.advance();
          return createToken(
            TokenType.BACKLINK,
            ".<",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === "?" && this.peekAhead(1) === ">") {
          this.advance();
          this.advance();
          return createToken(
            TokenType.OPTIONALLINK,
            ".?>",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.DOT,
          ".",
          startLine,
          startColumn,
          startPos
        );

      case "=":
        this.advance();
        return createToken(
          TokenType.EQUALS,
          "=",
          startLine,
          startColumn,
          startPos
        );

      case "!":
        this.advance();
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.NOTEQUALS,
            "!=",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === "~") {
          this.advance();
          if (this.peek() === "*") {
            this.advance();
            return createToken(
              TokenType.REGEX_NOT_IMATCH,
              "!~*",
              startLine,
              startColumn,
              startPos
            );
          }
          return createToken(
            TokenType.REGEX_NOT_MATCH,
            "!~",
            startLine,
            startColumn,
            startPos
          );
        }
        throw new SyntaxError(`Unexpected character '!'`, {
          location: { line: startLine, column: startColumn, offset: startPos }
        });

      case "<":
        this.advance();
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.LESSEQ,
            "<=",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === "<") {
          this.advance();
          return createToken(
            TokenType.LSHIFT,
            "<<",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === "@") {
          this.advance();
          return createToken(
            TokenType.RANGE_CONTAINED_BY,
            "<@",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.LESS,
          "<",
          startLine,
          startColumn,
          startPos
        );

      case ">":
        this.advance();
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.GREATEREQ,
            ">=",
            startLine,
            startColumn,
            startPos
          );
        }
        if (this.peek() === ">") {
          this.advance();
          return createToken(
            TokenType.RSHIFT,
            ">>",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.GREATER,
          ">",
          startLine,
          startColumn,
          startPos
        );

      case ";":
        this.advance();
        return createToken(
          TokenType.SEMICOLON,
          ";",
          startLine,
          startColumn,
          startPos
        );

      case ",":
        this.advance();
        return createToken(
          TokenType.COMMA,
          ",",
          startLine,
          startColumn,
          startPos
        );

      case "(":
        this.advance();
        return createToken(
          TokenType.LPAREN,
          "(",
          startLine,
          startColumn,
          startPos
        );

      case ")":
        this.advance();
        return createToken(
          TokenType.RPAREN,
          ")",
          startLine,
          startColumn,
          startPos
        );

      case "{":
        this.advance();
        return createToken(
          TokenType.LBRACE,
          "{",
          startLine,
          startColumn,
          startPos
        );

      case "}":
        this.advance();
        return createToken(
          TokenType.RBRACE,
          "}",
          startLine,
          startColumn,
          startPos
        );

      case "[":
        this.advance();
        return createToken(
          TokenType.LBRACKET,
          "[",
          startLine,
          startColumn,
          startPos
        );

      case "]":
        this.advance();
        return createToken(
          TokenType.RBRACKET,
          "]",
          startLine,
          startColumn,
          startPos
        );

      case "%":
        this.advance();
        return createToken(
          TokenType.PERCENT,
          "%",
          startLine,
          startColumn,
          startPos
        );

      case "@":
        this.advance();
        if (this.peek() === ">") {
          this.advance();
          return createToken(
            TokenType.RANGE_CONTAINS,
            "@>",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(TokenType.AT, "@", startLine, startColumn, startPos);

      case "&":
        this.advance();
        if (this.peek() === "&") {
          this.advance();
          return createToken(
            TokenType.RANGE_OVERLAPS,
            "&&",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.AMPERSAND,
          "&",
          startLine,
          startColumn,
          startPos
        );

      case "|":
        this.advance();
        return createToken(
          TokenType.PIPE,
          "|",
          startLine,
          startColumn,
          startPos
        );

      case "^":
        this.advance();
        return createToken(
          TokenType.CARET,
          "^",
          startLine,
          startColumn,
          startPos
        );

      case "~":
        this.advance();
        if (this.peek() === "*") {
          this.advance();
          return createToken(
            TokenType.REGEX_IMATCH,
            "~*",
            startLine,
            startColumn,
            startPos
          );
        }
        return createToken(
          TokenType.TILDE,
          "~",
          startLine,
          startColumn,
          startPos
        );

      default:
        throw new SyntaxError(`Unexpected character '${ch}'`, {
          location: { line: startLine, column: startColumn, offset: startPos }
        });
    }
  }

  /**
   * Scan a triple-quoted string (""" or ''').
   *
   * Content is taken verbatim (no escape processing — like Python raw triple
   * strings) up to the closing triple quote of the same kind. Newlines are
   * preserved; this is the preferred form for multi-line query literals.
   * (P1-06)
   */
  private scanTripleQuotedString(quote: string): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip 3 opening quotes
    this.advance();
    this.advance();

    const contentStart = this.pos;

    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (
        ch === quote && this.peekAhead(1) === quote &&
        this.peekAhead(2) === quote
      ) {
        const content = this.source.slice(contentStart, this.pos);
        this.advance();
        this.advance();
        this.advance();
        return createToken(
          TokenType.STRING,
          content,
          startLine,
          startColumn,
          startPos
        );
      }
      this.advance();
    }

    throw new SyntaxError(`Unterminated triple-quoted string literal`, {
      location: { line: startLine, column: startColumn, offset: startPos }
    });
  }

  /**
   * The body of a quoted literal whose opening quote is at the current
   * position: its source text up to the matching closing quote, which is
   * consumed. Unless `raw`, a backslash keeps the character after it in the
   * body (so `\'` does not close it); the escapes are read by
   * `unquoteString` / `unquoteBytes`. A raw literal has no escapes: its first
   * matching quote closes it, as in Gel.
   */
  private scanQuotedBody(kind: string, raw: boolean, location: SourceLocation): string {
    const quote = this.peek();
    this.advance(); // Skip opening quote
    const contentStart = this.pos;

    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === "\\" && !raw) {
        this.advance();
      } else if (ch === quote) {
        const body = this.source.slice(contentStart, this.pos);
        this.advance();
        return body;
      }
      this.advance();
    }

    throw new SyntaxError(`Unterminated ${kind} literal`, { location });
  }

  private scanString(): Token {
    const location = { column: this.column, line: this.line, offset: this.pos };
    const value = unquoteString(this.scanQuotedBody("string", false, location), location);
    return createToken(TokenType.STRING, value, location.line, location.column, location.offset);
  }

  private scanRawString(): Token {
    const location = { column: this.column, line: this.line, offset: this.pos };
    this.advance(); // Skip 'r'
    const value = this.scanQuotedBody("raw string", true, location);
    return createToken(TokenType.STRING, value, location.line, location.column, location.offset);
  }

  /**
   * A dollar-quoted string, `$$…$$` or `$tag$…$tag$`: its content verbatim, as
   * in Gel (and PostgreSQL). Null, with nothing consumed, when the `$` at the
   * current position opens no such quote (it is a parameter).
   */
  private scanDollarString(): Token | null {
    const location = { column: this.column, line: this.line, offset: this.pos };
    const delimiter = /^\$(?:[A-Za-z_0-9]*)?\$/.exec(this.source.slice(this.pos))?.[0];
    if (!delimiter) {
      return null;
    }
    if (this.isDigit(delimiter[1])) {
      throw new SyntaxError(`dollar quote must not start with a digit`, { location });
    }
    const end = this.source.indexOf(delimiter, this.pos + delimiter.length);
    if (end < 0) {
      throw new SyntaxError(`unterminated string started with ${delimiter}`, { location });
    }
    const value = this.source.slice(this.pos + delimiter.length, end);
    while (this.pos < end + delimiter.length) {
      this.advance();
    }
    return createToken(TokenType.STRING, value, location.line, location.column, location.offset);
  }

  /*** A bytes literal, `b'…'`, or raw `br'…'` / `rb'…'`: its bytes, one character per byte (see `unquoteBytes`). ***/
  private scanBytesLiteral(): Token {
    const location = { column: this.column, line: this.line, offset: this.pos };
    const raw = this.peek() === "r" || this.peekAhead(1) === "r";
    this.advance(); // Skip 'b' (or 'r')
    if (raw) {
      this.advance(); // Skip the second prefix letter
    }
    const value = unquoteBytes(this.scanQuotedBody("bytes", raw, location), raw, location);
    return createToken(TokenType.BYTES, value, location.line, location.column, location.offset);
  }

  private scanBacktickIdent(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip opening backtick

    const contentStart = this.pos;

    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === null) {
        throw new SyntaxError(`Unterminated backtick identifier`, {
          location: { line: startLine, column: startColumn, offset: startPos }
        });
      }

      if (ch === "`") {
        const value = this.source.slice(contentStart, this.pos);
        this.advance();
        return createToken(
          TokenType.BACKTICK_IDENT,
          value,
          startLine,
          startColumn,
          startPos
        );
      }

      this.advance();
    }

    throw new SyntaxError(`Unterminated backtick identifier`, {
      location: { line: startLine, column: startColumn, offset: startPos }
    });
  }

  private scanNumber(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    let isFloat = false;

    // Handle negative numbers
    if (this.peek() === "-") {
      this.advance();
    }

    // Scan integer part
    while (this.isDigit(this.peek())) {
      this.advance();
    }

    // Check for decimal point
    if (this.peek() === "." && this.isDigit(this.peekAhead(1))) {
      isFloat = true;
      this.advance();

      while (this.isDigit(this.peek())) {
        this.advance();
      }
    }

    // Check for scientific notation
    const ch = this.peek();
    if (ch === "e" || ch === "E") {
      isFloat = true;
      this.advance();

      const sign = this.peek();
      if (sign === "+" || sign === "-") {
        this.advance();
      }

      if (!this.isDigit(this.peek())) {
        throw new SyntaxError(`Invalid number format`, {
          location: { line: startLine, column: startColumn, offset: startPos }
        });
      }

      while (this.isDigit(this.peek())) {
        this.advance();
      }
    }

    const value = this.source.slice(startPos, this.pos);

    // An 'n' suffix makes an integer a bigint (`10n`) and a float a decimal
    // (`1.5n`, `1e3n`). The token value is the digits without the suffix.
    if (this.peek() === "n") {
      this.advance();
      return createToken(
        isFloat ? TokenType.DECIMAL : TokenType.BIGINT,
        value,
        startLine,
        startColumn,
        startPos
      );
    }

    return createToken(
      isFloat ? TokenType.FLOAT : TokenType.INTEGER,
      value,
      startLine,
      startColumn,
      startPos
    );
  }

  private scanIdentOrKeyword(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    // Handle special built-in names like __source__
    if (this.peek() === "_" && this.peekAhead(1) === "_") {
      while (this.isIdentCont(this.peek()) || this.peek() === "_") {
        this.advance();
      }
    } else {
      while (this.isIdentCont(this.peek())) {
        this.advance();
      }
    }

    const value = this.source.slice(startPos, this.pos);

    // Check if it's a keyword
    const keywordType = KEYWORDS.get(value.toLowerCase());
    if (keywordType) {
      // Special handling for boolean literals
      if (keywordType === TokenType.TRUE || keywordType === TokenType.FALSE) {
        return createToken(
          TokenType.BOOLEAN,
          value.toLowerCase(),
          startLine,
          startColumn,
          startPos
        );
      }
      return createToken(keywordType, value, startLine, startColumn, startPos);
    }

    // Check if it's a reserved keyword that was not in the KEYWORDS map
    if (RESERVED_KEYWORDS.has(value.toLowerCase())) {
      return createToken(
        TokenType.RESERVED_IDENT,
        value,
        startLine,
        startColumn,
        startPos
      );
    }

    return createToken(
      TokenType.IDENT,
      value,
      startLine,
      startColumn,
      startPos
    );
  }

  private scanParameter(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip $

    if (!this.isIdentStart(this.peek()) && !this.isDigit(this.peek())) {
      throw new SyntaxError(`Invalid parameter name`, {
        location: { line: startLine, column: startColumn, offset: startPos }
      });
    }

    while (this.isIdentCont(this.peek()) || this.isDigit(this.peek())) {
      this.advance();
    }

    const value = this.source.slice(startPos, this.pos);

    return createToken(
      TokenType.PARAMETER,
      value,
      startLine,
      startColumn,
      startPos
    );
  }

  private scanTypeCast(): Token | null {
    // Save position in case this isn't a type cast
    const savedPos = this.pos;
    const savedLine = this.line;
    const savedColumn = this.column;

    this.advance(); // Skip <

    // Check if this looks like a type cast
    let depth = 1;
    let foundType = false;

    while (this.pos < this.source.length && depth > 0) {
      const ch = this.peek();

      if (ch === "<") {
        depth++;
      } else if (ch === ">") {
        depth--;
        if (depth === 0) {
          foundType = true;
          break;
        }
      } else if (
        !this.isIdentCont(ch) && ch !== ":" && ch !== " " && ch !== "\t" &&
        ch !== ","
      ) {
        break;
      }

      this.advance();
    }

    // Restore position if not a type cast
    if (!foundType) {
      this.pos = savedPos;
      this.line = savedLine;
      this.column = savedColumn;
      return null;
    }

    // It's a comparison operator, not a type cast
    this.pos = savedPos;
    this.line = savedLine;
    this.column = savedColumn;

    return null;
  }

  private skipWhitespaceAndComments(): void {
    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === " " || ch === "\t" || ch === "\r") {
        this.advance();
      } else if (ch === "\n") {
        this.advance();
      } else if (ch === "#") {
        this.skipComment();
      } else {
        break;
      }
    }
  }

  private skipComment(): void {
    // Skip until end of line
    while (this.pos < this.source.length && this.peek() !== "\n") {
      this.advance();
    }
  }

  private peek(): string | null {
    if (this.pos >= this.source.length) {
      return null;
    }
    return this.source[this.pos];
  }

  private peekAhead(offset: number): string | null {
    const pos = this.pos + offset;
    if (pos >= this.source.length) {
      return null;
    }
    return this.source[pos];
  }

  private advance(): void {
    if (this.pos < this.source.length) {
      if (this.source[this.pos] === "\n") {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      this.pos++;
    }
  }

  private isDigit(ch: string | null): boolean {
    if (ch === null) {
      return false;
    }
    return ch >= "0" && ch <= "9";
  }

  private isIdentStart(ch: string | null): boolean {
    if (ch === null) {
      return false;
    }
    return (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      ch === "_";
  }

  private isIdentCont(ch: string | null): boolean {
    if (ch === null) {
      return false;
    }
    return this.isIdentStart(ch) || this.isDigit(ch);
  }
}

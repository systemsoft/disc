/**
 * SDL Lexer - Tokenizes SDL source code
 */

import { SyntaxError } from "../lib/errors.ts";
import { createToken, KEYWORDS, Token, TokenType } from "./tokens.ts";

export class SDLLexer {
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

    // String literals
    if (ch === "\"" || ch === "'") {
      return this.scanString(ch);
    }

    // Backtick identifiers
    if (ch === "`") {
      return this.scanBacktickIdent();
    }

    // Numbers
    if (this.isDigit(ch)) {
      return this.scanNumber();
    }

    // Raw strings (r"..." or r'...')
    if (
      ch === "r" && (this.peekAhead(1) === "\"" || this.peekAhead(1) === "'")
    ) {
      this.advance(); // consume 'r'
      return this.scanRawString();
    }

    // Identifiers and keywords
    if (this.isIdentStart(ch)) {
      return this.scanIdentOrKeyword();
    }

    // Parameters
    if (ch === "$") {
      return this.scanParameter();
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
            TokenType.DOUBLECOLON,
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
        return createToken(
          TokenType.MINUS,
          "-",
          startLine,
          startColumn,
          startPos
        );

      case "+":
        this.advance();
        if (this.peek() === "+") {
          this.advance();
          return createToken(
            TokenType.PLUSPLUS,
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
        throw new SyntaxError(`Unexpected character '!'`, {
          location: { line: startLine, column: startColumn, offset: startPos }
        });

      case "?":
        this.advance();
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.QUESTIONEQ,
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
            TokenType.QUESTIONNEQ,
            "?!=",
            startLine,
            startColumn,
            startPos
          );
        }
        throw new SyntaxError(`Unexpected character '?'`, {
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

      case ".":
        this.advance();
        return createToken(
          TokenType.DOT,
          ".",
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

      case "*":
        this.advance();
        return createToken(
          TokenType.STAR,
          "*",
          startLine,
          startColumn,
          startPos
        );

      case "/":
        this.advance();
        return createToken(
          TokenType.SLASH,
          "/",
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
        return createToken(TokenType.AT, "@", startLine, startColumn, startPos);

      default:
        throw new SyntaxError(`Unexpected character '${ch}'`, {
          location: { line: startLine, column: startColumn, offset: startPos }
        });
    }
  }

  private scanString(quote: string): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip opening quote

    const parts: string[] = [];
    let runStart = this.pos;
    let escaped = false;

    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === null) {
        throw new SyntaxError(`Unterminated string literal`, {
          location: { line: startLine, column: startColumn, offset: startPos }
        });
      }

      if (escaped) {
        // P2-03: Unicode escape \uXXXX — consume the next 4 hex digits.
        if (ch === "u") {
          this.advance(); // consume the 'u'
          const hex = this.source.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new SyntaxError(
              `Invalid \\u escape — expected 4 hex digits, got ${JSON.stringify(hex)}`,
              {
                location: { line: this.line, column: this.column, offset: this.pos }
              }
            );
          }
          parts.push(String.fromCodePoint(parseInt(hex, 16)));
          for (let i = 0; i < 4; i++)
            this.advance();
          escaped = false;
          runStart = this.pos;
          continue;
        }
        parts.push(this.processEscape(ch));
        escaped = false;
        this.advance();
        runStart = this.pos;
      } else if (ch === "\\") {
        // Flush the plain-text run before the backslash
        if (this.pos > runStart) {
          parts.push(this.source.slice(runStart, this.pos));
        }
        escaped = true;
        this.advance();
      } else if (ch === quote) {
        // Flush the remaining plain-text run
        if (this.pos > runStart) {
          parts.push(this.source.slice(runStart, this.pos));
        }
        this.advance();
        return createToken(
          TokenType.STRING,
          parts.join(""),
          startLine,
          startColumn,
          startPos
        );
      } else {
        this.advance();
      }
    }

    throw new SyntaxError(`Unterminated string literal`, {
      location: { line: startLine, column: startColumn, offset: startPos }
    });
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

  private scanRawString(): Token {
    const startPos = this.pos - 1; // Account for already consumed 'r'
    const startLine = this.line;
    const startColumn = this.column - 1;

    const quote = this.peek();
    if (!quote || (quote !== "\"" && quote !== "'")) {
      throw new SyntaxError(`Expected quote after 'r'`, {
        location: { line: startLine, column: startColumn, offset: startPos }
      });
    }

    this.advance(); // Skip opening quote

    const contentStart = this.pos;

    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === null) {
        throw new SyntaxError(`Unterminated raw string literal`, {
          location: { line: startLine, column: startColumn, offset: startPos }
        });
      }

      if (ch === quote) {
        const value = this.source.slice(contentStart, this.pos);
        this.advance();
        return createToken(
          TokenType.STRING,
          value,
          startLine,
          startColumn,
          startPos
        );
      }

      this.advance();
    }

    throw new SyntaxError(`Unterminated raw string literal`, {
      location: { line: startLine, column: startColumn, offset: startPos }
    });
  }

  private scanNumber(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    let isFloat = false;

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

    while (this.isIdentCont(this.peek())) {
      this.advance();
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

    if (!this.isIdentStart(this.peek())) {
      throw new SyntaxError(`Invalid parameter name`, {
        location: { line: startLine, column: startColumn, offset: startPos }
      });
    }

    while (this.isIdentCont(this.peek())) {
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

  private processEscape(ch: string): string {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "\\":
        return "\\";
      case "\"":
        return "\"";
      case "'":
        return "'";
      default:
        return ch;
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
    if (ch === null)
      return false;
    return ch >= "0" && ch <= "9";
  }

  private isIdentStart(ch: string | null): boolean {
    if (ch === null)
      return false;
    // ASCII fast-path
    if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      ch === "_"
    ) {
      return true;
    }
    // P2-04: accept Unicode letters for identifiers (\p{L}). Keeps
    // SDL writable in non-ASCII locales. Digits are still ASCII-only
    // in the "start" position to avoid parser ambiguity with numbers.
    return /\p{L}/u.test(ch);
  }

  private isIdentCont(ch: string | null): boolean {
    if (ch === null)
      return false;
    // P2-04: identifier continuation allows letters, digits, and
    // Unicode marks (combining chars like accents).
    return this.isIdentStart(ch) || this.isDigit(ch) || /\p{M}/u.test(ch);
  }
}

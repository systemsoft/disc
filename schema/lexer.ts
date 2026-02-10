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
      this.pos,
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
    if (ch === '"' || ch === "'") {
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
            startPos,
          );
        }
        if (this.peek() === ":") {
          this.advance();
          return createToken(
            TokenType.DOUBLECOLON,
            "::",
            startLine,
            startColumn,
            startPos,
          );
        }
        return createToken(
          TokenType.COLON,
          ":",
          startLine,
          startColumn,
          startPos,
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
            startPos,
          );
        }
        return createToken(
          TokenType.MINUS,
          "-",
          startLine,
          startColumn,
          startPos,
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
            startPos,
          );
        }
        return createToken(
          TokenType.PLUS,
          "+",
          startLine,
          startColumn,
          startPos,
        );

      case "=":
        this.advance();
        return createToken(
          TokenType.EQUALS,
          "=",
          startLine,
          startColumn,
          startPos,
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
            startPos,
          );
        }
        throw new SyntaxError(`Unexpected character '!'`, {
          location: { line: startLine, column: startColumn, offset: startPos },
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
            startPos,
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
            startPos,
          );
        }
        throw new SyntaxError(`Unexpected character '?'`, {
          location: { line: startLine, column: startColumn, offset: startPos },
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
            startPos,
          );
        }
        return createToken(
          TokenType.LESS,
          "<",
          startLine,
          startColumn,
          startPos,
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
            startPos,
          );
        }
        return createToken(
          TokenType.GREATER,
          ">",
          startLine,
          startColumn,
          startPos,
        );

      case ";":
        this.advance();
        return createToken(
          TokenType.SEMICOLON,
          ";",
          startLine,
          startColumn,
          startPos,
        );

      case ",":
        this.advance();
        return createToken(
          TokenType.COMMA,
          ",",
          startLine,
          startColumn,
          startPos,
        );

      case ".":
        this.advance();
        return createToken(
          TokenType.DOT,
          ".",
          startLine,
          startColumn,
          startPos,
        );

      case "(":
        this.advance();
        return createToken(
          TokenType.LPAREN,
          "(",
          startLine,
          startColumn,
          startPos,
        );

      case ")":
        this.advance();
        return createToken(
          TokenType.RPAREN,
          ")",
          startLine,
          startColumn,
          startPos,
        );

      case "{":
        this.advance();
        return createToken(
          TokenType.LBRACE,
          "{",
          startLine,
          startColumn,
          startPos,
        );

      case "}":
        this.advance();
        return createToken(
          TokenType.RBRACE,
          "}",
          startLine,
          startColumn,
          startPos,
        );

      case "[":
        this.advance();
        return createToken(
          TokenType.LBRACKET,
          "[",
          startLine,
          startColumn,
          startPos,
        );

      case "]":
        this.advance();
        return createToken(
          TokenType.RBRACKET,
          "]",
          startLine,
          startColumn,
          startPos,
        );

      case "*":
        this.advance();
        return createToken(
          TokenType.STAR,
          "*",
          startLine,
          startColumn,
          startPos,
        );

      case "/":
        this.advance();
        return createToken(
          TokenType.SLASH,
          "/",
          startLine,
          startColumn,
          startPos,
        );

      case "%":
        this.advance();
        return createToken(
          TokenType.PERCENT,
          "%",
          startLine,
          startColumn,
          startPos,
        );

      case "@":
        this.advance();
        return createToken(TokenType.AT, "@", startLine, startColumn, startPos);

      default:
        throw new SyntaxError(`Unexpected character '${ch}'`, {
          location: { line: startLine, column: startColumn, offset: startPos },
        });
    }
  }

  private scanString(quote: string): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip opening quote

    let value = "";
    let escaped = false;

    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === null) {
        throw new SyntaxError(`Unterminated string literal`, {
          location: { line: startLine, column: startColumn, offset: startPos },
        });
      }

      if (escaped) {
        value += this.processEscape(ch);
        escaped = false;
        this.advance();
      } else if (ch === "\\") {
        escaped = true;
        this.advance();
      } else if (ch === quote) {
        this.advance();
        return createToken(
          TokenType.STRING,
          value,
          startLine,
          startColumn,
          startPos,
        );
      } else {
        value += ch;
        this.advance();
      }
    }

    throw new SyntaxError(`Unterminated string literal`, {
      location: { line: startLine, column: startColumn, offset: startPos },
    });
  }

  private scanBacktickIdent(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip opening backtick

    let value = "";

    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === null) {
        throw new SyntaxError(`Unterminated backtick identifier`, {
          location: { line: startLine, column: startColumn, offset: startPos },
        });
      }

      if (ch === "`") {
        this.advance();
        return createToken(
          TokenType.BACKTICK_IDENT,
          value,
          startLine,
          startColumn,
          startPos,
        );
      }

      value += ch;
      this.advance();
    }

    throw new SyntaxError(`Unterminated backtick identifier`, {
      location: { line: startLine, column: startColumn, offset: startPos },
    });
  }

  private scanNumber(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    let value = "";
    let isFloat = false;

    // Scan integer part
    while (this.isDigit(this.peek())) {
      value += this.peek();
      this.advance();
    }

    // Check for decimal point
    if (this.peek() === "." && this.isDigit(this.peekAhead(1))) {
      isFloat = true;
      value += ".";
      this.advance();

      while (this.isDigit(this.peek())) {
        value += this.peek();
        this.advance();
      }
    }

    // Check for scientific notation
    const ch = this.peek();
    if (ch === "e" || ch === "E") {
      isFloat = true;
      value += ch;
      this.advance();

      const sign = this.peek();
      if (sign === "+" || sign === "-") {
        value += sign;
        this.advance();
      }

      if (!this.isDigit(this.peek())) {
        throw new SyntaxError(`Invalid number format`, {
          location: { line: startLine, column: startColumn, offset: startPos },
        });
      }

      while (this.isDigit(this.peek())) {
        value += this.peek();
        this.advance();
      }
    }

    return createToken(
      isFloat ? TokenType.FLOAT : TokenType.INTEGER,
      value,
      startLine,
      startColumn,
      startPos,
    );
  }

  private scanIdentOrKeyword(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    let value = "";

    while (this.isIdentCont(this.peek())) {
      value += this.peek();
      this.advance();
    }

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
          startPos,
        );
      }
      return createToken(keywordType, value, startLine, startColumn, startPos);
    }

    return createToken(
      TokenType.IDENT,
      value,
      startLine,
      startColumn,
      startPos,
    );
  }

  private scanParameter(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip $

    let value = "$";

    if (!this.isIdentStart(this.peek())) {
      throw new SyntaxError(`Invalid parameter name`, {
        location: { line: startLine, column: startColumn, offset: startPos },
      });
    }

    while (this.isIdentCont(this.peek())) {
      value += this.peek();
      this.advance();
    }

    return createToken(
      TokenType.PARAMETER,
      value,
      startLine,
      startColumn,
      startPos,
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
      case '"':
        return '"';
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
    if (ch === null) return false;
    return ch >= "0" && ch <= "9";
  }

  private isIdentStart(ch: string | null): boolean {
    if (ch === null) return false;
    return (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      ch === "_";
  }

  private isIdentCont(ch: string | null): boolean {
    if (ch === null) return false;
    return this.isIdentStart(ch) || this.isDigit(ch);
  }
}

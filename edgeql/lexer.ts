/**
 * EdgeQL Lexer - Tokenizes EdgeQL source code
 */

import { SyntaxError } from "../lib/errors.ts";
import {
  createToken,
  KEYWORDS,
  RESERVED_KEYWORDS,
  Token,
  TokenType,
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

    // String literals (single and double quotes)
    if (ch === '"' || ch === "'") {
      return this.scanString(ch);
    }

    // Raw string literals (r"..." or r'...')
    if (
      ch === "r" && (this.peekAhead(1) === '"' || this.peekAhead(1) === "'")
    ) {
      return this.scanRawString();
    }

    // Bytes literals (b"..." or b'...')
    if (
      ch === "b" && (this.peekAhead(1) === '"' || this.peekAhead(1) === "'")
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

    // Parameters
    if (ch === "$") {
      return this.scanParameter();
    }

    // Type cast <type>
    if (ch === "<" && this.isIdentStart(this.peekAhead(1))) {
      const lookahead = this.scanTypeCast();
      if (lookahead) return lookahead;
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
            TokenType.NAMESPACE,
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
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.SUBASSIGN,
            "-=",
            startLine,
            startColumn,
            startPos,
          );
        }
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
        if (this.peek() === "|" && this.peekAhead(1) === "-") {
          this.advance(); // consume |
          this.advance(); // consume -
          return createToken(
            TokenType.RANGE_ADJACENT,
            "-|-",
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
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.ADDASSIGN,
            "+=",
            startLine,
            startColumn,
            startPos,
          );
        }
        if (this.peek() === "+") {
          this.advance();
          return createToken(
            TokenType.CONCAT,
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

      case "*":
        this.advance();
        if (this.peek() === "*") {
          this.advance();
          return createToken(
            TokenType.POW,
            "**",
            startLine,
            startColumn,
            startPos,
          );
        }
        return createToken(
          TokenType.STAR,
          "*",
          startLine,
          startColumn,
          startPos,
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
            startPos,
          );
        }
        return createToken(
          TokenType.SLASH,
          "/",
          startLine,
          startColumn,
          startPos,
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
            startPos,
          );
        }
        if (this.peek() === "=") {
          this.advance();
          return createToken(
            TokenType.NOTDISTINCTFROM,
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
            TokenType.DISTINCTFROM,
            "?!=",
            startLine,
            startColumn,
            startPos,
          );
        }
        throw new SyntaxError(`Unexpected character '?'`, {
          location: { line: startLine, column: startColumn, offset: startPos },
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
            startPos,
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
            startPos,
          );
        }
        return createToken(
          TokenType.DOT,
          ".",
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
        if (this.peek() === "~") {
          this.advance();
          if (this.peek() === "*") {
            this.advance();
            return createToken(
              TokenType.REGEX_NOT_IMATCH,
              "!~*",
              startLine,
              startColumn,
              startPos,
            );
          }
          return createToken(
            TokenType.REGEX_NOT_MATCH,
            "!~",
            startLine,
            startColumn,
            startPos,
          );
        }
        throw new SyntaxError(`Unexpected character '!'`, {
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
        if (this.peek() === "<") {
          this.advance();
          return createToken(
            TokenType.LSHIFT,
            "<<",
            startLine,
            startColumn,
            startPos,
          );
        }
        if (this.peek() === "@") {
          this.advance();
          return createToken(
            TokenType.RANGE_CONTAINED_BY,
            "<@",
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
        if (this.peek() === ">") {
          this.advance();
          return createToken(
            TokenType.RSHIFT,
            ">>",
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
        if (this.peek() === ">") {
          this.advance();
          return createToken(
            TokenType.RANGE_CONTAINS,
            "@>",
            startLine,
            startColumn,
            startPos,
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
            startPos,
          );
        }
        return createToken(
          TokenType.AMPERSAND,
          "&",
          startLine,
          startColumn,
          startPos,
        );

      case "|":
        this.advance();
        return createToken(
          TokenType.PIPE,
          "|",
          startLine,
          startColumn,
          startPos,
        );

      case "^":
        this.advance();
        return createToken(
          TokenType.CARET,
          "^",
          startLine,
          startColumn,
          startPos,
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
            startPos,
          );
        }
        return createToken(
          TokenType.TILDE,
          "~",
          startLine,
          startColumn,
          startPos,
        );

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

    const parts: string[] = [];
    let runStart = this.pos;
    let escaped = false;

    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === null) {
        throw new SyntaxError(`Unterminated string literal`, {
          location: { line: startLine, column: startColumn, offset: startPos },
        });
      }

      if (escaped) {
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
          startPos,
        );
      } else {
        this.advance();
      }
    }

    throw new SyntaxError(`Unterminated string literal`, {
      location: { line: startLine, column: startColumn, offset: startPos },
    });
  }

  private scanRawString(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip 'r'
    const quote = this.peek();
    this.advance(); // Skip quote

    const contentStart = this.pos;

    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === null) {
        throw new SyntaxError(`Unterminated raw string literal`, {
          location: { line: startLine, column: startColumn, offset: startPos },
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
          startPos,
        );
      }

      this.advance();
    }

    throw new SyntaxError(`Unterminated raw string literal`, {
      location: { line: startLine, column: startColumn, offset: startPos },
    });
  }

  private scanBytesLiteral(): Token {
    const startPos = this.pos;
    const startLine = this.line;
    const startColumn = this.column;

    this.advance(); // Skip 'b'
    const quote = this.peek();
    this.advance(); // Skip quote

    const parts: string[] = [];
    let runStart = this.pos;
    let escaped = false;

    while (this.pos < this.source.length) {
      const ch = this.peek();

      if (ch === null) {
        throw new SyntaxError(`Unterminated bytes literal`, {
          location: { line: startLine, column: startColumn, offset: startPos },
        });
      }

      if (escaped) {
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
          TokenType.BYTES,
          parts.join(""),
          startLine,
          startColumn,
          startPos,
        );
      } else {
        this.advance();
      }
    }

    throw new SyntaxError(`Unterminated bytes literal`, {
      location: { line: startLine, column: startColumn, offset: startPos },
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
          location: { line: startLine, column: startColumn, offset: startPos },
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
          startPos,
        );
      }

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
          location: { line: startLine, column: startColumn, offset: startPos },
        });
      }

      while (this.isDigit(this.peek())) {
        this.advance();
      }
    }

    // Check for 'n' suffix (bigint)
    if (this.peek() === "n" && !isFloat) {
      this.advance();
    }

    const value = this.source.slice(startPos, this.pos);

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
          startPos,
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
        startPos,
      );
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

    if (!this.isIdentStart(this.peek()) && !this.isDigit(this.peek())) {
      throw new SyntaxError(`Invalid parameter name`, {
        location: { line: startLine, column: startColumn, offset: startPos },
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
      startPos,
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
      case "x": // Hex escape
      case "u": // Unicode escape
      case "U": // Unicode escape
        // Simplified for now
        return ch;
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

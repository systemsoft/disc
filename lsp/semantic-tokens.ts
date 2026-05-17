/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Semantic-tokens provider (LSP Phase 8c)
 *
 * Maps SDLLexer tokens to LSP semantic-token categories so editors
 * can render keywords / types / properties / strings / numbers /
 * comments with consistent colors regardless of their TextMate or
 * tree-sitter grammar.
 *
 * The encoded data follows the LSP delta format: groups of 5 ints
 * per token —
 *   [deltaLine, deltaStart, length, tokenTypeIdx, tokenModifierBitset]
 * `deltaStart` is column-relative when `deltaLine === 0`, absolute
 * otherwise. Tokens MUST be in document order.
 *
 * Punctuation and braces are deliberately not emitted — those are
 * handled cheaply by the editor's TextMate grammar; semantic tokens
 * are reserved for the categories where lexer knowledge wins
 * (keywords, identifier kinds, strings).
 */

import { SDLLexer } from "../schema/lexer.ts";
import { TokenType, type Token } from "../schema/tokens.ts";

export const SEMANTIC_TOKEN_TYPES = [
  "keyword",
  "type",
  "property",
  "string",
  "number",
  "comment",
  "operator"
] as const;

export const SEMANTIC_TOKEN_LEGEND = {
  tokenTypes: SEMANTIC_TOKEN_TYPES,
  tokenModifiers: [] as readonly string[]
};

type SemanticType = typeof SEMANTIC_TOKEN_TYPES[number];

export interface SemanticTokensResult {
  data: number[];
}

/**
 * Categorize a single SDL lexer token into a semantic-token type, or
 * `null` if the token is not worth emitting (whitespace, punctuation,
 * EOF, etc.).
 */
function categorize(tok: Token): SemanticType | null {
  switch (tok.type) {
    case TokenType.STRING:
      return "string";
    case TokenType.INTEGER:
    case TokenType.FLOAT:
      return "number";
    case TokenType.COMMENT:
      return "comment";
    case TokenType.IDENT:
    case TokenType.BACKTICK_IDENT: {
      // SDL convention: type names are PascalCase, properties/links
      // are camelCase. The first letter's case is a strong-enough
      // signal for v1.
      const first = tok.value[0];
      if (first >= "A" && first <= "Z") {
        return "type";
      }
      return "property";
    }
    // Whitespace / newlines / EOF / punctuation aren't useful semantic
    // categories — let the editor's grammar color them.
    case TokenType.WHITESPACE:
    case TokenType.NEWLINE:
    case TokenType.EOF:
    case TokenType.LBRACE:
    case TokenType.RBRACE:
    case TokenType.LPAREN:
    case TokenType.RPAREN:
    case TokenType.LBRACKET:
    case TokenType.RBRACKET:
    case TokenType.LANGLE:
    case TokenType.RANGLE:
    case TokenType.COMMA:
    case TokenType.SEMICOLON:
    case TokenType.COLON:
    case TokenType.DOT:
    case TokenType.AT:
      return null;
    default:
      // Every other TokenType is a keyword (MODULE, TYPE, REQUIRED, …).
      return "keyword";
  }
}

const TYPE_TO_INDEX: ReadonlyMap<SemanticType, number> = new Map(
  SEMANTIC_TOKEN_TYPES.map((t, i) => [t, i] as const)
);

export function provideSemanticTokens(text: string): SemanticTokensResult {
  if (text.length === 0) {
    return { data: [] };
  }

  let tokens: Token[];
  try {
    tokens = new SDLLexer(text).tokenize();
  } catch {
    // Lexer failure → no semantic tokens; the diagnostics provider
    // surfaces the parse error separately.
    return { data: [] };
  }

  const data: number[] = [];
  let prevLine = 0;
  let prevStart = 0;

  for (const tok of tokens) {
    const cat = categorize(tok);
    if (cat === null) {
      continue;
    }
    // Lexer positions are 1-indexed; LSP positions are 0-indexed.
    const line = Math.max(0, tok.line - 1);
    const startCol = Math.max(0, tok.column - 1);
    // STRING tokens carry their content without the surrounding
    // quotes (e.g. `"hello"` → tok.value = "hello"), so add 2 chars
    // for the quote pair to get the actual highlight length. Same
    // would apply to BACKTICK_IDENT but that already counts the
    // backticks in `tok.value`.
    const length = cat === "string" ? tok.value.length + 2 : tok.value.length;
    if (length === 0) {
      continue;
    }

    const deltaLine = line - prevLine;
    const deltaStart = deltaLine === 0 ? startCol - prevStart : startCol;
    if (deltaLine < 0 || deltaStart < 0) {
      // Out-of-order token — skip rather than emit invalid LSP data.
      continue;
    }

    data.push(deltaLine, deltaStart, length, TYPE_TO_INDEX.get(cat)!, 0);
    prevLine = line;
    prevStart = startCol;
  }

  return { data };
}

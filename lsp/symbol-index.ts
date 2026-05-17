/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Symbol index (#7411 + #655 — Phase 3)
 *
 * Re-tokenises the SDL source and records each top-level type
 * declaration plus its members along with their LSP `Range` so
 * go-to-definition and document-symbol providers can map names to
 * source locations. The parser itself doesn't populate AST spans, so
 * a token-level scan is the simplest source of truth.
 *
 * The index is conservative: it only emits names it's confident about
 * (those preceded by `type`, `scalar type`, `link`, `property`).
 * Malformed input is tolerated — the lexer is lenient and we just
 * skip the rest of a member when its shape doesn't match.
 */

import { SDLLexer } from "../schema/lexer.ts";
import { TokenType, type Token } from "../schema/tokens.ts";
import type { Range } from "./protocol.ts";

export type TypeKind = "object" | "abstract" | "scalar" | "enum";

export interface MemberSymbol {
  name: string;
  kind: "property" | "link";
  range: Range;
}

export interface TypeSymbol {
  name: string;
  kind: TypeKind;
  /** Range of the type's name identifier (selection range). */
  range: Range;
  /** Range covering the entire type block, name through closing brace. */
  fullRange: Range;
  members: MemberSymbol[];
}

export interface SymbolIndex {
  types: Map<string, TypeSymbol>;
}

export function buildSymbolIndex(text: string): SymbolIndex {
  const types = new Map<string, TypeSymbol>();
  if (text.length === 0) {
    return { types };
  }

  let tokens: Token[];
  try {
    tokens = new SDLLexer(text).tokenize().filter(t => t.type !== TokenType.WHITESPACE && t.type !== TokenType.COMMENT);
  } catch {
    return { types };
  }

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i];
    // Match `[abstract] type <Name>` or `scalar type <Name>`
    if (
      matchesKeyword(tok, "type") || matchesKeyword(tok, "abstract") ||
      matchesKeyword(tok, "scalar")
    ) {
      const consumed = tryReadTypeDecl(tokens, i, text);
      if (consumed) {
        types.set(consumed.symbol.name, consumed.symbol);
        i = consumed.nextIndex;
        continue;
      }
    }
    i++;
  }

  return { types };
}

interface ConsumedDecl {
  symbol: TypeSymbol;
  nextIndex: number;
}

function tryReadTypeDecl(
  tokens: Token[],
  start: number,
  _text: string
): ConsumedDecl | null {
  let i = start;
  let kind: TypeKind = "object";

  // Optional `abstract`
  if (matchesKeyword(tokens[i], "abstract")) {
    kind = "abstract";
    i++;
  }
  // Optional `scalar` — when present, expect `type` next.
  if (matchesKeyword(tokens[i], "scalar")) {
    kind = "scalar";
    i++;
  }
  // Required `type`
  if (!matchesKeyword(tokens[i], "type")) {
    return null;
  }
  i++;
  // Required identifier
  const nameTok = tokens[i];
  if (!nameTok || nameTok.type !== TokenType.IDENT) {
    return null;
  }
  i++;

  const nameRange = tokenRange(nameTok);

  // For object types, look for `{ ... }` and scan members. For scalar
  // types, the body is `extending enum<...>` or constraints — we don't
  // surface members for them.
  const members: MemberSymbol[] = [];
  let endTok: Token = nameTok;

  if (kind !== "scalar") {
    // Skip `extending Foo, Bar` if present
    if (matchesKeyword(tokens[i], "extending")) {
      i++;
      while (i < tokens.length && tokens[i].type === TokenType.IDENT) {
        i++;
        if (tokens[i]?.type === TokenType.COMMA) {
          i++;
        } else {
          break;
        }
        // Allow qualified names (Foo::Bar)
        if (tokens[i]?.type === TokenType.DOUBLECOLON) {
          i++;
          if (tokens[i]?.type === TokenType.IDENT) {
            i++;
          }
        }
      }
    }

    // Expect `{` to enter body
    if (tokens[i]?.type === TokenType.LBRACE) {
      i++;
      // Walk to matching `}`, recording top-level members.
      let depth = 1;
      while (i < tokens.length && depth > 0) {
        const t = tokens[i];
        if (t.type === TokenType.LBRACE) {
          depth++;
          i++;
          continue;
        }
        if (t.type === TokenType.RBRACE) {
          depth--;
          endTok = t;
          i++;
          continue;
        }
        if (depth === 1) {
          // Member detection at the immediate body level.
          const memberConsumed = tryReadMember(tokens, i);
          if (memberConsumed) {
            members.push(memberConsumed.symbol);
            i = memberConsumed.nextIndex;
            continue;
          }
        }
        i++;
      }
    } else {
      // No body — bare `type Foo;`
      endTok = nameTok;
    }
  } else {
    // Scalar type — advance to end of statement (`;`) or end of stream.
    while (i < tokens.length && tokens[i].type !== TokenType.SEMICOLON) {
      endTok = tokens[i];
      i++;
    }
    if (tokens[i]?.type === TokenType.SEMICOLON) {
      endTok = tokens[i];
      i++;
    }
  }

  const fullRange: Range = {
    start: nameRange.start,
    end: tokenRange(endTok).end
  };

  // Suppress duplicate scalar runs that the lexer might emit when source is messy.
  return {
    symbol: {
      name: nameTok.value,
      kind,
      range: nameRange,
      fullRange,
      members
    },
    nextIndex: i
  };
}

interface ConsumedMember {
  symbol: MemberSymbol;
  nextIndex: number;
}

function tryReadMember(tokens: Token[], start: number): ConsumedMember | null {
  let i = start;
  // Skip qualifiers `required`, `multi`, `readonly`, `overloaded`
  while (
    matchesKeyword(tokens[i], "required") ||
    matchesKeyword(tokens[i], "multi") ||
    matchesKeyword(tokens[i], "readonly") ||
    matchesKeyword(tokens[i], "overloaded")
  ) {
    i++;
  }

  let memberKind: "property" | "link" = "property";
  if (matchesKeyword(tokens[i], "link")) {
    memberKind = "link";
    i++;
  } else if (matchesKeyword(tokens[i], "property")) {
    i++;
  }

  const nameTok = tokens[i];
  if (!nameTok || nameTok.type !== TokenType.IDENT) {
    return null;
  }
  // Peek ahead to confirm this is actually a member (next should be `:` or `->`)
  const afterName = tokens[i + 1];
  if (
    afterName?.type !== TokenType.COLON &&
    afterName?.type !== TokenType.ARROW &&
    afterName?.type !== TokenType.ASSIGN
  ) {
    return null;
  }

  return {
    symbol: {
      name: nameTok.value,
      kind: memberKind,
      range: tokenRange(nameTok)
    },
    nextIndex: i + 1
  };
}

function matchesKeyword(tok: Token | undefined, keyword: string): boolean {
  if (!tok) {
    return false;
  }
  // Some keywords are their own TokenType (e.g. TYPE), others arrive
  // as IDENT depending on the lexer table. Match by value either way.
  return tok.value === keyword;
}

function tokenRange(tok: Token): Range {
  // Lexer is 1-indexed; LSP is 0-indexed.
  const startLine = Math.max(0, tok.line - 1);
  const startChar = Math.max(0, tok.column - 1);
  return {
    start: { line: startLine, character: startChar },
    end: { line: startLine, character: startChar + tok.value.length }
  };
}

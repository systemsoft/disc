/**
 * Find-references provider (#7411 + #655 — Phase 4)
 *
 * Returns every range in the document where a given type identifier
 * appears. Uses the symbol index to bound the search to known type
 * names — looking up a property name (`name`, `email`) returns nothing
 * because they're not in the type index, and we don't try to track
 * property scopes yet.
 */

import { SDLLexer } from "../schema/lexer.ts";
import { type Token, TokenType } from "../schema/tokens.ts";
import { buildSymbolIndex } from "./symbol-index.ts";
import type {
  DocumentUri,
  Location,
  Position,
  Range,
} from "./protocol.ts";

const IDENT = /[A-Za-z_][A-Za-z_0-9]*/g;

export function provideReferences(
  text: string,
  pos: Position,
  uri: DocumentUri,
  options: { includeDeclaration?: boolean } = {},
): Location[] {
  const word = wordAt(text, pos);
  if (!word) return [];

  // Only resolve type-name references for now. Property/link references
  // need scope tracking which Phase 4 doesn't tackle.
  const idx = buildSymbolIndex(text);
  const decl = idx.types.get(word);
  if (!decl) return [];

  const includeDecl = options.includeDeclaration ?? true;

  let tokens: Token[];
  try {
    tokens = new SDLLexer(text).tokenize();
  } catch {
    return [];
  }

  const out: Location[] = [];
  const declStart = decl.range.start;
  for (const tok of tokens) {
    if (tok.type !== TokenType.IDENT) continue;
    if (tok.value !== word) continue;
    const range = tokenRange(tok);
    const isDeclSite = range.start.line === declStart.line &&
      range.start.character === declStart.character;
    if (isDeclSite && !includeDecl) continue;
    out.push({ uri, range });
  }
  return out;
}

function wordAt(text: string, pos: Position): string | null {
  const lines = text.split("\n");
  if (pos.line < 0 || pos.line >= lines.length) return null;
  const line = lines[pos.line];
  if (pos.character < 0 || pos.character > line.length) return null;
  IDENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (pos.character >= start && pos.character <= end) return m[0];
  }
  return null;
}

function tokenRange(tok: Token): Range {
  const startLine = Math.max(0, tok.line - 1);
  const startChar = Math.max(0, tok.column - 1);
  return {
    start: { line: startLine, character: startChar },
    end: { line: startLine, character: startChar + tok.value.length },
  };
}

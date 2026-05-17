/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Find-references provider (#7411 + #655 — Phase 4 + Phase 8a)
 *
 * Returns every range in the document where a given type identifier
 * appears. Uses the symbol index to bound the search to known type
 * names — looking up a property name (`name`, `email`) returns nothing
 * because they're not in the type index, and we don't try to track
 * property scopes yet.
 *
 * Phase 8a: when an `EmbeddedSdlContext`-shaped context is supplied,
 * the search also walks every other open `.disc` document. This lets
 * "find references" surface uses in sibling SDL files — e.g. a `User`
 * type declared in `dbschema/default.disc` finds references in
 * `dbschema/extra.disc` too.
 */

import { SDLLexer } from "../schema/lexer.ts";
import { TokenType, type Token } from "../schema/tokens.ts";
import type { DocumentUri, Location, Position, Range } from "./protocol.ts";
import { buildSymbolIndex } from "./symbol-index.ts";

const IDENT = /[A-Za-z_][A-Za-z_0-9]*/g;

export interface ReferencesContext {
  documents: ReadonlyArray<{ uri: DocumentUri; text: string; }>;
}

export function provideReferences(
  text: string,
  pos: Position,
  uri: DocumentUri,
  options: {
    includeDeclaration?: boolean;
    context?: ReferencesContext;
  } = {}
): Location[] {
  const word = wordAt(text, pos);
  if (!word) {
    return [];
  }

  // Resolve the declaration. The cursor may be on a use site in this
  // file, or in another file in the cross-file context — we look at
  // the current file first (cheapest), then fall back to scanning the
  // context for the declaration.
  let declUri: DocumentUri = uri;
  let declRangeStart: Position | undefined;
  const localIdx = buildSymbolIndex(text);
  const localDecl = localIdx.types.get(word);
  if (localDecl) {
    declRangeStart = localDecl.range.start;
  } else if (options.context) {
    for (const ctxDoc of options.context.documents) {
      if (ctxDoc.uri === uri) {
        continue;
      }
      const ctxIdx = buildSymbolIndex(ctxDoc.text);
      const ctxDecl = ctxIdx.types.get(word);
      if (ctxDecl) {
        declUri = ctxDoc.uri;
        declRangeStart = ctxDecl.range.start;
        break;
      }
    }
  }
  if (!declRangeStart) {
    return [];
  }

  const includeDecl = options.includeDeclaration ?? true;

  // Collect every (uri, text) pair to scan: the primary document plus
  // any cross-file siblings. Dedupe by URI in case the context already
  // includes the primary doc (the caller often does, since
  // `LanguageServer.collectSdlContext()` returns every open .disc).
  const seen = new Set<DocumentUri>();
  const targets: { uri: DocumentUri; text: string; }[] = [];
  targets.push({ uri, text });
  seen.add(uri);
  if (options.context) {
    for (const ctxDoc of options.context.documents) {
      if (seen.has(ctxDoc.uri)) {
        continue;
      }
      targets.push(ctxDoc);
      seen.add(ctxDoc.uri);
    }
  }

  const out: Location[] = [];
  for (const target of targets) {
    let tokens: Token[];
    try {
      tokens = new SDLLexer(target.text).tokenize();
    } catch {
      continue;
    }
    for (const tok of tokens) {
      if (tok.type !== TokenType.IDENT) {
        continue;
      }
      if (tok.value !== word) {
        continue;
      }
      const range = tokenRange(tok);
      const isDeclSite = target.uri === declUri &&
        range.start.line === declRangeStart.line &&
        range.start.character === declRangeStart.character;
      if (isDeclSite && !includeDecl) {
        continue;
      }
      out.push({ uri: target.uri, range });
    }
  }
  return out;
}

function wordAt(text: string, pos: Position): string | null {
  const lines = text.split("\n");
  if (pos.line < 0 || pos.line >= lines.length) {
    return null;
  }
  const line = lines[pos.line];
  if (pos.character < 0 || pos.character > line.length) {
    return null;
  }
  IDENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (pos.character >= start && pos.character <= end) {
      return m[0];
    }
  }
  return null;
}

function tokenRange(tok: Token): Range {
  const startLine = Math.max(0, tok.line - 1);
  const startChar = Math.max(0, tok.column - 1);
  return {
    start: { line: startLine, character: startChar },
    end: { line: startLine, character: startChar + tok.value.length }
  };
}

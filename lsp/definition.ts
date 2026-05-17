/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Go-to-definition provider (#7411 + #655 — Phase 3)
 */

import type { DocumentUri, Location, Position } from "./protocol.ts";
import { buildSymbolIndex } from "./symbol-index.ts";

const IDENT = /[A-Za-z_][A-Za-z_0-9]*/g;

export function provideDefinition(
  text: string,
  pos: Position,
  uri: DocumentUri
): Location | null {
  const word = wordAt(text, pos);
  if (!word) {
    return null;
  }

  const idx = buildSymbolIndex(text);
  const sym = idx.types.get(word);
  if (!sym) {
    return null;
  }

  return {
    uri,
    range: sym.range
  };
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

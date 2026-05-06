/**
 * Rename provider (#7411 + #655 — Phase 4)
 *
 * `prepareRename` validates that the cursor sits on a renameable
 * type identifier and returns its range. `provideRename` returns a
 * `WorkspaceEdit` with one `TextEdit` per occurrence. Currently scoped
 * to type names — property/link rename needs scope tracking.
 */

import { buildSymbolIndex } from "./symbol-index.ts";
import { provideReferences } from "./references.ts";
import type {
  DocumentUri,
  Position,
  Range,
  TextEdit,
  WorkspaceEdit,
} from "./protocol.ts";

const IDENT = /[A-Za-z_][A-Za-z_0-9]*/g;
const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z_0-9]*$/;

/**
 * Determine whether the cursor is on a renameable identifier and
 * return its source range. Returns `null` when the position isn't
 * over a known type name (keywords, scalar types, properties, and
 * whitespace all disqualify).
 */
export function prepareRename(text: string, pos: Position): Range | null {
  const word = wordAt(text, pos);
  if (!word) return null;
  const idx = buildSymbolIndex(text);
  const sym = idx.types.get(word);
  if (!sym) return null;
  return sym.range;
}

export function provideRename(
  text: string,
  pos: Position,
  newName: string,
  uri: DocumentUri,
): WorkspaceEdit | null {
  // Validate the new name is a syntactically-correct identifier.
  if (!VALID_IDENTIFIER.test(newName)) return null;

  const word = wordAt(text, pos);
  if (!word || word === newName) return null;

  const idx = buildSymbolIndex(text);
  if (!idx.types.has(word)) return null;
  // Reject collisions — renaming `User` to an existing `Member` would
  // produce a schema with two types of the same name.
  if (idx.types.has(newName)) return null;

  const refs = provideReferences(text, pos, uri, { includeDeclaration: true });
  if (refs.length === 0) return null;

  const edits: TextEdit[] = refs.map((loc) => ({
    range: loc.range,
    newText: newName,
  }));

  return {
    changes: { [uri]: edits },
  };
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

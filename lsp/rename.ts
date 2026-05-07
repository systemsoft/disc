/**
 * Rename provider (#7411 + #655 — Phase 4 + Phase 8a)
 *
 * `prepareRename` validates that the cursor sits on a renameable
 * type identifier and returns its range. `provideRename` returns a
 * `WorkspaceEdit` with one `TextEdit` per occurrence. Currently scoped
 * to type names — property/link rename needs scope tracking.
 *
 * Phase 8a: when an `EmbeddedSdlContext`-shaped context is supplied,
 * rename composes with cross-file find-references — the declaration
 * is found in any open `.disc` file, edits land in every file that
 * uses the type, and collision checks run against names in every
 * sibling SDL file too.
 */

import { buildSymbolIndex } from "./symbol-index.ts";
import { provideReferences, type ReferencesContext } from "./references.ts";
import type { DocumentUri, Position, Range, TextEdit, WorkspaceEdit } from "./protocol.ts";

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
  options: { context?: ReferencesContext } = {},
): WorkspaceEdit | null {
  // Validate the new name is a syntactically-correct identifier.
  if (!VALID_IDENTIFIER.test(newName)) return null;

  const word = wordAt(text, pos);
  if (!word || word === newName) return null;

  // The cursor's word must resolve to a known type — either in this
  // document or in a sibling SDL document.
  const localIdx = buildSymbolIndex(text);
  let knownType = localIdx.types.has(word);
  if (!knownType && options.context) {
    for (const ctxDoc of options.context.documents) {
      if (ctxDoc.uri === uri) continue;
      if (buildSymbolIndex(ctxDoc.text).types.has(word)) {
        knownType = true;
        break;
      }
    }
  }
  if (!knownType) return null;

  // Collision check — the new name must not exist in this document or
  // any sibling SDL document. Renaming User → Member when Member
  // already exists somewhere produces duplicate types.
  if (localIdx.types.has(newName)) return null;
  if (options.context) {
    for (const ctxDoc of options.context.documents) {
      if (ctxDoc.uri === uri) continue;
      if (buildSymbolIndex(ctxDoc.text).types.has(newName)) return null;
    }
  }

  const refs = provideReferences(text, pos, uri, {
    includeDeclaration: true,
    context: options.context,
  });
  if (refs.length === 0) return null;

  // Group edits by URI so a cross-file rename produces one entry per
  // file in the WorkspaceEdit.changes map.
  const changes: Record<DocumentUri, TextEdit[]> = {};
  for (const loc of refs) {
    const list = changes[loc.uri] ?? (changes[loc.uri] = []);
    list.push({ range: loc.range, newText: newName });
  }

  return { changes };
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

/**
 * SDL completion provider (#7411 + #655)
 *
 * Phase 2 returns a flat list of candidates: SDL keywords, built-in
 * scalar types, and any user-defined types in the current document.
 *
 * Phase 8d adds context-aware narrowing: after `:` (property type
 * position), `->` (link target), or `extending` (inheritance), the
 * popup is filtered to types only — keywords like `module`/`required`
 * would be noise in those positions. At clause boundaries (e.g. start
 * of a property line inside a type body) the full set still appears
 * because either a keyword or a type is syntactically valid.
 */

import * as AST from "../schema/ast.ts";
import { SDLParser } from "../schema/parser.ts";
import { type CompletionItem, CompletionItemKind, type Position } from "./protocol.ts";
import { SCALAR_TYPES } from "./scalar-info.ts";

const KEYWORDS = [
  "module",
  "type",
  "abstract",
  "scalar",
  "enum",
  "extending",
  "link",
  "property",
  "required",
  "multi",
  "readonly",
  "default",
  "constraint",
  "annotation",
  "computed",
  "rewrite",
  "trigger",
  "access",
  "policy",
  "allow",
  "deny",
  "select",
  "insert",
  "update",
  "delete",
  "all",
  "using",
  "with",
  "check"
];

/**
 * Result of analyzing the cursor's surrounding context. `typesOnly`
 * is the only narrowing v1 ships; future phases can add finer-grained
 * cases (e.g., keyword-only at module-body start).
 */
interface CursorContext {
  typesOnly: boolean;
}

/**
 * Inspect the line up to the cursor and decide whether the position
 * is in a "type-only" context. Three triggers:
 *
 *   1. Last non-whitespace char before the cursor is `:` — property
 *      type position (`name: <here>`).
 *   2. Last two non-whitespace chars are `->` — link target position
 *      (`link author -> <here>`).
 *   3. The most recent identifier before the cursor is `extending` —
 *      inheritance position (`type User extending <here>`).
 */
function classifyCursor(text: string, pos: Position): CursorContext {
  const lines = text.split("\n");
  const line = lines[pos.line] ?? "";
  // Slice up to the cursor; do all detection on the prefix to avoid
  // confusion with material to the right of the cursor.
  const prefix = line.slice(0, Math.min(pos.character, line.length));

  // Trim trailing whitespace and look at what immediately precedes.
  const trimmedRight = prefix.replace(/\s+$/, "");
  if (trimmedRight.endsWith("->")) {
    return { typesOnly: true };
  }
  if (trimmedRight.endsWith(":")) {
    return { typesOnly: true };
  }
  // `extending` (alone or with a partial type name following) — the
  // parser only accepts type names here, so narrow even when the
  // cursor is immediately after the keyword (no space typed yet).
  // The `\b` boundary keeps this from matching mid-word like
  // "preextending" or similar typos.
  if (/\bextending\b\s*([A-Za-z_][A-Za-z_0-9]*)?$/.test(prefix)) {
    return { typesOnly: true };
  }
  return { typesOnly: false };
}

export function provideCompletion(
  text: string,
  pos: Position
): CompletionItem[] {
  const ctx = classifyCursor(text, pos);
  const items = new Map<string, CompletionItem>();

  if (!ctx.typesOnly) {
    for (const kw of KEYWORDS) {
      items.set(kw, {
        label: kw,
        kind: CompletionItemKind.Keyword
      });
    }
  }

  for (const s of SCALAR_TYPES) {
    items.set(s.name, {
      label: s.name,
      kind: CompletionItemKind.Class,
      detail: "scalar",
      documentation: s.description
    });
  }

  // User-defined types from the current document override built-ins
  // when they share a name (the user's intent wins).
  for (const name of collectTypeNames(text)) {
    items.set(name, {
      label: name,
      kind: CompletionItemKind.Class,
      detail: "type (this document)"
    });
  }

  return [...items.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function collectTypeNames(text: string): string[] {
  const names: string[] = [];
  let document: AST.SDLDocument;
  try {
    const parser = new SDLParser(text);
    document = parser.parseWithRecovery().document;
  } catch {
    return names;
  }

  for (const decl of document.declarations) {
    if (decl.kind === "ModuleDeclaration") {
      for (const inner of decl.declarations) {
        const n = nameOfTypeLikeDecl(inner);
        if (n)
          names.push(n);
      }
    } else {
      const n = nameOfTypeLikeDecl(decl);
      if (n)
        names.push(n);
    }
  }
  return names;
}

function nameOfTypeLikeDecl(decl: AST.Declaration): string | null {
  if (decl.kind === "TypeDeclaration")
    return decl.name.value;
  if (decl.kind === "ScalarTypeDeclaration")
    return decl.name.value;
  return null;
}

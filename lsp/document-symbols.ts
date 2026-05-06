/**
 * Document-symbol provider (#7411 + #655 — Phase 3)
 *
 * Surfaces the file's outline so editors can render breadcrumbs,
 * symbol search, and quick-jump menus. Each top-level type becomes
 * a symbol; its properties and links nest underneath.
 */

import { buildSymbolIndex, type TypeKind } from "./symbol-index.ts";
import {
  type DocumentSymbol,
  SymbolKind,
} from "./protocol.ts";

export function provideDocumentSymbols(text: string): DocumentSymbol[] {
  const idx = buildSymbolIndex(text);
  const out: DocumentSymbol[] = [];

  for (const t of idx.types.values()) {
    const children: DocumentSymbol[] = t.members.map((m) => ({
      name: m.name,
      kind: m.kind === "link" ? SymbolKind.Field : SymbolKind.Property,
      range: m.range,
      selectionRange: m.range,
    }));

    out.push({
      name: t.name,
      detail: typeKindLabel(t.kind),
      kind: typeKindToSymbolKind(t.kind),
      range: t.fullRange,
      selectionRange: t.range,
      children: children.length > 0 ? children : undefined,
    });
  }

  // Sort by start line for stable, file-order output.
  out.sort((a, b) =>
    a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character
  );
  return out;
}

function typeKindToSymbolKind(kind: TypeKind): SymbolKind {
  switch (kind) {
    case "scalar":
    case "enum":
      return SymbolKind.Enum;
    case "abstract":
      return SymbolKind.Interface;
    default:
      return SymbolKind.Class;
  }
}

function typeKindLabel(kind: TypeKind): string {
  switch (kind) {
    case "abstract":
      return "abstract type";
    case "scalar":
      return "scalar type";
    case "enum":
      return "enum";
    default:
      return "type";
  }
}

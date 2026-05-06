/**
 * SDL completion provider (#7411 + #655)
 *
 * Phase 2 returns a flat list of candidates: SDL keywords, built-in
 * scalar types, and any user-defined types in the current document.
 * Editors filter by prefix client-side, so context-aware narrowing
 * (e.g. only types after `:`, only keywords at top of a type body)
 * is a Phase 3 refinement.
 */

import { SDLParser } from "../schema/parser.ts";
import * as AST from "../schema/ast.ts";
import { SCALAR_TYPES } from "./scalar-info.ts";
import {
  type CompletionItem,
  CompletionItemKind,
  type Position,
} from "./protocol.ts";

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
  "check",
];

export function provideCompletion(
  text: string,
  _pos: Position,
): CompletionItem[] {
  const items = new Map<string, CompletionItem>();

  for (const kw of KEYWORDS) {
    items.set(kw, {
      label: kw,
      kind: CompletionItemKind.Keyword,
    });
  }

  for (const s of SCALAR_TYPES) {
    items.set(s.name, {
      label: s.name,
      kind: CompletionItemKind.Class,
      detail: "scalar",
      documentation: s.description,
    });
  }

  // User-defined types from the current document override built-ins
  // when they share a name (the user's intent wins).
  for (const name of collectTypeNames(text)) {
    items.set(name, {
      label: name,
      kind: CompletionItemKind.Class,
      detail: "type (this document)",
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
        if (n) names.push(n);
      }
    } else {
      const n = nameOfTypeLikeDecl(decl);
      if (n) names.push(n);
    }
  }
  return names;
}

function nameOfTypeLikeDecl(decl: AST.Declaration): string | null {
  if (decl.kind === "TypeDeclaration") return decl.name.value;
  if (decl.kind === "ScalarTypeDeclaration") return decl.name.value;
  return null;
}

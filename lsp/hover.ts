/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SDL hover provider (#7411 + #655)
 *
 * Given a document and a cursor position, identify the token under
 * the cursor and return a Markdown-rendered description if it's a
 * known scalar or a user-defined type in the same document. Returns
 * `null` for unrecognized tokens so editors don't show empty popups.
 */

import * as AST from "../schema/ast.ts";
import { SDLParser } from "../schema/parser.ts";
import type { Hover, Position } from "./protocol.ts";
import { lookupScalar } from "./scalar-info.ts";

export function provideHover(text: string, pos: Position): Hover | null {
  const word = wordAt(text, pos);
  if (!word) {
    return null;
  }

  // Built-in scalar?
  const scalar = lookupScalar(word);
  if (scalar) {
    return {
      contents: {
        kind: "markdown",
        value: `**${scalar.name}** _(scalar)_\n\n${scalar.description}`
      }
    };
  }

  // User-defined type in this document?
  const userType = findUserType(text, word);
  if (userType) {
    return {
      contents: {
        kind: "markdown",
        value: renderUserType(userType)
      }
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

const IDENT = /[A-Za-z_][A-Za-z_0-9]*/g;

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
    // Inclusive of `start`, exclusive of `end` — but allow the cursor
    // to sit at end-of-token too (LSP positions are between characters).
    if (pos.character >= start && pos.character <= end) {
      return m[0];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// User-type lookup
// ---------------------------------------------------------------------------

/**
 * Locate a user-defined type by name in a parsed SDL document. Exported
 * so other LSP features (e.g. cross-file SDL hover from embedded EdgeQL
 * in TS/JS host files — Phase 7) can reuse the same lookup without
 * duplicating SDL parsing.
 */
export function findUserType(
  text: string,
  name: string
): AST.TypeDeclaration | null {
  // Re-parse the document with recovery so errors elsewhere don't
  // suppress hover on a valid section. Cheap enough at editor latency.
  let document: AST.SDLDocument;
  try {
    const parser = new SDLParser(text);
    document = parser.parseWithRecovery().document;
  } catch {
    return null;
  }

  for (const decl of document.declarations) {
    if (decl.kind === "ModuleDeclaration") {
      for (const inner of decl.declarations) {
        const found = matchType(inner, name);
        if (found) {
          return found;
        }
      }
    } else {
      const found = matchType(decl, name);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function matchType(
  decl: AST.Declaration,
  name: string
): AST.TypeDeclaration | null {
  if (decl.kind === "TypeDeclaration" && decl.name.value === name) {
    return decl;
  }
  return null;
}

/**
 * Render a user-defined type as the Markdown body shown in hover
 * popups. Exported so cross-file resolution from embedded EdgeQL
 * (Phase 7) can produce identical output without duplicating the
 * formatting logic.
 */
export function renderUserType(t: AST.TypeDeclaration): string {
  const lines: string[] = [];
  const kind = t.abstract ? "abstract type" : "type";
  lines.push(`**${t.name.value}** _(${kind})_`);

  if (t.extending && t.extending.length > 0) {
    const parents = t.extending.map(e => e.name.parts.join("::")).join(", ");
    lines.push("");
    lines.push(`Extends: \`${parents}\``);
  }

  // Property summary — list up to 6 names with their types.
  const props = t.members.filter((m): m is AST.PropertyDeclaration => m.kind === "PropertyDeclaration");
  if (props.length > 0) {
    lines.push("");
    lines.push("Properties:");
    for (const p of props.slice(0, 6)) {
      const typeName = p.type ? p.type.name.parts.join("::") : "?";
      const reqd = p.required ? "required " : "";
      const multi = p.multi ? "multi " : "";
      lines.push(`- \`${reqd}${multi}${p.name.value}: ${typeName}\``);
    }
    if (props.length > 6) {
      lines.push(`- _… ${props.length - 6} more_`);
    }
  }

  const links = t.members.filter((m): m is AST.LinkDeclaration => m.kind === "LinkDeclaration");
  if (links.length > 0) {
    lines.push("");
    lines.push("Links:");
    for (const l of links.slice(0, 6)) {
      const target = l.target ? l.target.name.parts.join("::") : "?";
      const reqd = l.required ? "required " : "";
      const multi = l.multi ? "multi " : "";
      lines.push(`- \`${reqd}${multi}link ${l.name.value} -> ${target}\``);
    }
  }

  return lines.join("\n");
}

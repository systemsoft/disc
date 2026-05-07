/**
 * `.disc` formatter (LSP Phase 8b)
 *
 * Minimal-but-useful re-indenter for SDL files. Walks the source line
 * by line, counts net brace depth (`{` minus `}`, ignoring braces
 * inside string literals and line comments), and re-emits each line
 * with `2 * depth` spaces of indentation.
 *
 * Deliberately limited: this version doesn't reflow long lines,
 * collapse multiple spaces between tokens, normalize trailing
 * commas/semicolons, or alphabetize fields. Operators who want a
 * heavier-touch tool can run `deno fmt` on top — this formatter's
 * job is the structural-indent invariant a casual editor needs.
 */

import type { Position, Range, TextEdit } from "./protocol.ts";

const INDENT = "  ";

/**
 * Reformat a single SDL document. Returns the input unchanged when
 * already correctly indented (modulo whitespace-only edits we'd
 * skip anyway).
 */
export function formatSdl(text: string): string {
  // Preserve trailing newline if present — split on `\n` so we can
  // rejoin without losing it.
  const hasTrailingNewline = text.endsWith("\n");
  const body = hasTrailingNewline ? text.slice(0, -1) : text;

  const lines = body.split("\n");
  const out: string[] = [];
  let depth = 0;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      out.push("");
      continue;
    }

    // Lines that *start* with `}` close before printing — de-indent
    // first so the brace lines up with its opener.
    const stripped = stripStringsAndComments(trimmed);
    const startsWithClose = /^[})\]]/.test(stripped);
    const printDepth = startsWithClose ? Math.max(0, depth - 1) : depth;

    out.push(INDENT.repeat(printDepth) + trimmed);

    // Update depth based on net brace count for the next line.
    let net = 0;
    for (const ch of stripped) {
      if (ch === "{") net++;
      else if (ch === "}") net--;
    }
    depth = Math.max(0, depth + net);
  }

  const joined = out.join("\n");
  return hasTrailingNewline ? joined + "\n" : joined;
}

/**
 * Strip string literals and line comments from a line so brace
 * counting only sees real braces. The replacement uses spaces so
 * column positions stay roughly preserved (not strictly necessary for
 * depth-counting, but makes future use of the same primitive easier).
 *
 * Handles `"..."` (double-quoted) and `'...'` (single-quoted) literals
 * with backslash escapes, plus `//` line comments. Block comments
 * (`/* ... *\/`) aren't a thing in SDL.
 */
function stripStringsAndComments(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    // Line comment — drop the rest of the line.
    if (ch === "/" && line[i + 1] === "/") {
      break;
    }
    // String literal — skip to closing quote.
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      out += " ";
      i++;
      while (i < line.length) {
        const c = line[i];
        if (c === "\\" && i + 1 < line.length) {
          out += "  ";
          i += 2;
          continue;
        }
        if (c === quote) {
          out += " ";
          i++;
          break;
        }
        out += " ";
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * LSP `textDocument/formatting` provider. Returns a single TextEdit
 * covering the whole document, or an empty array when no change is
 * needed (idempotent reformat → no-op edit).
 */
export function provideFormatting(text: string): TextEdit[] {
  const formatted = formatSdl(text);
  if (formatted === text) return [];
  // End range covers the whole document — line `lineCount`, col 0
  // (LSP convention: end-of-document is one line past the last
  // newline-terminated line).
  const lineCount = text.split("\n").length;
  const start: Position = { line: 0, character: 0 };
  const end: Position = { line: lineCount, character: 0 };
  const range: Range = { start, end };
  return [{ range, newText: formatted }];
}

/**
 * SDL → LSP diagnostics translator (#7411 + #655)
 *
 * Pure function: given SDL source text, return the LSP diagnostics
 * (parse + validation errors) as a flat array. No I/O, so the server's
 * loop and editor integrations can both consume it.
 */

import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { DiscError } from "../lib/errors.ts";
import { type Diagnostic, DiagnosticSeverity, type Position, type Range } from "./protocol.ts";

const SOURCE = "disc";

export function analyzeDiscDocument(text: string): Diagnostic[] {
  if (text.length === 0) return [];

  const diagnostics: Diagnostic[] = [];

  // 1. Parse with recovery so multiple errors surface in a single pass.
  const parser = new SDLParser(text);
  const { document, errors: parseErrors } = parser.parseWithRecovery();
  for (const err of parseErrors) {
    diagnostics.push(errorToDiagnostic(err, text, DiagnosticSeverity.Error));
  }

  // 2. Even when parse errors exist, run the validator on whatever
  // declarations the recovery produced — surfaces both layers' errors
  // in one editor pass instead of forcing the user to fix syntax first.
  const validator = new SchemaValidator();
  const result = validator.validate(document);
  if (!result.ok && result.errors) {
    for (const err of result.errors) {
      diagnostics.push(errorToDiagnostic(err, text, DiagnosticSeverity.Error));
    }
  }

  return diagnostics;
}

function errorToDiagnostic(
  err: DiscError | Error,
  source: string,
  severity: DiagnosticSeverity,
): Diagnostic {
  const message = "message" in err ? err.message : String(err);
  const range = errorToRange(err, source);
  return {
    range,
    severity,
    source: SOURCE,
    message,
  };
}

function errorToRange(err: DiscError | Error, source: string): Range {
  // Parser/validator errors carry an optional `context.location`
  // (1-indexed line/column). LSP wants 0-indexed line/character.
  const ctx = (err as DiscError).context;
  if (ctx?.location) {
    const startLine = Math.max(0, ctx.location.line - 1);
    const startChar = Math.max(0, ctx.location.column - 1);
    return {
      start: { line: startLine, character: startChar },
      end: extendToEndOfTokenOrLine(source, startLine, startChar),
    };
  }
  // Without a location, point at the start of the document. Editors
  // surface the diagnostic in the file-level summary either way.
  const start: Position = { line: 0, character: 0 };
  return { start, end: start };
}

function extendToEndOfTokenOrLine(
  source: string,
  line: number,
  character: number,
): Position {
  const lines = source.split("\n");
  if (line >= lines.length) return { line, character };
  const lineText = lines[line];
  // Find the next whitespace or end-of-line after `character` so the
  // squiggle covers a meaningful chunk rather than a zero-width caret.
  let end = character;
  while (
    end < lineText.length &&
    !/\s/.test(lineText[end]) &&
    lineText[end] !== ";" &&
    lineText[end] !== "{" &&
    lineText[end] !== "}"
  ) {
    end++;
  }
  if (end === character) {
    // Couldn't find a token boundary — fall back to end-of-line so the
    // diagnostic is at least visible in the gutter.
    end = lineText.length;
  }
  return { line, character: end };
}

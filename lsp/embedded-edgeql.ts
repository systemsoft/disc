/**
 * Embedded-EdgeQL diagnostics for TS/JS host files (LSP Phase 5).
 *
 * Scans a TypeScript (or JavaScript) source for tagged template
 * literals of the form `eql\`...\`` and runs each one through the
 * EdgeQL parser. Parse errors are mapped back to the host file's
 * coordinates so editors surface squiggles at the right spot.
 *
 * v1 scope:
 *   - Matches `eql\`...\`` only — `client.query("...")` style strings
 *     stay out of scope (regex matching string-literal arguments is
 *     ambiguous without a TS AST).
 *   - Skips template literals containing `${...}` substitutions —
 *     the runtime value is unknown at lint time, and the embedded
 *     content rarely parses cleanly with the placeholder in-place.
 *   - Diagnostics-only — hover, completion, and go-to-definition
 *     inside the embedded string are out of scope (those need
 *     bidirectional cursor mapping which doubles the surface area).
 */

import { EdgeQLParser } from "../edgeql/parser.ts";
import { type DiscError } from "../lib/errors.ts";
import { type Diagnostic, DiagnosticSeverity, type Position, type Range } from "./protocol.ts";

const SOURCE = "disc-eql";

/**
 * One embedded `eql\`...\`` literal extracted from a host file. The
 * `start` is the 0-indexed position of the first character *inside*
 * the backticks (i.e. just past the opening `` ` ``).
 */
export interface EmbeddedQuery {
  start: Position;
  content: string;
}

/**
 * `eql\`...\`` matcher. We use a string-only character class
 * (`[^\`$\\]*`) so:
 *
 *   - Unmatched backticks short-circuit cleanly.
 *   - `${...}` template substitutions disqualify the literal at the
 *     match level (the `$` breaks the run), so the regex never
 *     captures partial content from a substituted template.
 *   - Backslash escapes are skipped — the user can write
 *     `\n` literally if they want it in the EdgeQL string, but a
 *     backslash inside `eql\`...\`` is unusual enough that v1
 *     refuses the literal rather than guess.
 *
 * The leading `\beql` boundary keeps `myEql\`...\`` and similar
 * adjacent identifiers from matching by accident.
 */
const EQL_TEMPLATE_RE = /\beql`([^`$\\]*)`/g;

export function extractEmbeddedQueries(text: string): EmbeddedQuery[] {
  const queries: EmbeddedQuery[] = [];
  EQL_TEMPLATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EQL_TEMPLATE_RE.exec(text)) !== null) {
    // m.index points at the leading `e` of `eql`; the content starts
    // four characters later (after `eql\``).
    const contentStartOffset = m.index + "eql`".length;
    const start = offsetToPosition(text, contentStartOffset);
    queries.push({ start, content: m[1] });
  }
  return queries;
}

/**
 * Run each embedded EdgeQL string through the parser and return
 * diagnostics in host-file coordinates. Empty embedded strings are
 * skipped — they're a benign no-op rather than a parse error.
 */
export function analyzeEmbeddedDocument(text: string): Diagnostic[] {
  if (text.length === 0) return [];
  const queries = extractEmbeddedQueries(text);
  const diagnostics: Diagnostic[] = [];
  for (const q of queries) {
    if (q.content.trim().length === 0) continue;
    const parser = new EdgeQLParser(q.content);
    const { errors } = parser.parseWithRecovery();
    for (const err of errors) {
      diagnostics.push(toHostDiagnostic(err, q));
    }
  }
  return diagnostics;
}

function toHostDiagnostic(err: DiscError, query: EmbeddedQuery): Diagnostic {
  const ctx = err.context;
  let range: Range;
  if (ctx?.location) {
    // EdgeQL parser uses 1-indexed line/column relative to the embedded
    // string. Convert to 0-indexed and offset by where the embedded
    // string lives in the host file.
    const eqlLine = Math.max(0, ctx.location.line - 1);
    const eqlChar = Math.max(0, ctx.location.column - 1);
    const hostLine = query.start.line + eqlLine;
    // Only the first line of the embedded string shares the host's
    // column origin — subsequent lines start at column 0.
    const hostChar = eqlLine === 0 ? query.start.character + eqlChar : eqlChar;
    range = {
      start: { line: hostLine, character: hostChar },
      end: { line: hostLine, character: hostChar + 1 },
    };
  } else {
    // Without a location, point at the start of the embedded string —
    // editors at least surface the file-level summary.
    range = {
      start: query.start,
      end: { line: query.start.line, character: query.start.character + 1 },
    };
  }
  return {
    range,
    severity: DiagnosticSeverity.Error,
    source: SOURCE,
    message: err.message,
  };
}

/**
 * Convert a flat character offset into a 0-indexed `{ line, character }`
 * position. The host file's text is the source of truth — we don't
 * cache, so callers can pass arbitrary text without invalidation
 * concerns.
 */
function offsetToPosition(text: string, offset: number): Position {
  let line = 0;
  let lineStart = 0;
  const cap = Math.min(offset, text.length);
  for (let i = 0; i < cap; i++) {
    if (text.charCodeAt(i) === 0x0a /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

/**
 * Return true if `uri` looks like a TypeScript or JavaScript file —
 * the host languages where embedded EdgeQL might appear. SDL
 * (`.disc`) goes through the standard SDL diagnostics path and is
 * never returned `true` here.
 */
export function isEmbeddedEqlHost(uri: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/i.test(uri);
}

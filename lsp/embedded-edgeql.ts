/**
 * Embedded-EdgeQL features for TS/JS host files (LSP Phases 5 + 6).
 *
 * Scans a TypeScript (or JavaScript) source for tagged template
 * literals of the form `eql\`...\`` and provides editor features
 * scoped to those embedded strings:
 *
 *   - Phase 5: parse-error diagnostics, mapped to host coordinates
 *   - Phase 6: hover (EdgeQL keywords + built-in scalars) and
 *     completion (same surface), driven by a bidirectional cursor
 *     mapping that resolves a host-file position to a position
 *     within the embedded string.
 *
 * v1 scope:
 *   - Matches `eql\`...\`` only — `client.query("...")` style strings
 *     stay out of scope (regex matching string-literal arguments is
 *     ambiguous without a TS AST).
 *   - Skips template literals containing `${...}` substitutions —
 *     the runtime value is unknown at lint time, and the embedded
 *     content rarely parses cleanly with the placeholder in-place.
 *   - Hover/completion target keywords + scalars; user-defined types
 *     and go-to-definition into a paired SDL file are out of scope
 *     for v1 (would require cross-file resolution).
 */

import { EdgeQLParser } from "../edgeql/parser.ts";
import { type DiscError } from "../lib/errors.ts";
import { findUserType, renderUserType } from "./hover.ts";
import {
  type CompletionItem,
  CompletionItemKind,
  type Diagnostic,
  DiagnosticSeverity,
  type DocumentUri,
  type Hover,
  type Location,
  type Position,
  type Range
} from "./protocol.ts";
import { lookupScalar, SCALAR_TYPES } from "./scalar-info.ts";
import { buildSymbolIndex } from "./symbol-index.ts";

/**
 * Open SDL documents the LSP knows about, fed to the embedded
 * providers so hover/completion/definition for user-declared types
 * resolve from a paired `.disc` file. (LSP Phase 7)
 *
 * The provider iterates these on each request and parses on demand —
 * SDL files are small and parsing is cheap; no caching layer needed
 * for v1. Callers with no SDL context (tests, direct callers) pass
 * an empty array and the providers behave exactly as Phase 6.
 */
export interface EmbeddedSdlContext {
  documents: ReadonlyArray<{ uri: DocumentUri; text: string; }>;
}

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
  if (text.length === 0)
    return [];
  const queries = extractEmbeddedQueries(text);
  const diagnostics: Diagnostic[] = [];
  for (const q of queries) {
    if (q.content.trim().length === 0)
      continue;
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
      end: { line: hostLine, character: hostChar + 1 }
    };
  } else {
    // Without a location, point at the start of the embedded string —
    // editors at least surface the file-level summary.
    range = {
      start: query.start,
      end: { line: query.start.line, character: query.start.character + 1 }
    };
  }
  return {
    range,
    severity: DiagnosticSeverity.Error,
    source: SOURCE,
    message: err.message
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

// =====================================================================
// Phase 6 — bidirectional cursor mapping + hover/completion
// =====================================================================

/**
 * Resolution of a host-file cursor position into the enclosing
 * embedded EdgeQL literal (if any) and the cursor's position within
 * the embedded string itself. Returns `null` when the cursor sits
 * outside every `eql\`...\`` literal in the host file.
 *
 * The mapping is the inverse of the diagnostic mapper above —
 * diagnostics map embedded → host (so editors squiggle at the right
 * line); hover/completion map host → embedded (so we ask the EdgeQL
 * provider about the right word).
 */
export interface EnclosingQuery {
  query: EmbeddedQuery;
  posInQuery: Position;
}

export function findEnclosingEmbeddedQuery(
  text: string,
  hostPos: Position
): EnclosingQuery | null {
  // We need character-offset arithmetic against `hostPos`, so convert
  // both the cursor and each query's start into flat offsets up front.
  const cursorOffset = positionToOffset(text, hostPos);
  if (cursorOffset === null)
    return null;

  EQL_TEMPLATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EQL_TEMPLATE_RE.exec(text)) !== null) {
    const contentStartOffset = m.index + "eql`".length;
    const contentEndOffset = contentStartOffset + m[1].length;
    // LSP positions sit between characters, so `<=` on the right
    // edge lets the cursor at the closing backtick still resolve.
    if (cursorOffset >= contentStartOffset && cursorOffset <= contentEndOffset) {
      const start = offsetToPosition(text, contentStartOffset);
      const posInQuery = offsetWithinQuery(m[1], cursorOffset - contentStartOffset);
      return { query: { start, content: m[1] }, posInQuery };
    }
  }
  return null;
}

/**
 * Hover provider for embedded EdgeQL. Returns `null` when the cursor
 * is outside every `eql\`...\`` literal, on whitespace within one,
 * or on a token we don't recognise (so editors don't show empty
 * popups).
 *
 * Recognises EdgeQL keywords, built-in scalars, and — when an
 * `EmbeddedSdlContext` is supplied (Phase 7) — user-defined types
 * declared in any open `.disc` document.
 */
export function provideEmbeddedHover(
  text: string,
  hostPos: Position,
  ctx?: EmbeddedSdlContext
): Hover | null {
  const enclosing = findEnclosingEmbeddedQuery(text, hostPos);
  if (!enclosing)
    return null;

  const word = wordAt(enclosing.query.content, enclosing.posInQuery);
  if (!word)
    return null;

  const lower = word.toLowerCase();
  const keywordDoc = EDGEQL_KEYWORD_DOCS[lower];
  if (keywordDoc) {
    return {
      contents: {
        kind: "markdown",
        value: `**${lower}** _(EdgeQL keyword)_\n\n${keywordDoc}`
      }
    };
  }
  // Bare keyword (no description in our table): still acknowledge it
  // as a keyword so the user knows it's recognised.
  if (EDGEQL_KEYWORDS.has(lower)) {
    return {
      contents: {
        kind: "markdown",
        value: `**${lower}** _(EdgeQL keyword)_`
      }
    };
  }

  const scalar = lookupScalar(word);
  if (scalar) {
    return {
      contents: {
        kind: "markdown",
        value: `**${scalar.name}** _(scalar)_\n\n${scalar.description}`
      }
    };
  }

  // Phase 7: cross-file SDL resolution. Walk every open `.disc`
  // document looking for a type declaration matching `word`. Match
  // wins on the first hit — name collisions across SDL files are
  // unusual enough that "first match" is fine for v1.
  if (ctx) {
    for (const doc of ctx.documents) {
      const decl = findUserType(doc.text, word);
      if (decl) {
        return {
          contents: { kind: "markdown", value: renderUserType(decl) }
        };
      }
    }
  }

  return null;
}

/**
 * Completion provider for embedded EdgeQL. Returns the union of
 * EdgeQL keywords, built-in scalars, and — when an
 * `EmbeddedSdlContext` is supplied (Phase 7) — user-defined types
 * from any open `.disc` document. Returns an empty list when the
 * cursor is outside any `eql\`...\`` literal so editors don't
 * surface SDL keywords inside plain TypeScript.
 *
 * Editors filter the returned set by prefix client-side, so we don't
 * narrow by context here (e.g. "only types after `:`"). That's a
 * future refinement.
 */
export function provideEmbeddedCompletion(
  text: string,
  hostPos: Position,
  ctx?: EmbeddedSdlContext
): CompletionItem[] {
  const enclosing = findEnclosingEmbeddedQuery(text, hostPos);
  if (!enclosing)
    return [];

  const items = new Map<string, CompletionItem>();
  for (const kw of EDGEQL_KEYWORDS) {
    items.set(kw, { label: kw, kind: CompletionItemKind.Keyword });
  }
  for (const s of SCALAR_TYPES) {
    items.set(s.name, {
      label: s.name,
      kind: CompletionItemKind.Class,
      detail: "scalar",
      documentation: s.description
    });
  }
  // Phase 7: pull user-defined type names from open `.disc` documents.
  // Built-in scalars and EdgeQL keywords win on a label collision —
  // user-defined types are appended last and the Map upsert preserves
  // the earlier entry.
  if (ctx) {
    for (const doc of ctx.documents) {
      const idx = buildSymbolIndex(doc.text);
      for (const [name, sym] of idx.types) {
        if (items.has(name))
          continue;
        items.set(name, {
          label: name,
          kind: CompletionItemKind.Class,
          detail: `${sym.kind} (from ${shortenUri(doc.uri)})`
        });
      }
    }
  }
  return [...items.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Go-to-definition provider for embedded EdgeQL (Phase 7). When the
 * cursor sits on a user-defined type name, return a `Location`
 * pointing at the type's declaration in whichever open `.disc`
 * document declares it. Returns `null` for keywords, scalars, or
 * unknown identifiers (callers route those through other features
 * or surface nothing).
 *
 * The implementation reuses `buildSymbolIndex` so the range matches
 * what the SDL document-symbol provider exposes — no second source
 * of truth for type-decl locations.
 */
export function provideEmbeddedDefinition(
  text: string,
  hostPos: Position,
  ctx?: EmbeddedSdlContext
): Location | null {
  const enclosing = findEnclosingEmbeddedQuery(text, hostPos);
  if (!enclosing)
    return null;
  const word = wordAt(enclosing.query.content, enclosing.posInQuery);
  if (!word)
    return null;
  // Don't try to resolve EdgeQL keywords or built-in scalars — those
  // have no source location.
  if (EDGEQL_KEYWORDS.has(word.toLowerCase()))
    return null;
  if (lookupScalar(word))
    return null;
  if (!ctx)
    return null;

  for (const doc of ctx.documents) {
    const idx = buildSymbolIndex(doc.text);
    const sym = idx.types.get(word);
    if (sym) {
      return { uri: doc.uri, range: sym.range };
    }
  }
  return null;
}

/**
 * Compact a `file:///path/to/dbschema/default.disc` URI to its last
 * two path segments (`dbschema/default.disc`) for completion-item
 * detail strings. The full path is noisy in completion popups; the
 * tail segments tell the user where the type comes from without
 * dominating the visible width.
 */
function shortenUri(uri: DocumentUri): string {
  const stripped = uri.replace(/^file:\/\//, "");
  const parts = stripped.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || stripped;
}

// ---------------------------------------------------------------------
// EdgeQL keyword surface
// ---------------------------------------------------------------------

/**
 * EdgeQL keywords surfaced for hover + completion. A subset of
 * `edgeql/tokens.ts:KEYWORDS` — we expose what an editor user is
 * likely to recognise in a query body. Internal lexer keywords for
 * clauses they'd never type freehand (e.g. `INSTANCE`, `ANALYZE`) are
 * skipped so completion stays focused.
 */
const EDGEQL_KEYWORDS = new Set<string>([
  "select",
  "insert",
  "update",
  "delete",
  "for",
  "with",
  "filter",
  "order",
  "by",
  "asc",
  "desc",
  "limit",
  "offset",
  "group",
  "and",
  "or",
  "not",
  "exists",
  "distinct",
  "is",
  "in",
  "union",
  "except",
  "intersect",
  "if",
  "else",
  "then",
  "case",
  "when",
  "end",
  "required",
  "optional",
  "single",
  "multi",
  "set",
  "unless",
  "conflict",
  "on",
  "like",
  "ilike",
  "module",
  "type",
  "describe",
  "explain",
  "true",
  "false",
  "empty",
  "detached",
  "global"
]);

/**
 * One-line descriptions for the keywords most likely to come up in
 * everyday queries. Hover falls back to "_EdgeQL keyword_" with no
 * body for keywords missing here, so it's safe to omit niche ones
 * rather than write filler descriptions.
 */
const EDGEQL_KEYWORD_DOCS: Record<string, string> = {
  select: "Read query — produce a set of values, optionally with a shape, filter, order, and slicing clauses.",
  insert: "Create new objects of a given type.",
  update: "Modify existing objects matching a filter.",
  delete: "Remove objects matching a filter.",
  filter: "Restrict the current set to elements matching a boolean expression.",
  order: "Sort the current set. Pair with `by <expr> [asc|desc]`.",
  by: "Order/group clause introducer (`order by ...`, `group by ...`).",
  limit: "Cap the number of returned elements.",
  offset: "Skip the first N elements before applying `limit`.",
  with: "Bind aliases (or `with module ...`) for the rest of the statement.",
  for: "Iterate a `union`-style query over each element of a set.",
  exists: "True iff the operand set is non-empty.",
  distinct: "Drop duplicate elements from the operand set.",
  union: "Set union — concatenate two sets, preserving duplicates.",
  except: "Set difference — elements of left absent from right.",
  intersect: "Set intersection — elements present in both operands.",
  required: "Cardinality marker — at least one value must be present.",
  optional: "Cardinality marker — zero or more values allowed.",
  single: "Cardinality marker — exactly one value (or zero with `optional`).",
  multi: "Cardinality marker — zero or more values.",
  detached: "Disable implicit path linking; treat the operand as a fresh root.",
  global: "Reference a session-scoped global value.",
  module: "Switch the active module for unqualified name resolution.",
  unless: "Conflict-resolution clause introducer (`insert ... unless conflict on .x`).",
  conflict: "Conflict-resolution clause introducer (`unless conflict on .x`)."
};

// ---------------------------------------------------------------------
// Cursor / token helpers shared by hover + completion
// ---------------------------------------------------------------------

const IDENT = /[A-Za-z_][A-Za-z_0-9]*/g;

/**
 * Identifier-or-null at the given position within `text`. LSP
 * positions sit between characters, so `pos.character` may equal the
 * end of the matched token (cursor at end-of-word) — both cases
 * resolve to the token under the cursor.
 */
function wordAt(text: string, pos: Position): string | null {
  const lines = text.split("\n");
  if (pos.line < 0 || pos.line >= lines.length)
    return null;
  const line = lines[pos.line];
  if (pos.character < 0 || pos.character > line.length)
    return null;
  IDENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT.exec(line)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (pos.character >= start && pos.character <= end)
      return m[0];
  }
  return null;
}

/**
 * Convert a 0-indexed line/character into a flat offset, or `null` if
 * the position is out of range. Mirror of `offsetToPosition` for the
 * inverse mapping.
 */
function positionToOffset(text: string, pos: Position): number | null {
  if (pos.line < 0 || pos.character < 0)
    return null;
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (line === pos.line) {
      const lineEndCandidate = text.indexOf("\n", lineStart);
      const lineEnd = lineEndCandidate === -1 ? text.length : lineEndCandidate;
      const lineLength = lineEnd - lineStart;
      if (pos.character > lineLength)
        return null;
      return lineStart + pos.character;
    }
    if (text.charCodeAt(i) === 0x0a /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  // Cursor on the (empty) trailing line — accept character 0 only.
  if (line === pos.line && pos.character === 0)
    return text.length;
  return null;
}

/**
 * Convert an offset within an embedded EdgeQL string into a 0-indexed
 * `{ line, character }` relative to the embedded content (column 0
 * for every line *of the embedded string*, not the host).
 */
function offsetWithinQuery(content: string, offset: number): Position {
  let line = 0;
  let lineStart = 0;
  const cap = Math.min(offset, content.length);
  for (let i = 0; i < cap; i++) {
    if (content.charCodeAt(i) === 0x0a /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

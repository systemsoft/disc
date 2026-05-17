/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for embedded-EdgeQL diagnostics (LSP Phase 5), hover +
 * completion within `eql\`...\`` literals (LSP Phase 6), and
 * cross-file SDL resolution from open `.disc` documents (LSP Phase 7).
 */

import { assert, assertEquals } from "@std/assert";
import {
  analyzeEmbeddedDocument,
  extractEmbeddedQueries,
  findEnclosingEmbeddedQuery,
  isEmbeddedEqlHost,
  provideEmbeddedCompletion,
  provideEmbeddedDefinition,
  provideEmbeddedHover,
  type EmbeddedSdlContext
} from "./embedded-edgeql.ts";

// --- isEmbeddedEqlHost ---

Deno.test("isEmbeddedEqlHost recognises TS/JS extensions", () => {
  for (
    const uri of [
      "file:///tmp/x.ts",
      "file:///tmp/x.tsx",
      "file:///tmp/x.js",
      "file:///tmp/x.jsx",
      "file:///tmp/x.mts",
      "file:///tmp/x.mjs",
      "file:///tmp/x.cts",
      "file:///tmp/x.cjs"
    ]
  ) {
    assert(isEmbeddedEqlHost(uri), `expected ${uri} to be a host file`);
  }
});

Deno.test("isEmbeddedEqlHost rejects SDL and unrelated extensions", () => {
  assertEquals(isEmbeddedEqlHost("file:///tmp/x.disc"), false);
  assertEquals(isEmbeddedEqlHost("file:///tmp/x.sql"), false);
  assertEquals(isEmbeddedEqlHost("file:///tmp/x.md"), false);
  assertEquals(isEmbeddedEqlHost("file:///tmp/x"), false);
});

// --- extractEmbeddedQueries ---

Deno.test("extractEmbeddedQueries returns no queries for plain text", () => {
  assertEquals(extractEmbeddedQueries(""), []);
  assertEquals(extractEmbeddedQueries("const x = 1;"), []);
});

Deno.test("extractEmbeddedQueries finds a single eql tag", () => {
  const text = "const q = eql`select User`;";
  const queries = extractEmbeddedQueries(text);
  assertEquals(queries.length, 1);
  assertEquals(queries[0].content, "select User");
  // `const q = ` is 10 chars; `eql\`` adds 4 → content starts at column 14.
  assertEquals(queries[0].start, { line: 0, character: 14 });
});

Deno.test("extractEmbeddedQueries finds multiple eql tags on different lines", () => {
  const text = [
    "const a = eql`select User`;",
    "const b = eql`select Post`;"
  ]
    .join("\n");
  const queries = extractEmbeddedQueries(text);
  assertEquals(queries.length, 2);
  assertEquals(queries[0].content, "select User");
  assertEquals(queries[0].start.line, 0);
  assertEquals(queries[1].content, "select Post");
  assertEquals(queries[1].start.line, 1);
  assertEquals(queries[1].start.character, 14);
});

Deno.test("extractEmbeddedQueries skips templates with substitutions", () => {
  // `${x}` makes the literal runtime-dynamic; v1 refuses to attempt analysis.
  const text = "const q = eql`select User filter .id = ${id}`;";
  assertEquals(extractEmbeddedQueries(text), []);
});

Deno.test("extractEmbeddedQueries respects identifier boundaries", () => {
  // `myEql\`...\`` should NOT match — only bare `eql\`...\``.
  const text = "const q = myEql`select User`;";
  assertEquals(extractEmbeddedQueries(text), []);
});

Deno.test("extractEmbeddedQueries handles multi-line embedded content", () => {
  const text = "const q = eql`select User {\n  id\n}`;";
  const queries = extractEmbeddedQueries(text);
  assertEquals(queries.length, 1);
  assertEquals(queries[0].content, "select User {\n  id\n}");
  assertEquals(queries[0].start.line, 0);
});

// --- analyzeEmbeddedDocument ---

Deno.test("analyzeEmbeddedDocument returns no diagnostics for clean EdgeQL", () => {
  const text = "const q = eql`select User { id, email }`;";
  assertEquals(analyzeEmbeddedDocument(text), []);
});

Deno.test("analyzeEmbeddedDocument returns no diagnostics for empty host text", () => {
  assertEquals(analyzeEmbeddedDocument(""), []);
});

Deno.test("analyzeEmbeddedDocument skips empty embedded strings", () => {
  // `eql\`\`` and `eql\` \`` are no-ops, not parse errors.
  const text = "const a = eql``;\nconst b = eql`   `;";
  assertEquals(analyzeEmbeddedDocument(text), []);
});

Deno.test("analyzeEmbeddedDocument flags broken EdgeQL with a host-coordinate diagnostic", () => {
  // Garbage that can't possibly parse — the parser should surface at
  // least one diagnostic.
  const text = "const q = eql`@@@ not valid edgeql`;";
  const diags = analyzeEmbeddedDocument(text);
  assert(
    diags.length > 0,
    `expected diagnostics for broken EdgeQL, got ${diags.length}`
  );
  for (const d of diags) {
    assertEquals(d.source, "disc-eql");
    // Diagnostic must land inside the embedded string region of the
    // host (line 0, column ≥ 14 since the content starts at col 14).
    assertEquals(d.range.start.line, 0);
    assert(
      d.range.start.character >= 14,
      `expected diagnostic at col ≥ 14, got ${d.range.start.character}`
    );
  }
});

Deno.test("analyzeEmbeddedDocument maps multi-line errors to the correct host line", () => {
  // Broken EdgeQL on the second line of the embedded string. The
  // diagnostic should land at host line 1 (line 0 is the host's
  // `const q = eql\`select User`), with column 0 origin (subsequent
  // lines of an embedded string start at column 0, not the host
  // column).
  const text = [
    "const q = eql`select User",
    "  @@@invalid`;"
  ]
    .join("\n");
  const diags = analyzeEmbeddedDocument(text);
  assert(diags.length > 0, "expected at least one diagnostic");
  // First diagnostic should be on the second host line.
  const onSecondLine = diags.find(d => d.range.start.line === 1);
  assert(
    onSecondLine,
    `expected at least one diagnostic on host line 1, got ${JSON.stringify(diags.map(d => d.range.start))}`
  );
});

Deno.test("analyzeEmbeddedDocument doesn't flag SDL-only files (caller routes by URI)", () => {
  // SDL syntax is not valid TS but `analyzeEmbeddedDocument` should
  // simply find no `eql\`...\`` literals and return empty. URI-based
  // routing in the server prevents this function from running on .disc
  // files in practice.
  const sdlSource = `module default {\n  type User { required name: str; }\n}`;
  assertEquals(analyzeEmbeddedDocument(sdlSource), []);
});

// =====================================================================
// Phase 6 — findEnclosingEmbeddedQuery
// =====================================================================

Deno.test("findEnclosingEmbeddedQuery returns null when cursor is outside any eql tag", () => {
  const text = "const q = eql`select User`;";
  // Cursor on the `c` of `const`.
  assertEquals(
    findEnclosingEmbeddedQuery(text, { line: 0, character: 0 }),
    null
  );
  // Cursor on the trailing `;`.
  assertEquals(
    findEnclosingEmbeddedQuery(text, { line: 0, character: 26 }),
    null
  );
});

Deno.test("findEnclosingEmbeddedQuery resolves a position inside the embedded string", () => {
  const text = "const q = eql`select User`;";
  // Content starts at column 14 (`const q = ` is 10 chars + `eql\`` is 4).
  // Position the cursor on the `s` of `select` (column 14).
  const enclosing = findEnclosingEmbeddedQuery(text, {
    line: 0,
    character: 14
  });
  assert(enclosing, "expected to be inside the embedded string");
  assertEquals(enclosing.query.content, "select User");
  assertEquals(enclosing.posInQuery, { line: 0, character: 0 });
});

Deno.test("findEnclosingEmbeddedQuery accepts the closing-backtick position (LSP between-chars)", () => {
  const text = "const q = eql`select User`;";
  // Embedded content is 11 chars; cursor at column 14 + 11 = 25 sits
  // at the closing backtick boundary.
  const enclosing = findEnclosingEmbeddedQuery(text, {
    line: 0,
    character: 25
  });
  assert(
    enclosing,
    "expected end-of-content position to resolve to enclosing query"
  );
  assertEquals(enclosing.posInQuery, { line: 0, character: 11 });
});

Deno.test("findEnclosingEmbeddedQuery picks the right query in a multi-query file", () => {
  const text = [
    "const a = eql`select User`;",
    "const b = eql`select Post`;"
  ]
    .join("\n");
  // Cursor inside the second query, on the `P` of `Post`.
  const enclosing = findEnclosingEmbeddedQuery(text, {
    line: 1,
    character: 21
  });
  assert(enclosing);
  assertEquals(enclosing.query.content, "select Post");
});

Deno.test("findEnclosingEmbeddedQuery maps multi-line embedded content to per-query coordinates", () => {
  // Host line 0: `const q = eql\`select User {`  (content starts col 14)
  // Host line 1: `  id`                          (embedded line 1, col 0)
  // Host line 2: `}\``;                          (embedded line 2)
  const text = "const q = eql`select User {\n  id\n}`;";
  // Cursor on the `i` of `id` — host line 1, char 2.
  const enclosing = findEnclosingEmbeddedQuery(text, { line: 1, character: 2 });
  assert(enclosing);
  // Within the embedded string this is line 1 (subsequent lines have
  // column origin 0), char 2.
  assertEquals(enclosing.posInQuery, { line: 1, character: 2 });
});

// =====================================================================
// Phase 6 — provideEmbeddedHover
// =====================================================================

Deno.test("provideEmbeddedHover returns null when cursor is outside any eql tag", () => {
  const text = "const select = 1;"; // `select` is a JS identifier here.
  assertEquals(provideEmbeddedHover(text, { line: 0, character: 8 }), null);
});

Deno.test("provideEmbeddedHover surfaces an EdgeQL keyword when cursor is on one", () => {
  const text = "const q = eql`select User`;";
  // Cursor on `select` (column 14..19).
  const hover = provideEmbeddedHover(text, { line: 0, character: 16 });
  assert(hover, "expected hover for `select`");
  const md = (hover.contents as { value: string; }).value;
  assert(md.includes("**select**"));
  assert(md.includes("EdgeQL keyword"));
});

Deno.test("provideEmbeddedHover surfaces a built-in scalar when cursor is on one", () => {
  // Note: the Phase 5 extractor disqualifies `$` so `eql\`<str>$x\``
  // would be skipped (it can't distinguish EdgeQL parameters from JS
  // template substitutions). We use a literal cast target instead.
  const text = "const q = eql`select <str>'hi'`;";
  // Content starts at column 14; `select <` is 8 chars, so `str`
  // begins at host column 22. Cursor on `t` (column 23).
  const hover = provideEmbeddedHover(text, { line: 0, character: 23 });
  assert(hover, "expected hover for `str`");
  const md = (hover.contents as { value: string; }).value;
  assert(md.includes("**str**"));
  assert(md.includes("scalar"));
});

Deno.test("provideEmbeddedHover returns null on whitespace inside a query", () => {
  const text = "const q = eql`  select User`;";
  // Cursor on the leading space of the embedded string.
  assertEquals(provideEmbeddedHover(text, { line: 0, character: 14 }), null);
});

Deno.test("provideEmbeddedHover returns null for unknown identifiers (e.g. user-defined names)", () => {
  const text = "const q = eql`select MyType`;";
  // Cursor on `MyType` (not an EdgeQL keyword and not a built-in scalar).
  assertEquals(provideEmbeddedHover(text, { line: 0, character: 24 }), null);
});

// =====================================================================
// Phase 6 — provideEmbeddedCompletion
// =====================================================================

Deno.test("provideEmbeddedCompletion returns an empty list outside any eql tag", () => {
  const text = "const q = 1; // no embedded EdgeQL here";
  assertEquals(provideEmbeddedCompletion(text, { line: 0, character: 5 }), []);
});

Deno.test("provideEmbeddedCompletion returns EdgeQL keywords + scalars inside an eql tag", () => {
  const text = "const q = eql`select User`;";
  const items = provideEmbeddedCompletion(text, { line: 0, character: 16 });
  assert(items.length > 0, "expected non-empty completion list");
  const labels = new Set(items.map(i => i.label));
  // EdgeQL-specific keywords are present.
  assert(labels.has("select"));
  assert(labels.has("filter"));
  assert(labels.has("limit"));
  // Built-in scalars are present.
  assert(labels.has("str"));
  assert(labels.has("uuid"));
  // SDL-only keywords (that aren't also EdgeQL) should NOT be present —
  // pick one we deliberately omitted from the EdgeQL list.
  assert(!labels.has("link"));
  assert(!labels.has("policy"));
});

Deno.test("provideEmbeddedCompletion sorts items alphabetically", () => {
  const text = "const q = eql`select User`;";
  const items = provideEmbeddedCompletion(text, { line: 0, character: 16 });
  const labels = items.map(i => i.label);
  const sorted = [...labels].sort((a, b) => a.localeCompare(b));
  assertEquals(labels, sorted);
});

// =====================================================================
// Phase 7 — cross-file SDL resolution from open `.disc` documents
// =====================================================================

const SAMPLE_SDL = [
  "module default {",
  "  type User {",
  "    required email: str;",
  "    name: str;",
  "    posts: Post;",
  "  }",
  "  type Post {",
  "    required title: str;",
  "    body: str;",
  "  }",
  "}"
]
  .join("\n");

function ctxFromSdl(sdl: string): EmbeddedSdlContext {
  return {
    documents: [{ uri: "file:///dbschema/default.disc", text: sdl }]
  };
}

Deno.test("provideEmbeddedHover surfaces a user-defined type from an open .disc document", () => {
  const text = "const q = eql`select User`;";
  // Cursor on `User` (column 21..24).
  const hover = provideEmbeddedHover(
    text,
    { line: 0, character: 22 },
    ctxFromSdl(SAMPLE_SDL)
  );
  assert(hover, "expected hover for user-defined type User");
  const md = (hover.contents as { value: string; }).value;
  assert(md.includes("**User**"), `expected hover to mention User; got: ${md}`);
  assert(md.includes("type"), "expected hover to acknowledge it as a type");
  assert(md.includes("email"), "expected property summary to include email");
});

Deno.test("provideEmbeddedHover keeps EdgeQL keywords ahead of user types on the same word", () => {
  // `User` is a user type, but `select` is an EdgeQL keyword. Hovering
  // `select` shouldn't get redirected to a user-type lookup just
  // because the SDL ctx is supplied.
  const text = "const q = eql`select User`;";
  const hover = provideEmbeddedHover(
    text,
    { line: 0, character: 16 },
    ctxFromSdl(SAMPLE_SDL)
  );
  assert(hover, "expected hover for `select`");
  const md = (hover.contents as { value: string; }).value;
  assert(md.includes("EdgeQL keyword"), `expected keyword hover; got: ${md}`);
});

Deno.test("provideEmbeddedHover returns null for unknown identifiers when ctx provides no match", () => {
  const text = "const q = eql`select MyType`;";
  // `MyType` is neither a keyword/scalar nor declared in SAMPLE_SDL.
  const hover = provideEmbeddedHover(
    text,
    { line: 0, character: 24 },
    ctxFromSdl(SAMPLE_SDL)
  );
  assertEquals(hover, null);
});

Deno.test("provideEmbeddedCompletion appends user-defined type names from open .disc docs", () => {
  const text = "const q = eql`select `;";
  const items = provideEmbeddedCompletion(
    text,
    { line: 0, character: 21 },
    ctxFromSdl(SAMPLE_SDL)
  );
  const labels = new Set(items.map(i => i.label));
  assert(labels.has("User"), "expected User in completion");
  assert(labels.has("Post"), "expected Post in completion");
  // EdgeQL keywords + scalars still present.
  assert(labels.has("select"));
  assert(labels.has("str"));
});

Deno.test("provideEmbeddedCompletion: built-in scalar wins on label collision with a user type", () => {
  // Construct a degenerate SDL with a `str` "type" — completion's
  // built-in `str` (scalar) entry should remain because keywords +
  // scalars are populated first and the Map upsert preserves earlier
  // entries.
  const sdlWithStrCollision = "module default { type str { name: str; } }";
  const items = provideEmbeddedCompletion(
    "const q = eql`select `;",
    { line: 0, character: 21 },
    ctxFromSdl(sdlWithStrCollision)
  );
  const strItem = items.find(i => i.label === "str");
  assert(strItem, "expected str in completion");
  assertEquals(
    strItem.detail,
    "scalar",
    `expected scalar detail, got: ${strItem.detail}`
  );
});

Deno.test("provideEmbeddedDefinition jumps to the type's declaration in the .disc document", () => {
  const text = "const q = eql`select User`;";
  const loc = provideEmbeddedDefinition(
    text,
    { line: 0, character: 22 },
    ctxFromSdl(SAMPLE_SDL)
  );
  assert(loc, "expected a Location for User");
  assertEquals(loc.uri, "file:///dbschema/default.disc");
  // `type User` is on line 1 (0-indexed) of SAMPLE_SDL; the name
  // identifier starts at column 7 (`  type ` = 7 chars).
  assertEquals(loc.range.start.line, 1);
  assertEquals(loc.range.start.character, 7);
});

Deno.test("provideEmbeddedDefinition returns null for EdgeQL keywords and built-in scalars", () => {
  const text = "const q = eql`select User`;";
  // `select` is a keyword — no source location.
  assertEquals(
    provideEmbeddedDefinition(
      text,
      { line: 0, character: 16 },
      ctxFromSdl(SAMPLE_SDL)
    ),
    null
  );
  // `str` (built-in scalar) — no source location.
  const text2 = "const q = eql`select <str>'x'`;";
  assertEquals(
    provideEmbeddedDefinition(
      text2,
      { line: 0, character: 23 },
      ctxFromSdl(SAMPLE_SDL)
    ),
    null
  );
});

Deno.test("provideEmbeddedDefinition returns null when ctx is omitted (Phase 6 callers)", () => {
  const text = "const q = eql`select User`;";
  assertEquals(
    provideEmbeddedDefinition(text, { line: 0, character: 22 }),
    null
  );
});

Deno.test("Phase 7 providers ignore non-.disc context entries silently", () => {
  // The server filters by URI suffix when collecting context, but the
  // providers themselves don't reject non-SDL text — they just won't
  // find any types in it. Confirm with a degenerate ctx.
  const ctx: EmbeddedSdlContext = {
    documents: [{ uri: "file:///app.ts", text: "const x = 1;" }]
  };
  const hover = provideEmbeddedHover(
    "const q = eql`select User`;",
    { line: 0, character: 22 },
    ctx
  );
  assertEquals(hover, null);
});

/**
 * Tests for embedded-EdgeQL diagnostics (LSP Phase 5).
 */

import { assert, assertEquals } from "@std/assert";
import { analyzeEmbeddedDocument, extractEmbeddedQueries, isEmbeddedEqlHost } from "./embedded-edgeql.ts";

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
      "file:///tmp/x.cjs",
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
    "const b = eql`select Post`;",
  ].join("\n");
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
  assert(diags.length > 0, `expected diagnostics for broken EdgeQL, got ${diags.length}`);
  for (const d of diags) {
    assertEquals(d.source, "disc-eql");
    // Diagnostic must land inside the embedded string region of the
    // host (line 0, column ≥ 14 since the content starts at col 14).
    assertEquals(d.range.start.line, 0);
    assert(
      d.range.start.character >= 14,
      `expected diagnostic at col ≥ 14, got ${d.range.start.character}`,
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
    "  @@@invalid`;",
  ].join("\n");
  const diags = analyzeEmbeddedDocument(text);
  assert(diags.length > 0, "expected at least one diagnostic");
  // First diagnostic should be on the second host line.
  const onSecondLine = diags.find((d) => d.range.start.line === 1);
  assert(onSecondLine, `expected at least one diagnostic on host line 1, got ${JSON.stringify(diags.map((d) => d.range.start))}`);
});

Deno.test("analyzeEmbeddedDocument doesn't flag SDL-only files (caller routes by URI)", () => {
  // SDL syntax is not valid TS but `analyzeEmbeddedDocument` should
  // simply find no `eql\`...\`` literals and return empty. URI-based
  // routing in the server prevents this function from running on .disc
  // files in practice.
  const sdlSource = `module default {\n  type User { required name: str; }\n}`;
  assertEquals(analyzeEmbeddedDocument(sdlSource), []);
});

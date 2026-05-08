/**
 * Semantic-tokens provider tests (LSP Phase 8c)
 */

import { assertEquals } from "@std/assert";
import { provideSemanticTokens, SEMANTIC_TOKEN_LEGEND, SEMANTIC_TOKEN_TYPES } from "./semantic-tokens.ts";

function tokenTypeIdx(name: typeof SEMANTIC_TOKEN_TYPES[number]): number {
  return SEMANTIC_TOKEN_TYPES.indexOf(name);
}

Deno.test("SEMANTIC_TOKEN_LEGEND - declares the expected token type ordering", () => {
  // Ordering matters: token data references types by index, so a
  // change here is a wire-protocol change.
  assertEquals(SEMANTIC_TOKEN_LEGEND.tokenTypes, [
    "keyword",
    "type",
    "property",
    "string",
    "number",
    "comment",
    "operator"
  ]);
});

Deno.test("provideSemanticTokens - empty document returns empty data", () => {
  const out = provideSemanticTokens("");
  assertEquals(out.data, []);
});

Deno.test("provideSemanticTokens - keyword maps to `keyword`", () => {
  const out = provideSemanticTokens("module");
  // Single token: deltaLine=0, deltaStart=0, length=6, type=keyword, mod=0
  assertEquals(out.data, [0, 0, 6, tokenTypeIdx("keyword"), 0]);
});

Deno.test("provideSemanticTokens - PascalCase ident maps to `type`", () => {
  const out = provideSemanticTokens("User");
  assertEquals(out.data, [0, 0, 4, tokenTypeIdx("type"), 0]);
});

Deno.test("provideSemanticTokens - lowerCase ident maps to `property`", () => {
  const out = provideSemanticTokens("name");
  assertEquals(out.data, [0, 0, 4, tokenTypeIdx("property"), 0]);
});

Deno.test("provideSemanticTokens - string literal maps to `string`", () => {
  const out = provideSemanticTokens(`"hello"`);
  assertEquals(out.data, [0, 0, 7, tokenTypeIdx("string"), 0]);
});

Deno.test("provideSemanticTokens - integer literal maps to `number`", () => {
  const out = provideSemanticTokens("42");
  assertEquals(out.data, [0, 0, 2, tokenTypeIdx("number"), 0]);
});

Deno.test("provideSemanticTokens - float literal maps to `number`", () => {
  const out = provideSemanticTokens("3.14");
  assertEquals(out.data, [0, 0, 4, tokenTypeIdx("number"), 0]);
});

Deno.test("provideSemanticTokens - multiple tokens on same line use column deltas", () => {
  const out = provideSemanticTokens("type User");
  assertEquals(out.data, [
    // type at (0, 0, 4) — keyword
    0,
    0,
    4,
    tokenTypeIdx("keyword"),
    0,
    // User at (0, 5, 4) — deltaLine=0, deltaStart=5 from prev token's start
    0,
    5,
    4,
    tokenTypeIdx("type"),
    0
  ]);
});

Deno.test("provideSemanticTokens - tokens on different lines use line deltas", () => {
  const out = provideSemanticTokens("module\ntype");
  assertEquals(out.data, [
    // module at line 0
    0,
    0,
    6,
    tokenTypeIdx("keyword"),
    0,
    // type at line 1, deltaStart resets to absolute col 0 since deltaLine > 0
    1,
    0,
    4,
    tokenTypeIdx("keyword"),
    0
  ]);
});

Deno.test("provideSemanticTokens - punctuation/braces are not emitted as tokens", () => {
  // Braces aren't useful semantic-token highlights; the editor's
  // tree-sitter / TextMate grammar handles punctuation already.
  const out = provideSemanticTokens("type User { }");
  // Should have exactly 2 tokens (`type`, `User`).
  assertEquals(out.data.length, 2 * 5);
});

Deno.test("provideSemanticTokens - full SDL block produces valid token stream", () => {
  const text = `module default {
  type User {
    required name: str;
  };
}`;
  const out = provideSemanticTokens(text);
  // Expected tokens, in order:
  //   line 0: module (keyword), default (property)
  //   line 1: type (keyword), User (type)
  //   line 2: required (keyword), name (property), str (property)
  //   line 3: (closing braces — skipped)
  //   line 4: (closing brace — skipped)
  // = 7 tokens × 5 ints each = 35
  assertEquals(out.data.length, 7 * 5);
  // First token is `module` at (0, 0).
  assertEquals(out.data.slice(0, 5), [0, 0, 6, tokenTypeIdx("keyword"), 0]);
});

Deno.test("provideSemanticTokens - emits monotonically non-negative deltas", () => {
  const text = `module default {
  type User { name: str; };
}`;
  const out = provideSemanticTokens(text);
  // Walk every (deltaLine, deltaStart) pair: deltaLine must be ≥0,
  // and when deltaLine === 0, deltaStart must also be ≥0 (LSP requires
  // tokens sorted by position).
  for (let i = 0; i < out.data.length; i += 5) {
    const dl = out.data[i];
    const ds = out.data[i + 1];
    assertEquals(dl >= 0, true, `deltaLine at ${i} must be ≥0; got ${dl}`);
    assertEquals(ds >= 0, true, `deltaStart at ${i} must be ≥0; got ${ds}`);
  }
});

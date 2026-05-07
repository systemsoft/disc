/**
 * Symbol-index tests (#7411 + #655 — Phase 3)
 *
 * The symbol index is a name → range map produced by re-tokenising
 * the document. Used by go-to-definition and document-symbol providers.
 */

import { assert, assertEquals } from "@std/assert";
import { buildSymbolIndex } from "./symbol-index.ts";

Deno.test("buildSymbolIndex - records each type declaration with its range", () => {
  const text = `module default {
  type User {
    required name: str;
  };

  abstract type Timestamped {
    required createdAt: datetime;
  };

  scalar type Status extending enum<a, b>;
}`;
  const idx = buildSymbolIndex(text);
  assertEquals(idx.types.has("User"), true);
  assertEquals(idx.types.has("Timestamped"), true);
  assertEquals(idx.types.has("Status"), true);

  const user = idx.types.get("User")!;
  // Range covers the identifier — line 1 (0-indexed), some character
  // position on `User` after `type `.
  assertEquals(user.kind, "object");
  assertEquals(user.range.start.line, 1);
  assert(
    text.split("\n")[1].slice(user.range.start.character).startsWith("User"),
    `range start should land on 'User'; got line: ${JSON.stringify(text.split("\n")[1])}, char: ${user.range.start.character}`,
  );

  const ts = idx.types.get("Timestamped")!;
  assertEquals(ts.kind, "abstract");

  const stat = idx.types.get("Status")!;
  assertEquals(stat.kind, "scalar");
});

Deno.test("buildSymbolIndex - records type members (properties + links)", () => {
  const text = `module default {
  type User {
    required name: str;
    multi link posts -> Post;
  };
}`;
  const idx = buildSymbolIndex(text);
  const user = idx.types.get("User")!;
  // members is a list keyed by their position in the source
  assertEquals(user.members.length, 2);
  const memberNames = user.members.map((m) => m.name).sort();
  assertEquals(memberNames, ["name", "posts"]);
  // Each has its own range
  for (const m of user.members) {
    assertEquals(m.range.start.line, m.range.end.line);
    assert(m.range.end.character >= m.range.start.character);
  }
});

Deno.test("buildSymbolIndex - tolerates malformed input without throwing", () => {
  const text = `garbage at top
  type Half {
    required ; // missing
  };`;
  const idx = buildSymbolIndex(text);
  // Whatever the lexer recovers from, it must produce *something*.
  // The exact contents are best-effort; the contract is "no throw".
  assert(idx.types instanceof Map);
});

Deno.test("buildSymbolIndex - empty source yields empty index", () => {
  const idx = buildSymbolIndex("");
  assertEquals(idx.types.size, 0);
});

/**
 * Document-symbol tests (#7411 + #655 — Phase 3)
 */

import { assertEquals } from "@std/assert";
import { provideDocumentSymbols } from "./document-symbols.ts";

Deno.test("provideDocumentSymbols - returns one symbol per type with members nested", () => {
  const text = `module default {
  type User {
    required name: str;
    multi link posts -> Post;
  };

  type Post {
    required title: str;
  };
}`;
  const syms = provideDocumentSymbols(text);
  // Two top-level type symbols
  const typeNames = syms.map((s) => s.name).sort();
  assertEquals(typeNames, ["Post", "User"]);

  const user = syms.find((s) => s.name === "User")!;
  // User has two children (name + posts)
  assertEquals(user.children?.length, 2);
  const childNames = (user.children ?? []).map((c) => c.name).sort();
  assertEquals(childNames, ["name", "posts"]);
});

Deno.test("provideDocumentSymbols - kind reflects type variety", () => {
  const text = `module default {
  abstract type Timestamped {
    required createdAt: datetime;
  };

  scalar type Status extending enum<a, b>;

  type User extending Timestamped {
    required name: str;
  };
}`;
  const syms = provideDocumentSymbols(text);
  const user = syms.find((s) => s.name === "User")!;
  const ts = syms.find((s) => s.name === "Timestamped")!;
  const stat = syms.find((s) => s.name === "Status")!;
  // SymbolKind.Class = 5, Interface = 11, Enum = 10 — but we keep
  // them as numeric LSP kinds.
  // Just verify each has *some* kind set, and Status is treated
  // distinctly from a regular type (Enum=10 vs Class=5).
  assertEquals(typeof user.kind, "number");
  assertEquals(typeof ts.kind, "number");
  assertEquals(stat.kind !== user.kind, true);
});

Deno.test("provideDocumentSymbols - empty document returns []", () => {
  assertEquals(provideDocumentSymbols("").length, 0);
});

Deno.test("provideDocumentSymbols - tolerates malformed source", () => {
  const text = `garbage; type Half { typo_here; };`;
  const syms = provideDocumentSymbols(text);
  // Should not throw; may or may not find the type.
  assertEquals(Array.isArray(syms), true);
});

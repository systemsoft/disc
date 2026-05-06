/**
 * Completion provider tests (#7411 + #655 — Phase 2)
 */

import { assert, assertEquals } from "@std/assert";
import { provideCompletion } from "./completion.ts";
import type { Position } from "./protocol.ts";

// Helpers ------------------------------------------------------------------

function findPos(haystack: string, needle: string): Position {
  const offset = haystack.indexOf(needle);
  if (offset === -1) throw new Error(`not found: ${needle}`);
  let line = 0;
  let character = 0;
  for (let i = 0; i < offset; i++) {
    if (haystack[i] === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  return { line, character };
}

function names(items: { label: string }[]): string[] {
  return items.map((i) => i.label).sort();
}

// =========================================================================
// SDL keywords always available
// =========================================================================

Deno.test("provideCompletion - SDL keywords always appear", () => {
  const text = `module default {

}`;
  // Cursor inside the module body, at start of an empty line.
  const items = provideCompletion(text, { line: 1, character: 2 });
  const ns = new Set(names(items));
  assert(ns.has("type"), "missing keyword: type");
  assert(ns.has("abstract"), "missing keyword: abstract");
  assert(ns.has("link"), "missing keyword: link");
  assert(ns.has("required"), "missing keyword: required");
  assert(ns.has("multi"), "missing keyword: multi");
  assert(ns.has("constraint"), "missing keyword: constraint");
});

// =========================================================================
// Scalar types
// =========================================================================

Deno.test("provideCompletion - scalar types appear after a property colon", () => {
  const text = `module default {
  type User {
    required name:
  };
}`;
  // Cursor right after the colon (end of that line)
  const pos = findPos(text, "required name:");
  pos.character += "required name:".length;
  const items = provideCompletion(text, pos);
  const ns = new Set(names(items));
  for (const t of ["str", "int32", "bool", "datetime", "uuid", "json"]) {
    assert(ns.has(t), `missing scalar: ${t}`);
  }
});

// =========================================================================
// User-defined types in the document
// =========================================================================

Deno.test("provideCompletion - includes user-defined types from the document", () => {
  // Well-formed document — recovery in parseWithRecovery would
  // currently drop the whole module on a half-typed declaration;
  // when the doc is parseable the user types must be present.
  const text = `module default {
  type User {
    required name: str;
  };

  type Post {
    required title: str;
  };
}`;
  const items = provideCompletion(text, { line: 0, character: 0 });
  const ns = new Set(names(items));
  assert(ns.has("User"), "User type not in completions");
  assert(ns.has("Post"), "Post type not in completions");
});

Deno.test("provideCompletion - dedupes built-in vs user types of same name", () => {
  // If a user defines `type str`, we should still only return one
  // completion item with that label (otherwise editors show duplicates).
  const text = `module default {
  type str {
    required x: int32;
  };
}`;
  const items = provideCompletion(text, { line: 1, character: 2 });
  const occurrences = items.filter((i) => i.label === "str").length;
  assertEquals(occurrences, 1);
});

// =========================================================================
// Empty document
// =========================================================================

Deno.test("provideCompletion - empty document still yields keyword set", () => {
  const items = provideCompletion("", { line: 0, character: 0 });
  const ns = new Set(names(items));
  assert(ns.has("module"), "missing keyword: module");
});

// =========================================================================
// Out-of-range positions are handled gracefully
// =========================================================================

Deno.test("provideCompletion - position past EOF doesn't throw", () => {
  const items = provideCompletion("module default {}", { line: 99, character: 99 });
  // Returns at least the keyword set; doesn't throw.
  assert(items.length > 0);
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Hover provider tests (#7411 + #655 — Phase 2)
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { provideHover } from "./hover.ts";
import type { Position } from "./protocol.ts";

// Helpers ------------------------------------------------------------------

/**
 * Find the position of a substring `needle` in `haystack` and return
 * the LSP Position pointing at the FIRST character of the match.
 */
function findPos(haystack: string, needle: string): Position {
  const offset = haystack.indexOf(needle);
  if (offset === -1) {
    throw new Error(`needle not found: ${JSON.stringify(needle)}`);
  }
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

// =========================================================================
// Hover on a known scalar type
// =========================================================================

Deno.test("provideHover - hovering 'str' returns the str scalar description", () => {
  const text = `module default {
  type User {
    required name: str;
  };
}`;
  const pos = findPos(text, "str");
  const hover = provideHover(text, pos);
  assertExists(hover, "hover should be defined");
  assertStringIncludes(hover!.contents.value, "str");
  // Markdown content type
  assertEquals(hover!.contents.kind, "markdown");
});

Deno.test("provideHover - hovering 'datetime' returns its description", () => {
  const text = `module default {
  type User {
    required createdAt: datetime;
  };
}`;
  const pos = findPos(text, "datetime");
  const hover = provideHover(text, pos);
  assertExists(hover);
  assertStringIncludes(hover!.contents.value.toLowerCase(), "datetime");
});

// =========================================================================
// Hover on a user-defined type
// =========================================================================

Deno.test("provideHover - hovering a user-defined type name shows its summary", () => {
  const text = `module default {
  type User {
    required name: str;
  };

  type Post {
    required link author -> User;
  };
}`;
  // Position over the `User` reference inside Post
  const userIdx = text.lastIndexOf("User");
  let line = 0;
  let character = 0;
  for (let i = 0; i < userIdx; i++) {
    if (text[i] === "\n") {
      line++;
      character = 0;
    } else {
      character++;
    }
  }
  const hover = provideHover(text, { line, character });
  assertExists(hover);
  // Should mention the type kind and at least one property
  assertStringIncludes(hover!.contents.value, "User");
  // Description includes property list
  assertStringIncludes(hover!.contents.value.toLowerCase(), "name");
});

// =========================================================================
// Hover on whitespace / unrelated text returns null
// =========================================================================

Deno.test("provideHover - hovering whitespace returns null", () => {
  const text = `module default {
  type User {
    required name: str;
  };
}`;
  // Position at column 0 of an empty line section between blocks.
  const hover = provideHover(text, { line: 1, character: 0 });
  assertEquals(hover, null);
});

Deno.test("provideHover - hovering an unknown token returns null", () => {
  const text = `module default {
  type User {
    required name: notARealType;
  };
}`;
  const pos = findPos(text, "notARealType");
  const hover = provideHover(text, pos);
  // No matching type or scalar — nothing useful to say.
  assertEquals(hover, null);
});

// =========================================================================
// Out-of-range positions are handled gracefully
// =========================================================================

Deno.test("provideHover - position past EOF returns null without throwing", () => {
  const text = `module default {}`;
  const hover = provideHover(text, { line: 999, character: 999 });
  assertEquals(hover, null);
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Go-to-definition tests (#7411 + #655 — Phase 3)
 */

import { assertEquals, assertExists } from "@std/assert";
import { provideDefinition } from "./definition.ts";
import type { Position } from "./protocol.ts";

function findPos(haystack: string, needle: string, occurrence = 0): Position {
  let offset = -1;
  for (let i = 0; i <= occurrence; i++) {
    offset = haystack.indexOf(needle, offset + 1);
    if (offset === -1) {
      throw new Error(`needle ${needle} occurrence ${i} not found`);
    }
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

Deno.test("provideDefinition - jumps from type reference to type declaration", () => {
  const text = `module default {
  type User {
    required name: str;
  };

  type Post {
    required link author -> User;
  };
}`;
  // Cursor on the `User` reference inside Post (last occurrence in source)
  const pos = findPos(text, "User", 1);
  const loc = provideDefinition(text, pos, "file:///tmp/x.disc");
  assertExists(loc);
  assertEquals(loc!.uri, "file:///tmp/x.disc");
  // The declaration is the FIRST `User` occurrence — line 1.
  assertEquals(loc!.range.start.line, 1);
});

Deno.test("provideDefinition - cursor on the declaration itself returns its own range", () => {
  const text = `module default {
  type User {
    required name: str;
  };
}`;
  const pos = findPos(text, "User");
  const loc = provideDefinition(text, pos, "file:///t.disc");
  assertExists(loc);
  assertEquals(loc!.range.start.line, 1);
});

Deno.test("provideDefinition - scalar reference returns null (no definition in doc)", () => {
  const text = `module default {
  type User {
    required name: str;
  };
}`;
  const pos = findPos(text, "str");
  const loc = provideDefinition(text, pos, "file:///t.disc");
  // Built-in scalars don't have a declaration in this document.
  assertEquals(loc, null);
});

Deno.test("provideDefinition - unknown identifier returns null", () => {
  const text = `module default {
  type User {
    required name: NotAType;
  };
}`;
  const pos = findPos(text, "NotAType");
  const loc = provideDefinition(text, pos, "file:///t.disc");
  assertEquals(loc, null);
});

Deno.test("provideDefinition - whitespace cursor returns null", () => {
  const text = `module default {

}`;
  const loc = provideDefinition(
    text,
    { line: 1, character: 0 },
    "file:///t.disc"
  );
  assertEquals(loc, null);
});

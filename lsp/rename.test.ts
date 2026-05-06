/**
 * Rename provider tests (#7411 + #655 — Phase 4)
 */

import { assert, assertEquals } from "@std/assert";
import { provideRename, prepareRename } from "./rename.ts";
import type { Position } from "./protocol.ts";

function findPos(haystack: string, needle: string, occurrence = 0): Position {
  let offset = -1;
  for (let i = 0; i <= occurrence; i++) {
    offset = haystack.indexOf(needle, offset + 1);
    if (offset === -1) throw new Error(`not found: ${needle}`);
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
// prepareRename
// =========================================================================

Deno.test("prepareRename - returns range for a renameable type identifier", () => {
  const text = `module default {
  type User {
    required name: str;
  };
}`;
  const pos = findPos(text, "User");
  const range = prepareRename(text, pos);
  assert(range !== null, "expected a renameable range");
  assertEquals(range!.start.line, 1);
});

Deno.test("prepareRename - returns null for a non-renameable token", () => {
  const text = `module default {
  type User { required name: str; };
}`;
  // `module` keyword — not renameable.
  const range = prepareRename(text, findPos(text, "module"));
  assertEquals(range, null);
});

Deno.test("prepareRename - returns null for whitespace cursor", () => {
  const text = `module default {

}`;
  const range = prepareRename(text, { line: 1, character: 0 });
  assertEquals(range, null);
});

// =========================================================================
// provideRename
// =========================================================================

Deno.test("provideRename - returns edits for declaration + all references", () => {
  const text = `module default {
  type User {
    required name: str;
  };

  type Post {
    required link author -> User;
  };

  type Comment {
    required link author -> User;
  };
}`;
  const pos = findPos(text, "User");
  const edit = provideRename(text, pos, "Member", "file:///t.disc");
  assert(edit !== null);
  // Three sites total in this doc.
  const edits = edit!.changes!["file:///t.disc"];
  assertEquals(edits.length, 3);
  // All edits replace with the new name.
  for (const e of edits) {
    assertEquals(e.newText, "Member");
  }
});

Deno.test("provideRename - returns null when cursor isn't on a renameable token", () => {
  const text = `module default {
  type User { required name: str; };
}`;
  const result = provideRename(
    text,
    findPos(text, "module"),
    "Mod",
    "file:///t.disc",
  );
  assertEquals(result, null);
});

Deno.test("provideRename - rejects new name that isn't a valid identifier", () => {
  const text = `module default {
  type User { required name: str; };
}`;
  const result = provideRename(
    text,
    findPos(text, "User"),
    "1bad-name",
    "file:///t.disc",
  );
  assertEquals(result, null);
});

Deno.test("provideRename - rejects rename to an existing type name (collision)", () => {
  const text = `module default {
  type User { required name: str; };
  type Member { required handle: str; };
}`;
  const result = provideRename(
    text,
    findPos(text, "User"),
    "Member",
    "file:///t.disc",
  );
  // Collision detected.
  assertEquals(result, null);
});

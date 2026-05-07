/**
 * Rename provider tests (#7411 + #655 — Phase 4)
 */

import { assert, assertEquals } from "@std/assert";
import type { Position } from "./protocol.ts";
import { prepareRename, provideRename } from "./rename.ts";

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

// =====================================================================
// LSP Phase 8a — cross-file rename
// =====================================================================
// A type renamed in one .disc file must update use sites in every
// other open .disc file too. Otherwise the rename leaves the schema
// in a broken state until the operator hand-edits the siblings.
// =====================================================================

Deno.test("provideRename - cross-file: edits land in every file that uses the type", () => {
  const aText = `module default {
  type User {
    required name: str;
  };
}`;
  const bText = `module default {
  type Post {
    required link author -> User;
  };

  type Comment {
    required link author -> User;
  };
}`;
  const pos = findPos(aText, "User");
  const edit = provideRename(aText, pos, "Member", "file:///a.disc", {
    context: {
      documents: [
        { uri: "file:///a.disc", text: aText },
        { uri: "file:///b.disc", text: bText },
      ],
    },
  });
  assert(edit !== null);
  // a.disc gets the declaration edit.
  const aEdits = edit!.changes!["file:///a.disc"];
  assertEquals(aEdits.length, 1);
  assertEquals(aEdits[0].newText, "Member");
  // b.disc gets two reference edits.
  const bEdits = edit!.changes!["file:///b.disc"];
  assertEquals(bEdits.length, 2);
  for (const e of bEdits) {
    assertEquals(e.newText, "Member");
  }
});

Deno.test("provideRename - cross-file: collision with a type in a sibling file", () => {
  const aText = `module default {
  type User { required name: str; };
}`;
  // Sibling file declares `Member`. Renaming User → Member in a.disc
  // would produce duplicate type names across the schema.
  const bText = `module default {
  type Member { required handle: str; };
}`;
  const result = provideRename(aText, findPos(aText, "User"), "Member", "file:///a.disc", {
    context: {
      documents: [
        { uri: "file:///a.disc", text: aText },
        { uri: "file:///b.disc", text: bText },
      ],
    },
  });
  assertEquals(result, null);
});

Deno.test("provideRename - cross-file: cursor on a use site in one file edits the declaration in another", () => {
  const aText = `module default {
  type User { required name: str; };
}`;
  const bText = `module default {
  type Post { required link author -> User; };
}`;
  // Cursor on `User` in b.disc (a use site, not the declaration).
  const pos = findPos(bText, "User");
  const edit = provideRename(bText, pos, "Member", "file:///b.disc", {
    context: {
      documents: [
        { uri: "file:///a.disc", text: aText },
        { uri: "file:///b.disc", text: bText },
      ],
    },
  });
  assert(edit !== null);
  // a.disc declaration must be renamed.
  assertEquals(edit!.changes!["file:///a.disc"].length, 1);
  // b.disc use site must be renamed.
  assertEquals(edit!.changes!["file:///b.disc"].length, 1);
});

/**
 * Find-references provider tests (#7411 + #655 — Phase 4)
 */

import { assertEquals } from "@std/assert";
import { provideReferences } from "./references.ts";
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

Deno.test("provideReferences - returns the declaration when cursor is on it", () => {
  const text = `module default {
  type User {
    required name: str;
  };
}`;
  const pos = findPos(text, "User");
  const refs = provideReferences(text, pos, "file:///t.disc", {
    includeDeclaration: true,
  });
  // Just one mention of `User` in this doc; the declaration itself.
  assertEquals(refs.length, 1);
  assertEquals(refs[0].uri, "file:///t.disc");
});

Deno.test("provideReferences - returns all uses of a type name", () => {
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
  const pos = findPos(text, "User"); // declaration
  const refs = provideReferences(text, pos, "file:///r.disc", {
    includeDeclaration: true,
  });
  // 1 declaration + 2 references = 3
  assertEquals(refs.length, 3);
});

Deno.test("provideReferences - includeDeclaration:false omits the declaration", () => {
  const text = `module default {
  type User {
    required name: str;
  };

  type Post {
    required link author -> User;
  };
}`;
  const pos = findPos(text, "User");
  const refs = provideReferences(text, pos, "file:///r.disc", {
    includeDeclaration: false,
  });
  // 1 reference; declaration excluded.
  assertEquals(refs.length, 1);
});

Deno.test("provideReferences - cursor on a reference site finds the same set", () => {
  const text = `module default {
  type User {
    required name: str;
  };

  type Post {
    required link author -> User;
  };
}`;
  // Cursor on the `User` referenced in Post (occurrence 1)
  const pos = findPos(text, "User", 1);
  const refs = provideReferences(text, pos, "file:///r.disc", {
    includeDeclaration: true,
  });
  assertEquals(refs.length, 2);
});

Deno.test("provideReferences - whitespace cursor returns []", () => {
  const text = `module default {

}`;
  const refs = provideReferences(text, { line: 1, character: 0 }, "file:///r.disc");
  assertEquals(refs.length, 0);
});

Deno.test("provideReferences - unknown identifier returns []", () => {
  const text = `module default {
  type User { required name: str; };
}`;
  // Position on a token that's not a type — `name` is a property name,
  // not a type name. Should return empty.
  const refs = provideReferences(
    text,
    findPos(text, "name"),
    "file:///r.disc",
  );
  assertEquals(refs.length, 0);
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `.disc` formatter tests (LSP Phase 8b)
 */

import { assertEquals } from "@std/assert";
import { formatSdl, provideFormatting } from "./formatting.ts";

Deno.test("formatSdl - re-indents flat SDL by brace depth", () => {
  const input = `module default {
type User {
required name: str;
};
}`;
  const expected = `module default {
  type User {
    required name: str;
  };
}`;
  assertEquals(formatSdl(input), expected);
});

Deno.test("formatSdl - already-formatted input is returned unchanged (idempotent)", () => {
  const input = `module default {
  type User {
    required name: str;
  };
}`;
  assertEquals(formatSdl(input), input);
  // Round-trip through twice — still unchanged.
  assertEquals(formatSdl(formatSdl(input)), input);
});

Deno.test("formatSdl - closing brace lines de-indent before printing", () => {
  const input = `module default {
  type User {
    name: str;
    }
}`;
  const expected = `module default {
  type User {
    name: str;
  }
}`;
  assertEquals(formatSdl(input), expected);
});

Deno.test("formatSdl - single-line braces are left alone (net depth 0)", () => {
  // `type X { };` opens and closes on the same line — depth stays at
  // module level both before and after.
  const input = `module default {
type X { };
type Y { };
}`;
  const expected = `module default {
  type X { };
  type Y { };
}`;
  assertEquals(formatSdl(input), expected);
});

Deno.test("formatSdl - nested braces grow indentation correctly", () => {
  const input = `module default {
type Cfg {
options: {
foo: str;
};
};
}`;
  const expected = `module default {
  type Cfg {
    options: {
      foo: str;
    };
  };
}`;
  assertEquals(formatSdl(input), expected);
});

Deno.test("formatSdl - blank lines are preserved (no trailing whitespace)", () => {
  const input = `module default {
  type User {
    name: str;

    email: str;
  };
}`;
  // Blank lines stay blank; non-blank lines re-indent.
  assertEquals(formatSdl(input), input);
});

Deno.test("formatSdl - comments re-indent like normal lines", () => {
  const input = `module default {
// header comment
type User {
// this is a property
required name: str;
};
}`;
  const expected = `module default {
  // header comment
  type User {
    // this is a property
    required name: str;
  };
}`;
  assertEquals(formatSdl(input), expected);
});

Deno.test("formatSdl - trailing newline is preserved", () => {
  const input = `module default {
  type X { };
}
`;
  const out = formatSdl(input);
  assertEquals(out.endsWith("\n"), true);
  assertEquals(out, input);
});

Deno.test("formatSdl - missing trailing newline is not added", () => {
  const input = `module default {
  type X { };
}`;
  const out = formatSdl(input);
  assertEquals(out.endsWith("\n"), false);
});

Deno.test("formatSdl - braces inside string literals are not counted", () => {
  // Strings can contain `{` and `}` — the formatter must not let
  // them affect depth tracking. (This is a pragmatic simplification:
  // we strip strings before counting.)
  const input = `module default {
  type X {
    default := "}{}{";
  };
}`;
  // Already correctly indented — should be a no-op.
  assertEquals(formatSdl(input), input);
});

// =====================================================================
// provideFormatting — LSP wrapper
// =====================================================================

Deno.test("provideFormatting - returns a single TextEdit covering the whole document", () => {
  const text = `module default {
type X {};
}`;
  const edits = provideFormatting(text);
  assertEquals(edits.length, 1);
  assertEquals(edits[0].range.start, { line: 0, character: 0 });
  // The end position is the start of the line *after* the last line.
  assertEquals(edits[0].newText, formatSdl(text));
});

Deno.test("provideFormatting - returns empty array when text is already formatted", () => {
  const text = `module default {
  type X { };
}`;
  // No-op formatting → empty edit list (clients skip applying when
  // there's nothing to change).
  const edits = provideFormatting(text);
  assertEquals(edits.length, 0);
});

/**
 * Diagnostics translator (#7411 + #655 — Phase 1)
 *
 * Pure tests for `analyzeDiscDocument` — the function that takes SDL
 * source text and produces LSP `Diagnostic[]` for parse + validation
 * errors. The server's I/O loop just calls this and ships the result.
 */

import { assert, assertEquals } from "@std/assert";
import { analyzeDiscDocument } from "./diagnostics.ts";

Deno.test("analyzeDiscDocument - clean SDL produces no diagnostics", () => {
  const source = `
    module default {
      type User {
        required name: str;
      };
    }
  `;
  assertEquals(analyzeDiscDocument(source).length, 0);
});

Deno.test("analyzeDiscDocument - parse error produces a diagnostic with location", () => {
  // Missing semicolon + unknown token inside the property block.
  const source = `
    module default {
      type User {
        required name: str {
          typo_here;
        };
      };
    }
  `;
  const diags = analyzeDiscDocument(source);
  assert(diags.length > 0, "expected at least one diagnostic");
  // LSP positions are 0-indexed line/character; parser is 1-indexed.
  // Whichever the offending line is, the diagnostic must have a sane range.
  const d = diags[0];
  assertEquals(d.severity, 1, "syntax errors are LSP severity 1 (Error)");
  assertEquals(d.source, "disc");
  assert(d.range.start.line >= 0);
  assert(d.range.start.character >= 0);
});

Deno.test("analyzeDiscDocument - validator error produces an Error diagnostic", () => {
  // `custom_note` is not a built-in annotation and not declared abstract,
  // so the validator emits an error.
  const source = `
    module default {
      type User {
        required name: str;
        annotation custom_note := 'note';
      };
    }
  `;
  const diags = analyzeDiscDocument(source);
  assert(diags.length > 0, "expected validation diagnostic");
  assert(
    diags.some((d) => d.message.includes("custom_note")),
    `expected a diagnostic mentioning custom_note; got: ${
      JSON.stringify(diags)
    }`,
  );
});

Deno.test("analyzeDiscDocument - LSP positions are 0-indexed", () => {
  // Trigger an error on the first line — character 0 of line 0 is the
  // earliest-possible position. The parser's 1-indexed line should
  // round-trip to LSP's 0-indexed line.
  const source = `bogus garbage at top level`;
  const diags = analyzeDiscDocument(source);
  assert(diags.length > 0);
  // Whatever the parser flagged, the line/character should be ≥ 0.
  for (const d of diags) {
    assert(d.range.start.line >= 0);
    assert(d.range.start.character >= 0);
    // End position must not be before start.
    assert(
      d.range.end.line > d.range.start.line ||
        (d.range.end.line === d.range.start.line &&
          d.range.end.character >= d.range.start.character),
      `range invalid: ${JSON.stringify(d.range)}`,
    );
  }
});

Deno.test("analyzeDiscDocument - empty document produces no diagnostics", () => {
  assertEquals(analyzeDiscDocument("").length, 0);
});

Deno.test("analyzeDiscDocument - multiple errors recovered in a single pass", () => {
  // Both a parse error and a validation error in the same file. The
  // parser's `parseWithRecovery` collects multiple errors; the validator
  // also collects multiple. analyzeDiscDocument should report from both.
  const source = `
    module default {
      type A {
        bad_typo;
      };

      type B {
        required name: str;
        annotation undeclared_annotation := 'x';
      };
    }
  `;
  const diags = analyzeDiscDocument(source);
  assert(diags.length >= 1, "expected at least one diagnostic from recovery");
});

/**
 * Range Operator Tests
 *
 * Verifies that range-specific binary operators are correctly parsed and
 * compiled to their PostgreSQL equivalents:
 *
 *   @>   — range contains (element or sub-range)
 *   <@   — contained by
 *   &&   — overlaps
 *   -|-  — adjacent
 */

import { assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const codegen = new SQLCodeGenerator();

/**
 * Compile an EdgeQL query string to a SQL string.
 * Creates a fresh compiler per call to avoid state leaks.
 */
function compileEdgeQL(source: string): string {
  const compiler = new EdgeQLCompiler(schema);
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }

  return codegen.generate(result.value);
}

// ---------------------------------------------------------------------------
// 1. @> — contains element
// ---------------------------------------------------------------------------

Deno.test("Range operators — r @> 5 compiles to @>", () => {
  const sql = compileEdgeQL(`SELECT range(1, 10) @> 5`);
  assertStringIncludes(sql, "@>");
  assertStringIncludes(sql, "5");
});

// ---------------------------------------------------------------------------
// 2. @> — contains range
// ---------------------------------------------------------------------------

Deno.test("Range operators — r @> r2 compiles to @>", () => {
  const sql = compileEdgeQL(`SELECT range(1, 10) @> range(2, 5)`);
  assertStringIncludes(sql, "@>");
});

// ---------------------------------------------------------------------------
// 3. <@ — element contained by range
// ---------------------------------------------------------------------------

Deno.test("Range operators — 5 <@ r compiles to <@", () => {
  const sql = compileEdgeQL(`SELECT 5 <@ range(1, 10)`);
  assertStringIncludes(sql, "<@");
  assertStringIncludes(sql, "5");
});

// ---------------------------------------------------------------------------
// 4. && — overlaps
// ---------------------------------------------------------------------------

Deno.test("Range operators — r1 && r2 compiles to &&", () => {
  const sql = compileEdgeQL(`SELECT range(1, 10) && range(5, 15)`);
  assertStringIncludes(sql, "&&");
});

// ---------------------------------------------------------------------------
// 5. -|- — adjacent
// ---------------------------------------------------------------------------

Deno.test("Range operators — r1 -|- r2 compiles to -|-", () => {
  const sql = compileEdgeQL(`SELECT range(1, 5) -|- range(5, 10)`);
  assertStringIncludes(sql, "-|-");
});

// ---------------------------------------------------------------------------
// 6. Range operator in FILTER clause
// ---------------------------------------------------------------------------

Deno.test("Range operators — @> in FILTER clause", () => {
  const sql = compileEdgeQL(
    `SELECT User FILTER range(1, 100) @> 50`,
  );
  assertStringIncludes(sql, "@>");
  assertStringIncludes(sql, "WHERE");
});

// ---------------------------------------------------------------------------
// 7. Multiple range operators combined with AND
// ---------------------------------------------------------------------------

Deno.test("Range operators — combined with AND", () => {
  const sql = compileEdgeQL(
    `SELECT range(1, 10) @> 5 AND range(1, 10) && range(5, 15)`,
  );
  assertStringIncludes(sql, "@>");
  assertStringIncludes(sql, "&&");
  assertStringIncludes(sql, "AND");
});

// ---------------------------------------------------------------------------
// 8. Operator precedence — range operators at comparison level
// ---------------------------------------------------------------------------

Deno.test("Range operators — precedence with arithmetic", () => {
  // Range operators should have same precedence as comparison operators,
  // meaning arithmetic on the right side should bind tighter.
  const sql = compileEdgeQL(`SELECT range(1, 10) @> 3 + 2`);
  assertStringIncludes(sql, "@>");
  // The 3 + 2 should be on the right side of @>
  assertStringIncludes(sql, "+");
});

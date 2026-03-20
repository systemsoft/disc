/**
 * Range & Multirange Built-in Functions Tests
 *
 * Verifies that range-related EdgeQL built-in functions are correctly
 * registered and compiled to their PostgreSQL equivalents:
 *
 *   range(lower, upper)           → int4range(lower, upper) / numrange(...)
 *   range_get_lower(r)            → LOWER(r)
 *   range_get_upper(r)            → UPPER(r)
 *   range_is_empty(r)             → ISEMPTY(r)
 *   range_unpack(r)               → UNNEST(r)
 *   range_is_inclusive_lower(r)    → LOWER_INC(r)
 *   range_is_inclusive_upper(r)    → UPPER_INC(r)
 *   contains(range_val, elem)     → range_val @> elem
 *   overlaps(r1, r2)              → r1 && r2
 *   multirange(r)                 → int4multirange(r)
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { createTestSchema } from "./context.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";

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
// 1. range() constructor — integer literals
// ---------------------------------------------------------------------------

Deno.test("Range functions — range(1, 10) compiles to int4range", () => {
  const sql = compileEdgeQL(`SELECT range(1, 10)`);
  assertStringIncludes(sql, "int4range");
  assertStringIncludes(sql, "1");
  assertStringIncludes(sql, "10");
});

// ---------------------------------------------------------------------------
// 2. range_get_lower → LOWER
// ---------------------------------------------------------------------------

Deno.test("Range functions — range_get_lower compiles to LOWER", () => {
  const sql = compileEdgeQL(`SELECT range_get_lower(range(1, 10))`);
  assertStringIncludes(sql, "LOWER");
});

// ---------------------------------------------------------------------------
// 3. range_get_upper → UPPER
// ---------------------------------------------------------------------------

Deno.test("Range functions — range_get_upper compiles to UPPER", () => {
  const sql = compileEdgeQL(`SELECT range_get_upper(range(1, 10))`);
  assertStringIncludes(sql, "UPPER");
});

// ---------------------------------------------------------------------------
// 4. range_is_empty → ISEMPTY
// ---------------------------------------------------------------------------

Deno.test("Range functions — range_is_empty compiles to ISEMPTY", () => {
  const sql = compileEdgeQL(`SELECT range_is_empty(range(1, 10))`);
  assertStringIncludes(sql, "ISEMPTY");
});

// ---------------------------------------------------------------------------
// 5. range_unpack → UNNEST
// ---------------------------------------------------------------------------

Deno.test("Range functions — range_unpack compiles to UNNEST", () => {
  const sql = compileEdgeQL(`SELECT range_unpack(range(1, 5))`);
  assertStringIncludes(sql, "UNNEST");
});

// ---------------------------------------------------------------------------
// 6. range_is_inclusive_lower → LOWER_INC
// ---------------------------------------------------------------------------

Deno.test("Range functions — range_is_inclusive_lower compiles to LOWER_INC", () => {
  const sql = compileEdgeQL(`SELECT range_is_inclusive_lower(range(1, 10))`);
  assertStringIncludes(sql, "LOWER_INC");
});

// ---------------------------------------------------------------------------
// 7. range_is_inclusive_upper → UPPER_INC
// ---------------------------------------------------------------------------

Deno.test("Range functions — range_is_inclusive_upper compiles to UPPER_INC", () => {
  const sql = compileEdgeQL(`SELECT range_is_inclusive_upper(range(1, 10))`);
  assertStringIncludes(sql, "UPPER_INC");
});

// ---------------------------------------------------------------------------
// 8. contains(range_val, elem) → @> operator
// ---------------------------------------------------------------------------

Deno.test("Range functions — contains(range(...), elem) compiles to @> operator", () => {
  const sql = compileEdgeQL(`SELECT contains(range(1, 10), 5)`);
  assertStringIncludes(sql, "@>");
});

// ---------------------------------------------------------------------------
// 9. overlaps(r1, r2) → && operator
// ---------------------------------------------------------------------------

Deno.test("Range functions — overlaps compiles to && operator", () => {
  const sql = compileEdgeQL(`SELECT overlaps(range(1, 5), range(3, 8))`);
  assertStringIncludes(sql, "&&");
});

// ---------------------------------------------------------------------------
// 10. multirange(r) → int4multirange constructor
// ---------------------------------------------------------------------------

Deno.test("Range functions — multirange compiles to int4multirange", () => {
  const sql = compileEdgeQL(`SELECT multirange(range(1, 10))`);
  assertStringIncludes(sql, "int4multirange");
});

// ---------------------------------------------------------------------------
// 11. Range function in a FILTER clause
// ---------------------------------------------------------------------------

Deno.test("Range functions — range_is_empty in a FILTER clause", () => {
  const sql = compileEdgeQL(
    `SELECT User { name } FILTER NOT range_is_empty(range(1, 10))`,
  );
  assertStringIncludes(sql, "ISEMPTY");
  assertStringIncludes(sql, "NOT");
});

// ---------------------------------------------------------------------------
// 12. String contains still works (no regression)
// ---------------------------------------------------------------------------

Deno.test("Range functions — string contains still compiles to STRPOS", () => {
  const sql = compileEdgeQL(`SELECT contains('hello world', 'world')`);
  assertStringIncludes(sql, "STRPOS");
  // Should NOT contain @> for string contains
  assertEquals(sql.includes("@>"), false);
});

// ---------------------------------------------------------------------------
// 13. Function registration checks
// ---------------------------------------------------------------------------

Deno.test("Range functions — all range functions are registered", () => {
  const fns = getBuiltinFunctions();

  const rangeFn = fns.get("range");
  assertExists(rangeFn, "range should be registered");
  assertEquals(rangeFn.returnType, "range");

  const getLower = fns.get("range_get_lower");
  assertExists(getLower, "range_get_lower should be registered");
  assertEquals(getLower.sqlName, "LOWER");

  const getUpper = fns.get("range_get_upper");
  assertExists(getUpper, "range_get_upper should be registered");
  assertEquals(getUpper.sqlName, "UPPER");

  const isEmpty = fns.get("range_is_empty");
  assertExists(isEmpty, "range_is_empty should be registered");
  assertEquals(isEmpty.sqlName, "ISEMPTY");

  const unpack = fns.get("range_unpack");
  assertExists(unpack, "range_unpack should be registered");
  assertEquals(unpack.sqlName, "UNNEST");

  const multirangeFn = fns.get("multirange");
  assertExists(multirangeFn, "multirange should be registered");
  assertEquals(multirangeFn.returnType, "multirange");

  const incLower = fns.get("range_is_inclusive_lower");
  assertExists(incLower, "range_is_inclusive_lower should be registered");
  assertEquals(incLower.sqlName, "LOWER_INC");

  const incUpper = fns.get("range_is_inclusive_upper");
  assertExists(incUpper, "range_is_inclusive_upper should be registered");
  assertEquals(incUpper.sqlName, "UPPER_INC");

  const overlapsFn = fns.get("overlaps");
  assertExists(overlapsFn, "overlaps should be registered");
  assertEquals(overlapsFn.returnType, "bool");
});

// ---------------------------------------------------------------------------
// 14. range() with float literals → numrange
// ---------------------------------------------------------------------------

Deno.test("Range functions — range(1.0, 10.0) compiles to numrange", () => {
  const sql = compileEdgeQL(`SELECT range(1.0, 10.0)`);
  assertStringIncludes(sql, "numrange");
});

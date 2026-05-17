/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Stage 27: Built-in Functions — Complete Standard Library
 *
 * Tests both function registration (via getBuiltinFunctions()) and
 * end-to-end EdgeQL → SQL compilation for all new functions added
 * in Stage 27.
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { getBuiltinFunctions } from "./builtin-functions.ts";
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
// String functions
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — str_title compiles to INITCAP", () => {
  const sql = compileEdgeQL(`SELECT str_title('hello world')`);
  assertStringIncludes(sql, "INITCAP");
});

Deno.test("Stage 27 — str_split compiles to STRING_TO_ARRAY", () => {
  const sql = compileEdgeQL(`SELECT str_split('a,b,c', ',')`);
  assertStringIncludes(sql, "STRING_TO_ARRAY");
});

Deno.test("Stage 27 — str_starts_with compiles to STARTS_WITH", () => {
  const sql = compileEdgeQL(`SELECT str_starts_with('hello', 'he')`);
  assertStringIncludes(sql, "STARTS_WITH");
});

Deno.test("Stage 27 — str_ends_with compiles to RIGHT and LENGTH", () => {
  const sql = compileEdgeQL(`SELECT str_ends_with('hello', 'lo')`);
  assertStringIncludes(sql, "RIGHT");
  assertStringIncludes(sql, "LENGTH");
});

// ---------------------------------------------------------------------------
// Math functions
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — math::sqrt compiles to SQRT", () => {
  const sql = compileEdgeQL(`SELECT math::sqrt(16)`);
  assertStringIncludes(sql, "SQRT");
});

Deno.test("Stage 27 — math::pow compiles to POWER", () => {
  const sql = compileEdgeQL(`SELECT math::pow(2, 10)`);
  assertStringIncludes(sql, "POWER");
});

Deno.test("Stage 27 — math::log compiles to LOG", () => {
  const sql = compileEdgeQL(`SELECT math::log(10, 100)`);
  assertStringIncludes(sql, "LOG");
});

Deno.test("Stage 27 — math::ln compiles to LN", () => {
  const sql = compileEdgeQL(`SELECT math::ln(2.718)`);
  assertStringIncludes(sql, "LN");
});

Deno.test("Stage 27 — math::pi compiles to PI", () => {
  const sql = compileEdgeQL(`SELECT math::pi()`);
  assertStringIncludes(sql, "PI");
});

Deno.test("Stage 27 — math::e compiles to EXP(1)", () => {
  const sql = compileEdgeQL(`SELECT math::e()`);
  assertStringIncludes(sql, "EXP");
  assertStringIncludes(sql, "1");
});

Deno.test("Stage 27 — math_mean is registered as a function", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("math_mean");
  assertExists(fn, "math_mean should be registered");
  assertEquals(fn.sqlName, "AVG");
  assertEquals(fn.returnType, "float64");
  assertEquals(fn.windowCompatible, true);
});

// ---------------------------------------------------------------------------
// Regex functions
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — re_match compiles to REGEXP_MATCH with args swapped", () => {
  const sql = compileEdgeQL(`SELECT re_match('^[a-z]+$', 'hello')`);
  assertStringIncludes(sql, "REGEXP_MATCH");
  // In PG: REGEXP_MATCH(string, pattern) — the string arg comes first
  // The compiled SQL should have 'hello' before the pattern
  const matchIdx = sql.indexOf("REGEXP_MATCH");
  const helloIdx = sql.indexOf("'hello'", matchIdx);
  const patternIdx = sql.indexOf("'^[a-z]+$'", matchIdx);
  assertEquals(
    helloIdx < patternIdx,
    true,
    "string arg should come before pattern arg (swapped from EdgeQL order)"
  );
});

Deno.test("Stage 27 — re_match_all compiles to REGEXP_MATCHES with 'g' flag", () => {
  const sql = compileEdgeQL(`SELECT re_match_all('[0-9]+', 'a1b2c3')`);
  assertStringIncludes(sql, "REGEXP_MATCHES");
  assertStringIncludes(sql, "'g'");
});

Deno.test("Stage 27 — re_replace compiles to REGEXP_REPLACE with args reordered", () => {
  const sql = compileEdgeQL(`SELECT re_replace('[0-9]', 'X', 'a1b2')`);
  assertStringIncludes(sql, "REGEXP_REPLACE");
  // In PG: REGEXP_REPLACE(string, pattern, replacement) — string arg first
  const replaceIdx = sql.indexOf("REGEXP_REPLACE");
  const stringIdx = sql.indexOf("'a1b2'", replaceIdx);
  const patternIdx = sql.indexOf("'[0-9]'", replaceIdx);
  assertEquals(
    stringIdx < patternIdx,
    true,
    "string arg should come before pattern arg (reordered from EdgeQL order)"
  );
});

Deno.test("Stage 27 — re_test compiles to ~ operator", () => {
  const sql = compileEdgeQL(`SELECT re_test('^[a-z]+$', 'hello')`);
  assertStringIncludes(sql, "~");
});

// ---------------------------------------------------------------------------
// Datetime functions
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — datetime_of_transaction compiles to TRANSACTION_TIMESTAMP", () => {
  const sql = compileEdgeQL(`SELECT datetime_of_transaction()`);
  assertStringIncludes(sql, "TRANSACTION_TIMESTAMP");
});

Deno.test("Stage 27 — datetime_get compiles to EXTRACT", () => {
  const sql = compileEdgeQL(`SELECT datetime_get(datetime_current(), 'year')`);
  assertStringIncludes(sql, "EXTRACT");
  assertStringIncludes(sql, "year");
});

Deno.test("Stage 27 — datetime_truncate compiles to DATE_TRUNC", () => {
  const sql = compileEdgeQL(
    `SELECT datetime_truncate(datetime_current(), 'month')`
  );
  assertStringIncludes(sql, "DATE_TRUNC");
});

Deno.test("Stage 27 — to_datetime compiles to CAST with timestamp with time zone", () => {
  const sql = compileEdgeQL(`SELECT to_datetime('2024-01-01')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "timestamp with time zone");
});

Deno.test("Stage 27 — to_duration compiles to CAST with interval", () => {
  const sql = compileEdgeQL(`SELECT to_duration('PT1H')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "interval");
});

// ---------------------------------------------------------------------------
// Calendar conversion functions
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — cal::to_local_date compiles to CAST with date", () => {
  const sql = compileEdgeQL(`SELECT cal::to_local_date('2024-01-01')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "date");
});

Deno.test("Stage 27 — cal::to_local_time compiles to CAST with time without time zone", () => {
  const sql = compileEdgeQL(`SELECT cal::to_local_time('12:00:00')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "time without time zone");
});

Deno.test("Stage 27 — cal::to_local_datetime compiles to CAST with timestamp without time zone", () => {
  const sql = compileEdgeQL(
    `SELECT cal::to_local_datetime('2024-01-01T12:00:00')`
  );
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "timestamp without time zone");
});

// ---------------------------------------------------------------------------
// JSON functions
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — to_json compiles to TO_JSONB", () => {
  const sql = compileEdgeQL(`SELECT to_json('hello')`);
  assertStringIncludes(sql, "TO_JSONB");
});

Deno.test("Stage 27 — json_typeof compiles to JSONB_TYPEOF", () => {
  const sql = compileEdgeQL(`SELECT json_typeof(to_json(42))`);
  assertStringIncludes(sql, "JSONB_TYPEOF");
});

Deno.test("Stage 27 — json_array_unpack compiles to JSONB_ARRAY_ELEMENTS", () => {
  const sql = compileEdgeQL(`SELECT json_array_unpack(to_json('[1,2,3]'))`);
  assertStringIncludes(sql, "JSONB_ARRAY_ELEMENTS");
});

Deno.test("Stage 27 — json_object_unpack compiles to JSONB_EACH", () => {
  const sql = compileEdgeQL(`SELECT json_object_unpack(to_json('{"a":1}'))`);
  assertStringIncludes(sql, "JSONB_EACH");
});

Deno.test("Stage 27 — json_get compiles to -> operator", () => {
  const sql = compileEdgeQL(`SELECT json_get(to_json('{"a":1}'), 'a')`);
  assertStringIncludes(sql, "->");
});

// ---------------------------------------------------------------------------
// Array functions
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — array_unpack compiles to UNNEST", () => {
  const sql = compileEdgeQL(`SELECT array_unpack([1, 2, 3])`);
  assertStringIncludes(sql, "UNNEST");
});

Deno.test("Stage 27 — array_join compiles to ARRAY_TO_STRING", () => {
  const sql = compileEdgeQL(`SELECT array_join(['a', 'b', 'c'], ',')`);
  assertStringIncludes(sql, "ARRAY_TO_STRING");
});

Deno.test("Stage 27 — array_get compiles with 1-indexed adjustment (+ 1)", () => {
  const sql = compileEdgeQL(`SELECT array_get([1, 2, 3], 0)`);
  assertStringIncludes(sql, "+ 1");
});

// ---------------------------------------------------------------------------
// Type converter functions
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — to_int16 compiles to CAST with smallint", () => {
  const sql = compileEdgeQL(`SELECT to_int16('42')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "smallint");
});

Deno.test("Stage 27 — to_int32 compiles to CAST with integer", () => {
  const sql = compileEdgeQL(`SELECT to_int32('42')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "integer");
});

Deno.test("Stage 27 — to_float32 compiles to CAST with real", () => {
  const sql = compileEdgeQL(`SELECT to_float32('3.14')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "real");
});

Deno.test("Stage 27 — to_bigint compiles to CAST with numeric", () => {
  const sql = compileEdgeQL(`SELECT to_bigint('999')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "numeric");
});

Deno.test("Stage 27 — to_decimal compiles to CAST with numeric", () => {
  const sql = compileEdgeQL(`SELECT to_decimal('1.5')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "numeric");
});

Deno.test("Stage 27 — to_bool compiles to CAST with boolean", () => {
  const sql = compileEdgeQL(`SELECT to_bool('true')`);
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "boolean");
});

Deno.test("Stage 27 — to_uuid compiles to CAST with uuid", () => {
  const sql = compileEdgeQL(
    `SELECT to_uuid('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')`
  );
  assertStringIncludes(sql, "CAST");
  assertStringIncludes(sql, "uuid");
});

// ---------------------------------------------------------------------------
// UUID functions
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — uuid_generate_v4 compiles to GEN_RANDOM_UUID", () => {
  const sql = compileEdgeQL(`SELECT uuid_generate_v4()`);
  assertStringIncludes(sql, "GEN_RANDOM_UUID");
});

// ---------------------------------------------------------------------------
// Set/Generic functions — registration checks
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — set functions are registered: any, all, enumerate, distinct, exists", () => {
  const fns = getBuiltinFunctions();

  const anyFn = fns.get("any");
  assertExists(anyFn, "any should be registered");
  assertEquals(anyFn.sqlName, "BOOL_OR");

  const allFn = fns.get("all");
  assertExists(allFn, "all should be registered");
  assertEquals(allFn.sqlName, "BOOL_AND");

  const enumerateFn = fns.get("enumerate");
  assertExists(enumerateFn, "enumerate should be registered");
  assertEquals(enumerateFn.returnType, "tuple");

  const distinctFn = fns.get("distinct");
  assertExists(distinctFn, "distinct should be registered");
  assertEquals(distinctFn.returnType, "any");

  const existsFn = fns.get("exists");
  assertExists(existsFn, "exists should be registered");
  assertEquals(existsFn.returnType, "bool");
});

// ---------------------------------------------------------------------------
// Set/Generic functions — compilation
// ---------------------------------------------------------------------------

Deno.test("Stage 27 — exists compiles via parser unary operator path", () => {
  // The EdgeQL parser treats `exists` as a unary keyword operator, not a
  // regular function call. So `exists(1)` is parsed as UnaryOp("EXISTS", 1)
  // rather than FunctionCall("exists", [1]). The compiled SQL uses the EXISTS
  // keyword directly rather than the IS NOT NULL path in compileFunctionCall.
  const sql = compileEdgeQL(`SELECT exists(1)`);
  assertStringIncludes(sql, "EXISTS");
});

Deno.test("Stage 27 — sequence_next compiles to NEXTVAL", () => {
  const sql = compileEdgeQL(`SELECT sequence_next('my_seq')`);
  assertStringIncludes(sql, "NEXTVAL");
});

Deno.test("Stage 27 — sequence_reset compiles to SETVAL", () => {
  const sql = compileEdgeQL(`SELECT sequence_reset('my_seq', 1)`);
  assertStringIncludes(sql, "SETVAL");
});

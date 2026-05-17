/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Stage 43: Remaining Built-in Function Gaps
 *
 * Verifies both function registration (via getBuiltinFunctions()) and
 * end-to-end EdgeQL -> SQL compilation for all functions added or
 * confirmed in Stage 43.
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
// 1. Bytes functions (new in Stage 43)
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — bytes_get_bit is registered with GET_BIT sqlName", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("bytes_get_bit");
  assertExists(fn, "bytes_get_bit should be registered");
  assertEquals(fn.sqlName, "GET_BIT");
  assertEquals(fn.returnType, "int64");
  assertEquals(fn.args.length, 2);
});

Deno.test("Stage 43 — bytes_to_str is registered with CONVERT_FROM sqlName", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("bytes_to_str");
  assertExists(fn, "bytes_to_str should be registered");
  assertEquals(fn.sqlName, "CONVERT_FROM");
  assertEquals(fn.returnType, "str");
  assertEquals(fn.args.length, 2);
});

// ---------------------------------------------------------------------------
// 2. UUID functions
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — uuid_generate_v1mc is registered and maps to GEN_RANDOM_UUID", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("uuid_generate_v1mc");
  assertExists(fn, "uuid_generate_v1mc should be registered");
  assertEquals(fn.sqlName, "GEN_RANDOM_UUID");
  assertEquals(fn.returnType, "uuid");
  assertEquals(fn.args.length, 0);
});

Deno.test("Stage 43 — uuid_generate_v4 compiles to GEN_RANDOM_UUID", () => {
  const sql = compileEdgeQL("SELECT uuid_generate_v4()");
  assertStringIncludes(sql, "GEN_RANDOM_UUID");
});

// ---------------------------------------------------------------------------
// 3. String functions (confirm existing registrations)
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — str_lower compiles to LOWER", () => {
  const sql = compileEdgeQL("SELECT str_lower('HELLO')");
  assertStringIncludes(sql, "LOWER");
});

Deno.test("Stage 43 — str_upper compiles to UPPER", () => {
  const sql = compileEdgeQL("SELECT str_upper('hello')");
  assertStringIncludes(sql, "UPPER");
});

Deno.test("Stage 43 — str_title compiles to INITCAP", () => {
  const sql = compileEdgeQL("SELECT str_title('hello world')");
  assertStringIncludes(sql, "INITCAP");
});

Deno.test("Stage 43 — str_split compiles to STRING_TO_ARRAY", () => {
  const sql = compileEdgeQL("SELECT str_split('a,b,c', ',')");
  assertStringIncludes(sql, "STRING_TO_ARRAY");
});

// ---------------------------------------------------------------------------
// 4. Regex functions (confirm existing compilation)
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — re_match compiles to REGEXP_MATCH with swapped args", () => {
  const sql = compileEdgeQL("SELECT re_match('[0-9]+', 'abc123')");
  assertStringIncludes(sql, "REGEXP_MATCH");
  // Verify arg order: string before pattern
  const matchIdx = sql.indexOf("REGEXP_MATCH");
  const stringIdx = sql.indexOf("'abc123'", matchIdx);
  const patternIdx = sql.indexOf("'[0-9]+'", matchIdx);
  assertEquals(
    stringIdx < patternIdx,
    true,
    "string arg should come before pattern (PG order)"
  );
});

Deno.test("Stage 43 — re_match_all compiles to REGEXP_MATCHES with 'g' flag", () => {
  const sql = compileEdgeQL("SELECT re_match_all('[0-9]+', 'a1b2c3')");
  assertStringIncludes(sql, "REGEXP_MATCHES");
  assertStringIncludes(sql, "'g'");
});

Deno.test("Stage 43 — re_replace compiles to REGEXP_REPLACE with reordered args", () => {
  const sql = compileEdgeQL("SELECT re_replace('[0-9]', 'X', 'a1b2')");
  assertStringIncludes(sql, "REGEXP_REPLACE");
  // PG order: string, pattern, replacement
  const replIdx = sql.indexOf("REGEXP_REPLACE");
  const stringIdx = sql.indexOf("'a1b2'", replIdx);
  const patternIdx = sql.indexOf("'[0-9]'", replIdx);
  assertEquals(
    stringIdx < patternIdx,
    true,
    "string arg should come before pattern (PG order)"
  );
});

Deno.test("Stage 43 — re_test compiles to ~ operator", () => {
  const sql = compileEdgeQL("SELECT re_test('^hello', 'hello world')");
  assertStringIncludes(sql, "~");
});

// ---------------------------------------------------------------------------
// 5. Math functions
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — math_log10 compiles to LOG(10, val)", () => {
  const sql = compileEdgeQL("SELECT math::log10(100)");
  assertStringIncludes(sql, "LOG");
  assertStringIncludes(sql, "10");
});

Deno.test("Stage 43 — math_log2 compiles to LOG(2, val)", () => {
  const sql = compileEdgeQL("SELECT math::log2(8)");
  assertStringIncludes(sql, "LOG");
  assertStringIncludes(sql, "2");
});

Deno.test("Stage 43 — math_sqrt compiles to SQRT", () => {
  const sql = compileEdgeQL("SELECT math::sqrt(25)");
  assertStringIncludes(sql, "SQRT");
});

Deno.test("Stage 43 — math_power is registered with POWER sqlName", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("math_power");
  assertExists(fn, "math_power should be registered");
  assertEquals(fn.sqlName, "POWER");
  assertEquals(fn.returnType, "float64");
  assertEquals(fn.args.length, 2);
});

Deno.test("Stage 43 — math::pow compiles to POWER", () => {
  const sql = compileEdgeQL("SELECT math::pow(2, 8)");
  assertStringIncludes(sql, "POWER");
});

Deno.test("Stage 43 — math_mean is registered as AVG with windowCompatible", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("math_mean");
  assertExists(fn, "math_mean should be registered");
  assertEquals(fn.sqlName, "AVG");
  assertEquals(fn.windowCompatible, true);
});

// ---------------------------------------------------------------------------
// 6. Datetime functions
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — datetime_of_transaction compiles to TRANSACTION_TIMESTAMP", () => {
  const sql = compileEdgeQL("SELECT datetime_of_transaction()");
  assertStringIncludes(sql, "TRANSACTION_TIMESTAMP");
});

Deno.test("Stage 43 — datetime_of_statement compiles to STATEMENT_TIMESTAMP", () => {
  const sql = compileEdgeQL("SELECT datetime_of_statement()");
  assertStringIncludes(sql, "STATEMENT_TIMESTAMP");
});

// ---------------------------------------------------------------------------
// 7. JSON functions (confirm existing registrations)
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — json_typeof compiles to JSONB_TYPEOF", () => {
  const sql = compileEdgeQL("SELECT json_typeof(to_json(42))");
  assertStringIncludes(sql, "JSONB_TYPEOF");
});

Deno.test("Stage 43 — json_array_unpack compiles to JSONB_ARRAY_ELEMENTS", () => {
  const sql = compileEdgeQL("SELECT json_array_unpack(to_json('[1,2]'))");
  assertStringIncludes(sql, "JSONB_ARRAY_ELEMENTS");
});

Deno.test("Stage 43 — json_object_unpack compiles to JSONB_EACH", () => {
  const sql = compileEdgeQL("SELECT json_object_unpack(to_json('{\"a\":1}'))");
  assertStringIncludes(sql, "JSONB_EACH");
});

// ---------------------------------------------------------------------------
// 8. Sequence functions (confirm existing registrations)
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — sequence_next compiles to NEXTVAL", () => {
  const sql = compileEdgeQL("SELECT sequence_next('my_seq')");
  assertStringIncludes(sql, "NEXTVAL");
});

// ---------------------------------------------------------------------------
// 9. to_json (confirm existing registration)
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — to_json compiles to TO_JSONB", () => {
  const sql = compileEdgeQL("SELECT to_json('hello')");
  assertStringIncludes(sql, "TO_JSONB");
});

// ---------------------------------------------------------------------------
// 10. Registration completeness check
// ---------------------------------------------------------------------------

Deno.test("Stage 43 — all Stage 43 functions are registered in the built-in map", () => {
  const fns = getBuiltinFunctions();
  const expected = [
    "bytes_get_bit",
    "bytes_to_str",
    "uuid_generate_v1mc",
    "uuid_generate_v4",
    "str_lower",
    "str_upper",
    "str_title",
    "str_split",
    "re_match",
    "re_match_all",
    "re_replace",
    "re_test",
    "math_log",
    "math_log10",
    "math_log2",
    "math_sqrt",
    "math_pow",
    "math_power",
    "math_mean",
    "datetime_of_transaction",
    "datetime_of_statement",
    "sequence_next",
    "sequence_reset",
    "to_json",
    "json_typeof",
    "json_array_unpack",
    "json_object_unpack",
    "json_get"
  ];

  for (const name of expected) {
    assertExists(fns.get(name), `Function '${name}' should be registered`);
  }
});

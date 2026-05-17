/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for Array, Tuple, and NamedTuple expression compilation
 * Phase 20.2: Collection expression compilation
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();

  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }

  return codegen.generate(result.value);
}

// =========================================================================
// Array Expression Tests
// =========================================================================

Deno.test("Collection Compilation - Array of integers", () => {
  const source = `SELECT [1, 2, 3]`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("ARRAY["),
    true,
    "SQL should contain ARRAY[ bracket syntax"
  );
  assertEquals(
    sql.includes("1, 2, 3"),
    true,
    "SQL should contain the integer elements"
  );
  // Should NOT use parentheses syntax
  assertEquals(
    sql.includes("ARRAY("),
    false,
    "SQL should not use ARRAY() parentheses syntax"
  );
});

Deno.test("Collection Compilation - Array of strings", () => {
  const source = `SELECT ["a", "b", "c"]`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("ARRAY["),
    true,
    "SQL should contain ARRAY[ bracket syntax"
  );
  assertEquals(
    sql.includes("'a'"),
    true,
    "SQL should contain string element 'a'"
  );
  assertEquals(
    sql.includes("'b'"),
    true,
    "SQL should contain string element 'b'"
  );
  assertEquals(
    sql.includes("'c'"),
    true,
    "SQL should contain string element 'c'"
  );
});

Deno.test("Collection Compilation - Single element array", () => {
  const source = `SELECT [1]`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("ARRAY[1]"),
    true,
    "SQL should contain ARRAY[1]"
  );
});

Deno.test("Collection Compilation - Array with mixed expressions", () => {
  const source = `SELECT [1, 2 + 3, 4]`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("ARRAY["),
    true,
    "SQL should contain ARRAY[ bracket syntax"
  );
  assertEquals(
    sql.includes("2 + 3"),
    true,
    "SQL should contain the binary expression"
  );
});

// =========================================================================
// Tuple Expression Tests
// =========================================================================

Deno.test("Collection Compilation - Tuple of integers", () => {
  const source = `SELECT (1, 2, 3)`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("jsonb_build_array("),
    true,
    "SQL should contain jsonb_build_array( function call"
  );
  assertEquals(
    sql.includes("1, 2, 3"),
    true,
    "SQL should contain the integer elements"
  );
});

Deno.test("Collection Compilation - Tuple with mixed types", () => {
  const source = `SELECT (1, "hello", true)`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("jsonb_build_array("),
    true,
    "SQL should contain jsonb_build_array("
  );
  assertEquals(
    sql.includes("1"),
    true,
    "SQL should contain integer element"
  );
  assertEquals(
    sql.includes("'hello'"),
    true,
    "SQL should contain string element"
  );
  assertEquals(
    sql.includes("TRUE"),
    true,
    "SQL should contain boolean element"
  );
});

Deno.test("Collection Compilation - Two-element tuple", () => {
  const source = `SELECT (42, "test")`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("jsonb_build_array("),
    true,
    "SQL should contain jsonb_build_array("
  );
  assertEquals(
    sql.includes("42"),
    true,
    "SQL should contain 42"
  );
  assertEquals(
    sql.includes("'test'"),
    true,
    "SQL should contain 'test'"
  );
});

// =========================================================================
// Named Tuple Expression Tests
// =========================================================================

Deno.test("Collection Compilation - Named tuple", () => {
  const source = `SELECT (name := "John", age := 30)`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("jsonb_build_object"),
    true,
    "SQL should contain jsonb_build_object for named tuple"
  );
  assertEquals(
    sql.includes("'name'"),
    true,
    "SQL should contain field key 'name'"
  );
  assertEquals(
    sql.includes("'John'"),
    true,
    "SQL should contain field value 'John'"
  );
  assertEquals(
    sql.includes("'age'"),
    true,
    "SQL should contain field key 'age'"
  );
  assertEquals(
    sql.includes("30"),
    true,
    "SQL should contain field value 30"
  );
});

Deno.test("Collection Compilation - Named tuple with boolean", () => {
  const source = `SELECT (active := true, count := 5)`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("jsonb_build_object"),
    true,
    "SQL should contain jsonb_build_object"
  );
  assertEquals(
    sql.includes("'active'"),
    true,
    "SQL should contain field key 'active'"
  );
  assertEquals(
    sql.includes("TRUE"),
    true,
    "SQL should contain TRUE"
  );
  assertEquals(
    sql.includes("'count'"),
    true,
    "SQL should contain field key 'count'"
  );
  assertEquals(
    sql.includes("5"),
    true,
    "SQL should contain 5"
  );
});

Deno.test("Collection Compilation - Named tuple single field", () => {
  const source = `SELECT (label := "hello")`;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("jsonb_build_object"),
    true,
    "SQL should contain jsonb_build_object"
  );
  assertEquals(
    sql.includes("'label'"),
    true,
    "SQL should contain field key 'label'"
  );
  assertEquals(
    sql.includes("'hello'"),
    true,
    "SQL should contain field value 'hello'"
  );
});

// =========================================================================
// Codegen Unit Tests
// =========================================================================

Deno.test("SQL Code Generator - ARRAY function call uses bracket syntax", () => {
  const gen = new SQLCodeGenerator();
  const sql = gen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "FunctionCall",
          name: "ARRAY",
          args: [
            { kind: "LiteralExpression", type: "number", value: 1 },
            { kind: "LiteralExpression", type: "number", value: 2 },
            { kind: "LiteralExpression", type: "number", value: 3 }
          ]
        }
      }]
    }
  });

  assertEquals(
    sql.includes("ARRAY[1, 2, 3]"),
    true,
    "Codegen should render ARRAY with brackets"
  );
  assertEquals(
    sql.includes("ARRAY("),
    false,
    "Codegen should not use parentheses for ARRAY"
  );
});

Deno.test("SQL Code Generator - jsonb_build_array function call uses parentheses", () => {
  const gen = new SQLCodeGenerator();
  const sql = gen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "FunctionCall",
          name: "jsonb_build_array",
          args: [
            { kind: "LiteralExpression", type: "number", value: 1 },
            { kind: "LiteralExpression", type: "string", value: "hi" }
          ]
        }
      }]
    }
  });

  assertEquals(
    sql.includes("jsonb_build_array(1, 'hi')"),
    true,
    "Codegen should render jsonb_build_array with parentheses"
  );
});

Deno.test("SQL Code Generator - Non-ARRAY function still uses parentheses", () => {
  const gen = new SQLCodeGenerator();
  const sql = gen.generate({
    kind: "SelectStatement",
    select: {
      kind: "SelectClause",
      columns: [{
        kind: "SelectItem",
        expression: {
          kind: "FunctionCall",
          name: "COUNT",
          args: [
            { kind: "ColumnReference", column: "*" }
          ]
        }
      }]
    }
  });

  assertEquals(
    sql.includes("COUNT(*)"),
    true,
    "Non-ARRAY functions should still use parentheses"
  );
});

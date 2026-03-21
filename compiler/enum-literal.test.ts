/**
 * Tests for enum literal compilation (e.g., Status.active → 'active'::status)
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { createTestSchema, getEnumSqlType, isEnumType } from "./context.ts";
import { CompilationError } from "../lib/errors.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const result = compiler.compile(ast);
  if (!result.ok) throw result.error;
  return codegen.generate(result.value);
}

// =========================================================================
// Helper Function Tests
// =========================================================================

Deno.test("isEnumType - returns true for enum types", () => {
  assertEquals(isEnumType(schema, "Status"), true);
});

Deno.test("isEnumType - returns false for object types", () => {
  assertEquals(isEnumType(schema, "User"), false);
  assertEquals(isEnumType(schema, "Post"), false);
});

Deno.test("isEnumType - returns false for unknown types", () => {
  assertEquals(isEnumType(schema, "NonExistent"), false);
});

Deno.test("getEnumSqlType - converts PascalCase to snake_case", () => {
  assertEquals(getEnumSqlType("Status"), "status");
  assertEquals(getEnumSqlType("UserRole"), "user_role");
  assertEquals(getEnumSqlType("OrderStatus"), "order_status");
  // All-caps sequences stay lowercased together (no word boundary detection)
  assertEquals(getEnumSqlType("HTTPMethod"), "httpmethod");
});

// =========================================================================
// Enum Literal in FILTER Expression
// =========================================================================

Deno.test("enum literal - in filter expression", () => {
  const source = `SELECT User FILTER .status = Status.active`;
  const sql = compileEdgeQL(source);

  assertStringIncludes(sql, "'active'::status");
  assertStringIncludes(sql, "WHERE");
});

// =========================================================================
// Enum Literal in INSERT
// =========================================================================

Deno.test("enum literal - in insert value", () => {
  const source =
    `INSERT User { name := "Ada", email := "ada@example.com", status := Status.pending }`;

  // The User type doesn't have a status property in createTestSchema,
  // so we need a schema with that property for a full INSERT test.
  // Instead, test the expression compilation directly by using it in a
  // SELECT context where it can be verified.
  const selectSource = `SELECT Status.pending`;
  const sql = compileEdgeQL(selectSource);

  assertStringIncludes(sql, "'pending'::status");
});

// =========================================================================
// Enum Literal in IF/ELSE
// =========================================================================

Deno.test("enum literal - in if/else expression", () => {
  const source = `SELECT "yes" IF Status.active = Status.active ELSE "no"`;
  const sql = compileEdgeQL(source);

  assertStringIncludes(sql, "CASE");
  assertStringIncludes(sql, "'active'::status");
  assertStringIncludes(sql, "'yes'");
  assertStringIncludes(sql, "'no'");
});

// =========================================================================
// Unknown Enum Member Error
// =========================================================================

Deno.test("enum literal - unknown member throws CompilationError", () => {
  const source = `SELECT Status.nonexistent`;

  assertThrows(
    () => {
      compileEdgeQL(source);
    },
    CompilationError,
    "is not a member of enum type",
  );
});

// =========================================================================
// Non-Enum Path Unaffected
// =========================================================================

Deno.test("enum literal - non-enum path is not treated as enum literal", () => {
  const source = `SELECT User.name`;
  const sql = compileEdgeQL(source);

  // User.name should compile to a column reference, not an enum cast
  assertEquals(
    sql.includes("::"),
    false,
    "Non-enum path should not have a type cast",
  );
  assertStringIncludes(sql, "name");
  assertStringIncludes(sql, "FROM");
  assertStringIncludes(sql, "users");
});

// =========================================================================
// Multiple Enum References in One Query
// =========================================================================

Deno.test("enum literal - multiple enum references in one query", () => {
  const source =
    `SELECT "match" IF Status.active = Status.active ELSE "no match"`;
  const sql = compileEdgeQL(source);

  // Both enum references should be compiled
  assertStringIncludes(sql, "'active'::status");
  // Count occurrences: should appear twice (once for each reference)
  const matches = sql.match(/'active'::status/g) || [];
  assertEquals(
    matches.length,
    2,
    "Should contain two enum literal references",
  );
});

// =========================================================================
// Enum in Comparison Expression
// =========================================================================

Deno.test("enum literal - in comparison expression", () => {
  const source = `SELECT Status.active = Status.inactive`;
  const sql = compileEdgeQL(source);

  assertStringIncludes(sql, "'active'::status");
  assertStringIncludes(sql, "'inactive'::status");
  assertStringIncludes(sql, "=");
});

// =========================================================================
// Case Sensitivity: Enum Member Must Match Exactly
// =========================================================================

Deno.test("enum literal - case sensitivity (exact match required)", () => {
  // "Active" (capital A) is not a valid member; only "active" (lowercase) is
  const source = `SELECT Status.Active`;

  assertThrows(
    () => {
      compileEdgeQL(source);
    },
    CompilationError,
    "is not a member of enum type",
  );
});

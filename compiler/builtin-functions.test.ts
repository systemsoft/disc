/**
 * Tests for the built-in functions registry
 */

import { assertEquals, assertExists } from "@std/assert";
import { getBuiltinFunctions } from "./builtin-functions.ts";

Deno.test("getBuiltinFunctions returns a Map with at least 12 entries", () => {
  const fns = getBuiltinFunctions();
  assertEquals(fns instanceof Map, true);
  assertEquals(
    fns.size >= 12,
    true,
    `Expected at least 12 functions, got ${fns.size}`,
  );
});

Deno.test("every entry has a valid FunctionDef shape", () => {
  const fns = getBuiltinFunctions();

  for (const [key, def] of fns) {
    assertEquals(typeof def.name, "string", `${key}: name should be a string`);
    assertEquals(def.name, key, `${key}: name should match the map key`);
    assertEquals(
      Array.isArray(def.args),
      true,
      `${key}: args should be an array`,
    );
    assertEquals(
      typeof def.returnType,
      "string",
      `${key}: returnType should be a string`,
    );

    for (const arg of def.args) {
      assertEquals(
        typeof arg.name,
        "string",
        `${key}: arg name should be a string`,
      );
      assertEquals(
        typeof arg.type,
        "string",
        `${key}: arg type should be a string`,
      );
      assertEquals(
        typeof arg.required,
        "boolean",
        `${key}: arg required should be a boolean`,
      );
    }
  }
});

Deno.test("count maps to SQL COUNT with return type int64", () => {
  const fns = getBuiltinFunctions();
  const count = fns.get("count");
  assertExists(count);
  assertEquals(count.sqlName, "COUNT");
  assertEquals(count.returnType, "int64");
  assertEquals(count.args.length, 1);
});

Deno.test("len maps to SQL LENGTH with return type int64", () => {
  const fns = getBuiltinFunctions();
  const len = fns.get("len");
  assertExists(len);
  assertEquals(len.sqlName, "LENGTH");
  assertEquals(len.returnType, "int64");
});

Deno.test("datetime_current maps to SQL NOW with return type datetime", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("datetime_current");
  assertExists(fn);
  assertEquals(fn.sqlName, "NOW");
  assertEquals(fn.returnType, "datetime");
  assertEquals(fn.args.length, 0);
});

Deno.test("datetime_of_statement maps to SQL STATEMENT_TIMESTAMP with return type datetime", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("datetime_of_statement");
  assertExists(fn);
  assertEquals(fn.sqlName, "STATEMENT_TIMESTAMP");
  assertEquals(fn.returnType, "datetime");
  assertEquals(fn.args.length, 0);
});

Deno.test("str_lower maps to SQL LOWER with return type str", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("str_lower");
  assertExists(fn);
  assertEquals(fn.sqlName, "LOWER");
  assertEquals(fn.returnType, "str");
});

Deno.test("str_upper maps to SQL UPPER with return type str", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("str_upper");
  assertExists(fn);
  assertEquals(fn.sqlName, "UPPER");
  assertEquals(fn.returnType, "str");
});

Deno.test("min maps to SQL MIN with return type int64", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("min");
  assertExists(fn);
  assertEquals(fn.sqlName, "MIN");
  assertEquals(fn.returnType, "int64");
});

Deno.test("max maps to SQL MAX with return type int64", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("max");
  assertExists(fn);
  assertEquals(fn.sqlName, "MAX");
  assertEquals(fn.returnType, "int64");
});

Deno.test("sum maps to SQL SUM with return type int64", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("sum");
  assertExists(fn);
  assertEquals(fn.sqlName, "SUM");
  assertEquals(fn.returnType, "int64");
});

Deno.test("array_agg maps to SQL ARRAY_AGG with return type array", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("array_agg");
  assertExists(fn);
  assertEquals(fn.sqlName, "ARRAY_AGG");
  assertEquals(fn.returnType, "array");
});

Deno.test("assert_exists is a pass-through with no sqlName", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("assert_exists");
  assertExists(fn);
  assertEquals(fn.sqlName, undefined);
  assertEquals(fn.returnType, "any");
  assertEquals(fn.args.length, 1);
});

Deno.test("assert_single is a pass-through with no sqlName", () => {
  const fns = getBuiltinFunctions();
  const fn = fns.get("assert_single");
  assertExists(fn);
  assertEquals(fn.sqlName, undefined);
  assertEquals(fn.returnType, "any");
  assertEquals(fn.args.length, 1);
});

Deno.test("each call returns a fresh Map instance", () => {
  const fns1 = getBuiltinFunctions();
  const fns2 = getBuiltinFunctions();
  assertEquals(fns1 !== fns2, true, "should return distinct Map instances");
  assertEquals(
    fns1.size,
    fns2.size,
    "both should have the same number of entries",
  );
});

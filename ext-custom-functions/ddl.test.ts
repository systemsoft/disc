/**
 * Tests for DDL generation utilities
 */

import { assertEquals, assertThrows } from "@std/assert";
import {
  generateCreateFunction,
  generateDropFunction,
  mapEdgeqlTypeToPg,
} from "./ddl.ts";
import { ExtensionConfigError } from "../extensions/errors.ts";
import type { CustomFunctionDef } from "./types.ts";

// ── mapEdgeqlTypeToPg ─────────────────────────────────────────────────

Deno.test("mapEdgeqlTypeToPg - maps str to text", () => {
  assertEquals(mapEdgeqlTypeToPg("str"), "text");
});

Deno.test("mapEdgeqlTypeToPg - maps int64 to bigint", () => {
  assertEquals(mapEdgeqlTypeToPg("int64"), "bigint");
});

Deno.test("mapEdgeqlTypeToPg - maps float64 to double precision", () => {
  assertEquals(mapEdgeqlTypeToPg("float64"), "double precision");
});

Deno.test("mapEdgeqlTypeToPg - maps bool to boolean", () => {
  assertEquals(mapEdgeqlTypeToPg("bool"), "boolean");
});

Deno.test("mapEdgeqlTypeToPg - maps uuid to uuid", () => {
  assertEquals(mapEdgeqlTypeToPg("uuid"), "uuid");
});

Deno.test("mapEdgeqlTypeToPg - maps datetime to timestamptz", () => {
  assertEquals(mapEdgeqlTypeToPg("datetime"), "timestamptz");
});

Deno.test("mapEdgeqlTypeToPg - maps json to jsonb", () => {
  assertEquals(mapEdgeqlTypeToPg("json"), "jsonb");
});

Deno.test("mapEdgeqlTypeToPg - throws ExtensionConfigError for unknown type", () => {
  assertThrows(
    () => mapEdgeqlTypeToPg("notatype"),
    ExtensionConfigError,
    "Unknown EdgeQL type: notatype",
  );
});

// ── generateCreateFunction ────────────────────────────────────────────

Deno.test("generateCreateFunction - returns empty string for sql_name implementation", () => {
  const def: CustomFunctionDef = {
    name: "my_func",
    args: [],
    returnType: "str",
    implementation: { kind: "sql_name", sqlName: "lower" },
  };
  assertEquals(generateCreateFunction(def), "");
});

Deno.test("generateCreateFunction - returns empty string for sql_expression implementation", () => {
  const def: CustomFunctionDef = {
    name: "my_func",
    args: [{ name: "val", type: "int64" }],
    returnType: "int64",
    implementation: { kind: "sql_expression", expression: "$1 * 2" },
  };
  assertEquals(generateCreateFunction(def), "");
});

Deno.test("generateCreateFunction - generates PL/pgSQL DDL with no args", () => {
  const def: CustomFunctionDef = {
    name: "get_version",
    args: [],
    returnType: "str",
    implementation: { kind: "plpgsql", body: "BEGIN\n  RETURN '1.0';\nEND;" },
  };
  const sql = generateCreateFunction(def);
  assertEquals(sql.includes("CREATE OR REPLACE FUNCTION get_version()"), true);
  assertEquals(sql.includes("RETURNS text"), true);
  assertEquals(sql.includes("LANGUAGE plpgsql"), true);
  assertEquals(sql.includes("VOLATILE"), true);
  assertEquals(sql.includes("$func$"), true);
  assertEquals(sql.includes("BEGIN\n  RETURN '1.0';\nEND;"), true);
});

Deno.test("generateCreateFunction - generates DDL with IMMUTABLE volatility", () => {
  const def: CustomFunctionDef = {
    name: "add_ints",
    args: [
      { name: "a", type: "int32" },
      { name: "b", type: "int32" },
    ],
    returnType: "int32",
    implementation: {
      kind: "plpgsql",
      body: "BEGIN\n  RETURN a + b;\nEND;",
    },
    volatility: "immutable",
  };
  const sql = generateCreateFunction(def);
  assertEquals(sql.includes("IMMUTABLE"), true);
  assertEquals(sql.includes("VOLATILE"), false);
});

Deno.test("generateCreateFunction - generates DDL with STABLE volatility", () => {
  const def: CustomFunctionDef = {
    name: "lookup_user",
    args: [{ name: "user_id", type: "uuid" }],
    returnType: "str",
    implementation: {
      kind: "plpgsql",
      body: "BEGIN\n  RETURN 'user';\nEND;",
    },
    volatility: "stable",
  };
  const sql = generateCreateFunction(def);
  assertEquals(sql.includes("STABLE"), true);
});

Deno.test("generateCreateFunction - generates DDL with multiple args", () => {
  const def: CustomFunctionDef = {
    name: "combine",
    args: [
      { name: "first", type: "str" },
      { name: "second", type: "str" },
      { name: "count", type: "int64" },
    ],
    returnType: "str",
    implementation: {
      kind: "plpgsql",
      body: "BEGIN\n  RETURN first || second;\nEND;",
    },
  };
  const sql = generateCreateFunction(def);
  assertEquals(
    sql.includes(
      "CREATE OR REPLACE FUNCTION combine(first text, second text, count bigint)",
    ),
    true,
  );
  assertEquals(sql.includes("RETURNS text"), true);
});

// ── generateDropFunction ──────────────────────────────────────────────

Deno.test("generateDropFunction - generates DROP FUNCTION for no-arg function", () => {
  const def: CustomFunctionDef = {
    name: "get_version",
    args: [],
    returnType: "str",
    implementation: { kind: "plpgsql", body: "BEGIN\n  RETURN '1.0';\nEND;" },
  };
  assertEquals(
    generateDropFunction(def),
    "DROP FUNCTION IF EXISTS get_version();",
  );
});

Deno.test("generateDropFunction - generates DROP FUNCTION with arg types", () => {
  const def: CustomFunctionDef = {
    name: "add_ints",
    args: [
      { name: "a", type: "int32" },
      { name: "b", type: "int32" },
    ],
    returnType: "int32",
    implementation: { kind: "sql_name", sqlName: "pg_add" },
  };
  assertEquals(
    generateDropFunction(def),
    "DROP FUNCTION IF EXISTS add_ints(integer, integer);",
  );
});

Deno.test("generateDropFunction - generates DROP FUNCTION for sql_name implementation", () => {
  const def: CustomFunctionDef = {
    name: "my_lower",
    args: [{ name: "input", type: "str" }],
    returnType: "str",
    implementation: { kind: "sql_name", sqlName: "lower" },
  };
  assertEquals(
    generateDropFunction(def),
    "DROP FUNCTION IF EXISTS my_lower(text);",
  );
});

/**
 * Built-in functions registry for Disc
 *
 * Defines the standard library of functions available in EdgeQL queries,
 * mapping each to its SQL equivalent and return type.
 */

import { FunctionDef } from "./context.ts";

/**
 * Returns a Map of all built-in EdgeQL functions with their SQL mappings.
 *
 * Each entry maps an EdgeQL function name to a FunctionDef containing:
 * - name: the EdgeQL function name
 * - args: parameter definitions
 * - returnType: the EdgeQL return type
 * - sqlName: the PostgreSQL function to compile to (undefined for pass-throughs)
 */
export function getBuiltinFunctions(): Map<string, FunctionDef> {
  return new Map<string, FunctionDef>([
    // Aggregate functions
    ["count", {
      name: "count",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "int64",
      sqlName: "COUNT",
    }],
    ["min", {
      name: "min",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "int64",
      sqlName: "MIN",
    }],
    ["max", {
      name: "max",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "int64",
      sqlName: "MAX",
    }],
    ["sum", {
      name: "sum",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "int64",
      sqlName: "SUM",
    }],
    ["array_agg", {
      name: "array_agg",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "array",
      sqlName: "ARRAY_AGG",
    }],

    // String functions
    ["len", {
      name: "len",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "int64",
      sqlName: "LENGTH",
    }],
    ["str_lower", {
      name: "str_lower",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "LOWER",
    }],
    ["str_upper", {
      name: "str_upper",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "UPPER",
    }],

    // Datetime functions
    ["datetime_current", {
      name: "datetime_current",
      args: [],
      returnType: "datetime",
      sqlName: "NOW",
    }],
    ["datetime_of_statement", {
      name: "datetime_of_statement",
      args: [],
      returnType: "datetime",
      sqlName: "STATEMENT_TIMESTAMP",
    }],

    // Assertion functions (pass-through, no SQL mapping)
    ["assert_exists", {
      name: "assert_exists",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "any",
    }],
    ["assert_single", {
      name: "assert_single",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "any",
    }],
  ]);
}

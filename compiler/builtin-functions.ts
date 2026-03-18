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
      windowCompatible: true,
    }],
    ["min", {
      name: "min",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "int64",
      sqlName: "MIN",
      windowCompatible: true,
    }],
    ["max", {
      name: "max",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "int64",
      sqlName: "MAX",
      windowCompatible: true,
    }],
    ["sum", {
      name: "sum",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "int64",
      sqlName: "SUM",
      windowCompatible: true,
    }],
    ["avg", {
      name: "avg",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "AVG",
      windowCompatible: true,
    }],
    ["stddev", {
      name: "stddev",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "STDDEV",
      windowCompatible: true,
    }],
    ["stddev_pop", {
      name: "stddev_pop",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "STDDEV_POP",
      windowCompatible: true,
    }],
    ["stddev_samp", {
      name: "stddev_samp",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "STDDEV_SAMP",
      windowCompatible: true,
    }],
    ["array_agg", {
      name: "array_agg",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "array",
      sqlName: "ARRAY_AGG",
      windowCompatible: true,
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
    ["str_trim", {
      name: "str_trim",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "TRIM",
    }],
    ["str_ltrim", {
      name: "str_ltrim",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "LTRIM",
    }],
    ["str_rtrim", {
      name: "str_rtrim",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "RTRIM",
    }],
    ["str_repeat", {
      name: "str_repeat",
      args: [
        { name: "val", type: "str", required: true },
        { name: "n", type: "int64", required: true },
      ],
      returnType: "str",
      sqlName: "REPEAT",
    }],
    ["str_replace", {
      name: "str_replace",
      args: [
        { name: "val", type: "str", required: true },
        { name: "old", type: "str", required: true },
        { name: "new", type: "str", required: true },
      ],
      returnType: "str",
      sqlName: "REPLACE",
    }],

    // Math functions
    ["math_abs", {
      name: "math_abs",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "anyreal",
      sqlName: "ABS",
    }],
    ["math_ceil", {
      name: "math_ceil",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "CEIL",
    }],
    ["math_floor", {
      name: "math_floor",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "FLOOR",
    }],
    ["round", {
      name: "round",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "ROUND",
    }],

    ["str_pad_start", {
      name: "str_pad_start",
      args: [
        { name: "val", type: "str", required: true },
        { name: "n", type: "int64", required: true },
        { name: "fill", type: "str", required: false },
      ],
      returnType: "str",
      sqlName: "LPAD",
    }],
    ["str_pad_end", {
      name: "str_pad_end",
      args: [
        { name: "val", type: "str", required: true },
        { name: "n", type: "int64", required: true },
        { name: "fill", type: "str", required: false },
      ],
      returnType: "str",
      sqlName: "RPAD",
    }],
    ["contains", {
      name: "contains",
      args: [
        { name: "haystack", type: "str", required: true },
        { name: "needle", type: "str", required: true },
      ],
      returnType: "bool",
    }],
    ["find", {
      name: "find",
      args: [
        { name: "haystack", type: "str", required: true },
        { name: "needle", type: "str", required: true },
      ],
      returnType: "int64",
    }],

    // Type casting functions (compiled to CAST expressions, no sqlName)
    ["to_str", {
      name: "to_str",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "str",
    }],
    ["to_int64", {
      name: "to_int64",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "int64",
    }],
    ["to_float64", {
      name: "to_float64",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "float64",
    }],

    // Window functions (only valid with OVER clause)
    ["row_number", {
      name: "row_number",
      args: [],
      returnType: "int64",
      sqlName: "ROW_NUMBER",
      windowOnly: true,
    }],
    ["rank", {
      name: "rank",
      args: [],
      returnType: "int64",
      sqlName: "RANK",
      windowOnly: true,
    }],
    ["dense_rank", {
      name: "dense_rank",
      args: [],
      returnType: "int64",
      sqlName: "DENSE_RANK",
      windowOnly: true,
    }],
    ["ntile", {
      name: "ntile",
      args: [{ name: "n", type: "int64", required: true }],
      returnType: "int64",
      sqlName: "NTILE",
      windowOnly: true,
    }],
    ["lag", {
      name: "lag",
      args: [
        { name: "expr", type: "any", required: true },
        { name: "offset", type: "int64", required: false },
        { name: "default", type: "any", required: false },
      ],
      returnType: "any",
      sqlName: "LAG",
      windowOnly: true,
    }],
    ["lead", {
      name: "lead",
      args: [
        { name: "expr", type: "any", required: true },
        { name: "offset", type: "int64", required: false },
        { name: "default", type: "any", required: false },
      ],
      returnType: "any",
      sqlName: "LEAD",
      windowOnly: true,
    }],
    ["first_value", {
      name: "first_value",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "any",
      sqlName: "FIRST_VALUE",
      windowOnly: true,
    }],
    ["last_value", {
      name: "last_value",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "any",
      sqlName: "LAST_VALUE",
      windowOnly: true,
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

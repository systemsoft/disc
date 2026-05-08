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
      windowCompatible: true
    }],
    ["min", {
      name: "min",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "int64",
      sqlName: "MIN",
      windowCompatible: true
    }],
    ["max", {
      name: "max",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "int64",
      sqlName: "MAX",
      windowCompatible: true
    }],
    ["sum", {
      name: "sum",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "int64",
      sqlName: "SUM",
      windowCompatible: true
    }],
    ["avg", {
      name: "avg",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "AVG",
      windowCompatible: true
    }],
    ["stddev", {
      name: "stddev",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "STDDEV",
      windowCompatible: true
    }],
    ["stddev_pop", {
      name: "stddev_pop",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "STDDEV_POP",
      windowCompatible: true
    }],
    ["stddev_samp", {
      name: "stddev_samp",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "STDDEV_SAMP",
      windowCompatible: true
    }],
    ["array_agg", {
      name: "array_agg",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "array",
      sqlName: "ARRAY_AGG",
      windowCompatible: true
    }],

    // String functions
    ["len", {
      name: "len",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "int64",
      sqlName: "LENGTH"
    }],
    ["str_lower", {
      name: "str_lower",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "LOWER"
    }],
    ["str_upper", {
      name: "str_upper",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "UPPER"
    }],
    ["str_trim", {
      name: "str_trim",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "TRIM"
    }],
    ["str_ltrim", {
      name: "str_ltrim",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "LTRIM"
    }],
    ["str_rtrim", {
      name: "str_rtrim",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "RTRIM"
    }],
    ["str_repeat", {
      name: "str_repeat",
      args: [
        { name: "val", type: "str", required: true },
        { name: "n", type: "int64", required: true }
      ],
      returnType: "str",
      sqlName: "REPEAT"
    }],
    ["str_replace", {
      name: "str_replace",
      args: [
        { name: "val", type: "str", required: true },
        { name: "old", type: "str", required: true },
        { name: "new", type: "str", required: true }
      ],
      returnType: "str",
      sqlName: "REPLACE"
    }],
    ["str_title", {
      name: "str_title",
      args: [{ name: "val", type: "str", required: true }],
      returnType: "str",
      sqlName: "INITCAP"
    }],
    ["str_split", {
      name: "str_split",
      args: [
        { name: "val", type: "str", required: true },
        { name: "delimiter", type: "str", required: true }
      ],
      returnType: "array",
      sqlName: "STRING_TO_ARRAY"
    }],
    ["str_starts_with", {
      name: "str_starts_with",
      args: [
        { name: "val", type: "str", required: true },
        { name: "prefix", type: "str", required: true }
      ],
      returnType: "bool"
    }],
    ["str_ends_with", {
      name: "str_ends_with",
      args: [
        { name: "val", type: "str", required: true },
        { name: "suffix", type: "str", required: true }
      ],
      returnType: "bool"
    }],

    // Math functions
    ["math_abs", {
      name: "math_abs",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "anyreal",
      sqlName: "ABS"
    }],
    ["math_ceil", {
      name: "math_ceil",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "CEIL"
    }],
    ["math_floor", {
      name: "math_floor",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "FLOOR"
    }],
    ["round", {
      name: "round",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "ROUND"
    }],
    ["math_sqrt", {
      name: "math_sqrt",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "SQRT"
    }],
    ["math_pow", {
      name: "math_pow",
      args: [
        { name: "base", type: "anyreal", required: true },
        { name: "exp", type: "anyreal", required: true }
      ],
      returnType: "float64",
      sqlName: "POWER"
    }],
    ["math_log", {
      name: "math_log",
      args: [
        { name: "base", type: "anyreal", required: true },
        { name: "val", type: "anyreal", required: true }
      ],
      returnType: "float64",
      sqlName: "LOG"
    }],
    ["math_ln", {
      name: "math_ln",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "LN"
    }],
    ["math_pi", {
      name: "math_pi",
      args: [],
      returnType: "float64",
      sqlName: "PI"
    }],
    ["math_e", {
      name: "math_e",
      args: [],
      returnType: "float64"
    }],
    ["math_mean", {
      name: "math_mean",
      args: [{ name: "expr", type: "anyreal", required: true }],
      returnType: "float64",
      sqlName: "AVG",
      windowCompatible: true
    }],

    ["str_pad_start", {
      name: "str_pad_start",
      args: [
        { name: "val", type: "str", required: true },
        { name: "n", type: "int64", required: true },
        { name: "fill", type: "str", required: false }
      ],
      returnType: "str",
      sqlName: "LPAD"
    }],
    ["str_pad_end", {
      name: "str_pad_end",
      args: [
        { name: "val", type: "str", required: true },
        { name: "n", type: "int64", required: true },
        { name: "fill", type: "str", required: false }
      ],
      returnType: "str",
      sqlName: "RPAD"
    }],
    ["contains", {
      name: "contains",
      args: [
        { name: "haystack", type: "str", required: true },
        { name: "needle", type: "str", required: true }
      ],
      returnType: "bool"
    }],
    ["find", {
      name: "find",
      args: [
        { name: "haystack", type: "str", required: true },
        { name: "needle", type: "str", required: true }
      ],
      returnType: "int64"
    }],

    // Type casting functions (compiled to CAST expressions, no sqlName)
    ["to_str", {
      name: "to_str",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "str"
    }],
    ["to_int64", {
      name: "to_int64",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "int64"
    }],
    ["to_float64", {
      name: "to_float64",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "float64"
    }],
    ["to_int16", {
      name: "to_int16",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "int16"
    }],
    ["to_int32", {
      name: "to_int32",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "int32"
    }],
    ["to_float32", {
      name: "to_float32",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "float32"
    }],
    ["to_bigint", {
      name: "to_bigint",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "bigint"
    }],
    ["to_decimal", {
      name: "to_decimal",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "decimal"
    }],
    ["to_bool", {
      name: "to_bool",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "bool"
    }],
    ["to_uuid", {
      name: "to_uuid",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "uuid"
    }],

    // Regex functions (special compilation — no direct SQL name passthrough)
    ["re_match", {
      name: "re_match",
      args: [
        { name: "pattern", type: "str", required: true },
        { name: "val", type: "str", required: true }
      ],
      returnType: "array",
      sqlName: "REGEXP_MATCH"
    }],
    ["re_match_all", {
      name: "re_match_all",
      args: [
        { name: "pattern", type: "str", required: true },
        { name: "val", type: "str", required: true }
      ],
      returnType: "array"
    }],
    ["re_replace", {
      name: "re_replace",
      args: [
        { name: "pattern", type: "str", required: true },
        { name: "sub", type: "str", required: true },
        { name: "val", type: "str", required: true }
      ],
      returnType: "str",
      sqlName: "REGEXP_REPLACE"
    }],
    ["re_test", {
      name: "re_test",
      args: [
        { name: "pattern", type: "str", required: true },
        { name: "val", type: "str", required: true }
      ],
      returnType: "bool"
    }],

    // Window functions (only valid with OVER clause)
    ["row_number", {
      name: "row_number",
      args: [],
      returnType: "int64",
      sqlName: "ROW_NUMBER",
      windowOnly: true
    }],
    ["rank", {
      name: "rank",
      args: [],
      returnType: "int64",
      sqlName: "RANK",
      windowOnly: true
    }],
    ["dense_rank", {
      name: "dense_rank",
      args: [],
      returnType: "int64",
      sqlName: "DENSE_RANK",
      windowOnly: true
    }],
    ["ntile", {
      name: "ntile",
      args: [{ name: "n", type: "int64", required: true }],
      returnType: "int64",
      sqlName: "NTILE",
      windowOnly: true
    }],
    ["lag", {
      name: "lag",
      args: [
        { name: "expr", type: "any", required: true },
        { name: "offset", type: "int64", required: false },
        { name: "default", type: "any", required: false }
      ],
      returnType: "any",
      sqlName: "LAG",
      windowOnly: true
    }],
    ["lead", {
      name: "lead",
      args: [
        { name: "expr", type: "any", required: true },
        { name: "offset", type: "int64", required: false },
        { name: "default", type: "any", required: false }
      ],
      returnType: "any",
      sqlName: "LEAD",
      windowOnly: true
    }],
    ["first_value", {
      name: "first_value",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "any",
      sqlName: "FIRST_VALUE",
      windowOnly: true
    }],
    ["last_value", {
      name: "last_value",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "any",
      sqlName: "LAST_VALUE",
      windowOnly: true
    }],

    // Datetime functions
    ["datetime_current", {
      name: "datetime_current",
      args: [],
      returnType: "datetime",
      sqlName: "NOW"
    }],
    ["datetime_of_statement", {
      name: "datetime_of_statement",
      args: [],
      returnType: "datetime",
      sqlName: "STATEMENT_TIMESTAMP"
    }],
    ["datetime_get", {
      name: "datetime_get",
      args: [
        { name: "val", type: "datetime", required: true },
        { name: "field", type: "str", required: true }
      ],
      returnType: "float64"
    }],
    ["datetime_of_transaction", {
      name: "datetime_of_transaction",
      args: [],
      returnType: "datetime",
      sqlName: "TRANSACTION_TIMESTAMP"
    }],
    ["datetime_truncate", {
      name: "datetime_truncate",
      args: [
        { name: "val", type: "datetime", required: true },
        { name: "field", type: "str", required: true }
      ],
      returnType: "datetime"
    }],
    ["to_datetime", {
      name: "to_datetime",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "datetime"
    }],
    ["to_duration", {
      name: "to_duration",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "duration"
    }],

    // Calendar conversion functions (compiled to CAST expressions)
    ["cal_to_local_date", {
      name: "cal_to_local_date",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "cal::local_date"
    }],
    ["cal_to_local_time", {
      name: "cal_to_local_time",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "cal::local_time"
    }],
    ["cal_to_local_datetime", {
      name: "cal_to_local_datetime",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "cal::local_datetime"
    }],

    // JSON functions
    ["to_json", {
      name: "to_json",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "json",
      sqlName: "TO_JSONB"
    }],
    ["json_typeof", {
      name: "json_typeof",
      args: [{ name: "val", type: "json", required: true }],
      returnType: "str",
      sqlName: "JSONB_TYPEOF"
    }],
    ["json_array_unpack", {
      name: "json_array_unpack",
      args: [{ name: "val", type: "json", required: true }],
      returnType: "json",
      sqlName: "JSONB_ARRAY_ELEMENTS"
    }],
    ["json_object_unpack", {
      name: "json_object_unpack",
      args: [{ name: "val", type: "json", required: true }],
      returnType: "json",
      sqlName: "JSONB_EACH"
    }],
    ["json_get", {
      name: "json_get",
      args: [
        { name: "val", type: "json", required: true },
        { name: "key", type: "str", required: true }
      ],
      returnType: "json"
    }],

    // Array functions
    ["array_get", {
      name: "array_get",
      args: [
        { name: "val", type: "array", required: true },
        { name: "index", type: "int64", required: true }
      ],
      returnType: "any"
    }],
    ["array_unpack", {
      name: "array_unpack",
      args: [{ name: "val", type: "array", required: true }],
      returnType: "any",
      sqlName: "UNNEST"
    }],
    ["array_join", {
      name: "array_join",
      args: [
        { name: "val", type: "array", required: true },
        { name: "delimiter", type: "str", required: true }
      ],
      returnType: "str",
      sqlName: "ARRAY_TO_STRING"
    }],

    // UUID functions
    ["uuid_generate_v4", {
      name: "uuid_generate_v4",
      args: [],
      returnType: "uuid",
      sqlName: "GEN_RANDOM_UUID"
    }],

    // Set/Generic functions (special compilation for most)
    ["any", {
      name: "any",
      args: [{ name: "vals", type: "bool", required: true }],
      returnType: "bool",
      sqlName: "BOOL_OR",
      windowCompatible: true
    }],
    ["all", {
      name: "all",
      args: [{ name: "vals", type: "bool", required: true }],
      returnType: "bool",
      sqlName: "BOOL_AND",
      windowCompatible: true
    }],
    ["enumerate", {
      name: "enumerate",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "tuple"
    }],
    ["distinct", {
      name: "distinct",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "any"
    }],
    ["exists", {
      name: "exists",
      args: [{ name: "val", type: "any", required: true }],
      returnType: "bool"
    }],

    // Sequence functions (compiled to NEXTVAL/SETVAL)
    ["sequence_next", {
      name: "sequence_next",
      args: [{ name: "name", type: "str", required: true }],
      returnType: "int64"
    }],
    ["sequence_reset", {
      name: "sequence_reset",
      args: [
        { name: "name", type: "str", required: true },
        { name: "val", type: "int64", required: true }
      ],
      returnType: "int64"
    }],

    // Assertion functions (pass-through, no SQL mapping)
    ["assert_exists", {
      name: "assert_exists",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "any"
    }],
    ["assert_single", {
      name: "assert_single",
      args: [{ name: "expr", type: "any", required: true }],
      returnType: "any"
    }],

    // Schema introspection functions (resolved at compile time)
    ["schema::types", {
      name: "schema::types",
      args: [],
      returnType: "json",
      introspection: true
    }],
    ["schema::get_type", {
      name: "schema::get_type",
      args: [{ name: "name", type: "str", required: true }],
      returnType: "json",
      introspection: true
    }],
    ["schema::functions", {
      name: "schema::functions",
      args: [],
      returnType: "json",
      introspection: true
    }],
    ["cfg::describe_settings", {
      name: "cfg::describe_settings",
      args: [],
      returnType: "json",
      introspection: true
    }],

    // Range & Multirange functions
    ["range", {
      name: "range",
      args: [
        { name: "lower", type: "any", required: true },
        { name: "upper", type: "any", required: true }
      ],
      returnType: "range"
    }],
    ["range_get_lower", {
      name: "range_get_lower",
      args: [{ name: "r", type: "range", required: true }],
      returnType: "any",
      sqlName: "LOWER"
    }],
    ["range_get_upper", {
      name: "range_get_upper",
      args: [{ name: "r", type: "range", required: true }],
      returnType: "any",
      sqlName: "UPPER"
    }],
    ["range_is_empty", {
      name: "range_is_empty",
      args: [{ name: "r", type: "range", required: true }],
      returnType: "bool",
      sqlName: "ISEMPTY"
    }],
    ["range_unpack", {
      name: "range_unpack",
      args: [{ name: "r", type: "range", required: true }],
      returnType: "any",
      sqlName: "UNNEST"
    }],
    ["multirange", {
      name: "multirange",
      args: [{ name: "r", type: "range", required: true }],
      returnType: "multirange"
    }],
    ["range_is_inclusive_lower", {
      name: "range_is_inclusive_lower",
      args: [{ name: "r", type: "range", required: true }],
      returnType: "bool",
      sqlName: "LOWER_INC"
    }],
    ["range_is_inclusive_upper", {
      name: "range_is_inclusive_upper",
      args: [{ name: "r", type: "range", required: true }],
      returnType: "bool",
      sqlName: "UPPER_INC"
    }],
    ["overlaps", {
      name: "overlaps",
      args: [
        { name: "r1", type: "range", required: true },
        { name: "r2", type: "range", required: true }
      ],
      returnType: "bool"
    }],

    // Bytes functions
    ["bytes_get_bit", {
      name: "bytes_get_bit",
      args: [
        { name: "val", type: "bytes", required: true },
        { name: "index", type: "int64", required: true }
      ],
      returnType: "int64",
      sqlName: "GET_BIT"
    }],
    ["bytes_to_str", {
      name: "bytes_to_str",
      args: [
        { name: "val", type: "bytes", required: true },
        { name: "encoding", type: "str", required: true }
      ],
      returnType: "str",
      sqlName: "CONVERT_FROM"
    }],

    // UUID functions — v1mc maps to v4 (PG 16 has no v1mc built-in)
    ["uuid_generate_v1mc", {
      name: "uuid_generate_v1mc",
      args: [],
      returnType: "uuid",
      sqlName: "GEN_RANDOM_UUID"
    }],

    // Additional math functions
    ["math_power", {
      name: "math_power",
      args: [
        { name: "base", type: "anyreal", required: true },
        { name: "exp", type: "anyreal", required: true }
      ],
      returnType: "float64",
      sqlName: "POWER"
    }],
    ["math_log10", {
      name: "math_log10",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64"
    }],
    ["math_log2", {
      name: "math_log2",
      args: [{ name: "val", type: "anyreal", required: true }],
      returnType: "float64"
    }],

    // ── Cryptography (gh/geldata#5065) ─────────────────────────────────
    //
    // SHA-2 / MD5 use PostgreSQL built-ins (PG 11+ ships sha224/256/384/
    // 512 in core; md5 has always been there). SHA-1 and HMAC require
    // pgcrypto, which Disc auto-installs in MigrationTracker.initialize()
    // — see migration/tracker.ts. encode() / decode() for hex/base64 are
    // also core built-ins.

    // Registry keyed by EdgeQL-form name (`std::md5`); the compiler
    // falls back to the qualified form when the underscore form misses.
    // SQL-side wrappers with single-underscore names (`std_md5`,
    // `std_sha1`, `std_hex_encode`, etc.) are created in
    // lib/stdlib-sql.ts so a missing sqlName still resolves to a real
    // PG function: the compiler emits `std_md5(...)` from `std::md5`'s
    // parts.join("_") form.
    ["std::md5", {
      name: "std::md5",
      args: [{ name: "msg", type: "bytes", required: true }],
      returnType: "bytes"
      // Wrapper exists because md5(bytea) returns text in PG; the
      // wrapper re-encodes to bytea so EdgeQL's bytes return type holds.
    }],
    ["std::sha1", {
      name: "std::sha1",
      args: [{ name: "msg", type: "bytes", required: true }],
      returnType: "bytes"
      // pgcrypto: digest(msg, 'sha1') — wrapped in std_sha1.
    }],
    ["std::sha256", {
      name: "std::sha256",
      args: [{ name: "msg", type: "bytes", required: true }],
      returnType: "bytes",
      sqlName: "SHA256"
    }],
    ["std::sha512", {
      name: "std::sha512",
      args: [{ name: "msg", type: "bytes", required: true }],
      returnType: "bytes",
      sqlName: "SHA512"
    }],
    ["std::hmac", {
      name: "std::hmac",
      args: [
        { name: "msg", type: "bytes", required: true },
        { name: "key", type: "bytes", required: true },
        { name: "algo", type: "str", required: true }
      ],
      returnType: "bytes",
      // pgcrypto hmac(bytea, bytea, text). Algo is one of
      // 'md5','sha1','sha224','sha256','sha384','sha512'.
      sqlName: "HMAC"
    }],
    ["std::hex_encode", {
      name: "std::hex_encode",
      args: [{ name: "data", type: "bytes", required: true }],
      returnType: "str"
    }],
    ["std::hex_decode", {
      name: "std::hex_decode",
      args: [{ name: "data", type: "str", required: true }],
      returnType: "bytes"
    }],
    ["std::base64_encode", {
      name: "std::base64_encode",
      args: [{ name: "data", type: "bytes", required: true }],
      returnType: "str"
    }],
    ["std::base64_decode", {
      name: "std::base64_decode",
      args: [{ name: "data", type: "str", required: true }],
      returnType: "bytes"
    }],

    // Full-text search functions (ext::fts)
    ["fts::search", {
      name: "fts::search",
      args: [{ name: "query", type: "str", required: true }],
      returnType: "bool",
      sqlName: "fts__search"
    }],
    ["fts::rank", {
      name: "fts::rank",
      args: [{ name: "query", type: "str", required: true }],
      returnType: "float64",
      sqlName: "fts__rank"
    }]
  ]);
}

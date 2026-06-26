/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Compiler base layer: module-level type-mapping helpers, compiler options,
 * and the abstract root class of the EdgeQL compiler inheritance chain —
 * construction, instance state, and small shared utility predicates.
 */

import {
  AccessConfig,
  AccessContext,
  AccessEvaluator,
  AccessPolicy,
  AccessSQLInjector
} from "../access/mod.ts";
import * as EdgeQLAST from "../edgeql/ast.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import * as Context from "./context.ts";
import * as SQL from "./sql.ts";

/**
 * Extract the intersection type name from a backlink step's optional
 * filter. The parser emits `[is X]` as a `TypeName` AST node here (see
 * edgeql/parser.ts:1227). Other filter expressions are valid EdgeQL but
 * map to a different code path, so this helper only matches `[is X]`.
 */
export function backlinkIntersectionName(
  filter: EdgeQLAST.Expression | undefined
): string | null {
  if (!filter || filter.kind !== "TypeName") {
    return null;
  }
  return (filter as EdgeQLAST.TypeName).name.parts.join("::");
}

/**
 * Render a TypeName AST node back to its EdgeQL textual form, including
 * any generic subtypes — e.g. `array<str>`, `tuple<str, int64>`,
 * `array<array<int>>`. Used to build the lookup key for the PG type map.
 */
export function renderEdgeQLTypeName(type: EdgeQLAST.TypeName): string {
  const head = type.name.parts.join("::");
  const label = type.fieldName ? `${type.fieldName}: ` : "";
  if (!type.subtypes || type.subtypes.length === 0) {
    return `${label}${head}`;
  }
  return `${label}${head}<${type.subtypes.map(renderEdgeQLTypeName).join(", ")}>`;
}

/** Maps EdgeQL type names to PostgreSQL type names */
export function edgeqlTypeToPgType(edgeqlType: string): string {
  const typeMap: Record<string, string> = {
    str: "text",
    int16: "smallint",
    int32: "integer",
    int64: "bigint",
    float32: "real",
    float64: "double precision",
    bool: "boolean",
    bytes: "bytea",
    datetime: "timestamptz",
    duration: "interval",
    json: "jsonb",
    uuid: "uuid",
    bigint: "numeric",
    decimal: "numeric",
    sequence: "bigint",
    "std::str": "text",
    "std::int16": "smallint",
    "std::int32": "integer",
    "std::int64": "bigint",
    "std::float32": "real",
    "std::float64": "double precision",
    "std::bool": "boolean",
    "std::bytes": "bytea",
    "std::datetime": "timestamptz",
    "std::duration": "interval",
    "std::json": "jsonb",
    "std::uuid": "uuid",
    "std::bigint": "numeric",
    "std::decimal": "numeric",
    "cal::local_date": "date",
    "cal::local_time": "time without time zone",
    "cal::local_datetime": "timestamp without time zone",
    "cal::relative_duration": "interval",
    "cal::date_duration": "interval",
    // Array types
    "array<str>": "text[]",
    "array<int16>": "smallint[]",
    "array<int32>": "integer[]",
    "array<int64>": "bigint[]",
    "array<float32>": "real[]",
    "array<float64>": "double precision[]",
    "array<bool>": "boolean[]",
    "array<uuid>": "uuid[]",
    "array<datetime>": "timestamptz[]",
    "array<json>": "jsonb[]",
    "array<bytes>": "bytea[]",
    "array<bigint>": "numeric[]",
    "array<decimal>": "numeric[]",
    "array<cal::local_date>": "date[]",
    "array<cal::local_time>": "time without time zone[]",
    "array<cal::local_datetime>": "timestamp without time zone[]",
    // Range types
    "range<int32>": "int4range",
    "range<int64>": "int8range",
    "range<float64>": "numrange",
    "range<decimal>": "numrange",
    "range<datetime>": "tstzrange",
    "range<cal::local_date>": "daterange",
    "range<cal::local_datetime>": "tsrange",
    // Multirange types
    "multirange<int32>": "int4multirange",
    "multirange<int64>": "int8multirange",
    "multirange<float64>": "nummultirange",
    "multirange<decimal>": "nummultirange",
    "multirange<datetime>": "tstzmultirange",
    "multirange<cal::local_date>": "datemultirange",
    "multirange<cal::local_datetime>": "tsmultirange"
  };
  if (typeMap[edgeqlType]) {
    return typeMap[edgeqlType];
  }

  // Tuple types map to jsonb (PostgreSQL has no native tuple type)
  if (edgeqlType.startsWith("tuple<")) {
    return "jsonb";
  }

  // Arrays of non-scalar elements (e.g. array<tuple<...>>) have no native PG
  // array representation — only the scalar `array<T>` forms above do. Store
  // them as jsonb, matching how the tuple element itself is stored.
  if (edgeqlType.startsWith("array<tuple<")) {
    return "jsonb";
  }

  return edgeqlType;
}

export interface CompilerOptions {
  enableAccessControl?: boolean;
  accessConfig?: AccessConfig;
  accessContext?: AccessContext;
}

/**
 * Walk a query AST and assign each named parameter a 1-indexed position
 * in first-seen order. Numeric parameters (`$0`, `$1`, ...) are skipped
 * because they bring their own index from the source. Used by `compile()`
 * when the caller doesn't pre-supply a map.
 */
export function buildParameterIndex(node: unknown): Map<string, number> {
  const out = new Map<string, number>();

  function visit(n: unknown): void {
    if (!n || typeof n !== "object") {
      return;
    }
    const obj = n as { kind?: string; name?: string; };
    if (obj.kind === "Parameter" && typeof obj.name === "string") {
      const bare = obj.name.startsWith("$") ? obj.name.slice(1) : obj.name;
      // Numeric parameters keep their source-supplied index.
      if (Number.isNaN(parseInt(bare, 10)) && !out.has(bare)) {
        out.set(bare, out.size + 1);
      }
    }
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          visit(item);
        }
      } else if (v && typeof v === "object") {
        visit(v);
      }
    }
  }

  visit(node);
  return out;
}

/**
 * Walk a compiled SQL AST and map each parameter's 1-indexed position to the
 * PostgreSQL type it is cast to (e.g. `1 -> "jsonb"`, `2 -> "text[]"`). Built
 * from `CastExpression` nodes wrapping a `ParameterReference`, which is how the
 * compiler emits every typed parameter (`CAST($n AS <type>)`). The binding
 * layer uses this to decide which params need JSON serialization (jsonb) versus
 * native driver encoding (scalars, PG arrays).
 */
export function buildParameterTypeMap(node: unknown): Map<number, string> {
  const out = new Map<number, string>();

  function visit(n: unknown): void {
    if (!n || typeof n !== "object") {
      return;
    }
    const obj = n as {
      kind?: string;
      targetType?: string;
      expression?: { kind?: string; index?: number; };
    };
    if (
      obj.kind === "CastExpression" &&
      typeof obj.targetType === "string" &&
      obj.expression &&
      obj.expression.kind === "ParameterReference" &&
      typeof obj.expression.index === "number"
    ) {
      out.set(obj.expression.index, obj.targetType);
    }
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          visit(item);
        }
      } else if (v && typeof v === "object") {
        visit(v);
      }
    }
  }

  visit(node);
  return out;
}

export abstract class CompilerBase {
  protected ctx: Context.CompilationContext;
  protected accessEvaluator?: AccessEvaluator;
  protected accessInjector?: AccessSQLInjector;
  protected accessContext: AccessContext;
  protected enableAccessControl: boolean;
  /**
   * Maps each named EdgeQL parameter (without leading `$`) to its 1-indexed
   * position in the bound-values array. Populated at the start of compile()
   * by walking the AST in first-seen order, so PG `$N` placeholders line up
   * with the values the binary protocol layer (and any other caller passing
   * `parameterMap`) supplies in that same order.
   */
  protected parameterIndex: Map<string, number> = new Map();

  constructor(schema: Context.Schema, options?: CompilerOptions) {
    this.ctx = Context.createContext(schema);

    // Access control is enabled by default
    this.enableAccessControl = options?.enableAccessControl !== false;
    this.accessContext = options?.accessContext || {};

    if (this.enableAccessControl) {
      // Initialize access control with default permissive config
      const config = options?.accessConfig || {
        mode: "permissive",
        defaultAllow: true,
        enableRLS: true,
        enableAudit: false
      };

      this.accessEvaluator = new AccessEvaluator(config);
      this.accessInjector = new AccessSQLInjector(this.accessEvaluator);
    }
  }

  /**
   * Register an access policy (only works if access control is enabled)
   */
  registerAccessPolicy(policy: AccessPolicy): void {
    if (this.accessEvaluator) {
      this.accessEvaluator.registerPolicy(policy);
    }
  }

  /**
   * Set the access context for the current compilation
   */
  setAccessContext(context: AccessContext): void {
    this.accessContext = context;
  }

  /** Check if an EdgeQL binary operator is a set operation. */
  protected isSetOperator(op: string): boolean {
    return op === "UNION" || op === "INTERSECT" || op === "EXCEPT";
  }

  /** Renders a SQL AST expression to a SQL string (for RawSQLExpression construction) */
  protected renderSqlExpr(expr: SQL.SQLExpression): string {
    return new SQLCodeGenerator().generateExpression(expr);
  }

  /** Comparison operators that drive EdgeQL set-vs-scalar semantics. */
  protected isComparisonOp(op: string): boolean {
    return [
      "=",
      "!=",
      "<",
      "<=",
      ">",
      ">=",
      "LIKE",
      "ILIKE",
      "IN",
      "NOT IN"
    ]
      .includes(op);
  }
}

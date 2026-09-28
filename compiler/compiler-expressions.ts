/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Expression compilation layer: scalar/set expressions, literals, operators,
 * function calls (including window functions), parameters, casts, and
 * collection/subquery expression forms of the EdgeQL compiler.
 */

import type { AccessExpressionNode } from "../access/ast.ts";
import * as EdgeQLAST from "../edgeql/ast.ts";
import { CompilationError, InvalidReferenceError, InvalidValueError, type ErrorContext } from "../lib/errors.ts";
import { sequenceName } from "../lib/identifiers.ts";
import { sqlStringLiteral } from "../lib/sql-escape.ts";
import { normalizeStdTypeName } from "../lib/std-types.ts";
import {
  backlinkIntersectionName,
  compileEmptyOrder,
  CompilerBase,
  detachedOperand,
  edgeqlTypeToPgType,
  flattenSetElements,
  locationOf,
  renderEdgeQLTypeName,
  tupleTypeElements,
  unitedTupleType
} from "./compiler-base.ts";
import * as Context from "./context.ts";
import { describeSchema, describeType } from "./introspection.ts";
import * as SQL from "./sql.ts";

function isUuidTypeName(typeName: string): boolean {
  return typeName === "uuid" || typeName === "std::uuid";
}

/*** Numeric EdgeQL types by how `/`, `//` and `%` treat them (Disc stores bigint as numeric). ***/
const DECIMAL_TYPES = new Set(["bigint", "decimal"]);
const FLOAT_TYPES = new Set(["float32", "float64"]);
const INT_SQL_TYPES = new Map([
  ["int16", { sql: "smallint", width: 16 }],
  ["int32", { sql: "integer", width: 32 }],
  ["int64", { sql: "bigint", width: 64 }]
]);

/*** The EdgeQL type of each non-numeric literal: `'a'`, `b'a'`, `true`. ***/
const LITERAL_TYPES = new Map<string, string>([
  ["boolean", "bool"],
  ["bytes", "bytes"],
  ["string", "str"]
]);

/*** The built-in scalar types an `is` test names, bare (`cal::local_date` is `local_date`). ***/
const STATIC_SCALAR_TYPES = new Set([
  "bigint",
  "bool",
  "bytes",
  "date_duration",
  "datetime",
  "decimal",
  "duration",
  "float32",
  "float64",
  "int16",
  "int32",
  "int64",
  "json",
  "local_date",
  "local_datetime",
  "local_time",
  "relative_duration",
  "str",
  "uuid"
]);

/*** The abstract scalar types an `is` test may name, and the types each stands for. ***/
const ABSTRACT_SCALAR_TYPES = new Map<string, Set<string>>([
  ["anyfloat", new Set(["float32", "float64"])],
  ["anyint", new Set(["int16", "int32", "int64", "bigint"])],
  ["anynumeric", new Set(["bigint", "decimal"])],
  ["anyreal", new Set(["int16", "int32", "int64", "bigint", "float32", "float64", "decimal"])],
  ["anyscalar", STATIC_SCALAR_TYPES]
]);

/*** The EdgeQL type of each numeric literal: `7`, `7.0`, `7n`, `7.0n`. ***/
const NUMERIC_LITERAL_TYPES = new Map<string, string>([
  ["bigint", "bigint"],
  ["decimal", "decimal"],
  ["float", "float64"],
  ["integer", "int64"]
]);

/*** The literals that are integers: `7`, `7n`. ***/
const INTEGER_LITERAL_TYPES = new Set(["bigint", "integer"]);

/*** The PostgreSQL types of int16, int32 and int64. ***/
const INTEGER_PG_TYPES = new Set(["bigint", "integer", "smallint"]);

/**
 * The units Gel's `datetime_get`, `duration_get`, `cal::time_get` and
 * `cal::date_get` take (edb/lib/std/30-datetimefuncs.edgeql, edb/lib/cal.edgeql),
 * with the name Gel's error gives each. `duration_get`'s depend on the
 * duration's type. EPOCH_UNITS are PostgreSQL's `epoch`; every other unit is
 * passed to `date_part` as spelled, as Gel does.
 */
const DATE_PART_UNITS = new Map<string, { name: string; units: readonly string[]; }>([
  ["cal_date_get", {
    name: "std::date_get",
    units: ["century", "day", "decade", "dow", "doy", "isodow", "isoyear", "millennium", "month", "quarter", "week", "year"]
  }],
  ["cal_time_get", { name: "std::time_get", units: ["hour", "microseconds", "midnightseconds", "milliseconds", "minutes", "seconds"] }],
  ["datetime_get", {
    name: "std::datetime_get",
    units: [
      "epochseconds",
      "century",
      "day",
      "decade",
      "dow",
      "doy",
      "hour",
      "isodow",
      "isoyear",
      "microseconds",
      "millennium",
      "milliseconds",
      "minutes",
      "month",
      "quarter",
      "seconds",
      "week",
      "year"
    ]
  }],
  ["duration_get:date_duration", {
    name: "std::duration_get",
    units: ["millennium", "century", "decade", "year", "quarter", "month", "day", "totalseconds"]
  }],
  ["duration_get:duration", { name: "std::duration_get", units: ["hour", "minutes", "seconds", "milliseconds", "microseconds", "totalseconds"] }],
  ["duration_get:relative_duration", {
    name: "std::duration_get",
    units: [
      "millennium",
      "century",
      "decade",
      "year",
      "quarter",
      "month",
      "day",
      "hour",
      "minutes",
      "seconds",
      "milliseconds",
      "microseconds",
      "totalseconds"
    ]
  }]
]);
const EPOCH_UNITS = new Set(["epochseconds", "midnightseconds", "totalseconds"]);

/*** A PostgreSQL type a cast may name in the SQL: words (`double precision`), optionally an array of them. ***/
const PG_TYPE_NAME = /^[A-Za-z_][\w ]*(\[\])?$/;

/*** The types a cast to bigint rounds, as Gel's `round($1)::edgedbt.bigint_t` casts do. ***/
const ROUNDED_TO_BIGINT = new Set(["decimal", "float32", "float64"]);

/**
 * Functions returning a set of rows (`array_unpack` is SQL `UNNEST`), which
 * PostgreSQL rejects inside an aggregate or a WHERE clause. `enumerate` counts
 * as one: it numbers its argument's rows with a window function.
 */
const SET_RETURNING_FUNCTIONS = new Set(["array_unpack", "enumerate", "json_array_unpack", "json_object_unpack", "range_unpack", "re_match_all"]);

/**
 * Built-in functions taking a set as a whole (Gel's `set of` parameters):
 * aggregates and set tests. Every other built-in applies to each element of a
 * set argument (`str_upper({'a', 'b'})` is `{'A', 'B'}`).
 */
const SET_ARGUMENT_FUNCTIONS = new Set([
  "all",
  "any",
  "array_agg",
  "assert_exists",
  "assert_single",
  "avg",
  "count",
  "distinct",
  "enumerate",
  "exists",
  "math_mean",
  "max",
  "min",
  "stddev",
  "stddev_pop",
  "stddev_samp",
  "sum"
]);

/*** Built-in functions of values whose answer may be the empty set (SQL NULL) though no argument is. ***/
const MAY_BE_EMPTY_FUNCTIONS = new Set(["array_get", "json_get", "re_match", "find"]);

/*** Aggregates and set tests with a value for every set, the empty one too. ***/
const NEVER_EMPTY_AGGREGATES = new Set(["all", "any", "array_agg", "count", "exists", "sum"]);

/*** Aggregates whose SQL form over a set's values is the SQL aggregate named, an empty set's being the empty set (NULL). ***/
const VALUE_AGGREGATES = new Map([
  ["avg", "AVG"],
  ["math_mean", "AVG"],
  ["max", "MAX"],
  ["min", "MIN"],
  ["stddev", "STDDEV"],
  ["stddev_pop", "STDDEV_POP"],
  ["stddev_samp", "STDDEV_SAMP"]
]);

/*** Unary operators applied to each element of a set operand (`-{1, 2}` is `{-1, -2}`); `exists` and `distinct` take the set as a whole. ***/
const ELEMENT_WISE_UNARY_OPERATORS = new Set(["+", "-", "NOT", "~"]);

/*** Operators that compare empty operands (`{} ?= 1` is false) rather than giving no element. ***/
const OPTIONAL_OPERAND_OPERATORS = new Set(["?=", "?!="]);

/*** Operators that compare whole values: on tuples they compare the tuples' elements (see `canonicalTuple`). ***/
const EQUALITY_OPERATORS = new Set(["=", "!=", "?=", "?!=", "IN", "NOT IN"]);

/*** Operators that order whole values: on arrays of tuples they compare the tuples' elements (see `tupleArraySortKey`). ***/
const ORDERING_OPERATORS = new Set(["<", ">", "<=", ">="]);

/**
 * PostgreSQL types of tuple elements whose JSON text can differ between equal
 * values (`…T00:00:00Z` and `…T00:00:00+00:00`, `1.5` and `"1.5"`): compared,
 * such an element is read as its type and made JSON again (`canonicalTuple`).
 */
const CANONICAL_JSON_PG_TYPES = new Set([
  "bigint",
  "date",
  "double precision",
  "integer",
  "interval",
  "numeric",
  "real",
  "smallint",
  "time without time zone",
  "timestamp without time zone",
  "timestamptz",
  "uuid"
]);

/*** The SQL type of int operands' floor division: the widest of them; an operand of unknown type counts as int64. ***/
function widestIntSqlType(types: (string | null)[]): string {
  const widths = types.map(type => (type !== null && INT_SQL_TYPES.get(type)?.width) || 64);
  return [...INT_SQL_TYPES.values()].find(int => int.width === Math.max(...widths))!.sql;
}

/*** The SQL type `to_str(value, fmt)` formats a value of each EdgeQL type as: Gel's overload for it (`disc_to_str`, lib/stdlib-sql.ts). ***/
const TO_STR_FORMAT_TYPES = new Map<string, string>([
  ["bigint", "numeric"],
  ["date_duration", "interval"],
  ["datetime", "timestamptz"],
  ["decimal", "numeric"],
  ["duration", "interval"],
  ["float32", "double precision"],
  ["float64", "double precision"],
  ["int16", "bigint"],
  ["int32", "bigint"],
  ["int64", "bigint"],
  ["json", "jsonb"],
  ["local_date", "date"],
  ["local_datetime", "timestamp"],
  ["local_time", "time"],
  ["relative_duration", "interval"]
]);

/*** The SQL type of each number parser (`to_int64(str, fmt)`, …). ***/
const NUMBER_PARSER_TYPES = new Map<string, string>([
  ["to_bigint", "numeric"],
  ["to_decimal", "numeric"],
  ["to_float32", "real"],
  ["to_float64", "double precision"],
  ["to_int16", "smallint"],
  ["to_int32", "integer"],
  ["to_int64", "bigint"]
]);

/*** The SQL type of each `cal::to_local_*` parser. ***/
const LOCAL_PARSER_TYPES = new Map<string, string>([
  ["cal_to_local_date", "date"],
  ["cal_to_local_datetime", "timestamp without time zone"],
  ["cal_to_local_time", "time without time zone"]
]);

/*** Whether the static type `type` is the built-in `name` (`datetime`, `date_duration`), however spelled (`std::datetime`, `cal::date_duration`). ***/
function isStdType(type: string | null, name: string): boolean {
  return type !== null && type.replace(/^(std|cal)::/, "") === name;
}

/**
 * The type of `left op right` where Gel types date arithmetic apart from
 * PostgreSQL: `cal::local_date - cal::local_date` is a `cal::date_duration`
 * (PostgreSQL: an integer of days), `cal::local_date ± cal::date_duration` a
 * `cal::local_date` (PostgreSQL: a timestamp), and `cal::date_duration ±
 * cal::date_duration` a `cal::date_duration`. Null for other operands.
 */
function dateArithmeticType(op: "+" | "-", left: string | null, right: string | null): string | null {
  const date = (type: string | null): boolean => isStdType(type, "local_date");
  const dateDuration = (type: string | null): boolean => isStdType(type, "date_duration");
  if ((dateDuration(left) && dateDuration(right)) || (op === "-" && date(left) && date(right))) {
    return "cal::date_duration";
  }
  if ((date(left) && dateDuration(right)) || (op === "+" && dateDuration(left) && date(right))) {
    return "cal::local_date";
  }
  return null;
}

/*** The names of the tuple type's elements, a nested tuple's in parentheses: `tuple<a: int64, b: tuple<str, c: str>>` → `a,b(,c)`. ***/
function tupleNames(typeName: string): string {
  return (tupleTypeElements(typeName) ?? [])
    .map(element => `${element.name ?? ""}${tupleTypeElements(element.type) ? `(${tupleNames(element.type)})` : ""}`)
    .join(",");
}

/*** The key element `index` of a jsonb tuple is stored under: its name (an object's key), else its position (an array's index). ***/
function tupleElementKey(element: { name?: string; }, index: number): SQL.LiteralExpression {
  return element.name !== undefined ? SQL.createLiteral("string", element.name) : SQL.createLiteral("number", index);
}

/*** `built` from the jsonb tuple `sql`, or NULL when `sql` is (an empty tuple). ***/
function unlessNullTuple(sql: SQL.SQLExpression, built: SQL.SQLExpression): SQL.SQLExpression {
  return SQL.createCaseExpression(
    [SQL.createWhenClause(SQL.createBinaryExpression("IS", sql, SQL.createLiteral("null", null)), SQL.createLiteral("null", null))],
    built
  );
}

export abstract class ExpressionCompilerLayer extends CompilerBase {
  /*** Set literals that are the right operand of `in`, the one place a set literal compiles to one SQL expression. ***/
  private readonly membershipSets = new WeakSet<EdgeQLAST.SetExpr>();
  /*** Comparisons of a multi path a filter's condition is a conjunction of, or `any()`'s argument (see `markAnyElementComparisons`), compiled as "any element matches". ***/
  private readonly anyElementComparisons = new WeakSet<EdgeQLAST.BinaryOp>();
  /*** The `and`, `or` and `??` of a filter's condition read only for being true (see `markTruthContexts`). ***/
  private readonly truthContexts = new WeakSet<EdgeQLAST.BinaryOp>();
  /*** `array_agg` calls over tuples being compiled as PostgreSQL arrays, to be made a jsonb array (see `compileFunctionCall`). ***/
  private readonly tupleArrayAggregates = new WeakSet<EdgeQLAST.FunctionCall>();
  /*** Inside `detached`: subjects bound in scopes before this index of the scope stack are hidden (see `scopeVariable`). ***/
  private detachedFrom = -1;
  /*** Selects of objects that compile to their objects' ids, not their JSON (see `objectComparisonById`). ***/
  protected readonly objectIdSelects = new WeakSet<EdgeQLAST.SelectQuery>();

  // Implemented by higher layers of the compiler inheritance chain.
  protected abstract compileQuery(query: EdgeQLAST.Query): SQL.SQLStatement;
  protected abstract compilePathInExpression(
    path: EdgeQLAST.Path
  ): SQL.SQLExpression;
  protected abstract isSetPath(expr: EdgeQLAST.Expression): boolean;
  protected abstract isObjectPath(path: EdgeQLAST.Path): boolean;
  protected abstract membershipSelect(expr: EdgeQLAST.Expression): SQL.SelectStatement | null;
  protected abstract pathProperty(path: EdgeQLAST.Path): Context.PropertyDef | undefined;
  protected abstract compileGlobalRef(
    expr: EdgeQLAST.GlobalRef
  ): SQL.SQLExpression;
  protected abstract compileTypeName(
    typeName: EdgeQLAST.TypeName
  ): SQL.SQLExpression;
  protected abstract compileIntrospectionFunction(
    qualifiedName: string,
    funcCall: EdgeQLAST.FunctionCall
  ): SQL.RawSQLExpression;

  protected compileExpression(expr: EdgeQLAST.Expression): SQL.SQLExpression {
    switch (expr.kind) {
      case "Literal":
        return this.compileLiteral(expr);
      case "Identifier":
        return this.compileIdentifier(expr);
      case "BinaryOp":
        return this.compileBinaryOp(expr);
      case "UnaryOp":
        return expr.op === "DETACHED" ? this.compileDetached({ expr: expr.operand, kind: "Detached", span: expr.span }) : this.compileUnaryOp(expr);
      case "FunctionCall":
        return this.compileFunctionCall(expr);
      case "WindowFunctionCall":
        return this.compileWindowFunctionCall(expr);
      case "Parameter":
        return this.compileParameter(expr);
      case "TypeCast":
        return this.compileTypeCast(expr);
      case "Path":
        return this.isTypeRoot(expr) ? this.readingSnapshot(() => this.compilePathInExpression(expr)) : this.compilePathInExpression(expr);
      case "TypeName":
        return this.readingSnapshot(() => this.compileTypeName(expr));
      case "SetExpr":
        return this.compileSetExpr(expr);
      case "Subquery":
        return this.compileSubqueryExpression(expr);
      case "IfElse":
        return this.compileIfElse(expr as EdgeQLAST.IfElse);
      case "CaseExpression":
        return this.compileCaseExpression(
          expr as EdgeQLAST.CaseExpression
        );
      case "ArrayExpr":
        return this.compileArrayExpr(expr as EdgeQLAST.ArrayExpr);
      case "TupleExpr":
        return this.compileTupleExpr(expr as EdgeQLAST.TupleExpr);
      case "NamedTuple":
        return this.compileNamedTuple(expr as EdgeQLAST.NamedTuple);
      case "TupleAccessExpr":
        return this.compileTupleAccess(expr as EdgeQLAST.TupleAccessExpr);
      case "Detached":
        return this.compileDetached(expr as EdgeQLAST.Detached);
      case "Introspection":
        return this.compileIntrospection(expr as EdgeQLAST.Introspection);
      case "IndexExpression":
        return this.compileIndexExpression(
          expr as EdgeQLAST.IndexExpression
        );
      case "SliceExpression":
        return this.compileSliceExpression(
          expr as EdgeQLAST.SliceExpression
        );
      case "GlobalRef":
        return this.compileGlobalRef(expr as EdgeQLAST.GlobalRef);
      default:
        throw new CompilationError(`Unsupported expression: ${expr.kind}`);
    }
  }

  private compileLiteral(literal: EdgeQLAST.Literal): SQL.SQLExpression {
    let sqlType: "string" | "number" | "boolean" | "null";

    switch (literal.type) {
      // `10n` / `1.5n`: bigint and decimal are both numeric (Disc stores
      // bigint as numeric). The cast keeps `10n` from being an integer.
      case "bigint":
      case "decimal":
        return SQL.createCastExpression(SQL.createLiteral("number", literal.value), "numeric");
      // `b'…'`: its bytes (one character per byte, see `unquoteBytes`) as
      // PostgreSQL's hex bytea input, which is digits only.
      case "bytes": {
        const hex = [...String(literal.value)].map(ch => ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
        return SQL.createCastExpression(SQL.createLiteral("string", `\\x${hex}`), "bytea");
      }
      case "string":
        sqlType = "string";
        break;
      case "integer":
      case "float":
        sqlType = "number";
        break;
      case "boolean":
        sqlType = "boolean";
        break;
      case "empty":
        sqlType = "null";
        break;
      default:
        throw new CompilationError(`Unsupported literal type: ${literal.type}`);
    }

    return SQL.createLiteral(sqlType, literal.value);
  }

  private compileIdentifier(
    identifier: EdgeQLAST.Identifier
  ): SQL.SQLExpression {
    // Check scope variables first (e.g., FOR loop variable)
    const varDef = this.ctx.currentScope.variables.get(identifier.name);
    if (varDef) {
      if (varDef.sqlOverride) {
        return varDef.sqlOverride;
      }
      return this.compileExpression(varDef.expression);
    }

    // Check parent scopes
    for (let i = this.ctx.scopes.length - 1; i >= 0; i--) {
      const parentVar = this.ctx.scopes[i].variables.get(identifier.name);
      if (parentVar) {
        if (parentVar.sqlOverride) {
          return parentVar.sqlOverride;
        }
        return this.compileExpression(parentVar.expression);
      }
    }

    // A set-valued `with` binding is a CTE. In expression position its name
    // stands for its rows: their ids when it binds objects (what a link column
    // or an `.id`/link comparison takes), else its single column.
    const cteAlias = Context.getCTEAlias(this.ctx, identifier.name);
    if (cteAlias) {
      return SQL.createSubqueryExpression(SQL.createSelectStatement({
        from: SQL.createFromClause([SQL.createTableReference(cteAlias.cteName)]),
        select: SQL.createSelectClause([SQL.createSelectItem(SQL.createColumnReference(cteAlias.typeDef ? "id" : "*"))])
      }));
    }

    throw new CompilationError(
      `Standalone identifier '${identifier.name}' cannot be resolved`
    );
  }

  private compileBinaryOp(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression {
    // `x in {a, b}`: the set literal is the tuple `IN (a, b)` (compileSetExpr).
    if ((binOp.op === "IN" || binOp.op === "NOT IN") && binOp.right.kind === "SetExpr") {
      this.membershipSets.add(binOp.right);
    }

    // Handle IS / IS NOT for polymorphic type checking
    if (binOp.op === "IS" || binOp.op === "IS NOT") {
      return this.compileIsTypeCheck(binOp);
    }

    const byId = this.objectComparisonById(binOp);
    if (byId) {
      return this.compileExpression(byId);
    }

    // A comparison of a multi path elsewhere (not marked: see anyElementComparisons) is one
    // boolean per element, compiled where a select, a shape element, a `for`
    // body or a function reads them (elementWiseSets): as one value inside
    // another expression it is a compile error, like any other set.
    if (!this.anyElementComparisons.has(binOp) && this.isAnyElementComparison(binOp)) {
      this.assertNotOverSet(binOp, `'${binOp.op}'`);
    }

    // A multi scalar property is an array column; comparing it tests its
    // elements (EdgeQL set semantics: true when any element matches).
    const multiComparison = this.compileMultiPropertyComparison(binOp);
    if (multiComparison) {
      return multiComparison;
    }

    // `.link@prop <op> x` / `x in .link@prop`: EXISTS over the junction.
    const linkPropertyComparison = this.compileLinkPropertyComparison(binOp);
    if (linkPropertyComparison) {
      return linkPropertyComparison;
    }

    // Multi-cardinality 2-step path on the LHS: rewrite the entire
    // comparison to EXISTS over the target table. EdgeQL set-comparison
    // semantics say `set OP scalar` is true if any element matches; SQL
    // EXISTS captures that without needing a "set" type.
    //
    // This MUST run before the array-membership lowering below: that lowering
    // compiles the LHS as a path, which a multi-link path like `.tags.id`
    // can't satisfy (it's not single-cardinality). `compileMultiLinkComparison`
    // handles the `IN array_unpack(...)` RHS itself, inside the EXISTS.
    if (this.isMultiLinkPath(binOp.left) && this.isComparisonOp(binOp.op)) {
      const rewritten = this.compileMultiLinkComparison(
        binOp.left as EdgeQLAST.Path,
        binOp.op,
        binOp.right
      );
      if (rewritten) {
        return rewritten;
      }
    }

    // Membership in a multi-link path, `x in .members.id`: some element is `x`,
    // which is the existential comparison `.members.id = x`.
    if (binOp.op === "IN" && this.isMultiLinkPath(binOp.right)) {
      const rewritten = this.compileMultiLinkComparison(binOp.right as EdgeQLAST.Path, "=", binOp.left);
      if (rewritten) {
        return rewritten;
      }
    }

    // Membership in a type's objects or a path's set (`x in Item`,
    // `o not in Order`, `n in o.items.name`): `IN` the select of their ids or
    // values.
    if (binOp.op === "IN" || binOp.op === "NOT IN") {
      const right = binOp.right;
      const set = this.membershipSubquery(right);
      if (set) {
        return SQL.createBinaryExpression(binOp.op, this.compileExpression(binOp.left), set);
      }
      // One object (a bound subject, a `for` variable, an object cast): `in` it is `=` it.
      const name = right.kind === "TypeName" ? right.name.parts.join("::") : right.kind === "Identifier" ? right.name : undefined;
      const objectCast = right.kind === "TypeCast" && Context.resolveTypeName(this.ctx, renderEdgeQLTypeName(right.type))?.kind === "object";
      if (objectCast || (name !== undefined && this.scopeVariable(name)?.row)) {
        return SQL.createBinaryExpression(binOp.op === "IN" ? "=" : "<>", this.compileExpression(binOp.left), this.compileExpression(right));
      }
    }

    // Multi-link chain on the LHS, e.g. `.channels.videos.isDraft` or the
    // deeper `.channels.videos.tags.name`: the SDK filter API emits this for a
    // nested `{ channels: { videos: { … } } }` filter. Rewrite to nested
    // EXISTS — each multi hop matches a linked row that itself has a linked row
    // satisfying the inner predicate, to any depth. Runs before the generic
    // path compilation (`compileLinkChain`), which only walks single-
    // cardinality chains and would reject a multi hop.
    if (this.isMultiHopLinkPath(binOp.left) && this.isComparisonOp(binOp.op)) {
      const rewritten = this.compileMultiHopComparison(
        binOp.left as EdgeQLAST.Path,
        binOp.op,
        binOp.right
      );
      if (rewritten) {
        return rewritten;
      }
    }

    // Set-membership over an unpacked array: `x in array_unpack(<array<T>>$p)`
    // maps to `array_unpack` → SQL `UNNEST`, but `x IN UNNEST(...)` is invalid
    // Postgres. Lower it to `x = ANY(arr)` (and `x <> ALL(arr)` for `NOT IN`).
    if (binOp.op === "IN" || binOp.op === "NOT IN") {
      const arrayMembership = this.compileArrayMembership(binOp);
      if (arrayMembership) {
        return arrayMembership;
      }
    }

    this.assertNotOverSet(binOp, `'${binOp.op}'`);
    const tupleComparison = this.compileTupleArrayComparison(binOp) ?? this.compileTupleComparison(binOp);
    if (tupleComparison) {
      return tupleComparison;
    }
    // Coalescing a set: `{1, 2} ?? 3` is {1, 2}, not one COALESCE.
    if (binOp.op === "??" && [binOp.left, binOp.right].some(operand => this.setArgument(operand) && this.isSetWithoutValue(operand))) {
      throw new CompilationError(
        "'??' of a set operand is not supported yet; its operands must be single values",
        this.expressionLocation(binOp.left) ?? this.expressionLocation(binOp.right)
      );
    }

    // Read only for being true, `x ?? false` is `x`: the SDK's filters wrap
    // conditions so, and a bare `x` keeps an index usable.
    if (binOp.op === "??" && this.truthContexts.has(binOp)) {
      return this.compileExpression(binOp.left);
    }

    let left = this.compileExpression(binOp.left);
    let right = this.compileExpression(binOp.right);

    // Arrays of tuples joined are of their tuples' united type (`[(a := 1)] ++ [(2,)]` is `[(1,), (2,)]`).
    const tupleArrays = binOp.op === "++" ? [this.staticTupleArrayType(binOp.left), this.staticTupleArrayType(binOp.right)] : [];
    if (tupleArrays.length === 2 && tupleArrays[0] && tupleArrays[1]) {
      const united = unitedTupleType([tupleArrays[0], tupleArrays[1]]);
      left = this.asTupleArrayType(left, tupleArrays[0], united);
      right = this.asTupleArrayType(right, tupleArrays[1], united);
    }

    if (binOp.op === "AND" || binOp.op === "OR") {
      return this.compileLogical(binOp, left, right);
    }

    // Coalescing: `a ?? b` → `COALESCE(a, b)`. A chain `a ?? b ?? c` nests
    // (`COALESCE(COALESCE(a, b), c)`), which is equivalent. Scalar operands
    // only — a multi-cardinality LHS (set coalescing) is not supported.
    if (binOp.op === "??") {
      return SQL.createFunctionCall("COALESCE", this.asUnitedAlternatives([binOp.left, binOp.right], [left, right]));
    }

    if (binOp.op === "/" || binOp.op === "//" || binOp.op === "%") {
      return this.compileDivision(binOp, left, right);
    }

    // `datetime - datetime` is a duration, which holds no days (`disc_datetime_sub`, lib/stdlib-sql.ts).
    if (binOp.op === "-" && [binOp.left, binOp.right].every(operand => isStdType(this.staticScalarType(operand), "datetime"))) {
      return SQL.createFunctionCall("disc_datetime_sub", [left, right]);
    }

    // Date arithmetic typed as Gel types it (`dateArithmeticType`): PostgreSQL's
    // `date - date` is an integer of days and `date ± interval` a timestamp.
    if (binOp.op === "+" || binOp.op === "-") {
      const operands = [this.staticScalarType(binOp.left), this.staticScalarType(binOp.right)];
      const type = dateArithmeticType(binOp.op, operands[0], operands[1]);
      if (isStdType(type, "local_date")) {
        return SQL.createCastExpression(SQL.createBinaryExpression(binOp.op, left, right), "date");
      }
      if (isStdType(type, "date_duration") && operands.every(operand => isStdType(operand, "local_date"))) {
        const days = SQL.createBinaryExpression("-", left, right);
        return SQL.createBinaryExpression("*", days, SQL.createCastExpression(SQL.createLiteral("string", "1 day"), "interval"));
      }
    }

    // Map EdgeQL operators to SQL operators
    let sqlOp: string = binOp.op;
    switch (binOp.op) {
      case "++":
        sqlOp = "||"; // String concatenation in PostgreSQL
        break;
      // Coalescing equality: an empty set (SQL NULL) equals only another
      // empty set, so these are NULL-safe comparisons in PG.
      case "?=":
        sqlOp = "IS NOT DISTINCT FROM";
        break;
      case "?!=":
        sqlOp = "IS DISTINCT FROM";
        break;
      case "LIKE":
      case "ILIKE":
        sqlOp = binOp.op;
        break;
      // Range operators — same syntax in PG
      case "@>":
      case "<@":
      case "&&":
      case "-|-":
        sqlOp = binOp.op;
        break;
      // Bitwise operators — same syntax in PG
      case "&":
      case "|":
      case "<<":
      case ">>":
        sqlOp = binOp.op;
        break;
      case "^":
        sqlOp = "#"; // PG uses # for bitwise XOR
        break;
      // Regex operators — same syntax in PG
      case "~":
      case "!~":
      case "~*":
      case "!~*":
        sqlOp = binOp.op;
        break;
    }

    return SQL.createBinaryExpression(sqlOp, left, right);
  }

  /**
   * `and` / `or` with Gel's empty-set semantics: an empty operand (SQL NULL)
   * makes the result empty, where SQL's `NULL OR TRUE` is TRUE and
   * `NULL AND FALSE` is FALSE. Each operand that may be empty (`mayBeEmpty`)
   * is tested:
   *
   *   select User { b := .visits = 1 or .name = 'bob' }
   *   → CASE WHEN (visits = 1) IS NOT NULL THEN (visits = 1) OR (name = 'bob') END
   *
   * In a filter's condition, read only for being true (`markTruthContexts`),
   * an `and` needs no test (NULL and FALSE keep no object alike), and an `or`
   * ANDs its tests instead: `(visits = 1 OR name = 'bob') AND (visits = 1) IS NOT NULL`.
   */
  private compileLogical(binOp: EdgeQLAST.BinaryOp, left: SQL.SQLExpression, right: SQL.SQLExpression): SQL.SQLExpression {
    const logical = SQL.createBinaryExpression(binOp.op, left, right);
    const truth = this.truthContexts.has(binOp);
    if (truth && binOp.op === "AND") {
      return logical;
    }
    const tests = [...(this.mayBeEmpty(binOp.left) ? [SQL.isNotNull(left)] : []), ...(this.mayBeEmpty(binOp.right) ? [SQL.isNotNull(right)] : [])];
    if (tests.length === 0) {
      return logical;
    }
    const nonEmpty = tests.slice(1).reduce<SQL.SQLExpression>((all, test) => SQL.createBinaryExpression("AND", all, test), tests[0]);
    return truth ? SQL.createBinaryExpression("AND", logical, nonEmpty) : SQL.createCaseExpression([SQL.createWhenClause(nonEmpty, logical)]);
  }

  /**
   * Mark the `and`, `or` and `x ?? false` of a filter's condition that are
   * read only for being true, where SQL NULL and FALSE mean the same: the
   * condition itself, the operands of such an `and`, the operands of such an
   * `or` that are never empty (an empty operand makes the `or` empty, so its
   * operands' emptiness matters), and the `x` of such an `x ?? false`.
   */
  private markTruthContexts(expr: EdgeQLAST.Expression): void {
    if (expr.kind !== "BinaryOp") {
      return;
    }
    const isFalse = expr.right.kind === "Literal" && expr.right.value === false;
    if (expr.op === "OR" || expr.op === "AND" || (expr.op === "??" && isFalse)) {
      this.truthContexts.add(expr);
    }
    if (expr.op === "AND" || (expr.op === "OR" && !this.mayBeEmpty(expr.left) && !this.mayBeEmpty(expr.right))) {
      this.markTruthContexts(expr.left);
      this.markTruthContexts(expr.right);
    } else if (expr.op === "??" && isFalse) {
      this.markTruthContexts(expr.left);
    }
  }

  /**
   * False when `expr` is never empty (never SQL NULL): a literal but `{}`, a required
   * single property, a parameter not cast `<optional …>`, a `with` name bound
   * to such a value, an element of a set, an aggregate or set test that is
   * never empty (`count`, `exists`, `any`, …), `?=` and `?!=`, and an
   * operator over never-empty operands. Anything else may be empty.
   */
  protected mayBeEmpty(expr: EdgeQLAST.Expression): boolean {
    switch (expr.kind) {
      case "Literal":
        return expr.type === "empty";
      case "Parameter":
        return false;
      case "TypeCast":
        return expr.cardinality?.required === false || this.mayBeEmpty(expr.expr);
      case "Path": {
        // An enum's value (`Status.active`) is a literal.
        const [first, second] = expr.steps;
        const isEnumValue = expr.steps.length === 2 && first.type === "property" && second.type === "property" &&
          (Context.resolveTypeName(this.ctx, first.name)?.enumValues?.length ?? 0) > 0;
        return !isEnumValue && !this.isNeverEmpty(expr);
      }
      case "Identifier": {
        const variable = this.scopeVariable(expr.name);
        if (variable?.element || variable?.row) {
          return false;
        }
        return !variable || variable.sqlOverride !== undefined || this.mayBeEmpty(variable.expression);
      }
      case "UnaryOp":
        return expr.op !== "EXISTS" && this.mayBeEmpty(expr.operand);
      case "BinaryOp":
        if (OPTIONAL_OPERAND_OPERATORS.has(expr.op)) {
          return false;
        }
        if (expr.op === "??") {
          return this.mayBeEmpty(expr.left) && this.mayBeEmpty(expr.right);
        }
        // `in`'s right operand is a whole set: `x in {}` is false.
        if (expr.op === "IN" || expr.op === "NOT IN" || expr.op === "IS" || expr.op === "IS NOT") {
          return this.mayBeEmpty(expr.left);
        }
        return this.mayBeEmpty(expr.left) || this.mayBeEmpty(expr.right);
      case "FunctionCall":
        return !NEVER_EMPTY_AGGREGATES.has(Context.lookupFunction(this.ctx.schema, expr.name.parts)?.name ?? "");
      // A tuple or array is empty when an element is.
      case "TupleExpr":
      case "ArrayExpr":
        return expr.elements.some(element => this.mayBeEmpty(element));
      case "NamedTuple":
        return expr.elements.some(element => this.mayBeEmpty(element.value));
      case "TupleAccessExpr": {
        const element = this.literalTupleElement(expr);
        return element ? this.mayBeEmpty(element) : true;
      }
      default:
        return true;
    }
  }

  /*** A filter's condition with its comparisons of objects comparing ids (`objectComparisonById`), through `and`, `or` and `not`. ***/
  private comparingObjectsById(expr: EdgeQLAST.Expression): EdgeQLAST.Expression {
    if (expr.kind === "UnaryOp" && expr.op === "NOT") {
      const operand = this.comparingObjectsById(expr.operand);
      return operand === expr.operand ? expr : { ...expr, operand };
    }
    if (expr.kind !== "BinaryOp") {
      return expr;
    }
    if (expr.op === "AND" || expr.op === "OR") {
      const left = this.comparingObjectsById(expr.left);
      const right = this.comparingObjectsById(expr.right);
      return left === expr.left && right === expr.right ? expr : { ...expr, left, right };
    }
    return this.objectComparisonById(expr) ?? expr;
  }

  /**
   * `=`, `!=`, `?=`, `?!=`, `in` and `not in` on objects, which compare their
   * identity, rewritten to compare their ids; null when no operand needs it.
   * A select of objects (`objectSelectOf`) compiles to their ids
   * (`objectIdSelects`), and a path to several objects gets `.id`
   * (`.tags` → `.tags.id`), compared element by element like any multi path
   * — on the left of a symmetric operator. A single link (`.author`), a
   * `with` name of objects and an id cast are ids already.
   *
   *   filter .author = (select User filter .email = $e)
   *   → author_id = (SELECT user_2.id FROM "user" AS user_2 WHERE user_2.email = $1)
   */
  private objectComparisonById(binOp: EdgeQLAST.BinaryOp): EdgeQLAST.BinaryOp | null {
    if (!EQUALITY_OPERATORS.has(binOp.op)) {
      return null;
    }
    const rights = binOp.right.kind === "SetExpr" ? flattenSetElements(binOp.right) : [binOp.right];
    const selects = [binOp.left, ...rights]
      .map(operand => this.objectSelectOf(operand))
      .filter((select): select is EdgeQLAST.SelectQuery => select !== null && !this.objectIdSelects.has(select));
    const isObjects = (expr: EdgeQLAST.Expression): expr is EdgeQLAST.Path => expr.kind === "Path" && this.isSetPath(expr) && this.isObjectPath(expr);
    if (selects.length === 0 && !isObjects(binOp.left) && !isObjects(binOp.right)) {
      return null;
    }
    selects.forEach(select => this.objectIdSelects.add(select));
    const idStep: EdgeQLAST.PathStep = { kind: "PathStep", name: "id", type: "property" };
    const ids = (expr: EdgeQLAST.Expression): EdgeQLAST.Expression => isObjects(expr) ? { ...expr, steps: [...expr.steps, idStep] } : expr;
    const swap = isObjects(binOp.right) && !isObjects(binOp.left) && binOp.op !== "IN" && binOp.op !== "NOT IN";
    const rewritten = { ...binOp, left: ids(swap ? binOp.right : binOp.left), right: ids(swap ? binOp.left : binOp.right) };
    if (this.anyElementComparisons.has(binOp)) {
      this.anyElementComparisons.add(rewritten);
    }
    return rewritten;
  }

  /*** The select of objects `expr` is (`(select User filter …)`, `(select detached User)`, `(select .author.best_friend)`, `(select u)`), else null. ***/
  protected objectSelectOf(expr: EdgeQLAST.Expression): EdgeQLAST.SelectQuery | null {
    if (expr.kind !== "Subquery" || expr.query.kind !== "SelectQuery") {
      return null;
    }
    const subject = detachedOperand(expr.query.expr) ?? expr.query.expr;
    if (subject.kind === "TypeName") {
      const name = subject.name.parts.join("::");
      return this.scopeVariable(name)?.row || Context.resolveTypeName(this.ctx, name)?.kind === "object" ? expr.query : null;
    }
    if (subject.kind === "Identifier") {
      return this.scopeVariable(subject.name)?.row || Context.getCTEAlias(this.ctx, subject.name)?.typeDef ? expr.query : null;
    }
    return subject.kind === "Path" && this.isObjectPath(subject) ? expr.query : null;
  }

  /**
   * Whether a statement's value `expr` is known to be possibly the empty set
   * (SQL NULL), so that the statement answers no row for it: `{}`, an
   * `<optional …>` parameter, a path or `with` name that may be empty, a
   * global, an aggregate of an empty set, a built-in function whose answer can
   * be empty (`json_get` of a path that isn't there, `array_get` past the end,
   * …), and a built-in function, operator, cast, index, slice or tuple
   * element of such a value. Anything else is taken as a value.
   */
  protected outputMayBeEmpty(expr: EdgeQLAST.Expression): boolean {
    switch (expr.kind) {
      case "Literal":
        return expr.type === "empty";
      case "SetExpr":
        return flattenSetElements(expr).length === 0;
      case "Path":
      case "GlobalRef":
        return this.mayBeEmpty(expr);
      case "Identifier": {
        // A `with` name inlined is its value; a `for` or select variable is an element.
        const variable = this.scopeVariable(expr.name);
        return variable !== undefined && !variable.sqlOverride && !variable.element && !variable.row && this.outputMayBeEmpty(variable.expression);
      }
      case "FunctionCall": {
        const funcDef = Context.lookupFunction(this.ctx.schema, expr.name.parts);
        const name = funcDef?.name ?? "";
        // A set-returning function is rows, none of them empty.
        if (
          !funcDef || !Context.isBuiltinFunction(funcDef) || SET_RETURNING_FUNCTIONS.has(name) || NEVER_EMPTY_AGGREGATES.has(name) || name === "assert_exists"
        ) {
          return false;
        }
        return MAY_BE_EMPTY_FUNCTIONS.has(name) || expr.args.some(arg => this.outputMayBeEmpty(arg.value));
      }
      case "TypeCast":
        return expr.cardinality?.required === false || this.outputMayBeEmpty(expr.expr);
      case "UnaryOp":
        return expr.op !== "EXISTS" && this.outputMayBeEmpty(expr.operand);
      case "BinaryOp":
        if (OPTIONAL_OPERAND_OPERATORS.has(expr.op)) {
          return false;
        }
        if (expr.op === "??") {
          return this.outputMayBeEmpty(expr.left) && this.outputMayBeEmpty(expr.right);
        }
        if (expr.op === "IN" || expr.op === "NOT IN" || expr.op === "IS" || expr.op === "IS NOT") {
          return this.outputMayBeEmpty(expr.left);
        }
        return this.outputMayBeEmpty(expr.left) || this.outputMayBeEmpty(expr.right);
      // An index, a slice or a tuple's element of an empty operand.
      case "IndexExpression":
      case "SliceExpression":
      case "TupleAccessExpr":
        return this.elementWiseOperands(expr)!.some(operand => this.outputMayBeEmpty(operand));
      default:
        return false;
    }
  }

  /**
   * `=`, `!=`, `?=`, `?!=`, `in` and `not in` on whole tuples, when either
   * operand's tuple type is known (`staticTupleType`): both sides compared as
   * positional `canonicalTuple`s, each read by its own type, so tuples written
   * as different JSON (a literal's and a parameter's datetime) are equal when
   * their elements are, and, as in Gel, whatever their elements' names
   * (`(1, 'a') = (a := 1, b := 'a')` is true). Tuples of the same names whose
   * values are stored as written are compared as stored. Null otherwise.
   *
   *   filter .t = (n := 1, at := <datetime>'2024-01-01T00:00:00Z')
   *   → canonical(t) = canonical(jsonb_build_object('n', 1, 'at', …))
   */
  private compileTupleComparison(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression | null {
    if (!EQUALITY_OPERATORS.has(binOp.op)) {
      return null;
    }
    const rights = binOp.right.kind === "SetExpr" ? flattenSetElements(binOp.right) : [binOp.right];
    const leftType = this.staticTupleType(binOp.left);
    const rightTypes = rights.map(element => this.staticTupleType(element));
    const typeName = leftType ?? rightTypes.find(type => type !== null);
    if (!typeName) {
      return null;
    }
    const known = [leftType, ...rightTypes].filter((type): type is string => type !== null);
    if (known.every(type => !this.hasCanonicalElements(type) && tupleNames(type) === tupleNames(typeName))) {
      return null;
    }
    // An operand of unknown type is read as the other's.
    const operand = (expr: EdgeQLAST.Expression, type: string | null | undefined): SQL.SQLExpression =>
      this.canonicalTuple(this.compileExpression(expr), type ?? typeName, true);
    const left = operand(binOp.left, leftType);
    const sqlOp = binOp.op === "?=" ? "IS NOT DISTINCT FROM" : binOp.op === "?!=" ? "IS DISTINCT FROM" : binOp.op;
    if (binOp.right.kind !== "SetExpr") {
      return SQL.createBinaryExpression(sqlOp, left, operand(binOp.right, rightTypes[0]));
    }
    // `in {a, b}`: each element made canonical (see `compileSetExpr`).
    if (rights.length === 0) {
      return SQL.createBinaryExpression(sqlOp, left, this.compileExpression(binOp.right));
    }
    const parts = rights.map((element, index) => this.renderSqlExpr(operand(element, rightTypes[index])));
    return SQL.createBinaryExpression(sqlOp, left, { kind: "RawSQLExpression", sql: `(${parts.join(", ")})` });
  }

  /**
   * Comparisons of whole arrays of tuples, when either operand's element type
   * is known (`staticTupleArrayType`): `=`, `!=`, `?=`, `?!=`, `in` and
   * `not in` compare `canonicalTupleArray`s, so arrays written as different
   * JSON (a parameter's, a row stored as sent) are equal when their tuples
   * are, whatever the tuples' names; `<`, `>`, `<=` and `>=` compare
   * `tupleArraySortKey`s, tuple by tuple as Gel does. Null otherwise.
   */
  private compileTupleArrayComparison(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression | null {
    const ordering = ORDERING_OPERATORS.has(binOp.op);
    if (!ordering && !EQUALITY_OPERATORS.has(binOp.op)) {
      return null;
    }
    const rights = binOp.right.kind === "SetExpr" ? flattenSetElements(binOp.right) : [binOp.right];
    const leftType = this.staticTupleArrayType(binOp.left);
    const rightTypes = rights.map(element => this.staticTupleArrayType(element));
    const typeName = leftType ?? rightTypes.find(type => type !== null);
    if (!typeName) {
      return null;
    }
    // An operand of unknown type is read as the other's.
    const operand = (expr: EdgeQLAST.Expression, type: string | null | undefined): SQL.SQLExpression =>
      ordering ?
        this.tupleArraySortKey(this.compileExpression(expr), type ?? typeName) :
        this.canonicalTupleArray(this.compileExpression(expr), type ?? typeName, true);
    const left = operand(binOp.left, leftType);
    const sqlOp = binOp.op === "?=" ? "IS NOT DISTINCT FROM" : binOp.op === "?!=" ? "IS DISTINCT FROM" : binOp.op;
    if (binOp.right.kind !== "SetExpr") {
      return SQL.createBinaryExpression(sqlOp, left, operand(binOp.right, rightTypes[0]));
    }
    if (rights.length === 0) {
      return SQL.createBinaryExpression(sqlOp, left, this.compileExpression(binOp.right));
    }
    const parts = rights.map((element, index) => this.renderSqlExpr(operand(element, rightTypes[index])));
    return SQL.createBinaryExpression(sqlOp, left, { kind: "RawSQLExpression", sql: `(${parts.join(", ")})` });
  }

  /**
   * The jsonb array of tuples `sql` with each tuple a `canonicalTuple` of
   * `typeName`, in order, so equal arrays are equal jsonb; an empty set
   * (NULL) stays NULL. The array stays a SQL AST node, in the NULL test, so a
   * parameter in it is still found by `buildParameterTypeMap`.
   *
   *   → CASE WHEN ts IS NULL THEN NULL ELSE (SELECT COALESCE(jsonb_agg(canonical(e.v) ORDER BY e.ord), '[]')
   *       FROM jsonb_array_elements(ts) WITH ORDINALITY AS e(v, ord)) END
   */
  protected canonicalTupleArray(sql: SQL.SQLExpression, typeName: string, positional = false): SQL.SQLExpression {
    const tuple = this.renderSqlExpr(this.canonicalTuple(SQL.createColumnReference("v", "e"), typeName, positional));
    return unlessNullTuple(sql, {
      kind: "RawSQLExpression",
      sql: `(SELECT COALESCE(jsonb_agg(${tuple} ORDER BY e.ord), '[]'::jsonb) FROM jsonb_array_elements(${
        this.renderSqlExpr(sql)
      }) WITH ORDINALITY AS e(v, ord))`
    });
  }

  /**
   * The jsonb tuple `sql` of type `from` as a tuple of type `to`, its union
   * with other tuples (`unitedTupleType`): rebuilt with `to`'s names, or none,
   * where they differ from `from`'s; else `sql` as it is. An empty tuple
   * (NULL) stays NULL.
   *
   *   (a := 1) as tuple<int64> → CASE WHEN t IS NULL THEN NULL ELSE jsonb_build_array(t -> 'a') END
   */
  protected asTupleType(sql: SQL.SQLExpression, from: string, to: string): SQL.SQLExpression {
    const fromElements = tupleTypeElements(from) ?? [];
    const toElements = tupleTypeElements(to) ?? [];
    if (tupleNames(from) === tupleNames(to) || fromElements.length !== toElements.length) {
      return sql;
    }
    const values = toElements.map((element, index) => {
      const value = SQL.createJsonbAccess(sql, "->", tupleElementKey(fromElements[index], index));
      return tupleTypeElements(element.type) && tupleTypeElements(fromElements[index].type) ?
        this.asTupleType(value, fromElements[index].type, element.type) :
        value;
    });
    return unlessNullTuple(
      sql,
      toElements.every(element => element.name !== undefined) ?
        SQL.createJsonBuildObject(toElements.map((element, index) => SQL.createJsonField(element.name!, values[index]))) :
        SQL.createFunctionCall("jsonb_build_array", values)
    );
  }

  /*** The jsonb array of tuples `sql` of element type `from` with each tuple `asTupleType` `to`, in order; `sql` as it is when their names agree. ***/
  private asTupleArrayType(sql: SQL.SQLExpression, from: string, to: string): SQL.SQLExpression {
    if (tupleNames(from) === tupleNames(to)) {
      return sql;
    }
    const tuple = this.renderSqlExpr(this.asTupleType(SQL.createColumnReference("v", "e"), from, to));
    return unlessNullTuple(sql, {
      kind: "RawSQLExpression",
      sql: `(SELECT COALESCE(jsonb_agg(${tuple} ORDER BY e.ord), '[]'::jsonb) FROM jsonb_array_elements(${
        this.renderSqlExpr(sql)
      }) WITH ORDINALITY AS e(v, ord))`
    });
  }

  /**
   * The rows of tuples of type `from` that `statement` selects (one column),
   * each `asTupleType` `to`, for a branch of a union of tuples; `statement`
   * as it is when their names agree.
   */
  protected asTupleTypeRows(statement: SQL.SQLStatement, from: string, to: string): SQL.SQLStatement {
    if (tupleNames(from) === tupleNames(to)) {
      return statement;
    }
    const alias = Context.generateAlias(this.ctx, "tuple");
    return SQL.createSelectStatement({
      from: SQL.createFromClause([{ alias, columnAliases: ["value"], kind: "TableReference", name: "", subquery: statement }]),
      select: SQL.createSelectClause([SQL.createSelectItem(this.asTupleType(SQL.createColumnReference("value", alias), from, to))])
    });
  }

  /*** The united tuple type (`unitedTupleType`) of the tuples `exprs` evaluate to, when each one's type is known (`staticTupleType`); else null. ***/
  protected unitedStaticTupleType(exprs: EdgeQLAST.Expression[]): string | null {
    const types = exprs.map(expr => this.staticTupleType(expr));
    return types.length > 0 && types.every(type => type !== null) ? unitedTupleType(types as string[]) : null;
  }

  /*** The united tuple type of the arrays of tuples `exprs` evaluate to, when each one's is known (`staticTupleArrayType`); else null. ***/
  private unitedStaticTupleArrayType(exprs: EdgeQLAST.Expression[]): string | null {
    const types = exprs.map(expr => this.staticTupleArrayType(expr));
    return types.every(type => type !== null) ? unitedTupleType(types as string[]) : null;
  }

  /**
   * `compiled`, the values of the alternatives `exprs` (`??`'s operands,
   * `if … else`'s branches), as their union's type: tuples, or arrays of
   * tuples, named differently lose their names, as `union`'s do
   * (`(a := 1) ?? (b := 2)` is `(1,)`); else `compiled` as it is.
   */
  private asUnitedAlternatives(exprs: EdgeQLAST.Expression[], compiled: SQL.SQLExpression[]): SQL.SQLExpression[] {
    const tuples = this.unitedStaticTupleType(exprs);
    if (tuples) {
      return compiled.map((sql, index) => this.asTupleType(sql, this.staticTupleType(exprs[index])!, tuples));
    }
    const arrays = this.unitedStaticTupleArrayType(exprs);
    if (arrays) {
      return compiled.map((sql, index) => this.asTupleArrayType(sql, this.staticTupleArrayType(exprs[index])!, arrays));
    }
    return compiled;
  }

  /**
   * The jsonb array of tuples `sql` as a key to order or compare by: a
   * PostgreSQL array of each tuple's `tupleSortKey`, in order, which sorts
   * tuple by tuple (a jsonb array sorts by length first). An empty set (NULL)
   * stays NULL, for `empty first|last`.
   */
  private tupleArraySortKey(sql: SQL.SQLExpression, typeName: string): SQL.SQLExpression {
    const tuple = this.renderSqlExpr(this.tupleSortKey(SQL.createColumnReference("v", "e"), typeName));
    return unlessNullTuple(sql, {
      kind: "RawSQLExpression",
      sql: `ARRAY(SELECT ${tuple} FROM jsonb_array_elements(${this.renderSqlExpr(sql)}) WITH ORDINALITY AS e(v, ord) ORDER BY e.ord)`
    });
  }

  /**
   * The elements' tuple type of `expr` when it is an array of tuples known
   * without running the query: a literal's (its first tuple's type), an array
   * cast's, a property's or a variable's, `array_agg` of tuples, `++` or a
   * slice of such an array. Null otherwise.
   */
  protected staticTupleArrayType(expr: EdgeQLAST.Expression): string | null {
    if (expr.kind === "ArrayExpr") {
      return this.unitedStaticTupleType(expr.elements) ??
        expr.elements.map(element => this.staticTupleType(element)).find(type => type !== null) ?? null;
    }
    if (expr.kind === "FunctionCall" && expr.args.length === 1 && Context.lookupFunction(this.ctx.schema, expr.name.parts)?.name === "array_agg") {
      return this.staticTupleType(expr.args[0].value);
    }
    if (expr.kind === "BinaryOp" && expr.op === "++") {
      const left = this.staticTupleArrayType(expr.left);
      const right = this.staticTupleArrayType(expr.right);
      return left && right ? unitedTupleType([left, right]) : left ?? right;
    }
    if (expr.kind === "SliceExpression") {
      return this.staticTupleArrayType(expr.expr);
    }
    if (expr.kind === "BinaryOp" && expr.op === "??") {
      return this.unitedStaticTupleArrayType([expr.left, expr.right]);
    }
    // An element of an array of arrays of tuples.
    if (expr.kind === "IndexExpression") {
      const element = /^array<(.+)>$/.exec(this.staticNestedArrayType(expr.expr) ?? "")?.[1] ?? "";
      const tuple = /^array<(.+)>$/.exec(element)?.[1] ?? "";
      return tupleTypeElements(tuple) ? tuple : null;
    }
    if (expr.kind === "IfElse") {
      return this.unitedStaticTupleArrayType([expr.then, expr.else]);
    }
    if (expr.kind === "Identifier") {
      const variable = this.scopeVariable(expr.name);
      if (variable && !variable.sqlOverride) {
        return this.staticTupleArrayType(variable.expression);
      }
    }
    const element = this.staticArrayElementType(expr);
    return element !== null && tupleTypeElements(element) ? element : null;
  }

  /**
   * The type of `expr` when it is an array of arrays (`array<array<int64>>`)
   * known without running the query: a literal with an array element, a
   * cast's, `array_agg` of arrays, `++`, `??`, `if … else`, a slice or an
   * index of one, a variable's. Null otherwise. Such an array is a jsonb
   * array (`edgeqlTypeToPgType`): PostgreSQL has no arrays of arrays of
   * different lengths.
   */
  protected staticNestedArrayType(expr: EdgeQLAST.Expression): string | null {
    const arrayType = (operand: EdgeQLAST.Expression): string | null => {
      if (operand.kind === "SetExpr") {
        return flattenSetElements(operand).map(arrayType).find(type => type !== null) ?? null;
      }
      const tuples = this.staticTupleArrayType(operand);
      const type = tuples ? `array<${tuples}>` : this.staticNestedArrayType(operand) ??
        (operand.kind === "TypeCast" ? renderEdgeQLTypeName(operand.type) : this.staticScalarType(operand));
      return type?.startsWith("array<") ? type : null;
    };
    switch (expr.kind) {
      case "ArrayExpr": {
        const element = expr.elements.map(arrayType).find(type => type !== null);
        return element ? `array<${element}>` : null;
      }
      case "TypeCast": {
        const type = renderEdgeQLTypeName(expr.type);
        return type.startsWith("array<array<") ? type : null;
      }
      case "FunctionCall": {
        const element = expr.args.length === 1 && Context.lookupFunction(this.ctx.schema, expr.name.parts)?.name === "array_agg" ?
          arrayType(expr.args[0].value) :
          null;
        return element ? `array<${element}>` : null;
      }
      case "BinaryOp":
        return expr.op === "++" || expr.op === "??" ? this.staticNestedArrayType(expr.left) ?? this.staticNestedArrayType(expr.right) : null;
      case "IfElse":
        return this.staticNestedArrayType(expr.then) ?? this.staticNestedArrayType(expr.else);
      case "SliceExpression":
        return this.staticNestedArrayType(expr.expr);
      case "IndexExpression": {
        const element = /^array<(.+)>$/.exec(this.staticNestedArrayType(expr.expr) ?? "")?.[1] ?? "";
        return element.startsWith("array<array<") ? element : null;
      }
      case "Identifier": {
        const variable = this.scopeVariable(expr.name);
        return variable && !variable.sqlOverride ? this.staticNestedArrayType(variable.expression) : null;
      }
      default:
        return null;
    }
  }

  /**
   * `<tuple> in array_unpack(<array of tuples>)` (and `not in`): the tuple
   * compared as a positional `canonicalTuple` with each of the array's, read
   * from the jsonb array such an array is (a literal's `jsonb[]` built as one,
   * see `jsonbArrayLiteral`). Null when neither the tuple's nor the array's
   * element type is known.
   *
   *   .t in array_unpack(<array<tuple<n: int64, at: datetime>>>$p)
   *   → canonical(t) IN (SELECT canonical(__elem.value) FROM jsonb_array_elements(CAST($1 AS jsonb)) AS __elem(value))
   */
  private compileTupleArrayMembership(binOp: EdgeQLAST.BinaryOp, array: EdgeQLAST.Expression): SQL.SQLExpression | null {
    const elementType = this.staticArrayElementType(array);
    const arrayType = elementType !== null && tupleTypeElements(elementType) ?
      elementType :
      array.kind === "ArrayExpr" && array.elements.length > 0 ?
      this.staticTupleType(array.elements[0]) :
      null;
    const leftType = this.staticTupleType(binOp.left);
    const typeName = leftType ?? arrayType;
    if (!typeName) {
      return null;
    }
    const compiled = this.compileExpression(array);
    const element = SQL.createColumnReference("value", "__elem");
    const elements = SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(this.canonicalTuple(element, arrayType ?? typeName, true))]),
      from: SQL.createFromClause([{
        alias: "__elem",
        columnAliases: ["value"],
        expression: SQL.createFunctionCall("jsonb_array_elements", [this.jsonbArrayLiteral(compiled) ?? compiled]),
        kind: "TableReference",
        name: ""
      }])
    });
    const left = this.canonicalTuple(this.compileExpression(binOp.left), leftType ?? typeName, true);
    return SQL.createBinaryExpression(binOp.op, left, SQL.createSubqueryExpression(elements));
  }

  /**
   * The tuple type of `expr` when known without running the query: a cast's,
   * a property's, a variable's, a set literal's first known one, a tuple
   * literal's (an element of unknown type as `json`, kept as it is by
   * `canonicalTuple`). Null otherwise.
   */
  protected staticTupleType(expr: EdgeQLAST.Expression): string | null {
    let type: string | null = null;
    if (expr.kind === "TupleExpr" || expr.kind === "NamedTuple") {
      const elements: { name?: string; value: EdgeQLAST.Expression; }[] = expr.kind === "TupleExpr" ?
        expr.elements.map(value => ({ value })) :
        expr.elements;
      return `tuple<${
        elements
          .map(({ name, value }) => {
            const element = this.staticTupleType(value) ?? this.staticScalarType(value) ?? "json";
            return name !== undefined ? `${name}: ${element}` : element;
          })
          .join(", ")
      }>`;
    }
    if (expr.kind === "TypeCast") {
      type = renderEdgeQLTypeName(expr.type);
    } else if (expr.kind === "Path") {
      type = this.staticNumericType(expr);
    } else if (expr.kind === "Identifier") {
      const variable = this.scopeVariable(expr.name);
      if (variable && !variable.sqlOverride) {
        return this.staticTupleType(variable.expression);
      }
      type = variable?.staticType ?? null;
    } else if (expr.kind === "SetExpr") {
      const elements = flattenSetElements(expr);
      return this.unitedStaticTupleType(elements) ?? elements.map(element => this.staticTupleType(element)).find(found => found !== null) ?? null;
    } else if (expr.kind === "BinaryOp" && (expr.op === "UNION" || expr.op === "??")) {
      return this.unitedStaticTupleType([expr.left, expr.right]);
    } else if (expr.kind === "IfElse") {
      return this.unitedStaticTupleType([expr.then, expr.else]);
    } else if (expr.kind === "Subquery" && expr.query.kind === "SelectQuery" && !expr.query.shape) {
      return this.staticTupleType(expr.query.expr);
    } else if (expr.kind === "IndexExpression") {
      return this.staticTupleArrayType(expr.expr);
    } else if (expr.kind === "TupleAccessExpr") {
      type = this.tupleAccessElement(expr)?.element.type ?? null;
    }
    return type !== null && tupleTypeElements(type) ? type : null;
  }

  /*** Whether the tuple type `typeName` has an element, at any depth, of a type in CANONICAL_JSON_PG_TYPES. ***/
  private hasCanonicalElements(typeName: string): boolean {
    return (tupleTypeElements(typeName) ?? []).some(element =>
      tupleTypeElements(element.type) ?
        this.hasCanonicalElements(element.type) :
        CANONICAL_JSON_PG_TYPES.has(edgeqlTypeToPgType(element.type, this.ctx.schema.scalars))
    );
  }

  /**
   * The jsonb tuple `sql` of `typeName` rebuilt so equal tuples are equal
   * jsonb: each element of a type in CANONICAL_JSON_PG_TYPES read as that type
   * and made JSON again (`to_jsonb`), a nested tuple rebuilt the same way, any
   * other element kept as is. An empty tuple (NULL) stays NULL. With
   * `positional`, a named tuple is rebuilt as an array, as an unnamed one is:
   * Gel compares tuples by position, whatever their names.
   *
   *   tuple<n: int64, at: datetime>
   *   → CASE WHEN t IS NULL THEN NULL ELSE jsonb_build_object(
   *       'n', to_jsonb(CAST(t ->> 'n' AS bigint)), 'at', to_jsonb(CAST(t ->> 'at' AS timestamptz))) END
   *
   * The operand stays a SQL AST node so a parameter in it is still found by
   * `buildParameterTypeMap`.
   */
  protected canonicalTuple(sql: SQL.SQLExpression, typeName: string, positional = false): SQL.SQLExpression {
    const elements = tupleTypeElements(typeName)!;
    const values = elements.map((element, index) => {
      if (tupleTypeElements(element.type)) {
        return this.canonicalTuple(SQL.createJsonbAccess(sql, "->", tupleElementKey(element, index)), element.type, positional);
      }
      const typed = this.typedTupleElement(sql, element, index);
      return typed ? SQL.createFunctionCall("to_jsonb", [typed]) : SQL.createJsonbAccess(sql, "->", tupleElementKey(element, index));
    });
    const named = !positional && elements.every(element => element.name !== undefined);
    return unlessNullTuple(
      sql,
      named ?
        SQL.createJsonBuildObject(elements.map((element, index) => SQL.createJsonField(element.name!, values[index]))) :
        SQL.createFunctionCall("jsonb_build_array", values)
    );
  }

  /**
   * The jsonb tuple `sql` of `typeName` as a key to order by: a row of its
   * elements in declared order, each of a type in CANONICAL_JSON_PG_TYPES read
   * as that type, a nested tuple as a row of its own, any other element as its
   * jsonb, so tuples sort element by element as Gel sorts them (not as their
   * stored JSON text, whose object keys jsonb orders shortest first). An empty
   * tuple (NULL) stays NULL, for `empty first|last`.
   *
   *   tuple<n: int64, at: datetime>
   *   → CASE WHEN t IS NULL THEN NULL ELSE ROW(CAST(t ->> 'n' AS bigint), CAST(t ->> 'at' AS timestamptz)) END
   */
  private tupleSortKey(sql: SQL.SQLExpression, typeName: string): SQL.SQLExpression {
    const row = (tuple: SQL.SQLExpression, type: string): SQL.SQLExpression =>
      SQL.createFunctionCall(
        "ROW",
        tupleTypeElements(type)!.map((element, index) => {
          const value = SQL.createJsonbAccess(tuple, "->", tupleElementKey(element, index));
          return tupleTypeElements(element.type) ? row(value, element.type) : this.typedTupleElement(tuple, element, index) ?? value;
        })
      );
    return unlessNullTuple(sql, row(sql, typeName));
  }

  /*** Element `index` of the jsonb tuple `sql` read as its type, when that is in CANONICAL_JSON_PG_TYPES (`CAST(t ->> 'at' AS timestamptz)`); null for any other type. ***/
  private typedTupleElement(sql: SQL.SQLExpression, element: { name?: string; type: string; }, index: number): SQL.SQLExpression | null {
    const pgType = edgeqlTypeToPgType(element.type, this.ctx.schema.scalars);
    return CANONICAL_JSON_PG_TYPES.has(pgType) ?
      SQL.createCastExpression(SQL.createJsonbAccess(sql, "->>", tupleElementKey(element, index)), pgType) :
      null;
  }

  /*** The select `in` reads for a right operand that is a type's objects or a path's set (see `membershipSelect`), else null. ***/
  private membershipSubquery(expr: EdgeQLAST.Expression): SQL.SubqueryExpression | null {
    const set = this.isTypeRoot(expr) ? this.readingSnapshot(() => this.membershipSelect(expr)) : this.membershipSelect(expr);
    return set ? SQL.createSubqueryExpression(set) : null;
  }

  /**
   * `/`, `//` and `%` with Gel's semantics, which PostgreSQL's operators do
   * not share (PG `7 / 2` is 3, has no `//`, and its `%` takes the sign of the
   * dividend):
   *
   *   decimal / decimal → l / r                          (bigint is numeric too)
   *   other   / other   → l / CAST(r AS double precision) (int / int is float64)
   *   decimal // …      → FLOOR(l / r)
   *   float   // …      → FLOOR(l / CAST(r AS double precision))
   *   int     // int    → CAST(FLOOR(CAST(l AS numeric) / r) AS <widest int>)
   *   float   % …       → l - FLOOR(l / CAST(r AS double precision)) * r
   *   int|decimal % …   → ((l % r) + r) % r               (sign of the divisor)
   *
   * An operand's type comes from `staticNumericType`. An operand of unknown
   * type is taken as an int: an int column or parameter is by far the common
   * case, and an unknown float or decimal still gets the right value from
   * `/` and `//` (as a float64 and an int64); only `%` of an unknown float
   * fails, as PG has no float `%`.
   */
  private compileDivision(
    binOp: EdgeQLAST.BinaryOp,
    left: SQL.SQLExpression,
    right: SQL.SQLExpression
  ): SQL.SQLExpression {
    const types = [this.staticNumericType(binOp.left), this.staticNumericType(binOp.right)];
    const decimal = types.some(type => type !== null && DECIMAL_TYPES.has(type));
    const float = !decimal && types.some(type => type !== null && FLOAT_TYPES.has(type));
    const floatDivision = (): SQL.SQLExpression => SQL.createBinaryExpression("/", left, SQL.createCastExpression(right, "double precision"));

    switch (binOp.op) {
      case "/":
        return decimal ? SQL.createBinaryExpression("/", left, right) : floatDivision();
      case "//": {
        if (decimal) {
          return SQL.createFunctionCall("FLOOR", [SQL.createBinaryExpression("/", left, right)]);
        }
        if (float) {
          return SQL.createFunctionCall("FLOOR", [floatDivision()]);
        }
        const quotient = SQL.createBinaryExpression("/", SQL.createCastExpression(left, "numeric"), right);
        return SQL.createCastExpression(SQL.createFunctionCall("FLOOR", [quotient]), widestIntSqlType(types));
      }
      default:
        if (float) {
          return SQL.createBinaryExpression("-", left, SQL.createBinaryExpression("*", SQL.createFunctionCall("FLOOR", [floatDivision()]), right));
        }
        return SQL.createBinaryExpression(
          "%",
          SQL.createBinaryExpression("+", SQL.createBinaryExpression("%", left, right), right),
          right
        );
    }
  }

  /**
   * The EdgeQL scalar type of a numeric operand when it is known without
   * running the query: a literal (`7` is int64, `7.0` float64, `7n` bigint,
   * `7.5n` decimal), a cast, a property of a type in scope (the same lookup
   * as `multiPropertyColumn`), a variable bound to one of these, or
   * arithmetic over them. Null when unknown (a function call, subquery,
   * untyped parameter, link path, …).
   */
  protected staticNumericType(expr: EdgeQLAST.Expression): string | null {
    switch (expr.kind) {
      case "Literal":
        return NUMERIC_LITERAL_TYPES.get(expr.type) ?? null;
      case "TypeCast":
        return this.scalarBaseType(renderEdgeQLTypeName(expr.type)) ?? expr.type.name.parts[expr.type.name.parts.length - 1];
      case "Path": {
        if (expr.steps.length !== 1 || expr.steps[0].type !== "property") {
          // A path from a type, a binding or a `for` variable (`u.tags`).
          const property = this.pathProperty(expr);
          return property && !property.multi ? Context.propertyBaseType(property) ?? null : null;
        }
        const name = expr.steps[0].name;
        for (const ta of this.ctx.currentScope.aliases.values()) {
          const property = Context.resolveTypeName(this.ctx, ta.type)?.properties.get(name);
          if (property) {
            return property.multi ? null : Context.propertyBaseType(property) ?? null;
          }
        }
        return null;
      }
      case "Identifier": {
        const variable = this.scopeVariable(expr.name);
        if (variable?.sqlOverride) {
          return variable.staticType ?? null;
        }
        return variable ? this.staticNumericType(variable.expression) : null;
      }
      case "UnaryOp":
        return expr.op === "-" || expr.op === "+" ? this.staticNumericType(expr.operand) : null;
      case "BinaryOp": {
        if (!["+", "-", "*", "/", "//", "%"].includes(expr.op)) {
          return null;
        }
        const operands = [this.staticNumericType(expr.left), this.staticNumericType(expr.right)];
        if (operands.some(type => type !== null && DECIMAL_TYPES.has(type))) {
          return "decimal";
        }
        if (expr.op === "/" || operands.some(type => type !== null && FLOAT_TYPES.has(type))) {
          return "float64";
        }
        const ints = operands.map(type => type !== null ? INT_SQL_TYPES.get(type) : undefined);
        if (ints.some(int => !int)) {
          return null;
        }
        return ints[0]!.width >= ints[1]!.width ? operands[0] : operands[1];
      }
      case "SetExpr":
        // The elements' common type (`{1, 2.5}` is float64).
        return this.commonNumericType(flattenSetElements(expr).map(element => this.staticNumericType(element)));
      case "TupleAccessExpr": {
        // A tuple's scalar element (`(a := 1).a`).
        const type = this.tupleAccessElement(expr)?.element.type ?? null;
        return type !== null && type !== "json" && !tupleTypeElements(type) ? type : null;
      }
      default:
        return null;
    }
  }

  /**
   * The EdgeQL type of `expr` when it is known without running the query:
   * `staticNumericType`'s forms, a call to a function registered with its
   * return type (`datetime_current()`), date arithmetic over operands of known
   * types (`dateArithmeticType`), and an array literal whose elements are all
   * of one known type. Null when unknown.
   */
  protected staticScalarType(expr: EdgeQLAST.Expression): string | null {
    const type = this.staticNumericType(expr);
    if (type !== null) {
      return type;
    }
    switch (expr.kind) {
      case "Literal":
        return LITERAL_TYPES.get(expr.type) ?? null;
      case "FunctionCall": {
        const funcDef = Context.lookupFunction(this.ctx.schema, expr.name.parts);
        // `cal::duration_normalize_days` of a date duration is a date duration.
        if (funcDef?.name === "cal_duration_normalize_days" && expr.args.length === 1) {
          const arg = this.staticScalarType(expr.args[0].value);
          return isStdType(arg, "date_duration") ? arg : funcDef.returnType ?? null;
        }
        // `array_agg` of a set of a known type is an array of it.
        if (funcDef?.name === "array_agg" && expr.args.length === 1) {
          const element = this.staticScalarType(expr.args[0].value)?.replace(/^(std|cal)::/, "");
          return element && !element.startsWith("array<") ? `array<${element}>` : null;
        }
        return funcDef?.returnType ?? null;
      }
      case "BinaryOp":
        // `a ?? b` is of its operands' type.
        if (expr.op === "??") {
          return this.staticScalarType(expr.left) ?? this.staticScalarType(expr.right);
        }
        return expr.op === "+" || expr.op === "-" ?
          dateArithmeticType(expr.op, this.staticScalarType(expr.left), this.staticScalarType(expr.right)) :
          null;
      case "IfElse":
        return this.staticScalarType(expr.then) ?? this.staticScalarType(expr.else);
      case "Identifier": {
        const variable = this.scopeVariable(expr.name);
        return variable && !variable.sqlOverride ? this.staticScalarType(variable.expression) : null;
      }
      case "ArrayExpr": {
        const types = expr.elements.map(element => this.staticScalarType(element)?.replace(/^(std|cal)::/, "") ?? null);
        return types[0] && types.every(element => element === types[0]) ? `array<${types[0]}>` : null;
      }
      default:
        return null;
    }
  }

  /**
   * `value` as the text Gel writes when `type`, its EdgeQL type if known, is
   * `cal::date_duration` or an array of them: ISO 8601 like every interval
   * (connections use `intervalstyle = iso_8601`, lib/database.ts), but zero is
   * `P0D`, where PostgreSQL writes `PT0S` (`disc_date_duration_text`,
   * lib/stdlib-sql.ts). For where a value leaves the query (a select's value,
   * a shape element, a tuple element) or becomes text; any other value is
   * returned as is. There is no expression type inference in the compiler, so
   * a zero date duration of an expression whose type is not stated
   * (`staticScalarType`) is still written `PT0S`.
   */
  protected dateDurationText(value: SQL.SQLExpression, type: string | null | undefined): SQL.SQLExpression {
    const element = /^array<(.+)>$/.exec(type ?? "")?.[1] ?? type;
    return isStdType(element ?? null, "date_duration") ? SQL.createFunctionCall("disc_date_duration_text", [value]) : value;
  }

  /**
   * `value` as the text `<str>` and `to_str` make of it when `type`, its
   * EdgeQL type if known, is a date or time: Gel's ISO 8601 text. A
   * `datetime` is `2024-01-02T03:04:05+00:00` and a `cal::local_datetime`
   * `2024-01-02T03:04:05`, where PostgreSQL's text puts a space and writes
   * `+00`; that is the JSON string `to_jsonb` makes of them, less its quotes
   * (it has no escapes). A date duration is `dateDurationText`'s. Any other
   * value is returned as is.
   */
  protected temporalText(value: SQL.SQLExpression, type: string | null): SQL.SQLExpression {
    if (isStdType(type, "datetime") || isStdType(type, "local_datetime")) {
      const json = SQL.createCastExpression(SQL.createFunctionCall("to_jsonb", [value]), "text");
      return SQL.createFunctionCall("btrim", [json, SQL.createLiteral("string", "\"")]);
    }
    return this.dateDurationText(value, type);
  }

  /**
   * The arguments of PostgreSQL's make_date / make_time / make_timestamp /
   * make_timestamptz from Gel's `(year, month, day, hour, min, sec[,
   * timezone])` and `(hour, min, sec)`: fields as `integer`, but the seconds,
   * at `seconds`, as `double precision`, and the time zone (the seventh) as is.
   */
  private dateTimeParts(args: SQL.SQLExpression[], seconds?: number): SQL.SQLExpression[] {
    return args.map((arg, index) => index === 6 ? arg : SQL.createCastExpression(arg, index === seconds ? "double precision" : "integer"));
  }

  /*** `to_str(value)`: its text, as `<str>` makes it (`temporalText`); bytes read as UTF-8, as in Gel. ***/
  private toStrValue(expr: EdgeQLAST.Expression, value: SQL.SQLExpression): SQL.SQLExpression {
    const type = this.staticScalarType(expr);
    if (isStdType(type, "bytes")) {
      return SQL.createFunctionCall("convert_from", [value, SQL.createLiteral("string", "UTF8")]);
    }
    const text = this.temporalText(value, type);
    return text !== value ? text : SQL.createCastExpression(value, "text");
  }

  /**
   * `to_str(value, fmt)`: Gel's overloads for a date or time, a duration, a
   * number (PostgreSQL's to_char, `disc_to_str`) and json (`pretty`), and
   * `to_str(array<str>, delimiter)`, which is `array_join`. The value is cast
   * to the SQL type of its overload when its type is known (an int to
   * `bigint`, a float32 to `double precision`, as Gel's implicit casts do);
   * any other known type has no such overload, as in Gel.
   */
  private compileFormattedToStr(funcCall: EdgeQLAST.FunctionCall, args: SQL.SQLExpression[]): SQL.SQLExpression {
    const expr = funcCall.args[0].value;
    const type = this.staticScalarType(expr);
    if (type?.startsWith("array<") || expr.kind === "ArrayExpr") {
      return SQL.createFunctionCall("ARRAY_TO_STRING", args);
    }
    const base = type?.replace(/^(std|cal)::/, "") ?? null;
    const pgType = base !== null ? TO_STR_FORMAT_TYPES.get(base) : undefined;
    if (type !== null && !pgType) {
      const qualified = type.includes("::") ? type : `std::${type}`;
      throw new CompilationError(`function "to_str(arg0: ${qualified}, arg1: std::str)" does not exist`, locationOf(funcCall));
    }
    const value = pgType ? SQL.createCastExpression(args[0], pgType) : args[0];
    return this.compileFormatted(funcCall, SQL.createFunctionCall("disc_to_str", [value, args[1]]), () => this.toStrValue(expr, args[0]));
  }

  /**
   * `to_datetime(str, fmt)` and `cal::to_local_datetime` / `_date` / `_time`
   * of one (`disc_to_timestamp`, UTC; `pgType` the result's type), or, of a
   * value of the other kind and a time zone, the value in that zone
   * (`to_datetime(local_datetime, zone)`, `cal::to_local_date(datetime,
   * zone)`, …). `name` is the function's, for its errors.
   */
  private compileFormattedTimestamp(
    funcCall: EdgeQLAST.FunctionCall,
    args: SQL.SQLExpression[],
    name: string,
    pgType: string
  ): SQL.SQLExpression {
    const zoned = pgType === "timestamp with time zone";
    const valueType = this.staticScalarType(funcCall.args[0].value);
    if (isStdType(valueType, zoned ? "local_datetime" : "datetime")) {
      const inZone = SQL.createFunctionCall("timezone", [args[1], args[0]]);
      return zoned ? inZone : SQL.createCastExpression(inZone, pgType);
    }
    const parsed = SQL.createFunctionCall("disc_to_timestamp", [
      SQL.createLiteral("string", name),
      args[0],
      args[1],
      SQL.createLiteral("boolean", zoned)
    ]);
    const value = zoned ? parsed : SQL.createCastExpression(SQL.createFunctionCall("timezone", [SQL.createLiteral("string", "UTC"), parsed]), pgType);
    return this.compileFormatted(funcCall, value, () => SQL.createCastExpression(args[0], pgType));
  }

  /**
   * A function of a value and a format, `formatted`. Gel declares the format
   * `OPTIONAL str = {}`: an empty one is the function without a format,
   * `unformatted()`, which the formatted form (NULL for a NULL format) falls
   * back to. A literal format is never empty.
   */
  private compileFormatted(
    funcCall: EdgeQLAST.FunctionCall,
    formatted: SQL.SQLExpression,
    unformatted: () => SQL.SQLExpression
  ): SQL.SQLExpression {
    const fmt = funcCall.args[1].value;
    return fmt.kind === "Literal" && fmt.type === "string" ? formatted : SQL.createFunctionCall("COALESCE", [formatted, unformatted()]);
  }

  /**
   * The wire form of `bytes` inside a shape or JSON. `jsonb_build_object` and
   * `to_jsonb` would render a bytea as PostgreSQL hex text (`"\\x1f8b…"`);
   * JSON carries `bytes` as base64 (RFC 4648), and `encode` breaks lines every
   * 76 characters, hence the `translate`. An `array<bytes>` is encoded element
   * by element, in order; NULL stays NULL and `{}` stays `[]`.
   *
   * The value stays a SQL AST node (for the array, in the `IS NULL` test) so
   * that a parameter inside it — `x := <bytes>$p` — is still found by
   * `buildParameterTypeMap`, which is how the server knows to decode it.
   */
  protected bytesAsBase64(value: SQL.SQLExpression, bytesType: "bytea" | "bytea[]" | null): SQL.SQLExpression {
    const newline: SQL.RawSQLExpression = { kind: "RawSQLExpression", sql: "E'\\n'" };
    const encoded = (bytes: SQL.SQLExpression): SQL.SQLExpression =>
      SQL.createFunctionCall("translate", [
        SQL.createFunctionCall("encode", [bytes, SQL.createLiteral("string", "base64")]),
        newline,
        SQL.createLiteral("string", "")
      ]);

    if (bytesType === "bytea") {
      return encoded(value);
    }
    if (bytesType === "bytea[]") {
      const elements = `ARRAY(SELECT ${this.renderSqlExpr(encoded(SQL.createColumnReference("b")))} FROM unnest(${
        this.renderSqlExpr(value)
      }) WITH ORDINALITY AS u(b, ord) ORDER BY ord)`;
      return SQL.createCaseExpression(
        [SQL.createWhenClause(SQL.createBinaryExpression("IS", value, SQL.createLiteral("null", null)), SQL.createLiteral("null", null))],
        { kind: "RawSQLExpression", sql: elements }
      );
    }
    return value;
  }

  /*** The common type of set or array literal elements of these static types: a decimal, else float64, else the widest int. Null when one is unknown. ***/
  private commonNumericType(types: (string | null)[]): string | null {
    if (types.length === 0 || types.some(type => type === null)) {
      return null;
    }
    const decimal = types.find(type => DECIMAL_TYPES.has(type!));
    if (decimal) {
      return decimal;
    }
    if (types.some(type => FLOAT_TYPES.has(type!))) {
      return "float64";
    }
    // The widest int.
    const width = (type: string | null): number => INT_SQL_TYPES.get(type!)?.width ?? 0;
    return types.reduce((widest, type) => width(type) > width(widest) ? type : widest);
  }

  /**
   * The EdgeQL type of the elements of an array operand when it is known
   * without running the query: an array literal's (their common type), an
   * array cast's or an array property's element type, or that of the array a
   * variable is bound to. Null when unknown.
   */
  private staticArrayElementType(expr: EdgeQLAST.Expression): string | null {
    if (expr.kind === "ArrayExpr") {
      const bytes = expr.elements.length > 0 && expr.elements.every(element => this.staticScalarType(element) === "bytes");
      return bytes ? "bytes" : this.commonNumericType(expr.elements.map(element => this.staticNumericType(element)));
    }
    let type: string | null = null;
    if (expr.kind === "Identifier") {
      const variable = this.scopeVariable(expr.name);
      if (variable && !variable.sqlOverride) {
        return this.staticArrayElementType(variable.expression);
      }
      type = variable?.staticType ?? null;
    } else if (expr.kind === "TypeCast") {
      type = renderEdgeQLTypeName(expr.type);
    } else if (expr.kind === "Path") {
      type = this.staticNumericType(expr);
    }
    return /^array<(.+)>$/.exec(type ?? "")?.[1] ?? null;
  }

  /**
   * Whether `expr` starts from an object type — `Item`, `Item.tags` — rather
   * than from a variable, a `with` binding or the implicit subject. Such a
   * read sees the tables as they were before the statement (see `readingSnapshot`).
   */
  protected isTypeRoot(expr: EdgeQLAST.Expression): boolean {
    const name = expr.kind === "TypeName" ?
      expr.name.parts.join("::") :
      expr.kind === "Path" && expr.rooted ?
      expr.steps[0]?.name :
      undefined;
    return name !== undefined && !this.scopeVariable(name) && !Context.getCTEAlias(this.ctx, name) &&
      Context.resolveTypeName(this.ctx, name)?.kind === "object";
  }

  /**
   * The variable `name` names in the current or an enclosing scope (a `for`
   * variable, an inlined `with` binding, a bound subject). Inside `detached`,
   * the subjects bound outside it are not seen.
   */
  protected scopeVariable(name: string): Context.VariableDef | undefined {
    const scopes = [...this.ctx.scopes, this.ctx.currentScope];
    for (let index = scopes.length - 1; index >= 0; index--) {
      const variable = scopes[index].variables.get(name);
      if (variable && !(variable.subject && index < this.detachedFrom)) {
        return variable;
      }
    }
    return undefined;
  }

  /**
   * Bind the subject of a select, update or delete to its current object
   * `row`, as Gel's path scoping does: in the statement's filter, order by
   * and shape, `Item` (or `Item.name`, `count(Item)`) of `select Item`, and
   * `Order.items` of `select Order.items.name`, are the current object, not
   * the whole set again. `names` are the subject's spellings: its type as
   * written and as resolved, or its path prefix (`Order.items`).
   */
  protected bindSubject(names: string[], row: Context.TableAlias): void {
    for (const name of new Set(names)) {
      this.ctx.currentScope.variables.set(name, {
        expression: EdgeQLAST.createIdentifier(name),
        name,
        row,
        sqlOverride: SQL.createColumnReference("id", row.alias),
        subject: true,
        type: row.type
      });
    }
  }

  /**
   * The longest leading steps of a rooted path bound to an object (a `for`
   * variable over objects, a bound subject: `Order.items` of
   * `Order.items.name`) and the steps after them, or null.
   */
  protected boundPrefix(path: EdgeQLAST.Path): { row: Context.TableAlias; steps: EdgeQLAST.PathStep[]; } | null {
    if (!path.rooted) {
      return null;
    }
    for (let length = path.steps.length; length >= 1; length--) {
      const prefix = path.steps.slice(0, length);
      if (length > 1 && prefix.slice(1).some(step => step.type !== "property")) {
        continue;
      }
      const row = this.scopeVariable(prefix.map(step => step.name).join("."))?.row;
      if (row) {
        return { row, steps: path.steps.slice(length) };
      }
    }
    return null;
  }

  /**
   * `select <T> { id }` when `expr` is an object type `T`: the set of its
   * objects, which an aggregate (`count(T)`) or `exists T` reads as rows. A
   * bound subject (`count(Item)` in `select Item { … }`) is its one current
   * object.
   */
  protected typeSetQuery(expr: EdgeQLAST.Expression): EdgeQLAST.Subquery | null {
    const detached = detachedOperand(expr);
    const type = detached ?? expr;
    if (type.kind !== "TypeName") {
      return null;
    }
    const name = type.name.parts.join("::");
    const variable = detached ? this.withDetached(() => this.scopeVariable(name)) : this.scopeVariable(name);
    const isObjects = variable ? variable.row !== undefined : Context.resolveTypeName(this.ctx, name)?.kind === "object";
    const shape = EdgeQLAST.createShape([EdgeQLAST.createShapeElement(EdgeQLAST.createIdentifier("id"))]);
    return isObjects ? { kind: "Subquery", query: { distinct: false, expr, kind: "SelectQuery", shape, span: expr.span } } : null;
  }

  /**
   * `select <name>` when `expr` names a `with` binding compiled to a CTE (and
   * not a scope variable, which is inlined instead), else null. The name stands
   * for the binding's rows, so aggregating it (`count(u)`, `exists u`) or
   * binding it again (`v := u`) goes through a select of it, not through its
   * expression form — a scalar subquery that fails on more than one row.
   */
  protected bindingSetQuery(expr: EdgeQLAST.Expression): EdgeQLAST.Subquery | null {
    if (expr.kind !== "Identifier" || this.scopeVariable(expr.name) || !Context.getCTEAlias(this.ctx, expr.name)) {
      return null;
    }
    return { kind: "Subquery", query: { distinct: false, expr, kind: "SelectQuery", span: expr.span } };
  }

  /**
   * `select <expr>` when `expr` is a set SQL cannot aggregate or test in
   * place: a call to a set-returning function (`array_unpack(…)`), a non-empty
   * set literal, or a `with` name inlined as a scope variable bound to either.
   * Else null. Aggregating or testing the select's rows instead of the
   * expression avoids `COUNT(UNNEST(…))` and `UNNEST(…) IS NOT NULL`.
   */
  protected setQuery(expr: EdgeQLAST.Expression): EdgeQLAST.Subquery | null {
    const variable = expr.kind === "Identifier" ? this.scopeVariable(expr.name) : undefined;
    const value = variable && !variable.sqlOverride && !variable.row ? variable.expression : expr;
    // An element-wise operator, cast or call over a set (`{1, 2} + 1`,
    // `str_upper({'a', 'b'})`) is a set too.
    const isSet = value.kind === "SetExpr" ?
      value.elements.length > 0 :
      (value.kind === "FunctionCall" && SET_RETURNING_FUNCTIONS.has(Context.lookupFunction(this.ctx.schema, value.name.parts)?.name ?? "")) ||
      this.elementWiseSets(value) !== null;
    return isSet ? { kind: "Subquery", query: { distinct: false, expr: value, kind: "SelectQuery", span: expr.span } } : null;
  }

  /**
   * The select of the set an argument stands for, or null for a value: a set
   * literal, a set-returning or element-wise expression over a set
   * (`setQuery`), a `with` binding's rows, or a path to several values
   * (`User.name`, `.posts.title`, a multi property).
   */
  protected setArgument(expr: EdgeQLAST.Expression): EdgeQLAST.Subquery | null {
    if (expr.kind === "SetExpr" && flattenSetElements(expr).length === 1) {
      return null;
    }
    return this.bindingSetQuery(expr) ?? this.setQuery(expr) ??
      (this.isSetPath(expr) ? { kind: "Subquery", query: { distinct: false, expr, kind: "SelectQuery", span: expr.span } } : null);
  }

  /**
   * The operands of an expression Gel applies to each element of its
   * operands, or null: an operator (`+`, `++`, `=`, `and`, `not`, …), a cast
   * to a scalar type, or a built-in function that is not an aggregate or set
   * test (SET_ARGUMENT_FUNCTIONS). `in` applies to each element of its left
   * operand only; its right operand is a set as a whole. Set operators, `??`,
   * `is`, `exists` and `distinct` have rules of their own.
   */
  private elementWiseOperands(expr: EdgeQLAST.Expression): EdgeQLAST.Expression[] | null {
    switch (expr.kind) {
      case "BinaryOp": {
        // `x is <scalar type>` is one boolean per element of `x`.
        const isType = expr.right.kind === "TypeName" ?
          expr.right.name.parts.join("::") :
          expr.right.kind === "Identifier" ?
          expr.right.name :
          undefined;
        if ((expr.op === "IS" || expr.op === "IS NOT") && isType !== undefined && this.isScalarTypeName(isType)) {
          return [expr.left];
        }
        if (this.isSetOperator(expr.op) || expr.op === "??" || expr.op === "IS" || expr.op === "IS NOT") {
          return null;
        }
        return expr.op === "IN" || expr.op === "NOT IN" ? [expr.left] : [expr.left, expr.right];
      }
      case "UnaryOp":
        return ELEMENT_WISE_UNARY_OPERATORS.has(expr.op) ? [expr.operand] : null;
      case "TypeCast":
        return Context.resolveTypeName(this.ctx, renderEdgeQLTypeName(expr.type))?.kind === "object" ? null : [expr.expr];
      case "FunctionCall": {
        const funcDef = Context.lookupFunction(this.ctx.schema, expr.name.parts);
        if (!funcDef || !Context.isBuiltinFunction(funcDef) || funcDef.introspection || funcDef.windowOnly || SET_ARGUMENT_FUNCTIONS.has(funcDef.name)) {
          return null;
        }
        return expr.args.map(arg => arg.value);
      }
      case "IndexExpression":
        return [expr.expr, expr.index];
      case "SliceExpression":
        return [expr.expr, ...(expr.start ? [expr.start] : []), ...(expr.end ? [expr.end] : [])];
      case "TupleAccessExpr":
        return [expr.tuple];
      default:
        return null;
    }
  }

  /*** `expr` with its element-wise operands (`elementWiseOperands`) replaced by `operands`. ***/
  private withOperands(expr: EdgeQLAST.Expression, operands: EdgeQLAST.Expression[]): EdgeQLAST.Expression {
    switch (expr.kind) {
      case "BinaryOp":
        return { ...expr, left: operands[0], right: operands[1] ?? expr.right };
      case "UnaryOp":
        return { ...expr, operand: operands[0] };
      case "TypeCast":
        return { ...expr, expr: operands[0] };
      case "FunctionCall":
        return { ...expr, args: expr.args.map((arg, index) => ({ ...arg, value: operands[index] })) };
      case "IndexExpression":
        return { ...expr, expr: operands[0], index: operands[1] };
      case "SliceExpression":
        return { ...expr, end: expr.end ? operands.at(-1) : undefined, expr: operands[0], start: expr.start ? operands[1] : undefined };
      case "TupleAccessExpr":
        return { ...expr, tuple: operands[0] };
      default:
        return expr;
    }
  }

  /**
   * For an element-wise expression (`elementWiseOperands`) with at least one
   * set operand: the set each operand stands for, null for a value. Else
   * null. A comparison of a multi path of the current object with one value
   * (`.nicks = 'a'`, `.posts.title = x`) a filter's condition is a conjunction of, or `any()`'s argument, is not one:
   * it keeps its compilation as a test of whether any element matches
   * (`markAnyElementComparisons`). Nor is an operator over a `with` binding
   * of objects (`.program = prog`), which compiles to the binding's ids.
   */
  protected elementWiseSets(expr: EdgeQLAST.Expression): (EdgeQLAST.Subquery | null)[] | null {
    const operands = this.elementWiseOperands(expr);
    if (!operands || (expr.kind === "BinaryOp" && this.anyElementComparisons.has(expr))) {
      return null;
    }
    const sets = operands.map(operand =>
      expr.kind !== "FunctionCall" && this.isObjectBinding(operand) ? this.bindingIdsQuery(operand) : this.setArgument(operand)
    );
    return sets.some(set => set !== null) ? sets : null;
  }

  /*** True when `expr` names a `with` binding compiled to a CTE of objects or of a mutation's rows, not of values. ***/
  private isObjectBinding(expr: EdgeQLAST.Expression): expr is EdgeQLAST.Identifier {
    if (expr.kind !== "Identifier" || this.scopeVariable(expr.name)) {
      return false;
    }
    const cte = Context.getCTEAlias(this.ctx, expr.name);
    return cte !== undefined && !cte.values;
  }

  /**
   * The ids of a `with` binding of objects (`isObjectBinding`) that may be
   * several, as a set operand: `.author = us` compares the author with each
   * (as Gel does), where the binding's expression form is one id, a scalar
   * subquery failing on more than one row. Null for a binding of one object
   * at most, which is that one id.
   */
  private bindingIdsQuery(expr: EdgeQLAST.Identifier): EdgeQLAST.Subquery | null {
    if (Context.getCTEAlias(this.ctx, expr.name)?.singleton) {
      return null;
    }
    const query: EdgeQLAST.SelectQuery = { distinct: false, expr, kind: "SelectQuery", span: expr.span };
    this.objectIdSelects.add(query);
    return { kind: "Subquery", query };
  }

  /**
   * True for a comparison compileBinaryOp can answer as "any element
   * matches" (compileMultiPropertyComparison, compileMultiLinkComparison,
   * compileMultiHopComparison): a multi property or multi link path of the
   * current object compared with one value.
   */
  private isAnyElementComparison(binOp: EdgeQLAST.BinaryOp): boolean {
    if (!this.isComparisonOp(binOp.op)) {
      return false;
    }
    const membership = binOp.op === "IN" || binOp.op === "NOT IN";
    if (this.multiPropertyColumn(binOp.left) || this.isMultiLinkPath(binOp.left) || this.isMultiHopLinkPath(binOp.left)) {
      return membership || this.setArgument(binOp.right) === null;
    }
    return this.multiPropertyColumn(binOp.right) !== null && this.setArgument(binOp.left) === null;
  }

  /**
   * An element-wise expression over sets (`elementWiseSets`) as the rows of a
   * select: each set operand is a FROM item `(select <set>) AS __arg_N(value)`
   * — several are crossed, the left one outermost, as Gel crosses an
   * element-wise expression's operand sets — and the expression reads each
   * one's `value`:
   *
   *   select str_upper(User.name)
   *   → SELECT UPPER(__arg_1.value) FROM (SELECT user_2.name FROM "user" AS user_2) AS __arg_1(value)
   *   select User { v := .visits + {1, 2} }
   *   → … (SELECT user_1.visits + __arg_2.value FROM (…) AS __arg_2(value) WHERE user_1.visits IS NOT NULL) …
   *
   * An operator's value operand that may be empty adds to `where`: with an
   * empty operand the expression has no elements, where SQL has NULLs. The
   * values are scope variables of the current scope, which the caller (a
   * select, a filter) owns.
   */
  protected compileElementWise(
    expr: EdgeQLAST.Expression,
    sets: (EdgeQLAST.Subquery | null)[]
  ): { from: SQL.TableReference[]; value: SQL.SQLExpression; where?: SQL.SQLExpression; } {
    const from: SQL.TableReference[] = [];
    const operands = this.elementWiseOperands(expr)!;
    // A function's arguments may be optional; `?=` compares empty operands.
    const optional = expr.kind === "FunctionCall" || (expr.kind === "BinaryOp" && OPTIONAL_OPERAND_OPERATORS.has(expr.op));
    const elements = operands.map((operand, index) => {
      const set = sets[index];
      if (!set) {
        return operand;
      }
      const alias = Context.generateAlias(this.ctx, "__arg");
      const rows = this.compileQuery(set.query);
      // `?=` and `?!=` compare an empty set as one empty (NULL) element.
      const subquery = expr.kind === "BinaryOp" && optional ? this.emptyAsNull(rows) : rows;
      from.push({ alias, columnAliases: ["value"], kind: "TableReference", name: "", subquery });
      this.ctx.currentScope.variables.set(alias, {
        element: true,
        expression: operand,
        name: alias,
        sqlOverride: SQL.createColumnReference("value", alias),
        staticType: this.elementType(operand),
        type: this.isJsonExpression(operand) ? "json" : "any"
      });
      return EdgeQLAST.createIdentifier(alias);
    });
    const value = this.compileExpression(this.withOperands(expr, elements));

    const conditions = optional ?
      [] :
      operands
        .filter((operand, index) => !sets[index] && operand.kind !== "Literal" && !this.isNeverEmpty(operand))
        .map(operand => SQL.isNotNull(this.compileExpression(operand)));
    const where = conditions.reduce<SQL.SQLExpression | undefined>(
      (all, condition) => all ? SQL.createBinaryExpression("AND", all, condition) : condition,
      undefined
    );
    return { from, value, where };
  }

  /**
   * A set's rows (one column), or one NULL row when there are none: `?=` and
   * `?!=` compare an empty set as a whole, so `{} ?= {}` is true and
   * `x ?!= {}` true, as in Gel. A set has no NULLs, so the NULL row is the
   * empty set.
   *
   *   SELECT __rows.value FROM (SELECT 1) AS __one LEFT JOIN (<rows>) AS __rows(value) ON TRUE
   */
  private emptyAsNull(rows: SQL.SQLStatement): SQL.SelectStatement {
    const one = SQL.createSelectStatement({ select: SQL.createSelectClause([SQL.createSelectItem(SQL.createLiteral("number", 1))]) });
    return SQL.createSelectStatement({
      from: SQL.createFromClause([{
        alias: "__one",
        joins: [{
          condition: SQL.createLiteral("boolean", true),
          kind: "JoinClause",
          table: { alias: "__rows", columnAliases: ["value"], kind: "TableReference", name: "", subquery: rows },
          type: "LEFT"
        }],
        kind: "TableReference",
        name: "",
        subquery: one
      }]),
      select: SQL.createSelectClause([SQL.createSelectItem(SQL.createColumnReference("value", "__rows"))])
    });
  }

  /**
   * True for a set operand with no one-value SQL form: a set literal, a path
   * of several steps not from a `with` binding (`User.name`, `.posts.title`),
   * or a multi property (one array column). A set-returning call and a
   * binding keep their expression form.
   */
  private isSetWithoutValue(expr: EdgeQLAST.Expression): boolean {
    if (expr.kind === "SetExpr") {
      return true;
    }
    return (expr.kind === "Path" && expr.steps.length > 1 && !Context.getCTEAlias(this.ctx, expr.steps[0].name)) ||
      this.multiPropertyColumn(expr) !== null;
  }

  /**
   * An element-wise expression over a set is a set of rows, compiled where a
   * select, a shape element, a `for` body, a filter or a function reads them
   * (compileElementWise). As one value inside another expression, a set
   * literal would be a record, a path from a type or over a multi link has no
   * column, and a multi property is one array: a compile error instead.
   */
  private assertNotOverSet(expr: EdgeQLAST.Expression, description: string): void {
    const sets = this.elementWiseSets(expr);
    const operands = this.elementWiseOperands(expr);
    if (sets?.some((set, index) => set && this.isSetWithoutValue(operands![index]))) {
      throw new CompilationError(
        `${description} of a set is a set, one element per element of its operands: it is supported selected ` +
          "(`select …`), as a shape element, as a for body, in a filter, or as a function's or aggregate's argument " +
          "(`count(…)`), not as one value inside another expression",
        this.expressionLocation(expr)
      );
    }
  }

  /*** Where `expr` is in the source: its own span, its first step's (a path), or its first operand's (an operator, a cast and a set literal's elements carry none). ***/
  private expressionLocation(expr: EdgeQLAST.Expression): ErrorContext | undefined {
    return locationOf(expr) ?? (expr.kind === "Path" ? locationOf(expr.steps[0]) : undefined) ??
      this.elementWiseOperands(expr)?.map(operand => this.expressionLocation(operand)).find(Boolean);
  }

  /*** The EdgeQL type of each element of a set operand, when known: a path's property type, a numeric expression's type, a tuple's type. ***/
  private elementType(expr: EdgeQLAST.Expression): string | undefined {
    if (expr.kind === "Path") {
      const property = this.pathProperty(expr);
      return property ? Context.propertyBaseType(property) : undefined;
    }
    return this.staticNumericType(expr) ?? this.staticTupleType(expr) ?? undefined;
  }

  /**
   * A filter: true when any element of its value is true. A filter over a
   * set (`filter {1, 2} = .n`, `filter .name ++ {'a', 'b'} = x`) compiles, as
   * in Gel (edb/pgsql/compiler/clauses.py, compile_filter_clause), to
   * `EXISTS (SELECT FROM <set> WHERE <value>)`. A comparison of a multi path
   * in its condition tests any element in place (`markAnyElementComparisons`).
   */
  protected compileFilter(filter: EdgeQLAST.Expression): SQL.SQLExpression {
    filter = this.comparingObjectsById(filter);
    this.markAnyElementComparisons(filter);
    this.markTruthContexts(filter);
    const sets = this.elementWiseSets(filter);
    if (!sets) {
      return this.compileExpression(filter);
    }
    const { from, value, where } = this.compileElementWise(filter, sets);
    return {
      kind: "UnaryExpression",
      operand: SQL.createSubqueryExpression(SQL.createSelectStatement({
        from: SQL.createFromClause(from),
        select: SQL.createSelectClause([SQL.createSelectItem(SQL.createLiteral("number", 1))]),
        where: SQL.createWhereClause(where ? SQL.createBinaryExpression("AND", where, value) : value)
      })),
      operator: "EXISTS"
    };
  }

  /**
   * Mark the comparisons of a multi path (`isAnyElementComparison`) that a
   * filter's condition is made of through `and`, which compile as "any
   * element matches" (`'a' = ANY(nicks)`, EXISTS over a multi link) instead
   * of one boolean per element. That is Gel's filter (true when any element
   * is): a conjunction of the comparisons' crossed elements has a true
   * element when each comparison has one, the comparisons independent as
   * with Gel's `future simple_scoping`. Under `or` and `not`, and anywhere
   * else (a shape element, a select, a function's argument), the comparison
   * is one boolean per element, as in Gel: `not (.nicks = 'a1')` is true when
   * some nick is not 'a1'. `any(<comparison>)` is one boolean
   * (`compileAnyOfComparison`).
   */
  private markAnyElementComparisons(expr: EdgeQLAST.Expression): void {
    if (expr.kind === "BinaryOp" && expr.op === "AND") {
      this.markAnyElementComparisons(expr.left);
      this.markAnyElementComparisons(expr.right);
    } else if (expr.kind === "BinaryOp" && this.isAnyElementComparison(expr)) {
      this.anyElementComparisons.add(expr);
    }
  }

  /**
   * `any(<comparison of a multi path>)` (`isAnyElementComparison`): whether
   * any element matches, one boolean tested in place (`'a' = ANY(nicks)`,
   * EXISTS over a multi link). The SDK's filters compile to it, so their
   * conditions mean the same under `and`, `or` and `not`. Null for any other
   * call.
   */
  private compileAnyOfComparison(funcCall: EdgeQLAST.FunctionCall, functionName: string): SQL.SQLExpression | null {
    const arg = funcCall.args.length === 1 ? funcCall.args[0].value : undefined;
    if (functionName !== "any" || arg?.kind !== "BinaryOp" || !this.isAnyElementComparison(arg)) {
      return null;
    }
    this.anyElementComparisons.add(arg);
    return this.compileExpression(arg);
  }

  /*** An order by key; a tuple's is its elements' (`tupleSortKey`), an array of tuples' its tuples' (`tupleArraySortKey`). A set has no one value to order by; Gel rejects it too. ***/
  protected compileOrderExpression(expr: EdgeQLAST.Expression): SQL.SQLExpression {
    if (expr.kind !== "Path" && this.setArgument(expr)) {
      throw new CompilationError(
        "possibly more than one element returned by an expression in an order by clause, where only one is allowed",
        this.expressionLocation(expr)
      );
    }
    const tupleType = this.staticTupleType(expr);
    const tupleArrayType = tupleType ? null : this.staticTupleArrayType(expr);
    const sql = this.compileExpression(expr);
    return tupleType ? this.tupleSortKey(sql, tupleType) : tupleArrayType ? this.tupleArraySortKey(sql, tupleArrayType) : sql;
  }

  /**
   * Lower `<scalar> IN array_unpack(<array<T>>$p)` (and the `NOT IN` form) to a
   * valid Postgres array comparison. `array_unpack` maps to SQL `UNNEST`, but
   * `<x> IN UNNEST(...)` is not valid syntax — the correct lowering is:
   *
   *   x IN array_unpack(arr)      → x = ANY(<compiled arr>)
   *   x NOT IN array_unpack(arr)  → x <> ALL(<compiled arr>)
   *
   * The array argument is compiled directly (so `<array<uuid>>$ids` becomes
   * `CAST($1 AS uuid[])`) and spliced as the operand of `ANY(...)` / `ALL(...)`.
   *
   * Returns `null` to fall through to the generic binary-op compilation when
   * the RHS is not a single-argument `array_unpack(...)` call — leaving
   * set-literal (`in {a, b}`) and subquery (`in (select ...)`) membership
   * unchanged.
   */
  private compileArrayMembership(
    binOp: EdgeQLAST.BinaryOp
  ): SQL.SQLExpression | null {
    const right = binOp.right;
    if (right.kind !== "FunctionCall") {
      return null;
    }
    if (right.name.parts.join("_") !== "array_unpack") {
      return null;
    }
    if (right.args.length !== 1) {
      return null;
    }
    const tupleMembership = this.compileTupleArrayMembership(binOp, right.args[0].value);
    if (tupleMembership) {
      return tupleMembership;
    }

    const left = this.renderSqlExpr(this.compileExpression(binOp.left));
    const arr = this.renderSqlExpr(
      this.compileExpression(right.args[0].value)
    );
    const sql = binOp.op === "NOT IN" ?
      `${left} <> ALL(${arr})` :
      `${left} = ANY(${arr})`;
    return { kind: "RawSQLExpression" as const, sql };
  }

  /**
   * Compile IS / IS NOT type checks into discriminator column checks.
   *
   * `expr IS Type` where Type has subtypes ->
   *   __type__ IN ('Type', 'Sub1', 'Sub2', ...)
   *
   * `expr IS Type` where Type is a leaf ->
   *   __type__ = 'Type'
   *
   * `expr IS NOT Type` -> negated versions of the above
   */
  private compileIsTypeCheck(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression {
    const isNot = binOp.op === "IS NOT";

    // The right side should be a TypeName or Identifier referring to a type
    let typeName: string;
    if (binOp.right.kind === "TypeName") {
      typeName = binOp.right.name.parts.join("::");
    } else if (binOp.right.kind === "Identifier") {
      typeName = binOp.right.name;
    } else {
      // Fallback: compile as generic IS / IS NOT (e.g., IS NULL)
      const left = this.compileExpression(binOp.left);
      const right = this.compileExpression(binOp.right);
      return SQL.createBinaryExpression(binOp.op, left, right);
    }

    const scalarCheck = this.compileScalarIsCheck(binOp, typeName);
    if (scalarCheck) {
      return scalarCheck;
    }

    // Resolve the type in the schema
    const typeDef = Context.resolveTypeName(this.ctx, typeName);
    if (!typeDef) {
      throw new CompilationError(
        `Type '${typeName}' not found in schema for IS check`
      );
    }

    // Build the list of matching type names (type + all transitive subtypes)
    const allTypes = [
      typeDef.name,
      ...Context.getAllSubtypes(this.ctx.schema, typeDef.name)
    ];

    // Compile the left side (the expression being checked)
    // For paths like `.prop IS Type`, the left side resolves to a table alias
    // The discriminator column is always "__type__" on whatever table context
    // we're currently in.
    // For a simple pattern like `Shape IS Circle`, the left side is the type
    // reference itself. We need the table alias to reference __type__.
    const discriminatorCol = SQL.createColumnReference("__type__");

    if (allTypes.length === 1) {
      // Leaf type: simple equality check
      const op = isNot ? "!=" : "=";
      return SQL.createBinaryExpression(
        op,
        discriminatorCol,
        SQL.createLiteral("string", allTypes[0])
      );
    }

    // Multiple types: IN / NOT IN expression
    const typeList = allTypes.map(t => `'${t}'`).join(", ");
    const inOp = isNot ? "NOT IN" : "IN";

    return {
      kind: "RawSQLExpression" as const,
      sql: `__type__ ${inOp} (${typeList})`
    };
  }

  /**
   * `x is T` for a scalar type `T` (`<cal::local_date>'…' is cal::local_date`,
   * `.age is str`, `1 is anyint`): Gel answers it from the static type of `x`,
   * so it is a constant — true when that type is `T`, a scalar extending `T`,
   * or one of the types an abstract `T` stands for — for each element of `x`
   * (none when `x` is empty). `is not` is its negation. Null when `T` is no
   * scalar type.
   */
  /*** Whether `typeName` names a scalar type an `is` test can name: built-in, abstract (`anyint`) or a user scalar. ***/
  private isScalarTypeName(typeName: string): boolean {
    const bare = typeName.replace(/^(std|cal|default)::/, "");
    return ABSTRACT_SCALAR_TYPES.has(bare) || STATIC_SCALAR_TYPES.has(bare) || this.scalarBaseType(typeName) !== undefined;
  }

  private compileScalarIsCheck(binOp: EdgeQLAST.BinaryOp, typeName: string): SQL.SQLExpression | null {
    const bare = (name: string): string => name.replace(/^(std|cal|default)::/, "");
    const target = bare(typeName);
    if (!this.isScalarTypeName(typeName)) {
      return null;
    }
    const operand = binOp.left;
    const actual = operand.kind === "TypeCast" ? renderEdgeQLTypeName(operand.type) : this.staticScalarType(operand);
    if (actual === null) {
      throw new CompilationError(
        `cannot determine the type of the operand of '${binOp.op.toLowerCase()} ${typeName}'`,
        this.expressionLocation(binOp)
      );
    }
    const types = [bare(actual), bare(this.scalarBaseType(actual) ?? actual)];
    const matches = types.some(type => type === target || (ABSTRACT_SCALAR_TYPES.get(target)?.has(type) ?? false));
    const result = SQL.createLiteral("boolean", matches !== (binOp.op === "IS NOT"));
    return this.mayBeEmpty(operand) ?
      SQL.createCaseExpression([SQL.createWhenClause(SQL.isNotNull(this.compileExpression(operand)), result)]) :
      result;
  }

  /**
   * Compile a BinaryOp representing a set operation (UNION, INTERSECT, EXCEPT)
   * into a SQL UnionAllStatement with the appropriate operator.
   */
  protected compileSetOperation(
    binOp: EdgeQLAST.BinaryOp
  ): SQL.UnionAllStatement {
    // Map EdgeQL set operator to SQL set operator
    let sqlOp: SQL.SetOperator;
    switch (binOp.op) {
      case "UNION":
        sqlOp = "UNION ALL";
        break;
      case "INTERSECT":
        sqlOp = "INTERSECT";
        break;
      case "EXCEPT":
        sqlOp = "EXCEPT";
        break;
      default:
        throw new CompilationError(`Unsupported set operator: ${binOp.op}`);
    }

    // Compile left and right operands as queries
    let leftStmt = this.compileSetOperand(binOp.left);
    let rightStmt = this.compileSetOperand(binOp.right);

    // A union of tuples is of their united type (`(a := 1) union (b := 2)` is `{(1,), (2,)}`).
    const united = binOp.op === "UNION" ? this.unitedStaticTupleType([binOp.left, binOp.right]) : null;
    if (united) {
      leftStmt = this.asTupleTypeRows(leftStmt, this.staticTupleType(binOp.left)!, united);
      rightStmt = this.asTupleTypeRows(rightStmt, this.staticTupleType(binOp.right)!, united);
    }

    return SQL.setOperation(sqlOp, [leftStmt, rightStmt]);
  }

  /**
   * Compile a set operation operand. The operand is typically a Subquery
   * wrapping a SelectQuery, but could be another BinaryOp for chained
   * set operations.
   */
  private compileSetOperand(expr: EdgeQLAST.Expression): SQL.SQLStatement {
    if (expr.kind === "Subquery") {
      return this.compileQuery(expr.query);
    }
    if (expr.kind === "BinaryOp" && this.isSetOperator(expr.op)) {
      return this.compileSetOperation(expr);
    }
    // Fallback: wrap expression in a SELECT
    const compiled = this.compileExpression(expr);
    return SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(compiled)])
    });
  }

  private compileUnaryOp(unaryOp: EdgeQLAST.UnaryOp): SQL.SQLExpression {
    if (unaryOp.op === "EXISTS") {
      return this.compileExists(unaryOp.operand);
    }

    // `not exists <value>` is `<value> IS NULL`; `not exists <set>` negates the set test.
    if (unaryOp.op === "NOT" && unaryOp.operand.kind === "UnaryOp" && unaryOp.operand.op === "EXISTS") {
      const test = this.compileExists(unaryOp.operand.operand);
      if (test.kind === "UnaryExpression" && test.operator === "IS NOT NULL") {
        return { kind: "UnaryExpression", operator: "IS NULL", operand: test.operand };
      }
      return { kind: "UnaryExpression", operator: "NOT", operand: test };
    }

    this.assertNotOverSet(unaryOp, `'${unaryOp.op.toLowerCase()}'`);
    return {
      kind: "UnaryExpression",
      operator: unaryOp.op,
      operand: this.compileExpression(unaryOp.operand)
    };
  }

  /**
   * `exists <expr>`. A subquery is a set: `EXISTS (subquery)`. A multi link or
   * backlink is a set with no column of its own, so its linked rows are
   * counted. Anything else — a property, a single link's FK column, a
   * parameter — is at most one value: `<expr> IS NOT NULL`.
   */
  private compileExists(operand: EdgeQLAST.Expression): SQL.SQLExpression {
    // A type (`exists User`) is the set of its objects.
    const set = operand.kind === "Subquery" ? operand : this.typeSetQuery(operand) ?? this.bindingSetQuery(operand) ?? this.setQuery(operand);
    if (set) {
      return { kind: "UnaryExpression", operator: "EXISTS", operand: this.compileSubqueryExpression(set) };
    }
    const multi = this.multiPropertyColumn(operand);
    if (multi) {
      return SQL.createBinaryExpression(">", SQL.createFunctionCall("CARDINALITY", [multi.column]), SQL.createLiteral("number", 0));
    }
    const linkCount = this.compileAggregateOverLinkPath("count", operand);
    if (linkCount) {
      return SQL.createBinaryExpression(">", linkCount, SQL.createLiteral("number", 0));
    }
    if (this.isSetPath(operand)) {
      const select: EdgeQLAST.Subquery = { kind: "Subquery", query: { distinct: false, expr: operand, kind: "SelectQuery" } };
      return { kind: "UnaryExpression", operator: "EXISTS", operand: this.compileSubqueryExpression(select) };
    }
    return SQL.isNotNull(this.compileExpression(operand));
  }

  /**
   * True when `expr` is `.prop` naming a required, single, stored property of
   * a type in scope (the same alias lookup as `compilePathInExpression`), so
   * it is never empty — e.g. an order key that needs no NULLS placement.
   */
  protected isNeverEmpty(expr: EdgeQLAST.Expression): boolean {
    if (expr.kind !== "Path" || expr.steps.length !== 1 || expr.steps[0].type !== "property") {
      return false;
    }
    const name = expr.steps[0].name;
    for (const ta of this.ctx.currentScope.aliases.values()) {
      const property = Context.resolveTypeName(this.ctx, ta.type)?.properties.get(name);
      if (property) {
        return property.required && !property.multi && !property.computed;
      }
    }
    return false;
  }

  /**
   * The array column behind `.prop` when it names a stored multi scalar
   * property of a type in scope (the same alias lookup as
   * `compilePathInExpression`), else null.
   */
  protected multiPropertyColumn(
    expr: EdgeQLAST.Expression
  ): { column: SQL.ColumnReference; property: Context.PropertyDef; } | null {
    if (expr.kind !== "Path" || expr.steps.length !== 1 || expr.steps[0].type !== "property") {
      return null;
    }
    const name = expr.steps[0].name;
    for (const ta of this.ctx.currentScope.aliases.values()) {
      const property = Context.resolveTypeName(this.ctx, ta.type)?.properties.get(name);
      if (property) {
        return property.multi && !property.computed ?
          { column: SQL.createColumnReference(property.columnName, ta.alias), property } :
          null;
      }
    }
    return null;
  }

  /*** The SQL array type of a multi property's column: `text[]`, or the enum's array type (`disc_enum_<name>[]`). ***/
  protected multiPropertyArrayType(property: Context.PropertyDef): string {
    const element = property.edgeqlType ?? "";
    const resolved = element ? Context.resolveTypeName(this.ctx, element) : undefined;
    return resolved?.enumValues?.length ? `${Context.enumSqlType(resolved)}[]` : property.type;
  }

  /**
   * The value assigned to a multi property, as one array of its column type:
   * a set literal is `ARRAY[…]`, `{}` is `'{}'`, `array_unpack(arr)` is `arr`,
   * and any other expression is a single value (an empty one — SQL NULL —
   * gives the empty array).
   */
  protected compileMultiPropertyValue(
    expr: EdgeQLAST.Expression,
    property: Context.PropertyDef
  ): SQL.SQLExpression {
    const arrayType = this.multiPropertyArrayType(property);
    const asArray = (value: SQL.SQLExpression) =>
      value.kind === "CastExpression" && value.targetType === arrayType ? value : SQL.createCastExpression(value, arrayType);

    if ((expr.kind === "Literal" && expr.type === "empty") || (expr.kind === "SetExpr" && expr.elements.length === 0)) {
      return asArray(SQL.createLiteral("string", "{}"));
    }
    if (expr.kind === "SetExpr") {
      return asArray(SQL.createFunctionCall("ARRAY", flattenSetElements(expr).map(element => this.compileExpression(element))));
    }
    if (expr.kind === "FunctionCall" && expr.name.parts.join("_") === "array_unpack" && expr.args.length === 1) {
      return asArray(this.compileExpression(expr.args[0].value));
    }
    return asArray(
      SQL.createFunctionCall("ARRAY_REMOVE", [SQL.createFunctionCall("ARRAY", [this.compileExpression(expr)]), SQL.createLiteral("null", null)])
    );
  }

  /**
   * An update `set { prop op value }` on a multi property: `:=` replaces the
   * array, `+=` appends, and `-=` removes every occurrence of each given value
   * (`disc_array_except`, lib/stdlib-sql.ts).
   */
  protected compileMultiPropertyAssignment(
    property: Context.PropertyDef,
    operator: ":=" | "+=" | "-=",
    expr: EdgeQLAST.Expression
  ): SQL.SQLExpression {
    const value = this.compileMultiPropertyValue(expr, property);
    const current = SQL.createColumnReference(property.columnName);
    switch (operator) {
      case "+=":
        return SQL.createBinaryExpression("||", current, value);
      case "-=":
        return SQL.createFunctionCall("disc_array_except", [current, value]);
      default:
        return value;
    }
  }

  /** Commuted comparison: `col_elem <op> x` is `x <commuted op> ANY(col)`. */
  private static readonly COMMUTED_COMPARISONS = new Map<string, string>([
    ["=", "="],
    ["!=", "<>"],
    ["<", ">"],
    ["<=", ">="],
    [">", "<"],
    [">=", "<="]
  ]);

  /** Pattern operators on a multi property, tested per element with EXISTS over UNNEST. */
  private static readonly ELEMENT_PATTERN_OPERATORS = new Set(["LIKE", "ILIKE", "NOT LIKE", "NOT ILIKE", "~", "~*", "!~", "!~*"]);

  /**
   * A comparison with a multi property on one side, over its array column.
   * EdgeQL compares a set element-wise and a filter keeps the object when
   * any result is true:
   *
   *   x in .p / .p = x          → x = ANY(p)        (x not in .p → x <> ALL(p))
   *   .p > x                    → x < ANY(p)
   *   .p in array_unpack(arr)   → p && arr           (not in → NOT (p <@ arr))
   *   .p like x                 → EXISTS (SELECT 1 FROM UNNEST(p) AS e(v) WHERE e.v LIKE x)
   *
   * Returns null when neither side is a multi property.
   */
  private compileMultiPropertyComparison(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression | null {
    const left = this.multiPropertyColumn(binOp.left);
    const right = this.multiPropertyColumn(binOp.right);
    if (!left && !right) {
      return null;
    }
    if (left && right) {
      throw new CompilationError(`Comparing two multi properties ('${binOp.op}') is not supported yet`);
    }

    const op = binOp.op;
    if (right) {
      const value = this.compileExpression(binOp.left);
      if (op === "IN") {
        return SQL.createBinaryExpression("=", value, SQL.createFunctionCall("ANY", [right.column]));
      }
      if (op === "NOT IN") {
        return SQL.createBinaryExpression("<>", value, SQL.createFunctionCall("ALL", [right.column]));
      }
      const sqlOp = ExpressionCompilerLayer.COMMUTED_COMPARISONS.has(op) ? (op === "!=" ? "<>" : op) : undefined;
      return sqlOp ? SQL.createBinaryExpression(sqlOp, value, SQL.createFunctionCall("ANY", [right.column])) : null;
    }

    const { column, property } = left!;
    if (op === "IN" || op === "NOT IN") {
      const values = this.compileMultiPropertyValue(binOp.right, property);
      return op === "IN" ?
        SQL.createBinaryExpression("&&", column, values) :
        { kind: "UnaryExpression", operator: "NOT", operand: SQL.createBinaryExpression("<@", column, values) };
    }

    const commuted = ExpressionCompilerLayer.COMMUTED_COMPARISONS.get(op);
    if (commuted) {
      return SQL.createBinaryExpression(commuted, this.compileExpression(binOp.right), SQL.createFunctionCall("ANY", [column]));
    }

    if (ExpressionCompilerLayer.ELEMENT_PATTERN_OPERATORS.has(op)) {
      const element = SQL.createColumnReference("v", "multi_elem");
      const match = SQL.createSelectStatement({
        select: SQL.createSelectClause([SQL.createSelectItem(SQL.createLiteral("number", 1))]),
        from: SQL.createFromClause([{
          kind: "TableReference",
          name: "",
          expression: SQL.createFunctionCall("UNNEST", [column]),
          alias: "multi_elem",
          columnAliases: ["v"]
        }]),
        where: SQL.createWhereClause(SQL.createBinaryExpression(op, element, this.compileExpression(binOp.right)))
      });
      return { kind: "UnaryExpression", operator: "EXISTS", operand: SQL.createSubqueryExpression(match) };
    }

    return null;
  }

  private compileFunctionCall(
    funcCall: EdgeQLAST.FunctionCall
  ): SQL.SQLExpression {
    // `std` is the default module: `std::to_str(x)` is `to_str(x)`, and gets
    // the same special compilation below.
    const parts = funcCall.name.parts.length > 1 && funcCall.name.parts[0] === "std" ? funcCall.name.parts.slice(1) : funcCall.name.parts;
    const functionName = parts.join("_");
    const qualifiedName = funcCall.name.parts.join("::");

    // `array_agg` of tuples: an array of tuples is a jsonb array (see
    // `compileArrayExpr`); the aggregate, however it is compiled, is made one.
    if (functionName === "array_agg" && this.staticTupleArrayType(funcCall) && !this.tupleArrayAggregates.has(funcCall)) {
      this.tupleArrayAggregates.add(funcCall);
      try {
        return SQL.createFunctionCall("to_jsonb", [this.compileFunctionCall(funcCall)]);
      } finally {
        this.tupleArrayAggregates.delete(funcCall);
      }
    }

    // `array_agg` of arrays: an array of arrays is a jsonb array (see
    // `compileArrayExpr`), made of the arrays as json.
    if (functionName === "array_agg" && funcCall.args.length === 1 && this.staticNestedArrayType(funcCall)) {
      const arg = funcCall.args[0];
      const asJson: EdgeQLAST.TypeCast = { expr: arg.value, kind: "TypeCast", type: EdgeQLAST.createTypeName(["json"]) };
      return SQL.createFunctionCall("to_jsonb", [this.compileFunctionCall({ ...funcCall, args: [{ ...arg, value: asJson }] })]);
    }

    // In a policy's condition, `runtime::has_permission('<spec>')` is the Deno
    // process's permission, decided now (see AccessEvaluator.expressionToSQL).
    if (qualifiedName === "runtime::has_permission" && this.compilingPolicy && this.accessEvaluator) {
      const arg = funcCall.args[0]?.value;
      const spec: AccessExpressionNode[] = arg?.kind === "Literal" && arg.type === "string" ?
        [{ kind: "AccessLiteral", type: "string", value: String(arg.value) }] :
        [];
      return {
        kind: "RawSQLExpression",
        sql: this.accessEvaluator.expressionToSQL({ args: spec, kind: "AccessFunction", name: qualifiedName }, this.accessContext)
      };
    }

    // Check for schema:: / cfg:: introspection functions
    if (
      qualifiedName.startsWith("schema::") ||
      qualifiedName.startsWith("cfg::")
    ) {
      return this.compileIntrospectionFunction(qualifiedName, funcCall);
    }

    if ((functionName === "sequence_next" || functionName === "sequence_reset") && funcCall.args[0]?.value.kind === "Introspection") {
      return this.compileSequenceFunction(functionName, funcCall);
    }

    const anyOfComparison = this.compileAnyOfComparison(funcCall, functionName);
    if (anyOfComparison) {
      return anyOfComparison;
    }

    // Set-aggregates (`count`/`sum`/…) over a link-set path must become a
    // correlated subquery — a forward multi-link / backlink is a *set* with
    // no scalar column to wrap. Returns null (fall through) for ordinary
    // scalar arguments.
    if (funcCall.args.length === 1) {
      const value = funcCall.args[0].value;
      const arg = this.typeSetQuery(value) ?? this.bindingSetQuery(value) ?? this.setQuery(value) ?? value;
      // `assert_single(<set>)` checks the set's rows; one value is itself.
      if (functionName === "assert_single") {
        const set = arg.kind === "Subquery" ?
          arg :
          this.isSetPath(arg) ?
          { kind: "Subquery" as const, query: { distinct: false, expr: arg, kind: "SelectQuery" as const } } :
          null;
        return set ? this.assertSingle(this.compileQuery(set.query)) : this.compileExpression(value);
      }
      const multi = functionName === "count" ? this.multiPropertyColumn(arg) : null;
      if (multi) {
        return SQL.createFunctionCall("CARDINALITY", [multi.column]);
      }
      // A set literal or a set-returning call aggregates its elements as rows,
      // like a subquery (`count({1, 2, 3})` is 3, not a count of one row
      // value; PostgreSQL rejects `COUNT(UNNEST(…))`).
      const aggregated = arg.kind === "Subquery" ?
        this.compileAggregateOverSubquery(functionName, arg) :
        this.compileAggregateOverLinkPath(functionName, arg);
      if (aggregated) {
        return aggregated;
      }
      // Any other path set (`User.posts`, `.posts.comments`) aggregates the
      // rows of a select of it.
      const pathSet = this.isSetPath(arg) ?
        this.compileAggregateOverSubquery(functionName, { kind: "Subquery", query: { distinct: false, expr: arg, kind: "SelectQuery" } }) :
        null;
      if (pathSet) {
        return pathSet;
      }
    }

    this.assertNotOverSet(funcCall, `${qualifiedName}()`);

    // `enumerate(<set>)` numbers the set's rows; the set has no one-value form
    // to compile as an argument.
    const enumerated = functionName === "enumerate" && funcCall.args.length === 1 ? this.setQuery(funcCall.args[0].value) : null;
    if (enumerated) {
      return this.compileEnumerateSet(enumerated);
    }

    const args = funcCall.args.map(arg => this.compileExpression(arg.value));

    // An array of tuples, or of arrays, is a jsonb array (see `compileArrayExpr`).
    if (
      functionName === "array_unpack" && args.length === 1 &&
      (this.staticTupleArrayType(funcCall.args[0].value) || this.staticNestedArrayType(funcCall.args[0].value))
    ) {
      return SQL.createFunctionCall("jsonb_array_elements", args);
    }

    // An aggregate over one value (or none) aggregates that value's set. A
    // group's filter aggregates the group's rows instead (`count(User)` is
    // `COUNT(*)` there, `sum(.visits)` `SUM(user_1.visits)`).
    const isGroupRows = this.ctx.currentScope.groupRows === true || (args[0]?.kind === "ColumnReference" && args[0].column === "*");
    const overValue = args.length === 1 && !isGroupRows ? this.compileAggregateOverValue(functionName, args[0]) : null;
    if (overValue) {
      return overValue;
    }

    // Special compilation for functions that aren't simple 1:1 mappings
    switch (functionName) {
      case "len":
        if (args.length !== 1) {
          throw new CompilationError("len() requires exactly 1 argument");
        }
        return SQL.createFunctionCall(this.lengthFunction(funcCall.args[0].value), args);

      case "contains": {
        // Overloaded: string contains vs range contains
        // String: contains(str, sub) → STRPOS(str, sub) > 0
        // Range: contains(range, elem) → range @> elem
        if (args.length !== 2) {
          throw new CompilationError("contains() requires exactly 2 arguments");
        }
        const containsFirstArg = funcCall.args[0].value;
        const isContainsRangeArg = containsFirstArg.kind === "FunctionCall" &&
          containsFirstArg.name.parts.join("_") === "range";
        if (isContainsRangeArg) {
          return SQL.createBinaryExpression("@>", args[0], args[1]);
        }
        return SQL.createBinaryExpression(
          ">",
          SQL.createFunctionCall("STRPOS", args),
          SQL.createLiteral("number", 0)
        );
      }

      case "find":
        // find(str, sub) → STRPOS(str, sub) - 1
        // PG STRPOS is 1-indexed (0 = not found), EdgeQL find is 0-indexed (-1 = not found)
        if (args.length !== 2) {
          throw new CompilationError("find() requires exactly 2 arguments");
        }
        return SQL.createBinaryExpression(
          "-",
          SQL.createFunctionCall("STRPOS", args),
          SQL.createLiteral("number", 1)
        );

      case "to_str":
        if (args.length === 2) {
          return this.compileFormattedToStr(funcCall, args);
        }
        if (args.length !== 1) {
          throw new CompilationError("to_str() requires 1 or 2 arguments");
        }
        return this.toStrValue(funcCall.args[0].value, args[0]);

      // `to_int64(str)`, …: a cast; `to_int64(str, fmt)`, …: PostgreSQL's
      // to_number (`disc_to_number`) cast, as in Gel.
      case "to_int64":
      case "to_float64":
      case "to_int16":
      case "to_int32":
      case "to_float32":
      case "to_bigint":
      case "to_decimal": {
        if (args.length !== 1 && args.length !== 2) {
          throw new CompilationError(`${functionName}() requires 1 or 2 arguments`);
        }
        const pgType = NUMBER_PARSER_TYPES.get(functionName)!;
        const parse = (text: SQL.SQLExpression): SQL.SQLExpression =>
          pgType === "numeric" ?
            this.finiteNumeric(SQL.createCastExpression(text, "numeric"), "numeric", functionName.slice("to_".length)) :
            SQL.createCastExpression(text, pgType);
        if (args.length === 1) {
          return parse(args[0]);
        }
        const parsed = SQL.createFunctionCall("disc_to_number", [SQL.createLiteral("string", functionName), args[0], args[1]]);
        return this.compileFormatted(funcCall, parse(parsed), () => parse(args[0]));
      }

      case "to_bool":
        if (args.length !== 1) {
          throw new CompilationError("to_bool() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "boolean");

      case "to_uuid":
        if (args.length !== 1) {
          throw new CompilationError("to_uuid() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "uuid");

      case "to_datetime": {
        // `to_datetime(year, month, day, hour, min, sec, timezone)`
        if (args.length === 7) {
          return SQL.createFunctionCall("make_timestamptz", this.dateTimeParts(args, 5));
        }
        if (args.length === 2) {
          return this.compileFormattedTimestamp(funcCall, args, "to_datetime", "timestamp with time zone");
        }
        if (args.length !== 1) {
          throw new CompilationError("to_datetime() requires 1, 2 or 7 arguments");
        }
        // `to_datetime(epochseconds)`
        const numeric = this.staticNumericType(funcCall.args[0].value);
        if (numeric !== null && (INT_SQL_TYPES.has(numeric) || FLOAT_TYPES.has(numeric) || DECIMAL_TYPES.has(numeric))) {
          return SQL.createFunctionCall("to_timestamp", [SQL.createCastExpression(args[0], "double precision")]);
        }
        return SQL.createCastExpression(
          args[0],
          "timestamp with time zone"
        );
      }

      case "to_duration":
        if (args.length !== 1) {
          throw new CompilationError(
            "to_duration() requires exactly 1 argument"
          );
        }
        return SQL.createCastExpression(args[0], "interval");

      // Calendar conversion functions → CAST
      case "cal_to_local_date":
      case "cal_to_local_time":
      case "cal_to_local_datetime": {
        const pgType = LOCAL_PARSER_TYPES.get(functionName)!;
        const name = functionName.slice("cal_".length);
        // `cal::to_local_date(year, month, day)`, `cal::to_local_time(hour,
        // min, sec)`, `cal::to_local_datetime(year, …, sec)`
        const parts = functionName === "cal_to_local_datetime" ? 6 : 3;
        if (args.length === parts) {
          return functionName === "cal_to_local_date" ?
            SQL.createFunctionCall("make_date", this.dateTimeParts(args)) :
            SQL.createFunctionCall(functionName === "cal_to_local_time" ? "make_time" : "make_timestamp", this.dateTimeParts(args, parts - 1));
        }
        if (args.length === 2) {
          return this.compileFormattedTimestamp(funcCall, args, name, pgType);
        }
        if (args.length !== 1) {
          throw new CompilationError(`cal::${name}() requires 1, 2 or ${parts} arguments`);
        }
        return SQL.createCastExpression(args[0], pgType);
      }

      // String functions with special compilation
      case "str_starts_with":
        // str_starts_with(s, prefix) → STARTS_WITH(s, prefix) (PG 15+)
        if (args.length !== 2) {
          throw new CompilationError(
            "str_starts_with() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("STARTS_WITH", args);

      case "str_ends_with":
        // str_ends_with(s, suffix) → RIGHT(s, LENGTH(suffix)) = suffix
        if (args.length !== 2) {
          throw new CompilationError(
            "str_ends_with() requires exactly 2 arguments"
          );
        }
        return SQL.createBinaryExpression(
          "=",
          SQL.createFunctionCall("RIGHT", [
            args[0],
            SQL.createFunctionCall("LENGTH", [args[1]])
          ]),
          args[1]
        );

      // Math special compilation
      case "math_e":
        // math::e() → EXP(1)
        return SQL.createFunctionCall("EXP", [
          SQL.createLiteral("number", 1)
        ]);

      case "math_log10":
        // math::log10(val) → LOG(10, val) — PG LOG(b, x) is base-b logarithm
        if (args.length !== 1) {
          throw new CompilationError(
            "math_log10() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("LOG", [
          SQL.createLiteral("number", 10),
          args[0]
        ]);

      case "math_log2":
        // math::log2(val) → LOG(2, val) — PG LOG(b, x) is base-b logarithm
        if (args.length !== 1) {
          throw new CompilationError(
            "math_log2() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("LOG", [
          SQL.createLiteral("number", 2),
          args[0]
        ]);

      // Regex functions with special compilation
      case "re_match":
        // re_match(pattern, str) → REGEXP_MATCH(str, pattern) — swap args
        if (args.length !== 2) {
          throw new CompilationError(
            "re_match() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("REGEXP_MATCH", [args[1], args[0]]);

      case "re_match_all":
        // re_match_all(pattern, str) → REGEXP_MATCHES(str, pattern, 'g')
        if (args.length !== 2) {
          throw new CompilationError(
            "re_match_all() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("REGEXP_MATCHES", [
          args[1],
          args[0],
          SQL.createLiteral("string", "g")
        ]);

      case "re_replace":
        // re_replace(pattern, sub, str) → REGEXP_REPLACE(str, pattern, sub)
        if (args.length !== 3) {
          throw new CompilationError(
            "re_replace() requires exactly 3 arguments"
          );
        }
        return SQL.createFunctionCall("REGEXP_REPLACE", [
          args[2],
          args[0],
          args[1]
        ]);

      case "re_test":
        // re_test(pattern, str) → str ~ pattern
        if (args.length !== 2) {
          throw new CompilationError(
            "re_test() requires exactly 2 arguments"
          );
        }
        return SQL.createBinaryExpression("~", args[1], args[0]);

      // Datetime special compilation
      case "cal_date_get":
      case "cal_time_get":
      case "datetime_get":
      case "duration_get":
        return this.compileDatePartGet(functionName, funcCall, args);

      case "datetime_truncate": {
        // datetime_truncate(val, field) → DATE_TRUNC(field, val)
        if (args.length !== 2) {
          throw new CompilationError(
            "datetime_truncate() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("DATE_TRUNC", [args[1], args[0]]);
      }

      // JSON special compilation
      case "to_json":
        // to_json(str) parses the JSON text; `<json>` of a str is a JSON string.
        if (args.length !== 1) {
          throw new CompilationError("to_json() requires exactly 1 argument");
        }
        return SQL.createCastExpression(args[0], "jsonb");

      case "json_get":
        return this.compileJsonGet(funcCall, args);

      // Array special compilation
      case "array_get":
        // array_get(arr, n) → arr[n + 1] (PG is 1-indexed)
        if (args.length !== 2) {
          throw new CompilationError(
            "array_get() requires exactly 2 arguments"
          );
        }
        // An array of tuples or of arrays is a jsonb array (see `compileArrayExpr`),
        // whose `->` counts a negative index from the end and answers NULL past either end.
        if (this.staticTupleArrayType(funcCall.args[0].value) || this.staticNestedArrayType(funcCall.args[0].value)) {
          const element = SQL.createJsonbAccess(args[0], "->", SQL.createCastExpression(args[1], "integer"));
          return this.nestedArrayElement(element, funcCall.args[0].value);
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `(${this.renderSqlExpr(args[0])})[${this.renderSqlExpr(args[1])} + 1]`
        };

      // Set functions with special compilation
      case "enumerate": {
        // enumerate(val) → ROW_NUMBER() OVER () paired with val as jsonb array
        if (args.length !== 1) {
          throw new CompilationError(
            "enumerate() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `jsonb_build_array(ROW_NUMBER() OVER () - 1, ${this.renderSqlExpr(args[0])})`
        };
      }

      case "distinct":
        // distinct(expr) → wraps expression with DISTINCT keyword
        if (args.length !== 1) {
          throw new CompilationError(
            "distinct() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `DISTINCT ${this.renderSqlExpr(args[0])}`
        };

      case "exists":
        // exists(expr) → EXISTS (subquery) or (expr IS NOT NULL)
        if (args.length !== 1) {
          throw new CompilationError(
            "exists() requires exactly 1 argument"
          );
        }
        return SQL.createBinaryExpression(
          "IS NOT",
          args[0],
          SQL.createLiteral("null", null)
        );

      // Sequence functions
      case "sequence_next":
        // sequence_next(name) → NEXTVAL(name)
        if (args.length !== 1) {
          throw new CompilationError(
            "sequence_next() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("NEXTVAL", args);

      case "sequence_reset":
        // sequence_reset(name, val) → SETVAL(name, val)
        if (args.length !== 2) {
          throw new CompilationError(
            "sequence_reset() requires exactly 2 arguments"
          );
        }
        return SQL.createFunctionCall("SETVAL", args);

      // Range & Multirange functions
      case "range": {
        // range(lower, upper) → type-dependent PG range constructor
        // Detect type from literal args: integer → int4range, float → numrange
        if (args.length !== 2) {
          throw new CompilationError(
            "range() requires exactly 2 arguments"
          );
        }
        let rangeConstructor = "int4range"; // default
        if (funcCall.args.length >= 1) {
          const firstArg = funcCall.args[0].value;
          if (firstArg.kind === "Literal") {
            if (firstArg.type === "float") {
              rangeConstructor = "numrange";
            }
            // integer → int4range (default), string literal could be date/timestamp
          }
        }
        return SQL.createFunctionCall(rangeConstructor, args);
      }

      case "range_unpack": {
        // range_unpack(r) → generate_series(lower(r), upper(r) - 1). PostgreSQL
        // has no unnest(range); a discrete range is canonically `[lower, upper)`.
        if (args.length !== 1) {
          throw new CompilationError(
            "range_unpack() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("generate_series", [
          SQL.createFunctionCall("lower", [args[0]]),
          SQL.createBinaryExpression("-", SQL.createFunctionCall("upper", [args[0]]), SQL.createLiteral("number", 1))
        ]);
      }

      case "multirange": {
        // multirange(r) → type-dependent PG multirange constructor
        // Default to int4multirange; enhanced type inference can be added later
        if (args.length !== 1) {
          throw new CompilationError(
            "multirange() requires exactly 1 argument"
          );
        }
        return SQL.createFunctionCall("int4multirange", args);
      }

      case "overlaps":
        // overlaps(r1, r2) → r1 && r2
        if (args.length !== 2) {
          throw new CompilationError(
            "overlaps() requires exactly 2 arguments"
          );
        }
        return SQL.createBinaryExpression("&&", args[0], args[1]);

      // Full-text search functions (ext::fts)
      case "fts_search":
        // fts::search(query) → fts_vector @@ plainto_tsquery('english', query)
        if (args.length !== 1) {
          throw new CompilationError(
            "fts::search() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `fts_vector @@ plainto_tsquery('english', ${this.renderSqlExpr(args[0])})`
        };

      case "fts_rank":
        // fts::rank(query) → ts_rank(fts_vector, plainto_tsquery('english', query))
        if (args.length !== 1) {
          throw new CompilationError(
            "fts::rank() requires exactly 1 argument"
          );
        }
        return {
          kind: "RawSQLExpression" as const,
          sql: `ts_rank(fts_vector, plainto_tsquery('english', ${this.renderSqlExpr(args[0])}))`
        };
    }

    // Standard 1:1 function name mapping. Without an `sqlName` the SQL function
    // is the entry's own name, underscore-joined: `std::md5` (however the call
    // spelled it) is the `std_md5` wrapper from lib/stdlib-sql.ts.
    const funcDef = Context.lookupFunction(this.ctx.schema, funcCall.name.parts);
    if (!funcDef) {
      throw this.unknownFunction(funcCall.name.parts);
    }
    if (funcDef?.windowOnly) {
      throw new CompilationError(
        `Function '${functionName}' requires an OVER clause`
      );
    }
    const sqlName = funcDef.sqlName ?? funcDef.name.replaceAll("::", "_");

    return SQL.createFunctionCall(sqlName, args);
  }

  /**
   * `datetime_get`, `duration_get`, `cal::time_get`, `cal::date_get`:
   * PostgreSQL's `date_part` of one of the units Gel allows (DATE_PART_UNITS).
   * A literal unit is checked now, an InvalidValueError as in Gel; any other
   * is checked when the query runs, by `disc_date_part` (lib/stdlib-sql.ts).
   * The unit reaches the SQL only as a quoted literal or a bound value. A
   * `duration_get` of a duration whose type isn't known statically takes a
   * `cal::relative_duration`'s units, which include every other duration's.
   */
  private compileDatePartGet(functionName: string, funcCall: EdgeQLAST.FunctionCall, args: SQL.SQLExpression[]): SQL.SQLExpression {
    if (args.length !== 2) {
      throw new CompilationError(`${funcCall.name.parts.join("::")}() requires exactly 2 arguments`);
    }
    let key = functionName;
    if (functionName === "duration_get") {
      const type = this.staticNumericType(funcCall.args[0].value)?.split("::").pop();
      key = `duration_get:${type === "duration" || type === "date_duration" ? type : "relative_duration"}`;
    }
    const { name, units } = DATE_PART_UNITS.get(key)!;
    const unit = funcCall.args[1].value;
    if (unit.kind !== "Literal" || typeof unit.value !== "string") {
      return SQL.createFunctionCall("disc_date_part", [
        SQL.createLiteral("string", name),
        args[1],
        args[0],
        SQL.createFunctionCall("ARRAY", units.map(allowed => SQL.createLiteral("string", allowed)))
      ]);
    }
    if (!units.includes(unit.value)) {
      throw new InvalidValueError(`invalid unit for ${name}: '${unit.value.replaceAll("'", "''")}'`, {
        ...this.expressionLocation(unit),
        hint: `Supported units: ${units.join(", ")}.`
      });
    }
    return SQL.createFunctionCall("date_part", [SQL.createLiteral("string", EPOCH_UNITS.has(unit.value) ? "epoch" : unit.value), args[0]]);
  }

  /**
   * The PostgreSQL function `len(expr)` compiles to, by `expr`'s static type
   * (`staticNumericType` reads any scalar or array type it can see, and an
   * array literal or a call to a function returning an array or bytes adds to
   * it; a user scalar is taken as the built-in it extends):
   *
   *   array<T> → CARDINALITY   (PG `LENGTH` has no array form)
   *   array<tuple<…>>, array<array<…>> → jsonb_array_length (see `compileArrayExpr`)
   *   bytes    → OCTET_LENGTH
   *   str      → LENGTH        (characters, as Gel counts them)
   *
   * An argument of unknown type also gets `LENGTH`: str is the common case,
   * and PostgreSQL's `LENGTH` takes bytea too, so only an array PostgreSQL
   * cannot see statically still fails there.
   */
  private lengthFunction(expr: EdgeQLAST.Expression): string {
    if (this.staticTupleArrayType(expr) || this.staticNestedArrayType(expr)) {
      return "jsonb_array_length";
    }
    const staticType = expr.kind === "ArrayExpr" ?
      "array" :
      expr.kind === "FunctionCall" ?
      Context.lookupFunction(this.ctx.schema, expr.name.parts)?.returnType :
      this.staticNumericType(expr);
    const type = staticType ? this.ctx.schema.scalars?.get(staticType) ?? staticType : null;
    if (type?.startsWith("array")) {
      return "CARDINALITY";
    }
    return type === "bytes" || type === "std::bytes" ? "OCTET_LENGTH" : "LENGTH";
  }

  /**
   * `enumerate(<set>)` over a set-returning call or set literal: the set's rows
   * numbered in a subquery, as an array unpacked again, so the result is
   * still a set wherever the argument could be one:
   *
   *   UNNEST(ARRAY(SELECT jsonb_build_array(ROW_NUMBER() OVER () - 1, __set.value)
   *                FROM (SELECT UNNEST(…)) AS __set(value)))
   *
   * Numbering next to the set-returning call instead (`ROW_NUMBER() OVER ()`
   * beside `UNNEST(…)`) numbers the one row the call expands, giving every
   * element index 0.
   */
  private compileEnumerateSet(set: EdgeQLAST.Subquery): SQL.SQLExpression {
    const value = SQL.createColumnReference("value", "__set");
    const index = SQL.createBinaryExpression("-", SQL.windowFunction("ROW_NUMBER", [], { kind: "WindowClause" }), SQL.createLiteral("number", 1));
    const numbered = SQL.createSelectStatement({
      from: SQL.createFromClause([{ alias: "__set", columnAliases: ["value"], kind: "TableReference", name: "", subquery: this.compileQuery(set.query) }]),
      select: SQL.createSelectClause([SQL.createSelectItem(SQL.createFunctionCall("jsonb_build_array", [index, value]))])
    });
    // `ARRAY (SELECT …)`, the array of the subquery's rows (a FunctionCall named
    // ARRAY renders as the `ARRAY[…]` constructor).
    return SQL.createFunctionCall("UNNEST", [{ kind: "UnaryExpression", operator: "ARRAY", operand: SQL.createSubqueryExpression(numbered) }]);
  }

  /**
   * `sequence_next(introspect T)` / `sequence_reset(introspect T[, value])` on
   * the PostgreSQL sequence of the sequence scalar `T`:
   *
   *   sequence_next(introspect T)      → NEXTVAL('<seq>')  (the next value, int64)
   *   sequence_reset(introspect T, v)  → SETVAL('<seq>', v) (the next is v + 1)
   *   sequence_reset(introspect T)     → SETVAL('<seq>', <start>, false)
   *                                      (the next is the start value again)
   *
   * `<seq>` is named by `sequenceName`, as the migrator names it.
   */
  private compileSequenceFunction(functionName: string, funcCall: EdgeQLAST.FunctionCall): SQL.SQLExpression {
    const [target, ...rest] = funcCall.args.map(arg => arg.value);
    if (functionName === "sequence_next" && rest.length !== 0) {
      throw new CompilationError("sequence_next() takes 1 argument: sequence_next(introspect <sequence scalar type>)");
    }
    if (rest.length > 1) {
      throw new CompilationError("sequence_reset() takes 1 or 2 arguments: sequence_reset(introspect <sequence scalar type>[, value])");
    }

    const sequence = this.sequenceOf((target as EdgeQLAST.Introspection).type);
    const name = SQL.createLiteral("string", sequence);
    if (functionName === "sequence_next") {
      return SQL.createFunctionCall("NEXTVAL", [name]);
    }
    if (rest.length === 1) {
      return SQL.createFunctionCall("SETVAL", [name, this.compileExpression(rest[0])]);
    }
    const start: SQL.RawSQLExpression = {
      kind: "RawSQLExpression",
      sql: `( SELECT seqstart FROM pg_catalog.pg_sequence WHERE seqrelid = '${sequence.replaceAll("'", "''")}'::regclass )`
    };
    return SQL.createFunctionCall("SETVAL", [name, start, SQL.createLiteral("boolean", false)]);
  }

  /**
   * The PostgreSQL sequence of the sequence scalar `type` names. A bare name
   * is looked up in the `with module` scope, then `default`, then any module
   * declaring it.
   */
  private sequenceOf(type: EdgeQLAST.TypeName): string {
    const parts = type.name.parts;
    const name = parts[parts.length - 1];
    const scalars = this.ctx.schema.scalars ?? new Map<string, string>();
    const qualified = parts.length > 1 ?
      parts.join("::") :
      [this.ctx.moduleScope, "default"].map(module => `${module}::${name}`).find(key => scalars.has(key)) ??
        [...scalars.keys()].find(key => key.endsWith(`::${name}`));

    if (!qualified || scalars.get(qualified) !== "sequence") {
      throw new CompilationError(
        `'${parts.join("::")}' is not a sequence scalar type. sequence_next() and sequence_reset() take ` +
          "`introspect T` of a scalar declared `scalar type T extending sequence`."
      );
    }
    return sequenceName(qualified.slice(0, qualified.lastIndexOf("::")), name);
  }

  /**
   * A call to a function that is neither built in nor added by the schema (SDL
   * declaration, extension, custom function). Without this it would reach
   * PostgreSQL as `enc_base64_decode(…)` and fail there, or worse, resolve to
   * some unrelated SQL function of that name.
   */
  private unknownFunction(parts: string[]): CompilationError {
    return new CompilationError(
      `Unknown function '${parts.join("::")}'. It is not a built-in function, and the schema does not declare it ` +
        "(SDL function, extension or custom function)."
    );
  }

  private compileWindowFunctionCall(
    wfc: EdgeQLAST.WindowFunctionCall
  ): SQL.WindowFunctionExpression {
    const functionName = wfc.name.parts.join("_");
    const args = wfc.args.map(arg => this.compileExpression(arg.value));

    // Map function name to SQL
    let sqlName = functionName;
    const funcDef = Context.lookupFunction(this.ctx.schema, wfc.name.parts);
    if (!funcDef) {
      throw this.unknownFunction(wfc.name.parts);
    }
    if (!funcDef?.windowOnly && !funcDef?.windowCompatible) {
      throw new CompilationError(
        `Function '${functionName}' cannot be used with an OVER clause`
      );
    }
    if (funcDef?.sqlName) {
      sqlName = funcDef.sqlName;
    }

    // Compile the OVER clause
    const over = this.compileWindowOverClause(wfc.over);

    return SQL.windowFunction(sqlName, args, over);
  }

  private compileWindowOverClause(
    over: EdgeQLAST.WindowOverClause
  ): SQL.WindowClause {
    // Compile PARTITION BY
    let partitionBy: SQL.SQLExpression[] | undefined;
    if (over.partitionBy && over.partitionBy.length > 0) {
      partitionBy = over.partitionBy.map(expr => this.compileExpression(expr));
    }

    // Compile ORDER BY
    let orderBy: SQL.OrderByItem[] | undefined;
    if (over.orderBy && over.orderBy.length > 0) {
      orderBy = over.orderBy.map(item => ({
        kind: "OrderByItem" as const,
        expression: this.compileExpression(item.expr),
        direction: item.direction || "ASC" as "ASC" | "DESC",
        ...compileEmptyOrder(item, this.isNeverEmpty(item.expr))
      }));
    }

    // Compile frame spec
    let frame: SQL.WindowFrame | undefined;
    if (over.frame) {
      const start = this.compileFrameBound(over.frame.start);
      const end = over.frame.end ?
        this.compileFrameBound(over.frame.end) :
        start;

      frame = {
        kind: "WindowFrame",
        mode: over.frame.mode,
        start,
        end,
        exclude: over.frame.exclude
      };
    }

    return {
      kind: "WindowClause",
      partitionBy,
      orderBy,
      frame
    };
  }

  private compileFrameBound(bound: EdgeQLAST.FrameBound): string {
    switch (bound.type) {
      case "UNBOUNDED PRECEDING":
        return "UNBOUNDED PRECEDING";
      case "CURRENT ROW":
        return "CURRENT ROW";
      case "UNBOUNDED FOLLOWING":
        return "UNBOUNDED FOLLOWING";
      case "OFFSET PRECEDING": {
        // Extract literal value for the offset
        if (bound.offset && bound.offset.kind === "Literal") {
          return `${bound.offset.value} PRECEDING`;
        }
        return "0 PRECEDING";
      }
      case "OFFSET FOLLOWING": {
        if (bound.offset && bound.offset.kind === "Literal") {
          return `${bound.offset.value} FOLLOWING`;
        }
        return "0 FOLLOWING";
      }
      default:
        return bound.type;
    }
  }

  private compileParameter(param: EdgeQLAST.Parameter): SQL.SQLExpression {
    // The lexer keeps the leading `$` on the name. Strip it so callers can
    // key the parameter map by the bare identifier (matches the wire-level
    // `kwargs` shape both upstream Gel clients use).
    const bare = param.name.startsWith("$") ? param.name.slice(1) : param.name;

    // Numeric positional parameters (`$0`, `$1`, ...) keep their literal
    // index. Without this, parseInt fails for purely-numeric names that
    // happen to also exist in `parameterIndex` and we'd shift positions.
    const numeric = parseInt(bare, 10);
    if (!Number.isNaN(numeric)) {
      // EdgeQL `$0` is the first positional argument; PG `$1` is the first
      // bind value. Bump by 1 to keep the two coordinate systems aligned.
      return SQL.createParameterReference(numeric + 1);
    }

    const idx = this.parameterIndex.get(bare);
    if (idx !== undefined) {
      return SQL.createParameterReference(idx);
    }

    // No map entry — fall back to length+1 so successive unmapped names get
    // distinct indices instead of all collapsing onto $1 (the prior bug).
    const next = this.parameterIndex.size + 1;
    this.parameterIndex.set(bare, next);
    return SQL.createParameterReference(next);
  }

  /**
   * True when `expr` is known to yield json. There is no expression type
   * inference in the compiler; this reads the forms whose type is stated:
   *
   * - a cast to json (`<json>$rows`);
   * - a subscript with a string-literal key (`x['k']` — only json takes one), or
   *   any subscript whose base is json (`x['items'][0]`);
   * - a call to a function registered as returning json (`json_get`,
   *   `to_json`, `json_array_unpack`, …);
   * - a name bound to one of these: a `with` binding (`rows := <json>$rows`), a
   *   `for` variable over a set literal, or a `for` variable iterating
   *   `json_array_unpack(…)`;
   * - a one-step path to a json property of a type in scope (`.meta`).
   *
   * Anything else (`a ?? b`, `a if c else b`, a subquery, a multi-step path, a
   * tuple element) is not recognized and keeps the plain SQL cast.
   */
  protected isJsonExpression(expr: EdgeQLAST.Expression): boolean {
    switch (expr.kind) {
      case "TypeCast":
        return edgeqlTypeToPgType(renderEdgeQLTypeName(expr.type), this.ctx.schema.scalars) === "jsonb" && !expr.type.subtypes?.length;
      case "IndexExpression":
        return (expr.index.kind === "Literal" && expr.index.type === "string") || this.isJsonExpression(expr.expr);
      case "FunctionCall":
        return Context.lookupFunction(this.ctx.schema, expr.name.parts)?.returnType === "json";
      case "Identifier": {
        const variable = [this.ctx.currentScope, ...[...this.ctx.scopes].reverse()]
          .map(scope => scope.variables.get(expr.name))
          .find(found => found !== undefined);
        if (!variable) {
          return false;
        }
        return variable.sqlOverride ? variable.type === "json" : this.isJsonExpression(variable.expression);
      }
      case "Path": {
        if (expr.steps.length !== 1 || expr.steps[0].type !== "property") {
          return false;
        }
        for (const alias of this.ctx.currentScope.aliases.values()) {
          const property = Context.getProperty(this.ctx, alias.type, expr.steps[0].name);
          if (property) {
            return !property.computed && property.type === "jsonb";
          }
        }
        return false;
      }
      default:
        return false;
    }
  }

  /**
   * A cast whose operand is json. `CAST(jsonb AS text)` keeps the JSON quotes
   * and jsonb → `text[]` / `bytea` are not valid PostgreSQL, so the value is
   * taken out as text first (`#>> '{}'`; JSON null becomes NULL) and that is
   * cast. An array is rebuilt element by element, in order: `[]` gives an empty
   * array, a missing key or JSON null gives NULL.
   *
   * The operand stays a SQL AST node (for the array, in the NULL test) so a
   * `<json>$p` inside it is still found by `buildParameterTypeMap`.
   */
  private compileCastFromJson(operand: SQL.SQLExpression, pgType: string, typeName: string): SQL.SQLExpression {
    if (pgType === "jsonb") {
      return SQL.createCastExpression(operand, pgType);
    }

    if (pgType === "bytea" || pgType === "bytea[]") {
      throw new CompilationError(
        `Cannot cast json to ${typeName}: JSON carries bytes as base64 text. Decode it: std::base64_decode(<str>…)`
      );
    }

    if (pgType.endsWith("[]")) {
      const elements = pgType === "jsonb[]" ? "jsonb_array_elements" : "jsonb_array_elements_text";
      const rebuilt = `CAST(ARRAY(SELECT e.v FROM ${elements}(${this.renderSqlExpr(operand)}) WITH ORDINALITY AS e(v, ord) ORDER BY e.ord) AS ${pgType})`;
      const isNull = SQL.createBinaryExpression(
        "OR",
        SQL.createBinaryExpression("IS", operand, SQL.createLiteral("null", null)),
        SQL.createBinaryExpression("=", SQL.createFunctionCall("JSONB_TYPEOF", [operand]), SQL.createLiteral("string", "null"))
      );

      return SQL.createCaseExpression(
        [SQL.createWhenClause(isNull, SQL.createLiteral("null", null))],
        { kind: "RawSQLExpression", sql: rebuilt }
      );
    }

    const text = SQL.createJsonbAccess(operand, "#>>", SQL.createLiteral("string", "{}"));
    return pgType === "text" ? text : SQL.createCastExpression(text, pgType);
  }

  /**
   * `<T><uuid>x`: the id `x`, when an object of `T` (or of a subtype) the
   * query may read has it; else Gel's CardinalityViolationError ("'default::T'
   * with id '…' does not exist"), raised by `disc_object_cast`
   * (lib/stdlib-sql.ts, SQLSTATE 21000). An empty `x` is the empty set.
   *
   *   <User><uuid>$u
   *   → disc_object_cast(CAST($1 AS uuid), EXISTS (SELECT … FROM "user" AS user_2 WHERE user_2.id = CAST($1 AS uuid)), 'default::User')
   */
  private objectCast(id: SQL.SQLExpression, type: EdgeQLAST.TypeName, typeDef: Context.TypeDef): SQL.SQLExpression {
    const name = Context.generateAlias(this.ctx, "__cast_id");
    const variables = this.ctx.currentScope.variables;
    variables.set(name, { expression: EdgeQLAST.createIdentifier(name), name, sqlOverride: id, staticType: "uuid", type: "any" });
    let found: SQL.SQLExpression;
    try {
      const idStep: EdgeQLAST.PathStep = { kind: "PathStep", name: "id", type: "property" };
      const query: EdgeQLAST.SelectQuery = {
        distinct: false,
        expr: { expr: type, kind: "Detached" },
        filter: EdgeQLAST.createBinaryOp("=", EdgeQLAST.createPath([idStep]), EdgeQLAST.createIdentifier(name)),
        kind: "SelectQuery"
      };
      this.objectIdSelects.add(query);
      found = this.compileExpression(EdgeQLAST.createUnaryOp("EXISTS", { kind: "Subquery", query }));
    } finally {
      variables.delete(name);
    }
    const qualified = typeDef.name.includes("::") ? typeDef.name : `${typeDef.module ?? "default"}::${typeDef.name}`;
    return SQL.createFunctionCall("disc_object_cast", [id, found, SQL.createLiteral("string", qualified)]);
  }

  private compileTypeCast(cast: EdgeQLAST.TypeCast): SQL.SQLExpression {
    this.assertNotOverSet(cast, `<${renderEdgeQLTypeName(cast.type)}>`);
    const tuple = this.tupleLiteralCast(cast);
    if (tuple) {
      return tuple;
    }
    const expr = this.compileExpression(cast.expr);
    const typeName = renderEdgeQLTypeName(cast.type);
    const fromJson = this.isJsonExpression(cast.expr);

    // User-declared enum scalars don't appear in the static built-in map.
    // Resolve them through the schema so casts like `<LogLevel>$level`
    // emit `::disc_enum_loglevel` instead of being passed through verbatim
    // (which PG would silently lowercase to `loglevel` — a type that
    // doesn't exist). `<array<LogLevel>>` casts to the enum's array type.
    const resolved = Context.resolveTypeName(this.ctx, typeName);
    const arrayElement = /^array<(.+)>$/.exec(typeName)?.[1];
    const enumDef = arrayElement ? Context.resolveTypeName(this.ctx, arrayElement) : resolved;
    if (enumDef?.enumValues?.length) {
      const enumType = `${Context.enumSqlType(enumDef)}${arrayElement ? "[]" : ""}`;
      return fromJson ? this.compileCastFromJson(expr, enumType, typeName) : SQL.createCastExpression(expr, enumType);
    }

    // `<Program><uuid>$p` names an object by its id. A link column stores that
    // uuid, so the cast is the uuid expression itself, checked (`objectCast`);
    // there is no SQL type to cast to.
    if (resolved?.kind === "object") {
      return this.objectCast(expr, cast.type, resolved);
    }

    const pgType = edgeqlTypeToPgType(typeName, this.ctx.schema.scalars);

    // `<Progam><uuid>$p`: the object-cast shape with a name that is neither a
    // schema type nor a known scalar. Without this it reaches Postgres as
    // `CAST(… AS Progam)`.
    if (pgType === typeName && !isUuidTypeName(typeName) && cast.expr.kind === "TypeCast" && isUuidTypeName(renderEdgeQLTypeName(cast.expr.type))) {
      throw new InvalidReferenceError(`Unknown type '${typeName}' in cast <${typeName}><uuid>…`);
    }
    // A name that is no known type is passed through as the PostgreSQL type,
    // written into the SQL as is; a backtick-quoted one can hold any
    // character, so only a plain name may be.
    if (!PG_TYPE_NAME.test(pgType)) {
      throw new InvalidReferenceError(`Unknown type '${typeName}' in cast <${typeName}>`, this.expressionLocation(cast));
    }

    // `<array<tuple<…>>>[…]`: an array of tuples is a jsonb array, as its
    // parameter form is (see `jsonbArrayLiteral`).
    const jsonbArray = pgType === "jsonb" && typeName.startsWith("array<") ? this.jsonbArrayLiteral(expr) : null;
    if (jsonbArray) {
      return jsonbArray;
    }

    // `<str>` of a date duration writes zero `P0D`; `<json>` of a value that is
    // not json already is `jsonValue`.
    const sourceType = this.staticScalarType(cast.expr);
    if (pgType === "text" && !fromJson) {
      const text = this.temporalText(expr, sourceType);
      if (text !== expr) {
        return text;
      }
    }
    if (isStdType(typeName, "json") && !fromJson) {
      const json = this.jsonValue(cast.expr, expr, sourceType);
      if (json) {
        return json;
      }
    }

    // A decimal or float cast to bigint is rounded, as Gel's
    // `round($1)::edgedbt.bigint_t` casts do, and so is each element of an
    // array of them cast to `array<bigint>`; text and other values are not,
    // so a fractional one is rejected (see `finiteNumeric`).
    const array = pgType === "numeric[]";
    const toBigint = (pgType === "numeric" || array) && this.numericBaseType(typeName) === "bigint";
    const source = pgType.endsWith("[]") ? this.staticArrayElementType(cast.expr) : this.staticNumericType(cast.expr);
    const rounded = toBigint && source !== null && ROUNDED_TO_BIGINT.has(this.numericBaseType(source) ?? "");
    // A float rounds half to even, as Gel's do: PostgreSQL's float8 `round`
    // and int casts use rint(). A float literal (or arithmetic over one) is
    // numeric to PostgreSQL, which rounds half away from zero, as a decimal
    // does in both; so a float is made a float8 first.
    const toInteger = toBigint || INTEGER_PG_TYPES.has(pgType.replace(/\[\]$/, ""));
    const isFloatCast = expr.kind === "CastExpression" && /^(double precision|real)(\[\])?$/.test(expr.targetType);
    const float = toInteger && !isFloatCast && source !== null && FLOAT_TYPES.has(this.numericBaseType(source) ?? "");
    const value = float ? SQL.createCastExpression(expr, pgType.endsWith("[]") ? "double precision[]" : "double precision") : expr;
    const operand = !rounded ? value : array ? this.roundElements(value) : SQL.createFunctionCall("round", [value]);
    const compiled = fromJson ? this.compileCastFromJson(operand, pgType, typeName) : SQL.createCastExpression(operand, pgType);
    const checked = this.isFiniteNumber(cast.expr, toBigint && !rounded) ? compiled : this.finiteNumeric(compiled, pgType, typeName);
    return this.scalarCastCheck(checked, typeName);
  }

  /**
   * `value`, cast to `typeName`, checked against the constraints of the user
   * scalar it names (or of its array element: each element is), as Gel checks
   * a cast to a constrained scalar: each constraint's boolean, compiled over
   * the value as a CHECK's is (`subjectCheckSql`), goes through
   * `disc_check_constraint`, which raises Gel's ConstraintViolationError when
   * it is false. The value is a derived table's column, so it is computed
   * once; an empty value passes. `value` itself when the scalar has none.
   */
  private scalarCastCheck(value: SQL.SQLExpression, typeName: string): SQL.SQLExpression {
    const element = /^array<(.+)>$/.exec(typeName)?.[1];
    const name = normalizeStdTypeName(element ?? typeName);
    const scalarChecks = this.ctx.schema.scalarChecks;
    const checks = (this.ctx.moduleScope && !name.includes("::") ? scalarChecks?.get(`${this.ctx.moduleScope}::${name}`) : undefined) ??
      scalarChecks?.get(name) ?? scalarChecks?.get(name.replace(/^default::/, ""));
    if (!checks) {
      return value;
    }
    const subject = Context.generateAlias(this.ctx, "subject");
    const holds: SQL.RawSQLExpression = {
      kind: "RawSQLExpression",
      sql: checks
        .map(check =>
          `disc_check_constraint(${this.subjectCheckSql(check.edgeql, check.module, "v")}, ${sqlStringLiteral(check.message)}, ${
            sqlStringLiteral(check.detail)
          }, '', '')`
        )
        .join(" AND ")
    };
    const column = SQL.createColumnReference(element ? "a" : "v", subject);
    const test = element ?
      SQL.createSubqueryExpression(SQL.createSelectStatement({
        from: SQL.createFromClause([{
          alias: "e",
          columnAliases: ["v"],
          expression: SQL.createFunctionCall("unnest", [column]),
          kind: "TableReference",
          name: ""
        }]),
        select: SQL.createSelectClause([SQL.createSelectItem(SQL.createFunctionCall("bool_and", [holds]))])
      })) :
      holds;
    return SQL.createSubqueryExpression(SQL.createSelectStatement({
      from: SQL.createFromClause([{
        alias: subject,
        columnAliases: [element ? "a" : "v"],
        kind: "TableReference",
        name: "",
        subquery: SQL.createSelectStatement({ select: SQL.createSelectClause([SQL.createSelectItem(value)]) })
      }]),
      select: SQL.createSelectClause([
        SQL.createSelectItem(
          SQL.createCaseExpression([SQL.createWhenClause(SQL.createBinaryExpression("IS NOT", test, SQL.createLiteral("boolean", false)), column)])
        )
      ])
    }));
  }

  /**
   * A tuple literal cast to a tuple type, `<tuple<a: int64, b: str>>(1, 'x')`:
   * the tuple of the cast's type, built element by element — each element
   * cast to its type and named as the type names it. As in Gel, a named
   * target names (or renames) the elements and a positional one drops the
   * literal's names. Null for any other cast.
   */
  private tupleLiteralCast(cast: EdgeQLAST.TypeCast): SQL.SQLExpression | null {
    const targets = cast.type.subtypes;
    const values = cast.expr.kind === "TupleExpr" ?
      cast.expr.elements :
      cast.expr.kind === "NamedTuple" ?
      cast.expr.elements.map(element => element.value) :
      null;
    if (cast.type.name.parts.at(-1) !== "tuple" || !targets?.length || !values) {
      return null;
    }
    if (targets.length !== values.length) {
      throw new CompilationError(
        `cannot cast a tuple of ${values.length} element(s) to '${renderEdgeQLTypeName(cast.type)}'`,
        this.expressionLocation(cast)
      );
    }
    const elements = values.map((value, i) =>
      this.tupleElement({ expr: value, kind: "TypeCast", span: value.span, type: { ...targets[i], fieldName: undefined } })
    );
    return targets.every(target => target.fieldName) ?
      SQL.createJsonBuildObject(targets.map((target, i) => SQL.createJsonField(target.fieldName!, elements[i]))) :
      SQL.createFunctionCall("jsonb_build_array", elements);
  }

  /**
   * `round` of each element of the array `sql`, in order (Gel casts an array
   * element by element); a NULL array (an empty set) stays NULL. The array is
   * also kept as a SQL AST node, in the NULL test, so a parameter in it is
   * still found by `buildParameterTypeMap`.
   */
  private roundElements(sql: SQL.SQLExpression): SQL.SQLExpression {
    const rounded = `ARRAY(SELECT round(e.v) FROM UNNEST(${this.renderSqlExpr(sql)}) WITH ORDINALITY AS e(v, ord) ORDER BY e.ord)`;
    return SQL.createCaseExpression(
      [SQL.createWhenClause(SQL.createBinaryExpression("IS", sql, SQL.createLiteral("null", null)), SQL.createLiteral("null", null))],
      { kind: "RawSQLExpression", sql: rounded }
    );
  }

  /**
   * `<json>` of `value`, the compiled `operand`, whose EdgeQL type is `type`
   * when known: the JSON value Gel makes, which is `to_jsonb`'s — a str is a
   * JSON string, a bigint or decimal keeps its digits, a float's NaN and
   * ±Infinity are strings, a date or time is its ISO text, an enum its label,
   * an array a JSON array of its elements, a tuple (jsonb already) itself —
   * but for a duration, Gel's ISO 8601 text (`dateDurationText`), and bytes,
   * base64. A string literal is made text first (PostgreSQL leaves its type
   * unknown). Null for a parameter (`<json>$p` binds JSON text) and an empty
   * set, which keep the plain cast.
   */
  private jsonValue(operand: EdgeQLAST.Expression, value: SQL.SQLExpression, type: string | null): SQL.SQLExpression | null {
    const empty = (value.kind === "LiteralExpression" && value.type === "null") || (value.kind === "RawSQLExpression" && value.sql === "NULL");
    if (operand.kind === "Parameter" || empty) {
      return null;
    }
    const element = this.staticArrayElementType(operand);
    const bytes = isStdType(element ?? type, "bytes") ? element ? "bytea[]" : "bytea" : null;
    const typed = value.kind === "LiteralExpression" && value.type === "string" ?
      SQL.createCastExpression(value, "text") :
      this.bytesAsBase64(this.dateDurationText(value, element ? `array<${element}>` : type), bytes);
    return SQL.createFunctionCall("to_jsonb", [typed]);
  }

  /*** The built-in type the user scalar `typeName` names extends (a sequence scalar is an `int64`); undefined when it names none. A bare name is the `with module`'s scalar first. ***/
  private scalarBaseType(typeName: string): string | undefined {
    const scalars = this.ctx.schema.scalars;
    const name = normalizeStdTypeName(typeName);
    const base = (this.ctx.moduleScope && !name.includes("::") ? scalars?.get(`${this.ctx.moduleScope}::${name}`) : undefined) ??
      scalars?.get(name) ?? scalars?.get(name.replace(/^default::/, ""));
    return base === "sequence" ? "int64" : base;
  }

  /*** The numeric type `typeName` (or its array element) is, or a scalar it names extends: `bigint`, `decimal`, `float32` or `float64`. ***/
  private numericBaseType(typeName: string): string | undefined {
    const element = normalizeStdTypeName(/^array<(.+)>$/.exec(typeName)?.[1] ?? typeName);
    const scalars = this.ctx.schema.scalars;
    const base = normalizeStdTypeName(scalars?.get(element) ?? scalars?.get(element.replace(/^default::/, "")) ?? element);
    return DECIMAL_TYPES.has(base) || FLOAT_TYPES.has(base) ? base : undefined;
  }

  /**
   * `sql`, a value of `typeName` stored as `pgType`, checked by
   * `disc_finite_numeric` (lib/stdlib-sql.ts) when it is a `decimal` or
   * `bigint` (or an array of either, or a scalar extending one): PostgreSQL's
   * numeric holds NaN and ±Infinity, Gel's decimal and bigint do not, so the
   * cast that would make one fails as InvalidValueError, as in Gel. With the
   * check on what is written to a decimal or bigint property
   * (`finitePropertyValue`), no NaN is ever stored, so none is answered.
   * A `bigint` must also have no fractional part (Gel's `bigint_t` domain
   * checks `scale(VALUE) = 0`). A scalar is checked as the type it extends,
   * which is the type Gel's error names.
   */
  protected finiteNumeric(sql: SQL.SQLExpression, pgType: string, typeName: string): SQL.SQLExpression {
    if (pgType !== "numeric" && pgType !== "numeric[]") {
      return sql;
    }
    const base = this.numericBaseType(typeName);
    const name = base !== undefined && DECIMAL_TYPES.has(base) ? `std::${base}` : /^array<(.+)>$/.exec(typeName)?.[1] ?? typeName;
    return SQL.createFunctionCall("disc_finite_numeric", [sql, SQL.createLiteral("string", name)]);
  }

  /**
   * `sql`, the value `expr` writes to a stored `property`, checked by
   * `finiteNumeric` when the property is a `decimal` or `bigint` (or an array
   * of either). A cast already checks its value, but a value reaches the
   * column without one too: an uncast parameter, a float (PostgreSQL assigns
   * float8 to numeric), a string literal. The value is cast to the column's
   * type first, which is also how PostgreSQL types an uncast parameter.
   */
  protected finitePropertyValue(property: Context.PropertyDef, expr: EdgeQLAST.Expression, sql: SQL.SQLExpression): SQL.SQLExpression {
    const pgType = property.type;
    const typeName = Context.propertyBaseType(property) ?? "decimal";
    // An array literal written to an `array<tuple<…>>` property (a jsonb column).
    const jsonbArray = pgType === "jsonb" && typeName.startsWith("array<") ? this.jsonbArrayLiteral(sql) : null;
    if (jsonbArray) {
      return jsonbArray;
    }
    // A tuple from a parameter, a cast or another tuple is stored as the JSON
    // its literal writes (`canonicalTuple`; a literal is built of typed
    // values already), however the client wrote its datetimes or numbers.
    const valueType = pgType === "jsonb" && tupleTypeElements(typeName) && this.hasCanonicalElements(typeName) &&
        expr.kind !== "TupleExpr" && expr.kind !== "NamedTuple" ?
      this.staticTupleType(expr) :
      null;
    if (valueType !== null && tupleNames(valueType) === tupleNames(typeName)) {
      return this.canonicalTuple(sql, typeName);
    }
    // So is each tuple of an array of tuples from a parameter, a cast or another array.
    const elementType = pgType === "jsonb" ? /^array<(.+)>$/.exec(typeName)?.[1] : undefined;
    const arrayType = elementType && tupleTypeElements(elementType) && this.hasCanonicalElements(elementType) && expr.kind !== "ArrayExpr" ?
      this.staticTupleArrayType(expr) :
      null;
    if (elementType && arrayType !== null && tupleNames(arrayType) === tupleNames(elementType)) {
      return this.canonicalTupleArray(sql, elementType);
    }
    if (
      (pgType !== "numeric" && pgType !== "numeric[]") || this.isFiniteNumber(expr, this.numericBaseType(typeName) === "bigint") ||
      (sql.kind === "FunctionCall" && sql.name === "disc_finite_numeric")
    ) {
      return sql;
    }
    const typed = sql.kind === "CastExpression" && sql.targetType === pgType ? sql : SQL.createCastExpression(sql, pgType);
    return this.finiteNumeric(typed, pgType, typeName);
  }

  /**
   * An array literal `sql` (`ARRAY[…]`) of an `array<tuple<…>>` built as the
   * jsonb array such a value is stored as (`edgeqlTypeToPgType`), the form a
   * `<array<tuple<…>>>$p` parameter binds: its tuples are jsonb already, and
   * `jsonb_build_array()` of none is `[]`. Null when `sql` is no array literal.
   */
  private jsonbArrayLiteral(sql: SQL.SQLExpression): SQL.SQLExpression | null {
    return sql.kind === "FunctionCall" && sql.name === "ARRAY" ? SQL.createFunctionCall("jsonb_build_array", sql.args) : null;
  }

  /**
   * Whether `expr` is a number that cannot be NaN or ±Infinity: a numeric
   * literal (possibly negated) or an integer. With `integral`, a `1.5` or
   * `1.5n` literal is not one: a bigint can't hold it.
   */
  private isFiniteNumber(expr: EdgeQLAST.Expression, integral = false): boolean {
    if (expr.kind === "UnaryOp" && (expr.op === "-" || expr.op === "+")) {
      return this.isFiniteNumber(expr.operand, integral);
    }
    if (expr.kind === "Literal") {
      return integral ? INTEGER_LITERAL_TYPES.has(expr.type) : NUMERIC_LITERAL_TYPES.has(expr.type);
    }
    const type = this.staticNumericType(expr);
    return type !== null && INT_SQL_TYPES.has(type);
  }

  /**
   * True iff `expr` is a 2-step Path whose first step resolves to a
   * multi-cardinality link on any active alias's type. Used to detect
   * the `.multi_link.field` pattern at the binary-op compile point so
   * we can rewrite it to EXISTS rather than try to compile the path
   * as a scalar value.
   */
  /**
   * EdgeQL → SQL name for set-aggregate functions that, when applied to a
   * link-set path, must be lowered to a correlated subquery.
   */
  private static readonly SET_AGGREGATES = new Map<string, string>([
    ["count", "COUNT"],
    ["sum", "SUM"],
    ["min", "MIN"],
    ["max", "MAX"],
    ["avg", "AVG"]
  ]);

  /**
   * Compile a set-aggregate applied to a link-set path into a correlated
   * scalar subquery, e.g. inside a computed property:
   *
   *   count(.subscribers)            → (SELECT COUNT(*) FROM <junction>
   *                                       WHERE <junction>.<src> = parent.id)
   *   count(.<channel[is Video])     → (SELECT COUNT(*) FROM video
   *                                       WHERE video.channel_id = parent.id)
   *   sum(.<creator[is Video].size)  → (SELECT COALESCE(SUM(video.size), 0)
   *                                       FROM video
   *                                       WHERE video.creator_id = parent.id)
   *
   * Returns null — fall through to the generic 1:1 function mapping — when the
   * argument isn't a link-set path this rule understands (ordinary scalar
   * arguments, unknown links, unsupported shapes).
   */
  private compileAggregateOverLinkPath(
    funcName: string,
    arg: EdgeQLAST.Expression
  ): SQL.SQLExpression | null {
    const sqlAgg = ExpressionCompilerLayer.SET_AGGREGATES.get(funcName);
    if (!sqlAgg || arg.kind !== "Path") {
      return null;
    }
    const steps = arg.steps;
    if (steps.length === 0 || steps.length > 2) {
      return null;
    }

    // Correlate against the current (outer) row's alias.
    let parent: { alias: string; type: string; } | undefined;
    for (const ta of this.ctx.currentScope.aliases.values()) {
      parent = ta;
      break;
    }
    if (!parent) {
      return null;
    }
    const parentType = Context.resolveTypeName(this.ctx, parent.type);
    if (!parentType) {
      return null;
    }

    // Forward multi-link: count the linked set. Only `count` is meaningful
    // without a trailing scalar property. A multi-link is stored either as a
    // junction table or, when the FK lives on the target, as a backlink.
    const first = steps[0];
    if (steps.length === 1 && first.type === "property") {
      const link = parentType.links.get(first.name);
      if (!link?.multi || funcName !== "count") {
        return null;
      }
      if (link.junctionTable) {
        const srcCol = link.junctionSourceColumn ?? "source_id";
        const tgtCol = link.junctionTargetColumn ?? "target_id";
        const targetTd = Context.resolveTypeName(this.ctx, link.target);
        // Only the targets the select policy shows are counted.
        const readable = targetTd ? this.readableIdConditionSql(targetTd, `"${link.junctionTable}"."${tgtCol}"`) : "";
        const sql = `(SELECT COUNT(*) FROM ${this.junctionTableSql(link.junctionTable)} ` +
          `WHERE "${link.junctionTable}"."${srcCol}" = "${parent.alias}"."id"${readable})`;
        return { kind: "RawSQLExpression", sql };
      }
      if (link.backlink) {
        // FK on the target table; `backlink` names the forward link there.
        const targetTd = Context.resolveTypeName(this.ctx, link.target);
        const fkCol = targetTd?.links.get(link.backlink)?.columnName;
        if (!targetTd || !fkCol) {
          return null;
        }
        const rowAlias = `__bl_${first.name}`;
        const sql = `(SELECT COUNT(*) FROM ${this.readableTableSql(targetTd)} "${rowAlias}" ` +
          `WHERE "${rowAlias}"."${fkCol}" = "${parent.alias}"."id")`;
        return { kind: "RawSQLExpression", sql };
      }
      return null;
    }

    // Backlink, optionally with a trailing scalar property:
    //   .<creator[is Video]        → count rows of Video by FK
    //   .<creator[is Video].size   → aggregate Video.size over those rows
    if (first.type !== "backlink") {
      return null;
    }
    const intersection = backlinkIntersectionName(first.filter);
    if (!intersection) {
      return null;
    }
    const targetType = Context.resolveTypeName(this.ctx, intersection);
    if (!targetType) {
      return null;
    }
    const fwd = targetType.links.get(first.name);
    if (!fwd) {
      return null;
    }

    // Build the FROM + correlation for "target rows that link back to parent".
    // The target rows get their own alias: when the link points back at the
    // parent's own type, the bare table name would capture the parent's.
    const rowAlias = `__bl_${first.name}`;
    let fromSql: string;
    let correlation: string;
    if (fwd.columnName && !fwd.junctionTable) {
      fromSql = `${this.readableTableSql(targetType)} "${rowAlias}"`;
      correlation = `"${rowAlias}"."${fwd.columnName}" = "${parent.alias}"."id"`;
    } else if (fwd.junctionTable) {
      const srcCol = fwd.junctionSourceColumn ?? "source_id";
      const tgtCol = fwd.junctionTargetColumn ?? "target_id";
      fromSql = `${this.readableTableSql(targetType)} "${rowAlias}" ` +
        `JOIN ${this.junctionTableSql(fwd.junctionTable)} ON "${fwd.junctionTable}"."${srcCol}" = ` +
        `"${rowAlias}"."id"`;
      correlation = `"${fwd.junctionTable}"."${tgtCol}" = "${parent.alias}"."id"`;
    } else {
      return null;
    }

    // Determine the aggregated expression.
    let aggExpr: string;
    if (steps.length === 2) {
      const second = steps[1];
      if (second.type !== "property") {
        return null;
      }
      const prop = targetType.properties.get(second.name);
      if (!prop?.columnName) {
        return null;
      }
      const col = `"${rowAlias}"."${prop.columnName}"`;
      // `sum` of an empty set is 0 in EdgeQL; SQL SUM() yields NULL, so
      // coalesce. min/max/avg/count over an empty set stay NULL/0 as-is.
      aggExpr = funcName === "sum" ?
        `COALESCE(SUM(${col}), 0)` :
        `${sqlAgg}(${col})`;
    } else {
      // Bare backlink with no scalar property — only count(*) is valid.
      if (funcName !== "count") {
        return null;
      }
      aggExpr = "COUNT(*)";
    }

    return {
      kind: "RawSQLExpression",
      sql: `(SELECT ${aggExpr} FROM ${fromSql} WHERE ${correlation})`
    };
  }

  /**
   * Compile a set-aggregate (or `exists`) over a subquery — `count(X filter …)`
   * parses to one — by aggregating the subquery's rows:
   *
   *   count((select X filter …))    → (SELECT COUNT(*) FROM (…) AS __set)
   *   sum((select X.size filter …)) → (SELECT COALESCE(SUM(__set.value), 0)
   *                                      FROM (…) AS __set(value))
   *   std::exists((select X …))     → EXISTS (…)
   *   any(.best.tags.name = 'x')    → (SELECT COALESCE(BOOL_OR(__set.value), false)
   *                                      FROM (…) AS __set(value))
   *
   * `any` of no element is false and `all` of none true, as in Gel.
   *
   * Wrapping the subquery itself (`COUNT((SELECT …))`) makes it a scalar
   * subquery, which fails as soon as it yields more than one row. The subquery
   * stays a SQL AST node so parameter casts inside it are still found by
   * `buildParameterTypeMap`. Returns null for any other function.
   */
  private compileAggregateOverSubquery(
    funcName: string,
    subquery: EdgeQLAST.Subquery
  ): SQL.SQLExpression | null {
    if (funcName === "exists") {
      return { kind: "UnaryExpression", operator: "EXISTS", operand: this.compileSubqueryExpression(subquery) };
    }
    const aggregate = this.setAggregate(funcName);
    if (!aggregate) {
      return null;
    }

    return SQL.createSubqueryExpression(SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(aggregate)]),
      from: SQL.createFromClause([{
        kind: "TableReference",
        name: "",
        subquery: this.compileQuery(subquery.query),
        alias: "__set",
        columnAliases: funcName === "count" ? undefined : ["value"]
      }])
    }));
  }

  /**
   * An aggregate over one value — a property or single link of the current
   * object (`any(.visits > 1)`, `count(.best)`), a `for` variable's — or
   * none: the aggregate of that set of at most one element, SQL NULL being
   * the empty set, as a scalar subquery of its own:
   *
   *   select User { b := any(.visits > 1) }
   *   → (SELECT COALESCE(BOOL_OR(__set.value), false) FROM (SELECT user_1.visits > 1) AS __set(value)
   *      WHERE __set.value IS NOT NULL)
   *
   * `BOOL_OR(user_1.visits > 1)` in place would aggregate the enclosing
   * select's rows: one value for the whole table. Null for a function that is
   * not an aggregate.
   */
  private compileAggregateOverValue(funcName: string, arg: SQL.SQLExpression): SQL.SQLExpression | null {
    const aggregate = this.setAggregate(funcName);
    if (!aggregate) {
      return null;
    }
    const value = SQL.createColumnReference("value", "__set");
    return SQL.createSubqueryExpression(SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(aggregate)]),
      from: SQL.createFromClause([{
        kind: "TableReference",
        name: "",
        subquery: SQL.createSelectStatement({ select: SQL.createSelectClause([SQL.createSelectItem(arg)]) }),
        alias: "__set",
        columnAliases: ["value"]
      }]),
      where: SQL.createWhereClause(SQL.isNotNull(value))
    }));
  }

  /**
   * `assert_single(<set>)` over the set's rows (one column): its one element,
   * or none. More than one is Gel's CardinalityViolationError, raised at run
   * time by `disc_assert_single` (lib/stdlib-sql.ts, SQLSTATE 21000):
   *
   *   (SELECT disc_assert_single(__set.value, COUNT(*) OVER ()) FROM (<rows>) AS __set(value) LIMIT 1)
   */
  protected assertSingle(rows: SQL.SQLStatement): SQL.SQLExpression {
    const count = SQL.windowFunction("COUNT", [SQL.star()], { kind: "WindowClause" });
    return SQL.createSubqueryExpression(SQL.createSelectStatement({
      from: SQL.createFromClause([{ alias: "__set", columnAliases: ["value"], kind: "TableReference", name: "", subquery: rows }]),
      limit: { count: SQL.createLiteral("number", 1), kind: "LimitClause" },
      select: SQL.createSelectClause([
        SQL.createSelectItem(SQL.createFunctionCall("disc_assert_single", [SQL.createColumnReference("value", "__set"), count]))
      ])
    }));
  }

  /**
   * The SQL aggregate of EdgeQL aggregate `funcName` over the rows of `__set`
   * (`__set.value` each), or null for a function that is not one. An empty
   * set's aggregate is Gel's: 0 for `count` and `sum`, `[]` for `array_agg`,
   * false for `any`, true for `all` (SQL yields NULL for all but COUNT), and
   * the empty set (NULL) for the others.
   */
  private setAggregate(funcName: string): SQL.SQLExpression | null {
    const value = SQL.createColumnReference("value", "__set");
    const orEmpty = (name: string, empty: SQL.SQLExpression): SQL.SQLExpression =>
      SQL.createFunctionCall("COALESCE", [SQL.createFunctionCall(name, [value]), empty]);
    switch (funcName) {
      case "all":
        return orEmpty("BOOL_AND", SQL.createLiteral("boolean", true));
      case "any":
        return orEmpty("BOOL_OR", SQL.createLiteral("boolean", false));
      case "array_agg":
        return orEmpty("ARRAY_AGG", SQL.createLiteral("string", "{}"));
      case "count":
        return SQL.createFunctionCall("COUNT", [SQL.star()]);
      case "sum":
        return orEmpty("SUM", SQL.createLiteral("number", 0));
    }
    const sqlAgg = VALUE_AGGREGATES.get(funcName);
    return sqlAgg ? SQL.createFunctionCall(sqlAgg, [value]) : null;
  }

  private isMultiLinkPath(expr: EdgeQLAST.Expression): boolean {
    if (expr.kind !== "Path" || expr.steps.length !== 2 || this.endsInMultiProperty(expr)) {
      return false;
    }
    const [first] = expr.steps;
    // A backlink (`.<author[is Post]`) is a set of the rows linking here.
    if (first.type === "backlink") {
      return backlinkIntersectionName(first.filter) !== null;
    }
    if (first.type !== "property") {
      return false;
    }
    for (const ta of this.ctx.currentScope.aliases.values()) {
      const td = Context.resolveTypeName(this.ctx, ta.type);
      const link = td?.links.get(first.name);
      if (link?.multi) {
        return true;
      }
    }
    return false;
  }

  /**
   * True when `path` (`.link….prop`) ends in a multi property of the type its
   * links lead to: an array column, which the EXISTS rewrites of a link path
   * (compileMultiLinkComparison, compileMultiHopComparison) would compare with
   * one value as a whole. Its comparison compiles element-wise instead.
   */
  private endsInMultiProperty(path: EdgeQLAST.Path): boolean {
    const last = path.steps[path.steps.length - 1];
    for (const ta of this.ctx.currentScope.aliases.values()) {
      let type = Context.resolveTypeName(this.ctx, ta.type);
      for (const step of path.steps.slice(0, -1)) {
        const target = step.type === "backlink" ? backlinkIntersectionName(step.filter) : type?.links.get(step.name)?.target;
        type = target ? Context.resolveTypeName(this.ctx, target) : undefined;
      }
      if (type?.properties.get(last.name)?.multi) {
        return true;
      }
    }
    return false;
  }

  /**
   * Rewrite `.multi_link.field <op> rhs` into:
   *
   *   EXISTS (
   *     SELECT 1 FROM "<target_table>" "<sub_alias>"
   *     WHERE "<sub_alias>"."<fk_col>" = "<src_alias>"."id"
   *       AND "<sub_alias>"."<target_col>" <op> <rhs>
   *   )
   *
   * Currently handles backlink-style multi links (FK lives on the
   * target table). Junction-table multi links are a future-work case
   * that would emit a 3-table EXISTS. Returns `null` to fall through
   * to the default binary-op compilation if anything doesn't resolve.
   */
  private compileMultiLinkComparison(
    path: EdgeQLAST.Path,
    op: string,
    rhsExpr: EdgeQLAST.Expression
  ): SQL.SQLExpression | null {
    const [firstStep, secondStep] = path.steps;
    if (firstStep.type === "backlink" && secondStep.type === "property") {
      return this.compileBacklinkComparison(firstStep, secondStep.name, op, rhsExpr);
    }
    if (firstStep.type !== "property" || secondStep.type !== "property") {
      return null;
    }

    for (const ta of this.ctx.currentScope.aliases.values()) {
      const td = Context.resolveTypeName(this.ctx, ta.type);
      const link = td?.links.get(firstStep.name);
      if (!link?.multi) {
        continue;
      }

      const targetType = Context.resolveTypeName(this.ctx, link.target);
      if (!targetType) {
        return null;
      }

      // Junction-table multi link (many-to-many): EXISTS over the
      // junction with an INNER JOIN to the target. When the terminal
      // step is `id`, the junction's target column already holds the
      // target id, so the JOIN can be elided.
      if (link.junctionTable) {
        const sourceCol = link.junctionSourceColumn ?? "source_id";
        const targetCol = link.junctionTargetColumn ?? "target_id";
        const jAlias = `__j_${firstStep.name}`;

        if (secondStep.name === "id") {
          const sql = `EXISTS (SELECT 1 FROM ${this.junctionTableSql(link.junctionTable, jAlias)} ` +
            `WHERE "${jAlias}"."${sourceCol}" = "${ta.alias}"."id"${this.readableIdConditionSql(targetType, `"${jAlias}"."${targetCol}"`)} ` +
            `AND ${this.renderInnerPredicate(`"${jAlias}"."${targetCol}"`, op, rhsExpr)})`;
          return { kind: "RawSQLExpression", sql };
        }

        const tAlias = `__t_${firstStep.name}`;
        const prop = targetType.properties.get(secondStep.name);
        if (!prop?.columnName) {
          return null;
        }

        const sql = `EXISTS (SELECT 1 FROM ${this.junctionTableSql(link.junctionTable, jAlias)} ` +
          `INNER JOIN ${this.readableTableSql(targetType)} "${tAlias}" ` +
          `ON "${tAlias}"."id" = "${jAlias}"."${targetCol}" ` +
          `WHERE "${jAlias}"."${sourceCol}" = "${ta.alias}"."id" ` +
          `AND ${this.renderInnerPredicate(`"${tAlias}"."${prop.columnName}"`, op, rhsExpr)})`;
        return { kind: "RawSQLExpression", sql };
      }

      // Backlink-style multi link (one-to-many): EXISTS on the target
      // table where its FK back to the source matches.
      let fkColumn: string | undefined;
      if (link.backlink) {
        const backLink = targetType.links.get(link.backlink);
        fkColumn = backLink?.columnName;
      }
      if (!fkColumn) {
        return null;
      }

      let targetColName: string;
      if (secondStep.name === "id") {
        targetColName = "id";
      } else {
        const prop = targetType.properties.get(secondStep.name);
        if (!prop?.columnName) {
          return null;
        }
        targetColName = prop.columnName;
      }

      const subAlias = `__sub_${firstStep.name}`;
      const sql = `EXISTS (SELECT 1 FROM ${this.readableTableSql(targetType)} "${subAlias}" ` +
        `WHERE "${subAlias}"."${fkColumn}" = "${ta.alias}"."id" ` +
        `AND ${this.renderInnerPredicate(`"${subAlias}"."${targetColName}"`, op, rhsExpr)})`;
      return { kind: "RawSQLExpression", sql };
    }
    return null;
  }

  /**
   * `.<link[is T].field <op> rhs`: EXISTS over the `T` rows whose `link`
   * points at the current row — through `T`'s FK column, or its junction
   * table when `link` is multi. Null when the backlink doesn't resolve.
   */
  private compileBacklinkComparison(
    step: EdgeQLAST.PathStep,
    field: string,
    op: string,
    rhsExpr: EdgeQLAST.Expression
  ): SQL.SQLExpression | null {
    const intersection = backlinkIntersectionName(step.filter);
    const sourceType = intersection ? Context.resolveTypeName(this.ctx, intersection) : undefined;
    const forward = sourceType?.links.get(step.name);
    const current = this.ctx.currentScope.aliases.values().next().value;
    if (!sourceType || !forward || !current) {
      return null;
    }
    const column = field === "id" ? "id" : sourceType.properties.get(field)?.columnName;
    if (!column) {
      return null;
    }

    const rowAlias = `__bl_${step.name}`;
    const predicate = this.renderInnerPredicate(`"${rowAlias}"."${column}"`, op, rhsExpr);
    if (forward.junctionTable) {
      const jAlias = `__blj_${step.name}`;
      const srcCol = forward.junctionSourceColumn ?? "source_id";
      const tgtCol = forward.junctionTargetColumn ?? "target_id";
      const sql = `EXISTS (SELECT 1 FROM ${this.junctionTableSql(forward.junctionTable, jAlias)} ` +
        `INNER JOIN ${this.readableTableSql(sourceType)} "${rowAlias}" ON "${rowAlias}"."id" = "${jAlias}"."${srcCol}" ` +
        `WHERE "${jAlias}"."${tgtCol}" = "${current.alias}"."id" AND ${predicate})`;
      return { kind: "RawSQLExpression", sql };
    }
    if (!forward.columnName) {
      return null;
    }
    const sql = `EXISTS (SELECT 1 FROM ${this.readableTableSql(sourceType)} "${rowAlias}" ` +
      `WHERE "${rowAlias}"."${forward.columnName}" = "${current.alias}"."id" AND ${predicate})`;
    return { kind: "RawSQLExpression", sql };
  }

  /**
   * True iff `expr` is a Path of 3+ steps whose first step resolves to a
   * multi-cardinality link on any active alias's type — the `.multi....field`
   * shape produced by a nested filter object two or more levels deep. The
   * first hop being multi is what distinguishes this from a pure single-link
   * chain (handled by `compileLinkChain`); `buildHopChainExists` walks the
   * rest, descending through both further multi links and single-FK hops to
   * any depth.
   */
  private isMultiHopLinkPath(expr: EdgeQLAST.Expression): boolean {
    if (expr.kind !== "Path" || expr.steps.length < 3) {
      return false;
    }
    if (!expr.steps.every(s => s.type === "property") || this.endsInMultiProperty(expr)) {
      return false;
    }
    const first = expr.steps[0];
    for (const ta of this.ctx.currentScope.aliases.values()) {
      const td = Context.resolveTypeName(this.ctx, ta.type);
      const link = td?.links.get(first.name);
      if (link?.multi) {
        return true;
      }
    }
    return false;
  }

  /**
   * Rewrite `.linkA.linkB.field <op> rhs` (two multi-link hops) into nested
   * EXISTS:
   *
   *   EXISTS (SELECT 1 FROM <A_rows> WHERE <correlate A to outer>
   *     AND EXISTS (SELECT 1 FROM <B_rows> WHERE <correlate B to A>
   *       AND "<B>"."<col>" <op> <rhs>))
   *
   * Each hop may be a junction-table multi link or a backlink-style multi
   * link; `buildHopChainExists` handles both. Returns `null` (fall through to
   * the generic path compilation, which then errors) when any link in the
   * chain isn't a resolvable multi link — e.g. a single-cardinality hop, which
   * `compileLinkChain` already covers.
   */
  private compileMultiHopComparison(
    path: EdgeQLAST.Path,
    op: string,
    rhsExpr: EdgeQLAST.Expression
  ): SQL.SQLExpression | null {
    const names = path.steps.map(s => (s as { name: string; }).name);
    for (const ta of this.ctx.currentScope.aliases.values()) {
      const startType = Context.resolveTypeName(this.ctx, ta.type);
      if (!startType?.links.get(names[0])) {
        continue;
      }
      const sql = this.buildHopChainExists(
        `"${ta.alias}"`,
        startType,
        names,
        op,
        rhsExpr,
        0
      );
      if (sql) {
        return { kind: "RawSQLExpression", sql };
      }
    }
    return null;
  }

  /**
   * Recursively build the nested-EXISTS body for a link chain whose first hop
   * is multi-cardinality.
   *
   * `names` is `[linkName, …intermediate links…, terminalProp]`. The head is
   * the link to descend; `parentRef` is the already-quoted alias of the row
   * this hop correlates against (e.g. `"u"` or `"__h0_channels"`), so the
   * correlation can read either `.id` (multi backlink / junction) or the FK
   * column (single forward link) off it. When only `[linkName, terminalProp]`
   * remains, the recursion bottoms out into a scalar predicate on the target
   * column (via `renderInnerPredicate`, so `id`-shortcut and `array_unpack`
   * membership are handled uniformly).
   *
   * Each hop may be a junction-table multi link, a backlink-style multi link,
   * or a single forward-FK link — mixing freely along the chain. Returns
   * `null` if a hop can't be resolved as one of those, so the caller can fall
   * through to the generic path compiler.
   */
  private buildHopChainExists(
    parentRef: string,
    parentType: { links: Map<string, unknown>; },
    names: string[],
    op: string,
    rhsExpr: EdgeQLAST.Expression,
    depth: number
  ): string | null {
    const linkName = names[0];
    const link = (parentType.links as Map<string, {
      target: string;
      multi?: boolean;
      backlink?: string;
      columnName?: string;
      junctionTable?: string;
      junctionSourceColumn?: string;
      junctionTargetColumn?: string;
    }>)
      .get(linkName);
    if (!link) {
      return null;
    }
    const targetType = Context.resolveTypeName(this.ctx, link.target);
    if (!targetType) {
      return null;
    }

    const tAlias = `__h${depth}_${linkName}`;
    let fromSql: string;
    let correlation: string;

    if (link.junctionTable) {
      // Junction-table multi link: correlate the junction's source side to the
      // parent row's id, joining the target so its columns are addressable.
      const srcCol = link.junctionSourceColumn ?? "source_id";
      const tgtCol = link.junctionTargetColumn ?? "target_id";
      const jAlias = `__hj${depth}_${linkName}`;
      fromSql = `${this.readableTableSql(targetType)} "${tAlias}" ` +
        `INNER JOIN ${this.junctionTableSql(link.junctionTable, jAlias)} ` +
        `ON "${jAlias}"."${tgtCol}" = "${tAlias}"."id"`;
      correlation = `"${jAlias}"."${srcCol}" = ${parentRef}."id"`;
    } else if (link.multi && link.backlink) {
      // Backlink-style multi link: the FK lives on the target, pointing back
      // at the parent row's id.
      const fkCol = (targetType.links.get(link.backlink) as
        | { columnName?: string; }
        | undefined)
        ?.columnName;
      if (!fkCol) {
        return null;
      }
      fromSql = `${this.readableTableSql(targetType)} "${tAlias}"`;
      correlation = `"${tAlias}"."${fkCol}" = ${parentRef}."id"`;
    } else if (!link.multi && link.columnName) {
      // Single forward link: the FK lives on the parent row; the target is the
      // row whose id it points at.
      fromSql = `${this.readableTableSql(targetType)} "${tAlias}"`;
      correlation = `"${tAlias}"."id" = ${parentRef}."${link.columnName}"`;
    } else {
      return null;
    }

    const rest = names.slice(1);
    let inner: string;
    if (rest.length === 1) {
      // Terminal scalar predicate on the target column.
      const terminal = rest[0];
      let colName: string;
      if (terminal === "id") {
        colName = "id";
      } else {
        const prop = targetType.properties.get(terminal);
        if (!prop?.columnName) {
          return null;
        }
        colName = prop.columnName;
      }
      inner = this.renderInnerPredicate(
        `"${tAlias}"."${colName}"`,
        op,
        rhsExpr
      );
    } else {
      // Descend one more hop, correlating it to this hop's target row.
      const nested = this.buildHopChainExists(
        `"${tAlias}"`,
        targetType,
        rest,
        op,
        rhsExpr,
        depth + 1
      );
      if (!nested) {
        return null;
      }
      inner = nested;
    }

    return `EXISTS (SELECT 1 FROM ${fromSql} WHERE ${correlation} AND ${inner})`;
  }

  /*** `.link@prop` — a link step followed by a link-property step. ***/
  private isLinkPropertyPath(expr: EdgeQLAST.Expression): expr is EdgeQLAST.Path {
    return expr.kind === "Path" && expr.steps.length === 2 && expr.steps[0].type === "property" &&
      expr.steps[1].type === "link_property";
  }

  /**
   * A comparison with a link-property path `.link@prop` on one side. The
   * path is a set — one value per link — so, as for a multi link's target
   * properties, the comparison holds when any link matches:
   *
   *   .members@role <op> x      → EXISTS (SELECT 1 FROM <junction> j
   *                                 WHERE j.source_id = <src>.id AND j.role <op> x)
   *   x in .members@role        → EXISTS (… AND j.role = x)   (`not in` → NOT EXISTS)
   *   x = / != .members@role    → EXISTS (… AND j.role = / != x)
   *
   * Returns null when neither side is a link-property path, or when the link
   * isn't on any type in scope (the generic path compiler then reports it).
   */
  private compileLinkPropertyComparison(binOp: EdgeQLAST.BinaryOp): SQL.SQLExpression | null {
    const reversed = !this.isLinkPropertyPath(binOp.left) && this.isLinkPropertyPath(binOp.right);
    const path = reversed ? binOp.right : binOp.left;
    if (!this.isLinkPropertyPath(path) || !this.isComparisonOp(binOp.op)) {
      return null;
    }
    const [linkStep, propStep] = path.steps;

    for (const ta of this.ctx.currentScope.aliases.values()) {
      const link = Context.resolveTypeName(this.ctx, ta.type)?.links.get(linkStep.name);
      if (!link) {
        continue;
      }
      if (!link.junctionTable) {
        throw new CompilationError(
          `Link property path '.${linkStep.name}@${propStep.name}': link properties are only stored on multi links`
        );
      }
      const column = Context.getLinkProperty(link, propStep.name).columnName;
      const jAlias = `__lp_${linkStep.name}`;
      const columnSql = `"${jAlias}"."${column}"`;

      let predicate: string;
      let negate = false;
      if (!reversed) {
        predicate = this.renderInnerPredicate(columnSql, binOp.op, binOp.right);
      } else if (binOp.op === "IN" || binOp.op === "NOT IN" || binOp.op === "=" || binOp.op === "!=") {
        negate = binOp.op === "NOT IN";
        predicate = this.renderInnerPredicate(columnSql, binOp.op === "!=" ? "!=" : "=", binOp.left);
      } else {
        throw new CompilationError(
          `Link property path '.${linkStep.name}@${propStep.name}' on the right of '${binOp.op}' is not supported — put it on the left`
        );
      }

      const sourceCol = link.junctionSourceColumn ?? "source_id";
      const targetCol = link.junctionTargetColumn ?? "target_id";
      const target = Context.resolveTypeName(this.ctx, link.target);
      const readable = target ? this.readableIdConditionSql(target, `"${jAlias}"."${targetCol}"`) : "";
      const sql = `${negate ? "NOT " : ""}EXISTS (SELECT 1 FROM ${this.junctionTableSql(link.junctionTable, jAlias)} ` +
        `WHERE "${jAlias}"."${sourceCol}" = "${ta.alias}"."id"${readable} AND ${predicate})`;
      return { kind: "RawSQLExpression", sql };
    }
    return null;
  }

  /**
   * Render the inner `<column> <op> <rhs>` predicate spliced into a multi-link
   * EXISTS body. `<column>` is already-quoted SQL for the target column.
   *
   * `IN array_unpack(<array<T>>$p)` must lower to `<col> = ANY(arr)` (and
   * `NOT IN` to `<> ALL(arr)`) — same reason as the top-level array-membership
   * lowering: `<col> IN UNNEST(...)` is invalid Postgres. Everything else
   * (scalar `=`, `<`, set-literal `IN {a, b}`, …) splices `<op> <rhs>` directly.
   */
  private renderInnerPredicate(
    columnSql: string,
    op: string,
    rhsExpr: EdgeQLAST.Expression
  ): string {
    if (op === "IN" || op === "NOT IN") {
      const r = rhsExpr;
      if (
        r.kind === "FunctionCall" &&
        r.name.parts.join("_") === "array_unpack" &&
        r.args.length === 1
      ) {
        const arr = this.renderSqlExpr(
          this.compileExpression(r.args[0].value)
        );
        return op === "NOT IN" ?
          `${columnSql} <> ALL(${arr})` :
          `${columnSql} = ANY(${arr})`;
      }
      const set = this.membershipSubquery(r);
      if (set) {
        return `${columnSql} ${op} ${this.renderSqlExpr(set)}`;
      }
    }
    const rhsSql = this.renderSqlExpr(this.compileExpression(rhsExpr));
    return `${columnSql} ${op} ${rhsSql}`;
  }

  private compileSetExpr(setExpr: EdgeQLAST.SetExpr): SQL.SQLExpression {
    // Compile set expression {val1, val2, ...} into a SQL tuple (val1, val2, ...)
    // This is used in expressions like FILTER .role IN {"admin", "moderator"}
    // The empty set `{}` is the EdgeQL "no value" sentinel; in scalar/assignment
    // context (e.g. `update T set { col := {} }`) it must become SQL NULL, not
    // `()` — bare `()` is invalid Postgres syntax.
    const flat = flattenSetElements(setExpr);
    if (flat.length === 0)
      return { kind: "RawSQLExpression" as const, sql: "NULL" };

    // Anywhere but as the right operand of `in` the tuple would be a record.
    if (flat.length > 1 && !this.membershipSets.has(setExpr)) {
      throw new CompilationError(
        "A set of several elements is not supported here: select it (`select {…}`), use it as a shape element, a for " +
          "iterator, the right operand of `in`, or an operand of an operator or function where those are selected or filtered",
        locationOf(setExpr)
      );
    }

    const elements = flat.map(elem => this.compileExpression(elem));

    // Build a raw SQL expression for the tuple representation
    const parts = elements.map(elem => {
      if (elem.kind === "LiteralExpression") {
        if (elem.type === "string") {
          return "'" + String(elem.value).replace(/'/g, "''") + "'";
        }
        if (elem.type === "number") {
          return String(elem.value);
        }
        if (elem.type === "boolean") {
          return elem.value ? "TRUE" : "FALSE";
        }
        if (elem.type === "null") {
          return "NULL";
        }
      }
      // Parameters, casts, paths and other expressions render as themselves
      // (`<uuid>$a` → `CAST($1 AS uuid)`).
      return this.renderSqlExpr(elem);
    });

    return {
      kind: "RawSQLExpression" as const,
      sql: "(" + parts.join(", ") + ")"
    };
  }

  private compileSubqueryExpression(
    subquery: EdgeQLAST.Subquery
  ): SQL.SQLExpression {
    const compiled = this.compileQuery(subquery.query);

    // compileQuery returns a SQLStatement which could be any statement type.
    // For SubqueryExpression we need a SelectStatement. If it's already one,
    // use it directly. Otherwise wrap in a simple SELECT that references it.
    if (compiled.kind === "SelectStatement") {
      return SQL.createSubqueryExpression(compiled);
    }

    // For CTEStatement, UnionAllStatement, etc. — wrap inside a derived select
    // by placing the statement as a subquery in FROM and selecting *.
    const wrapper: SQL.SelectStatement = SQL.createSelectStatement({
      select: SQL.createSelectClause([
        SQL.createSelectItem(SQL.createColumnReference("*"))
      ]),
      from: SQL.createFromClause([{
        kind: "TableReference",
        name: "",
        subquery: compiled,
        alias: "subq"
      }])
    });

    return SQL.createSubqueryExpression(wrapper);
  }

  private compileIfElse(ifElse: EdgeQLAST.IfElse): SQL.CaseExpression {
    const condition = this.compileExpression(ifElse.condition);
    const [thenExpr, elseExpr] = this.asUnitedAlternatives(
      [ifElse.then, ifElse.else],
      [this.compileExpression(ifElse.then), this.compileExpression(ifElse.else)]
    );

    // An empty condition makes the result empty (Gel), not the else branch.
    if (this.mayBeEmpty(ifElse.condition)) {
      return SQL.createCaseExpression([
        SQL.createWhenClause(condition, thenExpr),
        SQL.createWhenClause({ kind: "UnaryExpression", operand: condition, operator: "NOT" }, elseExpr)
      ]);
    }
    return SQL.createCaseExpression(
      [SQL.createWhenClause(condition, thenExpr)],
      elseExpr
    );
  }

  /**
   * Compile a multi-branch CASE expression (P1-05). Maps 1:1 to SQL CASE.
   */
  private compileCaseExpression(
    caseExpr: EdgeQLAST.CaseExpression
  ): SQL.CaseExpression {
    const whens = caseExpr.whenClauses.map(clause =>
      SQL.createWhenClause(
        this.compileExpression(clause.condition),
        this.compileExpression(clause.result)
      )
    );
    const elseExpr = caseExpr.elseResult ?
      this.compileExpression(caseExpr.elseResult) :
      undefined;
    return SQL.createCaseExpression(whens, elseExpr);
  }

  private compileArrayExpr(arrayExpr: EdgeQLAST.ArrayExpr): SQL.SQLExpression {
    // P1-07: validate that all literal elements share the same JS type.
    // `[1, 'two']` used to compile to `ARRAY[1, 'two']` which PostgreSQL
    // then rejected at runtime with a cryptic coercion error. Catching the
    // homogeneity violation at compile time points the user at the right
    // source line.
    const literalKinds = new Set<string>();
    for (const el of arrayExpr.elements) {
      if (el.kind === "Literal") {
        literalKinds.add(typeof (el as { value: unknown; }).value);
      }
    }
    if (literalKinds.size > 1) {
      throw new CompilationError(
        `Array literal has mixed element types: ${[...literalKinds].sort().join(", ")}. Arrays must be homogeneous.`
      );
    }
    // An array of tuples is a jsonb array, as its parameter form and its
    // column are, so all three mix (`++`, `=`, `len`, `[0]`, …); its tuples
    // are of their united type (`[(a := 1), (2,)]` is `[(1,), (2,)]`). So is
    // an array of arrays (`staticNestedArrayType`), each array a jsonb one.
    const united = this.unitedStaticTupleType(arrayExpr.elements);
    const elements = arrayExpr.elements.map(el =>
      united ? this.asTupleType(this.compileExpression(el), this.staticTupleType(el)!, united) : this.compileExpression(el)
    );
    const jsonb = this.staticTupleArrayType(arrayExpr) || this.staticNestedArrayType(arrayExpr);
    return SQL.createFunctionCall(jsonb ? "jsonb_build_array" : "ARRAY", elements);
  }

  /**
   * `json_get(json, variadic path: str, named only default: optional json)`:
   * the element of `json` at `path`, each step an object key or an array
   * index (negative from the end) — PostgreSQL's `jsonb_extract_path`, which
   * reads the steps the same way — or `default` when there is none there
   * (without one, the empty set). An empty `json` or path step is the empty
   * set, whatever the default. No path is `json` itself.
   */
  private compileJsonGet(funcCall: EdgeQLAST.FunctionCall, args: SQL.SQLExpression[]): SQL.SQLExpression {
    const unknown = funcCall.args.find(arg => arg.name !== undefined && arg.name !== "default");
    const positional = args.filter((_, i) => funcCall.args[i].name === undefined);
    if (unknown || positional.length === 0) {
      throw new CompilationError(
        `json_get() takes a json value, then its path, and a 'default' named argument${unknown ? `, not '${unknown.name}'` : ""}`,
        this.expressionLocation(funcCall)
      );
    }
    const [json, ...steps] = positional;
    if (steps.length === 0) {
      return json;
    }
    const path = steps.map(step => SQL.createCastExpression(step, "text"));
    const found = SQL.createFunctionCall("jsonb_extract_path", [json, ...path]);
    const fallback = args[funcCall.args.findIndex(arg => arg.name === "default")];
    if (!fallback) {
      return found;
    }
    const anyEmpty = [json, ...path]
      .map(value => SQL.createBinaryExpression("IS", value, SQL.createLiteral("null", null)))
      .reduce((all, test) => SQL.createBinaryExpression("OR", all, test));
    return SQL.createCaseExpression(
      [SQL.createWhenClause(anyEmpty, SQL.createLiteral("null", null))],
      SQL.createFunctionCall("COALESCE", [found, fallback])
    );
  }

  private compileTupleExpr(tupleExpr: EdgeQLAST.TupleExpr): SQL.SQLExpression {
    const elements = tupleExpr.elements.map(el => this.tupleElement(el));
    return SQL.createFunctionCall("jsonb_build_array", elements);
  }

  /*** A tuple element as its tuple's jsonb holds it: a zero date duration `P0D` (`dateDurationText`), bytes base64 (`bytesAsBase64`). ***/
  private tupleElement(expr: EdgeQLAST.Expression): SQL.SQLExpression {
    const type = this.staticScalarType(expr);
    return this.bytesAsBase64(this.dateDurationText(this.compileExpression(expr), type), isStdType(type, "bytes") ? "bytea" : null);
  }

  private compileTupleAccess(
    access: EdgeQLAST.TupleAccessExpr
  ): SQL.SQLExpression {
    const element = this.literalTupleElement(access);
    if (element) {
      return this.compileExpression(element);
    }
    const tupleExpr = this.compileExpression(access.tuple);
    const known = this.tupleAccessElement(access);
    if (known) {
      return this.tupleElementValue(tupleExpr, known.element, known.index);
    }

    if (access.accessType === "index" && access.index !== undefined) {
      // Numeric index access: tuple_expr -> N
      return SQL.createJsonbAccess(
        tupleExpr,
        "->",
        SQL.createLiteral("number", access.index)
      );
    } else if (access.accessType === "name" && access.fieldName) {
      // Named field access: tuple_expr ->> 'name'
      return SQL.createJsonbAccess(
        tupleExpr,
        "->>",
        SQL.createLiteral("string", access.fieldName)
      );
    }

    throw new CompilationError("Invalid tuple access expression");
  }

  /*** The element, and its position, `access` reads of a tuple whose type is known (`staticTupleType`); null otherwise. ***/
  private tupleAccessElement(access: EdgeQLAST.TupleAccessExpr): { element: { name?: string; type: string; }; index: number; } | null {
    const typeName = this.staticTupleType(access.tuple);
    const elements = typeName ? tupleTypeElements(typeName) ?? [] : [];
    const index = access.accessType === "index" ? access.index ?? -1 : elements.findIndex(element => element.name === access.fieldName);
    return index >= 0 && index < elements.length ? { element: elements[index], index } : null;
  }

  /**
   * Element `index` of the jsonb tuple `sql` as a value of its own type, as
   * Gel answers it: a tuple, an array or a json element as its jsonb, `str`
   * (or an enum) as text, `bytes` from the base64 the tuple holds, any other
   * scalar cast to its type (`(a := 1).a` → `CAST(t ->> 'a' AS bigint)`).
   */
  private tupleElementValue(sql: SQL.SQLExpression, element: { name?: string; type: string; }, index: number): SQL.SQLExpression {
    const key = tupleElementKey(element, index);
    const pgType = edgeqlTypeToPgType(element.type, this.ctx.schema.scalars);
    if (tupleTypeElements(element.type) || element.type.startsWith("array<") || pgType === "jsonb") {
      return SQL.createJsonbAccess(sql, "->", key);
    }
    const text = SQL.createJsonbAccess(sql, "->>", key);
    if (pgType === "bytea") {
      return SQL.createFunctionCall("decode", [text, SQL.createLiteral("string", "base64")]);
    }
    return pgType === "text" || pgType === element.type ? text : SQL.createCastExpression(text, pgType);
  }

  /**
   * The element an access names of a tuple literal cast to a tuple type
   * (`(<tuple<a: int64, b: str>>(1, 'x')).a` is `<int64>1`): the element's
   * own expression, cast to its type, where reading it back out of the
   * tuple's jsonb would give text. Undefined for any other access.
   */
  private literalTupleElement(access: EdgeQLAST.TupleAccessExpr): EdgeQLAST.Expression | undefined {
    const cast = access.tuple.kind === "TypeCast" ? access.tuple : undefined;
    const tuple = cast?.expr;
    const values = tuple?.kind === "TupleExpr" ?
      tuple.elements :
      tuple?.kind === "NamedTuple" ?
      tuple.elements.map(element => element.value) :
      undefined;
    const targets = cast?.type.subtypes;
    if (!values || !targets || targets.length !== values.length) {
      return undefined;
    }
    const i = access.accessType === "index" ? access.index ?? -1 : targets.map(target => target.fieldName).indexOf(access.fieldName);
    if (i < 0 || i >= values.length) {
      return undefined;
    }
    return { expr: values[i], kind: "TypeCast", span: values[i].span, type: { ...targets[i], fieldName: undefined } };
  }

  private compileNamedTuple(
    namedTuple: EdgeQLAST.NamedTuple
  ): SQL.SQLExpression {
    const fields = namedTuple.elements.map(el => SQL.createJsonField(el.name, this.tupleElement(el.value)));
    return SQL.createJsonBuildObject(fields);
  }

  private compileDetached(detached: EdgeQLAST.Detached): SQL.SQLExpression {
    // DETACHED strips scope context — compile inner expression without
    // scope resolution (the expression runs in a fresh scope context). A
    // subject bound outside is the whole set again: `count(detached Item)`
    // in `select Item { … }` counts every Item.
    Context.pushScope(this.ctx);
    try {
      return this.withDetached(() => this.compileExpression(detached.expr));
    } finally {
      Context.popScope(this.ctx);
    }
  }

  /*** Run `compile` with the subjects bound so far hidden (see `scopeVariable`). ***/
  protected withDetached<T>(compile: () => T): T {
    const outer = this.detachedFrom;
    this.detachedFrom = this.ctx.scopes.length + 1;
    try {
      return compile();
    } finally {
      this.detachedFrom = outer;
    }
  }

  /**
   * Compile DESCRIBE TYPE <typeName> into a SELECT statement returning the
   * type description as a JSON literal. The introspection is resolved at
   * compile time from the in-memory schema, then embedded as a SQL string
   * literal so the result passes through PG normally.
   */
  protected compileDescribeType(
    query: EdgeQLAST.DescribeTypeQuery
  ): SQL.SelectStatement {
    const description = describeType(this.ctx.schema, query.typeName);
    const json = JSON.stringify(description);

    // SELECT '<json>'::jsonb
    const rawExpr: SQL.RawSQLExpression = {
      kind: "RawSQLExpression",
      sql: `'${json.replace(/'/g, "''")}'::jsonb`
    };

    return SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(rawExpr)])
    });
  }

  /**
   * Compile DESCRIBE SCHEMA into a SELECT statement returning the full schema
   * description as a JSON literal.
   */
  protected compileDescribeSchema(): SQL.SelectStatement {
    const description = describeSchema(this.ctx.schema);
    const json = JSON.stringify(description);

    // SELECT '<json>'::jsonb
    const rawExpr: SQL.RawSQLExpression = {
      kind: "RawSQLExpression",
      sql: `'${json.replace(/'/g, "''")}'::jsonb`
    };

    return SQL.createSelectStatement({
      select: SQL.createSelectClause([SQL.createSelectItem(rawExpr)])
    });
  }

  private compileIntrospection(
    introspection: EdgeQLAST.Introspection
  ): SQL.SQLExpression {
    const typeName = introspection.type.name.parts.join("::");
    throw new CompilationError(
      `Introspection queries (INTROSPECT ${typeName}) are not yet supported. ` +
        `Schema metadata queries require the schema reflection catalog.`
    );
  }

  private compileIndexExpression(
    indexExpr: EdgeQLAST.IndexExpression
  ): SQL.SQLExpression {
    const base = this.compileExpression(indexExpr.expr);
    const idx = this.compileExpression(indexExpr.index);

    // A string key, or a JSON base (a json cast, or a name/subscript/call
    // known to be json): an array's element, a string's character or an
    // object's value, else Gel's errors (lib/stdlib-sql.ts).
    if (
      (indexExpr.index.kind === "Literal" && indexExpr.index.type === "string") ||
      (indexExpr.expr.kind === "TypeCast" &&
        indexExpr.expr.type.name.parts.some((p: string) => p === "json" || p === "jsonb")) ||
      this.isJsonExpression(indexExpr.expr)
    ) {
      return SQL.createFunctionCall("disc_json_index", [base, idx]);
    }

    // An array (an array of tuples is a jsonb array, see `compileArrayExpr`),
    // a `str` or `bytes`: Gel's 0-based index, a negative one counting from
    // the end, else Gel's out of bounds error (lib/stdlib-sql.ts).
    return this.nestedArrayElement(SQL.createFunctionCall("disc_index", [base, idx]), indexExpr.expr);
  }

  /**
   * `element`, a jsonb element of the array of arrays `array`
   * (`staticNestedArrayType`, a jsonb array), as the PostgreSQL array such an
   * array is elsewhere; kept jsonb when it is an array of tuples or of arrays
   * itself. `element` as it is when `array` is no array of arrays.
   */
  private nestedArrayElement(element: SQL.SQLExpression, array: EdgeQLAST.Expression): SQL.SQLExpression {
    const type = /^array<(.+)>$/.exec(this.staticNestedArrayType(array) ?? "")?.[1];
    const pgType = type ? edgeqlTypeToPgType(type, this.ctx.schema.scalars) : "jsonb";
    return type && pgType !== "jsonb" ? this.compileCastFromJson(element, pgType, type) : element;
  }

  private compileSliceExpression(
    sliceExpr: EdgeQLAST.SliceExpression
  ): SQL.SQLExpression {
    const base = this.compileExpression(sliceExpr.expr);

    if (this.staticTupleArrayType(sliceExpr.expr) || this.staticNestedArrayType(sliceExpr.expr)) {
      return this.tupleArraySlice(base, sliceExpr);
    }

    if (!sliceExpr.start && !sliceExpr.end) {
      // [:] — identity
      return base;
    }

    // An array, a `str` or `bytes`, sliced with Gel's bounds (lib/stdlib-sql.ts):
    // [a:b] → disc_slice(expr, a, b), [a:] → disc_slice(expr, a), [:b] → disc_slice(expr, 0, b).
    const start = sliceExpr.start ? this.compileExpression(sliceExpr.start) : SQL.createLiteral("number", 0);
    const end = sliceExpr.end ? [this.compileExpression(sliceExpr.end)] : [];
    return SQL.createFunctionCall("disc_slice", [base, start, ...end]);
  }

  /**
   * `[start:end]` of the jsonb array of tuples `base`, as Gel slices: the
   * tuples from index `start` up to (not including) `end`, a negative bound
   * counting from the end, bounds past either end clamped. An empty set
   * (NULL) stays NULL; `base` stays a SQL AST node, in the NULL test, so a
   * parameter in it is still found by `buildParameterTypeMap`.
   *
   *   ts[1:] → (SELECT COALESCE(jsonb_agg(e.v ORDER BY e.ord), '[]') FROM jsonb_array_elements(ts)
   *              WITH ORDINALITY AS e(v, ord) WHERE e.ord > 1 AND e.ord <= jsonb_array_length(ts))
   */
  private tupleArraySlice(base: SQL.SQLExpression, sliceExpr: EdgeQLAST.SliceExpression): SQL.SQLExpression {
    const array = this.renderSqlExpr(base);
    const length = `jsonb_array_length(${array})`;
    // A bound as an index from the start.
    const index = (bound: EdgeQLAST.Expression): string => {
      const value = this.renderSqlExpr(this.compileExpression(bound));
      return `(CASE WHEN ${value} < 0 THEN ${length} + ${value} ELSE ${value} END)`;
    };
    // `ord` counts from 1: element `i` is kept when start <= i < end.
    const start = sliceExpr.start ? index(sliceExpr.start) : "0";
    const end = sliceExpr.end ? index(sliceExpr.end) : length;
    return unlessNullTuple(base, {
      kind: "RawSQLExpression",
      sql: `(SELECT COALESCE(jsonb_agg(e.v ORDER BY e.ord), '[]'::jsonb) FROM jsonb_array_elements(${array}) ` +
        `WITH ORDINALITY AS e(v, ord) WHERE e.ord > ${start} AND e.ord <= ${end})`
    });
  }
}

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The values a schema computed's expression yields, as Gel infers them for
 * the computed property: their type, whether there may be several (multi)
 * and whether there is always one (required). Gel 7.1 is the reference:
 *
 *   n_posts := count(.<author[is Post])           → required int64
 *   full := .first ++ ' ' ++ .last  (optional)    → optional str
 *   is_old := .age > 60             (optional)    → optional bool
 *   tags_up := array_agg(str_upper(.tags))        → required array<str>
 *   up := str_upper(.tags)          (multi)       → multi str
 *
 * An aggregate (`count`, `sum`, `array_agg`, `exists`, …) is one value; an
 * element-wise operator or function is one value per combination of its
 * operands' (multi when one is, required when all are); a set literal or
 * `union` is several. The type is null when it cannot be told (a
 * polymorphic function over an operand of unknown type, a user function);
 * the whole result is null when the cardinality cannot either.
 */

import type * as EdgeQLAST from "../edgeql/ast.ts";
import { renderEdgeQLTypeName } from "../compiler/compiler-base.ts";
import { lookupFunction, type FunctionDef } from "../compiler/context.ts";

export interface ComputedValues {
  /*** For a user scalar type (a path to a property of one): the built-in it extends. ***/
  baseType?: string;
  multi: boolean;
  required: boolean;
  /*** The EdgeQL type, written as a property's (`str`, `cal::local_date`, `array<int64>`, `tuple<a: int64, b: str>`), or null when unknown. ***/
  type: string | null;
}

/*** What a path yields (a property's values, a link's objects with a null type), or null when it cannot be told. ***/
export type PathValues = (path: EdgeQLAST.Path) => ComputedValues | null;

const LITERAL_TYPES: Record<EdgeQLAST.Literal["type"], string | null> = {
  bigint: "bigint",
  boolean: "bool",
  bytes: "bytes",
  decimal: "decimal",
  empty: null,
  float: "float64",
  integer: "int64",
  string: "str",
  uuid: "uuid"
};

const INT_WIDTHS: Record<string, number> = { int16: 16, int32: 32, int64: 64 };

const COMPARISONS = new Set([
  "!=",
  "!~",
  "!~*",
  "<",
  "<=",
  "=",
  ">",
  ">=",
  "AND",
  "ILIKE",
  "LIKE",
  "OR",
  "~",
  "~*"
]);

/*** Aggregates over their argument's set that are one boolean or one int64 whatever it holds. ***/
const SET_TESTS: Record<string, string> = { all: "bool", any: "bool", count: "int64", exists: "bool" };

/*** Aggregates that are one float64 (a decimal for decimals) and never empty. ***/
const MEANS = new Set(["avg", "math_mean", "math_stddev", "math_stddev_pop", "math_var", "math_var_pop", "stddev", "stddev_pop", "stddev_samp"]);

/*** Functions whose registered return type stands for "an array of str". ***/
const STR_ARRAY_FUNCTIONS = new Set(["re_match", "re_match_all", "str_split"]);

/*** The values `expr` yields (see the module comment), or null. ***/
export function inferComputedValues(
  expr: EdgeQLAST.Expression,
  pathValues: PathValues,
  functions: Map<string, FunctionDef>
): ComputedValues | null {
  const infer = (e: EdgeQLAST.Expression): ComputedValues | null => inferComputedValues(e, pathValues, functions);
  switch (expr.kind) {
    case "Literal":
      return expr.type === "empty" ?
        { multi: false, required: false, type: null } :
        { multi: false, required: true, type: LITERAL_TYPES[expr.type] };
    case "Path":
      return expr.rooted ? null : pathValues(expr);
    case "TypeCast": {
      const inner = infer(expr.expr);
      return inner && { multi: inner.multi, required: inner.required, type: typeName(expr.type) };
    }
    case "FunctionCall":
      return inferCall(expr, infer, functions);
    case "BinaryOp":
      return inferBinary(expr, infer);
    case "UnaryOp": {
      const operand = infer(expr.operand);
      if (expr.op === "EXISTS") {
        return { multi: false, required: true, type: "bool" };
      }
      if (!operand || expr.op === "DETACHED") {
        return null;
      }
      return { ...operand, type: expr.op === "NOT" ? "bool" : operand.type };
    }
    case "IfElse": {
      const [condition, then, otherwise] = [infer(expr.condition), infer(expr.then), infer(expr.else)];
      if (!condition || !then || !otherwise) {
        return null;
      }
      return {
        multi: condition.multi || then.multi || otherwise.multi,
        required: condition.required && then.required && otherwise.required,
        type: commonType([then.type, otherwise.type])
      };
    }
    case "SetExpr": {
      const elements = flatten(expr).map(infer);
      if (elements.some(element => !element)) {
        return null;
      }
      const values = elements as ComputedValues[];
      if (values.length === 0) {
        return { multi: false, required: false, type: null };
      }
      if (values.length === 1) {
        return values[0];
      }
      return { multi: true, required: values.some(value => value.required), type: commonType(values.map(value => value.type)) };
    }
    case "ArrayExpr": {
      const elements = product(expr.elements.map(infer));
      const type = elements && commonType(elements.types);
      return elements && { ...elements.card, type: type ? `array<${type}>` : null };
    }
    case "TupleExpr": {
      const elements = product(expr.elements.map(infer));
      const known = elements?.types.every(type => type !== null);
      return elements && { ...elements.card, type: known ? `tuple<${elements.types.join(", ")}>` : null };
    }
    case "NamedTuple": {
      const elements = product(expr.elements.map(element => infer(element.value)));
      const known = elements?.types.every(type => type !== null);
      const fields = expr.elements.map((element, index) => `${element.name}: ${elements?.types[index]}`);
      return elements && { ...elements.card, type: known ? `tuple<${fields.join(", ")}>` : null };
    }
    case "Subquery": {
      const query = expr.query;
      if (query.kind !== "SelectQuery" || query.shape) {
        return null;
      }
      const inner = infer(query.expr);
      const atMostOne = query.limit?.kind === "Literal" && Number(query.limit.value) <= 1;
      return inner && {
        ...inner,
        multi: inner.multi && !atMostOne,
        required: inner.required && !query.filter && !query.offset && !(query.limit?.kind === "Literal" && Number(query.limit.value) < 1)
      };
    }
    default:
      return null;
  }
}

/*** A call's values: an aggregate is one value, any other function one per combination of its arguments'. ***/
function inferCall(
  call: EdgeQLAST.FunctionCall,
  infer: (e: EdgeQLAST.Expression) => ComputedValues | null,
  functions: Map<string, FunctionDef>
): ComputedValues | null {
  const funcDef = lookupFunction({ functions, types: new Map() }, call.name.parts);
  if (!funcDef || funcDef.windowOnly) {
    return null;
  }
  const name = funcDef.name;
  if (SET_TESTS[name]) {
    return { multi: false, required: true, type: SET_TESTS[name] };
  }
  const args = call.args.map(arg => infer(arg.value));
  const [arg] = args;
  const argType = arg ? arg.baseType ?? arg.type : null;
  switch (name) {
    case "sum":
      return { multi: false, required: true, type: argType && INT_WIDTHS[argType] ? "int64" : argType };
    case "min":
    case "max":
      return arg ? { ...arg, multi: false, required: arg.required } : null;
    case "array_agg":
      return { multi: false, required: true, type: arg?.type && !arg.type.startsWith("array<") ? `array<${arg.type}>` : null };
    case "assert_single":
      return arg ? { ...arg, multi: false } : null;
    case "assert_exists":
      return arg ? { ...arg, required: true } : null;
    case "distinct":
    case "assert_distinct":
      return arg;
    case "array_unpack":
      return arg ? { multi: true, required: false, type: arrayElement(argType) } : null;
    case "enumerate":
      return arg ? { ...arg, type: arg.type ? `tuple<int64, ${arg.type}>` : null } : null;
  }
  if (MEANS.has(name)) {
    return { multi: false, required: true, type: argType === "decimal" || argType === "bigint" ? "decimal" : "float64" };
  }
  const operands = product(args);
  if (!operands) {
    return null;
  }
  let type: string | null = funcDef.returnType;
  if (name === "array_get" || name === "json_get") {
    return { multi: operands.card.multi, required: false, type: name === "json_get" ? "json" : arrayElement(argType) };
  } else if (name === "math_abs") {
    type = argType;
  } else if (["math_ceil", "math_floor", "round"].includes(name)) {
    type = argType && INT_WIDTHS[argType] ? "int64" : argType === "float32" ? "float64" : argType;
  } else if (STR_ARRAY_FUNCTIONS.has(name)) {
    type = "array<str>";
  } else if (!isConcrete(type)) {
    type = null;
  }
  return { ...operands.card, type };
}

/*** A binary operator's values: element-wise over its operands, but for `??`, `in`, `?=` and the set operators. ***/
function inferBinary(
  op: EdgeQLAST.BinaryOp,
  infer: (e: EdgeQLAST.Expression) => ComputedValues | null
): ComputedValues | null {
  const left = infer(op.left);
  if (op.op === "IS" || op.op === "IS NOT") {
    return left && { multi: left.multi, required: left.required, type: "bool" };
  }
  const right = infer(op.right);
  if (!left || !right) {
    return null;
  }
  const [l, r] = [left.baseType ?? left.type, right.baseType ?? right.type];
  switch (op.op) {
    case "??":
      return { multi: left.multi || right.multi, required: left.required || right.required, type: commonType([left.type, right.type]) };
    case "UNION":
      return { multi: true, required: left.required || right.required, type: commonType([left.type, right.type]) };
    case "EXCEPT":
    case "INTERSECT":
      return { multi: left.multi, required: false, type: left.type };
    case "IN":
    case "NOT IN":
      return { multi: left.multi, required: left.required, type: "bool" };
    case "?=":
    case "?!=":
      return { multi: left.multi || right.multi, required: true, type: "bool" };
  }
  const card = { multi: left.multi || right.multi, required: left.required && right.required };
  if (COMPARISONS.has(op.op)) {
    return { ...card, type: "bool" };
  }
  if (op.op === "++") {
    return { ...card, type: l !== null && l === r && (l === "str" || l === "bytes" || l === "json" || l.startsWith("array<")) ? l : null };
  }
  if (["+", "-", "*", "/", "//", "%", "^", "**"].includes(op.op)) {
    return { ...card, type: arithmeticType(op.op, l, r) };
  }
  return null;
}

/*** The type of `left op right` for numbers (Gel's implicit casts) and dates and durations; null when not one of these. ***/
function arithmeticType(op: string, left: string | null, right: string | null): string | null {
  if (left === null || right === null) {
    return null;
  }
  const temporal = temporalArithmeticType(op, left.replace(/^cal::/, ""), right.replace(/^cal::/, ""));
  if (temporal !== undefined) {
    return temporal;
  }
  const numeric = numericType(left, right);
  if (numeric === null) {
    return null;
  }
  if (op === "/" || op === "^" || op === "**") {
    return numeric === "bigint" ? "decimal" : INT_WIDTHS[numeric] ? "float64" : numeric;
  }
  return numeric;
}

/*** The common type of two numeric operands, by Gel's implicit casts (int16 → int32 → int64 → bigint → decimal; int16 → float32 → float64; int32, int64 → float64); null when there is none. ***/
function numericType(left: string, right: string): string | null {
  const widths = [INT_WIDTHS[left], INT_WIDTHS[right]];
  if (widths[0] && widths[1]) {
    return widths[0] >= widths[1] ? left : right;
  }
  const types = new Set([left, right]);
  const exact = ["decimal", "bigint"].find(type => types.has(type));
  const float = ["float64", "float32"].find(type => types.has(type));
  if (exact && float) {
    return null;
  }
  if (exact) {
    return [...types].every(type => type === exact || type === "bigint" || INT_WIDTHS[type]) ? exact : null;
  }
  if (float === "float32") {
    return [...types].every(type => type === "float32" || type === "int16") ? "float32" : types.has("int32") || types.has("int64") ? "float64" : null;
  }
  return float && [...types].every(type => type === "float64" || type === "float32" || INT_WIDTHS[type]) ? "float64" : null;
}

/*** The type of date and duration arithmetic (Gel's `+` / `-` operators on them), null for other such operands, undefined when neither operand is a date or duration. ***/
function temporalArithmeticType(op: string, left: string, right: string): string | null | undefined {
  const temporal = new Set(["date_duration", "datetime", "duration", "local_date", "local_datetime", "local_time", "relative_duration"]);
  if (!temporal.has(left) && !temporal.has(right)) {
    return undefined;
  }
  if (op !== "+" && op !== "-") {
    return null;
  }
  const durations = new Set(["date_duration", "duration", "relative_duration"]);
  if (durations.has(left) && durations.has(right)) {
    return left === right ? prefixed(left) : "cal::relative_duration";
  }
  if (op === "-" && left === right) {
    return left === "datetime" ? "duration" : left === "local_date" ? "cal::date_duration" : "cal::relative_duration";
  }
  const [point, duration] = durations.has(right) ? [left, right] : op === "+" ? [right, left] : [null, null];
  if (!point || !duration) {
    return null;
  }
  if (point === "local_date" && duration !== "date_duration") {
    return "cal::local_datetime";
  }
  return prefixed(point);
}

/*** A date or duration type as a property writes it (`cal::local_date`, `duration`). ***/
function prefixed(type: string): string {
  return type === "datetime" || type === "duration" ? type : `cal::${type}`;
}

/*** The element type of `array<T>`, or null. ***/
function arrayElement(type: string | null): string | null {
  return type?.startsWith("array<") && type.endsWith(">") ? type.slice("array<".length, -1) : null;
}

/*** The type all of `types` are, or null when they differ or one is unknown. ***/
function commonType(types: (string | null)[]): string | null {
  const known = types.filter(type => type !== null);
  return known.length === types.length && known.every(type => type === known[0]) ? known[0] : null;
}

/*** The cardinality of an element-wise combination of `operands` (multi when one is, required when all are) and their types; null when one is unknown. ***/
function product(operands: (ComputedValues | null)[]): { card: { multi: boolean; required: boolean; }; types: (string | null)[]; } | null {
  if (operands.some(operand => !operand)) {
    return null;
  }
  const values = operands as ComputedValues[];
  return {
    card: { multi: values.some(value => value.multi), required: values.every(value => value.required) },
    types: values.map(value => value.type)
  };
}

/*** A set literal's elements, nested set literals flattened (`{1, {2, 3}}` is three). ***/
function flatten(set: EdgeQLAST.SetExpr): EdgeQLAST.Expression[] {
  return set.elements.flatMap(element => element.kind === "SetExpr" ? flatten(element) : [element]);
}

/*** A cast's type as a property writes it: `str`, `cal::local_date`, `array<int64>`. ***/
function typeName(type: EdgeQLAST.TypeName): string {
  return renderEdgeQLTypeName(type).replace(/\bstd::/g, "");
}

/*** A registered return type that names one type (not `any`, `anyreal`, a bare `array`, `tuple`, `range`). ***/
function isConcrete(type: string): boolean {
  return !["any", "anyreal", "array", "multirange", "range", "tuple"].includes(type);
}

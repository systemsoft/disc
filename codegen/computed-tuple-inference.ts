/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Infer the field shape of a computed named-tuple property from its EdgeQL
 * expression, so codegen can emit a typed nested filter
 * (`counts?: { videos?: ... }`) and the runtime TypeInfo can carry per-field
 * casts.
 *
 * v1 scope: a NamedTuple whose field values are builtin function calls
 * (`count`, `sum`, `min`, `max`, `avg`, …) — their return type comes from the
 * builtin-function registry. Fields whose type can't be inferred are dropped;
 * if none are inferable the whole property is omitted (callers then skip it
 * rather than emit a broken `unknown | Op<unknown>` filter field).
 */

import type * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { getBuiltinFunctions } from "../compiler/builtin-functions.ts";

/**
 * Returns `{ tupleField → edgeqlType }` for the inferable fields of a computed
 * named-tuple property, or `null` when the expression isn't a named tuple or
 * has no inferable field.
 */
export function inferComputedTupleFields(
  computedExpr: string
): Record<string, string> | null {
  let expr: EdgeQLAST.Expression;
  try {
    expr = new EdgeQLParser(computedExpr).parseExpressionOnly();
  } catch {
    return null;
  }
  if (expr.kind !== "NamedTuple") {
    return null;
  }

  const functions = getBuiltinFunctions();
  const fields: Record<string, string> = {};
  for (const element of expr.elements) {
    const type = inferScalarType(element.value, functions);
    if (type) {
      fields[element.name] = type;
    }
  }
  return Object.keys(fields).length > 0 ? fields : null;
}

function inferScalarType(
  expr: EdgeQLAST.Expression,
  functions: ReturnType<typeof getBuiltinFunctions>
): string | null {
  if (expr.kind === "FunctionCall") {
    const def = functions.get(expr.name.parts.join("_")) ??
      functions.get(expr.name.parts.join("::"));
    return def?.returnType ?? null;
  }
  return null;
}

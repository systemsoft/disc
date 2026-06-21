/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SDL Expression → EdgeQL Source Printer
 *
 * Converts an SDL Expression node (parsed by schema/parser.ts) back into an
 * EdgeQL source string. Used by schema-manager to persist computed-property
 * expressions on `PropertyDef`/`LinkDef` so the compiler can inline them at
 * query time (the SDL AST and EdgeQL AST are separate type universes, but
 * EdgeQL is a strict superset of the expression syntax SDL accepts).
 */

import type {
  BinaryOp,
  ConditionalExpression,
  Expression,
  FunctionCall,
  Literal,
  NamedTupleExpression,
  Parameter,
  PathExpression,
  TupleExpression,
  TypeCast,
  TypeRef,
  UnaryOp
} from "./ast.ts";

/** Format an SDL expression as the equivalent EdgeQL source text. */
export function sdlExpressionToEdgeQL(expr: Expression): string {
  switch (expr.kind) {
    case "Literal":
      return formatLiteral(expr as Literal);
    case "PathExpression":
      return formatPath(expr as PathExpression);
    case "BinaryOp":
      return formatBinary(expr as BinaryOp);
    case "UnaryOp":
      return formatUnary(expr as UnaryOp);
    case "FunctionCall":
      return formatFunctionCall(expr as FunctionCall);
    case "TypeCast":
      return formatTypeCast(expr as TypeCast);
    case "Parameter":
      return `$${(expr as Parameter).name}`;
    case "ConditionalExpression":
      return formatConditional(expr as ConditionalExpression);
    case "TupleExpression":
      return formatTuple(expr as TupleExpression);
    case "NamedTupleExpression":
      return formatNamedTuple(expr as NamedTupleExpression);
    default:
      // The Expression union is closed; this branch exists for forward
      // compatibility if new SDL expression kinds are added.
      throw new Error(`unsupported SDL expression kind: ${(expr as { kind: string; }).kind}`);
  }
}

function formatLiteral(lit: Literal): string {
  if (lit.type === "string") {
    return `'${String(lit.value).replace(/'/g, "\\'")}'`;
  }
  return String(lit.value);
}

function formatPath(path: PathExpression): string {
  // SDL parser path encoding (see schema/parser.ts `parsePathStep` and
  // `parsePostfixExpression`):
  //   `.created`                       → [".", "created"]
  //   `.foo.bar`                       → [".", "foo", "bar"]
  //   `.<options`                      → [".", "<options"]
  //   `.<options[is PaymentReq]`       → [".", "<options", "[is PaymentReq]"]
  //   `User.email` (bare path)         → ["User", "email"]
  //
  // Joining naively with `.` produces invalid EdgeQL like `.<options.[is X]`,
  // so each step is emitted with its own separator rule.
  if (path.path.length === 0) {
    return "";
  }

  let result = "";
  let needsDotBeforeNext = false;
  for (const step of path.path) {
    if (step === ".") {
      // Leading-dot marker — the next step glues directly onto the `.`.
      result += ".";
      needsDotBeforeNext = false;
    } else if (step.startsWith("[")) {
      // Type intersection (`[is Type]`) attaches to the previous step.
      result += step;
      // `[is X]` still allows further `.foo` chaining after it.
      needsDotBeforeNext = true;
    } else {
      // Regular identifier or backlink (`<name`); both need a `.` separator
      // unless we just emitted the leading-dot marker.
      if (needsDotBeforeNext) {
        result += ".";
      }
      result += step;
      needsDotBeforeNext = true;
    }
  }
  return result;
}

function formatBinary(bin: BinaryOp): string {
  return `(${sdlExpressionToEdgeQL(bin.left)} ${bin.op} ${sdlExpressionToEdgeQL(bin.right)})`;
}

function formatUnary(un: UnaryOp): string {
  // `not x` needs a space; `-x` / `+x` don't. Use the SDL operator literal.
  const op = un.op;
  const sep = /[a-z]/i.test(op) ? " " : "";
  return `(${op}${sep}${sdlExpressionToEdgeQL(un.operand)})`;
}

function formatFunctionCall(fn: FunctionCall): string {
  const name = fn.name.parts.join("::");
  const args = fn.args.map(sdlExpressionToEdgeQL).join(", ");
  return `${name}(${args})`;
}

function formatTypeCast(cast: TypeCast): string {
  return `<${formatTypeRef(cast.type)}>${sdlExpressionToEdgeQL(cast.expr)}`;
}

function formatTypeRef(ref: TypeRef): string {
  let base = ref.name.parts.join("::");
  if (ref.params && ref.params.length > 0) {
    base += `<${ref.params.map(formatTypeRef).join(", ")}>`;
  }
  if (ref.array) {
    base = `array<${base}>`;
  }
  // Named-tuple field: `icon: str`.
  if (ref.fieldName) {
    base = `${ref.fieldName}: ${base}`;
  }
  return base;
}

function formatConditional(cond: ConditionalExpression): string {
  return `(${sdlExpressionToEdgeQL(cond.consequent)} if ${sdlExpressionToEdgeQL(cond.test)} else ${sdlExpressionToEdgeQL(cond.alternate)})`;
}

function formatTuple(tup: TupleExpression): string {
  return `(${tup.elements.map(sdlExpressionToEdgeQL).join(", ")})`;
}

function formatNamedTuple(tup: NamedTupleExpression): string {
  return `(${
    tup
      .elements
      .map(e => `${e.name} := ${sdlExpressionToEdgeQL(e.value)}`)
      .join(", ")
  })`;
}

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Expression Converter
 *
 * Converts SDL Expression nodes (schema/ast.ts) into AccessExpressionNode
 * nodes (access/ast.ts) so that the access evaluator can process expressions
 * parsed from SDL `using(...)` clauses.
 */

/*** UTILITY ------------------------------------------ ***/

import { ValidationError } from "../lib/errors.ts";

import type {
  BinaryOp,
  ConditionalExpression,
  Expression,
  FunctionCall,
  Literal,
  PathExpression,
  TypeCast,
  UnaryOp
} from "../schema/ast.ts";

import type { AccessExpressionNode } from "./ast.ts";

/*** EXPORT ------------------------------------------- ***/

/**
 * Convert an SDL Expression into an AccessExpressionNode.
 *
 * Throws ValidationError for expression kinds that are not valid inside
 * access policy conditions (e.g. Parameter).
 */
export function convertExpression(expr: Expression): AccessExpressionNode {
  switch (expr.kind) {
    case "BinaryOp": {
      const bin = expr as BinaryOp;

      if (bin.op === "and" || bin.op === "or") {
        return {
          kind: "AccessLogical",
          operands: [convertExpression(bin.left), convertExpression(bin.right)],
          operator: bin.op
        };
      }

      // Map optional comparison operators
      let operator: string = bin.op;

      if (bin.op === "?=")
        operator = "=";

      if (bin.op === "?!=")
        operator = "!=";

      return {
        kind: "AccessComparison",
        left: convertExpression(bin.left),
        operator: operator as "=" | "!=" | "<" | ">" | "<=" | ">=",
        right: convertExpression(bin.right)
      };
    }

    case "ConditionalExpression": {
      const cond = expr as ConditionalExpression;
      // Decompose: (test AND consequent) OR (NOT test AND alternate)
      return {
        kind: "AccessLogical",
        operands: [
          {
            kind: "AccessLogical",
            operands: [
              convertExpression(cond.test),
              convertExpression(cond.consequent)
            ],
            operator: "and"
          },
          {
            kind: "AccessLogical",
            operands: [
              {
                kind: "AccessLogical",
                operator: "not",
                operands: [convertExpression(cond.test)]
              },
              convertExpression(cond.alternate)
            ],
            operator: "and"
          }
        ],
        operator: "or"
      };
    }

    case "FunctionCall": {
      const func = expr as FunctionCall;

      return {
        args: func.args.map(convertExpression),
        kind: "AccessFunction",
        name: func.name.parts.join("::")
      };
    }

    case "Literal": {
      const lit = expr as Literal;
      const mappedType = lit.type === "integer" || lit.type === "float" ?
        "number" :
        lit.type; // "string" | "boolean"

      return {
        kind: "AccessLiteral",
        type: mappedType,
        value: lit.value
      };
    }

    case "Parameter": {
      throw new ValidationError("Parameter expressions are not valid in access policies");
    }

    case "PathExpression": {
      const path = expr as PathExpression;

      if (path.path[0] === "global") {
        return {
          kind: "AccessGlobal",
          name: path.path[1]
        };
      }

      if (path.path[0] === ".") {
        return {
          kind: "AccessPath",
          path: path.path.slice(1)
        };
      }

      return {
        kind: "AccessPath",
        path: path.path
      };
    }

    case "TypeCast": {
      const cast = expr as TypeCast;
      return convertExpression(cast.expr);
    }

    case "UnaryOp": {
      const un = expr as UnaryOp;

      if (un.op === "not") {
        return {
          kind: "AccessLogical",
          operands: [convertExpression(un.operand)],
          operator: "not"
        };
      }

      throw new ValidationError(`Unsupported unary operator in access policy: ${un.op}`);
    }

    default: {
      throw new ValidationError(`Unsupported expression kind in access policy: ${(expr as any).kind}`);
    }
  }
}

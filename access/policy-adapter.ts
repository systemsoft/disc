/**
 * Policy Adapter
 *
 * Converts SDL AST access policies (from schema/ast.ts) to runtime access
 * policy objects (from access/types.ts) used by the access control evaluator.
 */

import type { AccessAction as SDLAccessAction, AccessPolicy as SDLAccessPolicy } from "../schema/ast.ts";
import type { AccessExpressionNode } from "./ast.ts";
import { convertExpression } from "./expression-converter.ts";
import type { AccessAction as RuntimeAccessAction, AccessPolicy as RuntimeAccessPolicy } from "./types.ts";

/**
 * Converts a single SDL AccessAction into a runtime AccessAction, stripping
 * the AST-specific `kind` and `span` fields.
 */
function adaptAccessAction(sdlAction: SDLAccessAction): RuntimeAccessAction {
  return {
    allow: sdlAction.allow,
    operations: sdlAction.operations
  };
}

/**
 * Returns true if the expression tree contains any AccessPath nodes
 * (column references that can only be resolved against database rows).
 */
export function containsColumnReference(expr: AccessExpressionNode): boolean {
  switch (expr.kind) {
    case "AccessPath":
      return true;
    case "AccessLiteral":
    case "AccessGlobal":
      return false;
    case "AccessComparison":
      return containsColumnReference(expr.left) ||
        containsColumnReference(expr.right);
    case "AccessLogical":
      return expr.operands.some(containsColumnReference);
    case "AccessFunction":
      return expr.args.some(containsColumnReference);
    default:
      return false;
  }
}

/**
 * Extracts a minimal condition guard from an expression by collecting all
 * referenced globals and combining them with AND. This checks that required
 * context values (e.g. current_user) are present before the SQL filter runs.
 *
 * Returns undefined if no globals are referenced (pure column expression).
 */
export function extractGlobalGuard(
  expr: AccessExpressionNode
): AccessExpressionNode | undefined {
  const globals: AccessExpressionNode[] = [];
  collectGlobals(expr, globals);

  if (globals.length === 0) {
    return undefined;
  }

  if (globals.length === 1) {
    return globals[0];
  }

  return {
    kind: "AccessLogical",
    operator: "and",
    operands: globals
  };
}

function collectGlobals(
  expr: AccessExpressionNode,
  out: AccessExpressionNode[]
): void {
  switch (expr.kind) {
    case "AccessGlobal": {
      // Avoid duplicates
      if (!out.some(g => g.kind === "AccessGlobal" && g.name === expr.name)) {
        out.push(expr);
      }
      break;
    }
    case "AccessComparison": {
      collectGlobals(expr.left, out);
      collectGlobals(expr.right, out);
      break;
    }
    case "AccessLogical": {
      for (const operand of expr.operands) {
        collectGlobals(operand, out);
      }
      break;
    }
    case "AccessFunction": {
      for (const arg of expr.args) {
        collectGlobals(arg, out);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Converts an array of SDL AST access policies into runtime access policy
 * objects suitable for registration with AccessEvaluator.
 *
 * Mapping rules:
 * - `sdl.name.value`  → `runtime.name`
 * - `objectType` arg  → `runtime.objectType`
 * - `sdl.actions[]`   → `runtime.actions[]` (only `allow` and `operations` kept)
 * - `sdl.condition`   → `runtime.using` (always, for SQL WHERE generation)
 * - `sdl.condition`   → `runtime.condition` ONLY if no column references;
 *   otherwise a minimal global-presence guard is extracted
 *
 * Note on withCheck (P1-37): the SDL parser surfaces `with check (...)` as
 * `sdl.withCheck`; this adapter forwards the converted expression to
 * `runtime.withCheck`, which the SQL injector emits as a row-level CHECK
 * constraint on INSERT/UPDATE.
 *
 * Note on deny policies (P1-38): deny policies currently compile to a
 * coarse gate (if the policy matches and the action is denied, reject the
 * whole request) rather than per-row filtering. This mirrors Gel's
 * documented behavior as of 5.x — row-level deny would require JOIN-style
 * policy composition that isn't implemented.
 */
export function adaptAccessPolicies(
  objectType: string,
  sdlPolicies: SDLAccessPolicy[]
): RuntimeAccessPolicy[] {
  return sdlPolicies.map((sdl): RuntimeAccessPolicy => {
    const policy: RuntimeAccessPolicy = {
      actions: sdl.actions.map(adaptAccessAction),
      name: sdl.name.value,
      objectType
    };

    if (sdl.condition !== undefined) {
      const converted = convertExpression(sdl.condition);
      policy.using = converted;

      if (containsColumnReference(converted)) {
        // Column references can't be evaluated in-memory; extract a
        // minimal guard that checks required globals are present.
        policy.condition = extractGlobalGuard(converted);
      } else {
        // Pure context expression — safe for in-memory evaluation.
        policy.condition = converted;
      }
    }

    if (sdl.withCheck !== undefined) {
      policy.withCheck = convertExpression(sdl.withCheck);
    }

    // Custom denial message (Gel #4095). Forwarded as-is; the evaluator
    // surfaces it via AccessDecision.denialMessage and callers prefer it
    // over the generic reason when raising an error.
    if (sdl.errmessage !== undefined) {
      policy.errmessage = sdl.errmessage;
    }

    return policy;
  });
}

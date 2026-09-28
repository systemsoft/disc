/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Policy Adapter
 *
 * Converts SDL AST access policies (from schema/ast.ts) to runtime access
 * policy objects (from access/types.ts) used by the access control evaluator.
 */

/*** UTILITY ------------------------------------------ ***/

import { BUILTIN_ACCESS_GLOBALS, containsColumnReference } from "./evaluator.ts";
import { convertExpression } from "./expression-converter.ts";
import { sdlExpressionToEdgeQL } from "../schema/expression-printer.ts";
import { ValidationError } from "../lib/errors.ts";

import type { AccessExpressionNode } from "./ast.ts";
import type { AccessAction as SDLAccessAction, AccessPolicy as SDLAccessPolicy, Expression as SDLExpression } from "../schema/ast.ts";
import type { AccessAction as RuntimeAccessAction, AccessPolicy as RuntimeAccessPolicy } from "./types.ts";

/*** EXPORT ------------------------------------------- ***/

export { containsColumnReference };

/**
 * Extracts a minimal condition guard from an expression by collecting the
 * built-in globals it references (see `BUILTIN_ACCESS_GLOBALS`) and combining
 * them with AND. This checks that required context values (e.g. current_user)
 * are present before the SQL filter runs. Custom globals are left to the SQL,
 * which reads them where `set global` stored them.
 *
 * Returns undefined if no built-in globals are referenced.
 */
export function extractGlobalGuard(expr: AccessExpressionNode): AccessExpressionNode | undefined {
  const globals: AccessExpressionNode[] = [];
  collectGlobals(expr, globals);

  if (globals.length === 0)
    return undefined;

  if (globals.length === 1)
    return globals[0];

  return {
    kind: "AccessLogical",
    operands: globals,
    operator: "and"
  };
}

/*** Collects the built-in globals `expr` references, once each. ***/
function collectGlobals(expr: AccessExpressionNode, out: AccessExpressionNode[]): void {
  switch (expr.kind) {
    case "AccessGlobal": {
      // Avoid duplicates
      if (BUILTIN_ACCESS_GLOBALS.has(expr.name) && !out.some(g => g.kind === "AccessGlobal" && g.name === expr.name))
        out.push(expr);

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

    default: {
      break;
    }
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
 * - `sdl.when` AND `sdl.condition` (Gel's `when` and `using`) →
 *   `runtime.usingSource`, the EdgeQL the compiler compiles for SQL, and
 *   `runtime.using`, its in-memory form when it has one
 * - that condition → `runtime.condition` ONLY if no column references;
 *   otherwise a minimal presence guard over its built-in globals is extracted
 *
 * Note on withCheck (P1-37): the SDL parser surfaces `with check (...)` as
 * `sdl.withCheck`; this adapter forwards the converted expression to
 * `runtime.withCheck`, which the compiler checks, with `using`, on every
 * object an insert or update writes (see `AccessEvaluator.writePolicies`).
 *
 * Note on deny policies: a deny with a condition denies the objects that
 * meet it (a filter on select, update read and delete; the write check on
 * insert and update write); one without denies the operation outright.
 */
export function adaptAccessPolicies(objectType: string, sdlPolicies: SDLAccessPolicy[]): RuntimeAccessPolicy[] {
  return sdlPolicies.map((sdl): RuntimeAccessPolicy => {
    const policy: RuntimeAccessPolicy = {
      actions: sdl.actions.map(adaptAccessAction),
      name: sdl.name.value,
      objectType
    };

    /*** Gel's `when` restricts the objects the policy applies to, as its `using` does: the
         policy's condition is both. ***/
    const conditions = [sdl.when, sdl.condition].filter((expr): expr is SDLExpression => expr !== undefined);
    // Each as written; a schema an older Disc stored has only the SDL form.
    const sources = [
      ...sdl.when ? [sdl.whenSource ?? sdlExpressionToEdgeQL(sdl.when)] : [],
      ...sdl.condition ? [sdl.conditionSource ?? sdlExpressionToEdgeQL(sdl.condition)] : []
    ];

    if (conditions.length > 0) {
      policy.usingSource = sources.map(source => `(${source})`).join(" and ");
      const converted = convertAll(conditions);

      if (converted !== undefined) {
        policy.using = converted;

        /*** Column references can’t be evaluated in-memory; extract a minimal guard that
             checks required globals are present. A pure context expression is safe for
             in-memory evaluation. With no in-memory form (`exists .owner`), the SQL alone
             decides. ***/
        policy.condition = containsColumnReference(converted) ? extractGlobalGuard(converted) : converted;
      }
    }

    if (sdl.withCheck !== undefined) {
      policy.withCheckSource = sdl.withCheckSource ?? sdlExpressionToEdgeQL(sdl.withCheck);
      policy.withCheck = convertAll([sdl.withCheck]);
    }

    /*** Custom denial message (Gel #4095). Forwarded as-is; the evaluator surfaces it via
         AccessDecision.denialMessage and callers prefer it over the generic reason when
         raising an error. ***/
    if (sdl.errmessage !== undefined)
      policy.errmessage = sdl.errmessage;

    return policy;
  });
}

/*** HELPER ------------------------------------------- ***/

/**
 * The in-memory form of `exprs` ANDed, or undefined when one has none (an
 * expression the evaluator cannot run, such as `exists .owner`).
 */
function convertAll(exprs: SDLExpression[]): AccessExpressionNode | undefined {
  try {
    const converted = exprs.map(convertExpression);
    return converted.length === 1 ? converted[0] : { kind: "AccessLogical", operands: converted, operator: "and" };
  } catch (error) {
    if (error instanceof ValidationError)
      return undefined;

    throw error;
  }
}

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

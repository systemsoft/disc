/**
 * Policy Adapter
 *
 * Converts SDL AST access policies (from schema/ast.ts) to runtime access
 * policy objects (from access/types.ts) used by the access control evaluator.
 */

import type {
  AccessAction as SDLAccessAction,
  AccessPolicy as SDLAccessPolicy,
} from "../schema/ast.ts";
import type {
  AccessAction as RuntimeAccessAction,
  AccessPolicy as RuntimeAccessPolicy,
} from "./types.ts";

/**
 * Converts a single SDL AccessAction into a runtime AccessAction, stripping
 * the AST-specific `kind` and `span` fields.
 */
function adaptAccessAction(sdlAction: SDLAccessAction): RuntimeAccessAction {
  return {
    allow: sdlAction.allow,
    operations: sdlAction.operations,
  };
}

/**
 * Converts an array of SDL AST access policies into runtime access policy
 * objects suitable for registration with AccessEvaluator.
 *
 * Mapping rules:
 * - `sdl.name.value`  → `runtime.name`
 * - `objectType` arg  → `runtime.objectType`
 * - `sdl.actions[]`   → `runtime.actions[]` (only `allow` and `operations` kept)
 * - `sdl.condition`   → `runtime.condition` AND `runtime.using`
 *   (the same expression is assigned to both fields so the evaluator can use
 *   it for row-level filtering as well as condition evaluation)
 */
export function adaptAccessPolicies(
  objectType: string,
  sdlPolicies: SDLAccessPolicy[],
): RuntimeAccessPolicy[] {
  return sdlPolicies.map((sdl): RuntimeAccessPolicy => {
    const policy: RuntimeAccessPolicy = {
      actions: sdl.actions.map(adaptAccessAction),
      name: sdl.name.value,
      objectType,
    };

    if (sdl.condition !== undefined) {
      policy.condition = sdl.condition;
      policy.using = sdl.condition;
    }

    return policy;
  });
}

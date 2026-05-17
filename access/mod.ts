/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Access Control Module
 *
 * Provides object-level access policies and row-level security for Disc
 */

/*** EXPORT ------------------------------------------- ***/

export * from "./ast.ts";
export * from "./evaluator.ts";
export * from "./parser.ts";
export * from "./sql-injector.ts";
export * from "./types.ts";

export { AccessEvaluator } from "./evaluator.ts";
export { AccessPolicyParser } from "./parser.ts";
export { AccessSQLInjector } from "./sql-injector.ts";

export type {
  AccessAction,
  AccessConfig,
  AccessContext,
  AccessDecision,
  AccessOperation,
  AccessPolicy,
  PolicyMode
} from "./types.ts";

export type {
  AccessExpressionNode,
  AccessOperationNode,
  AccessPolicyNode,
  AccessRuleNode
} from "./ast.ts";

export { convertExpression } from "./expression-converter.ts";
export { adaptAccessPolicies, containsColumnReference, extractGlobalGuard } from "./policy-adapter.ts";

/**
 * Access Control Module
 *
 * Provides object-level access policies and row-level security for Disc
 */

export * from "./types.ts";
export * from "./ast.ts";
export * from "./parser.ts";
export * from "./evaluator.ts";
export * from "./sql-injector.ts";

// Re-export key classes for convenience
export { AccessPolicyParser } from "./parser.ts";
export { AccessEvaluator } from "./evaluator.ts";
export { AccessSQLInjector } from "./sql-injector.ts";

// Re-export key types
export type { AccessAction, AccessConfig, AccessContext, AccessDecision, AccessOperation, AccessPolicy, PolicyMode } from "./types.ts";

export type { AccessExpressionNode, AccessOperationNode, AccessPolicyNode, AccessRuleNode } from "./ast.ts";

export { adaptAccessPolicies, containsColumnReference, extractGlobalGuard } from "./policy-adapter.ts";
export { convertExpression } from "./expression-converter.ts";

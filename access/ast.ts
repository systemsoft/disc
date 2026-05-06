/**
 * Access Policy AST Extensions
 *
 * These extend the base schema AST to support access control features
 */

import { SDLNode } from "../schema/ast.ts";
import { Span } from "../lib/types.ts";

/**
 * Access policy AST node for schema-level policies
 */
export interface AccessPolicyNode extends SDLNode {
  /**
   * Optional custom error message surfaced when this policy denies an
   * operation. Set via `errmessage := '...';` in SDL. Falls back to a
   * generic deny reason at runtime when omitted. (Gel #4095)
   */
  errmessage?: string;
  global?: boolean; // If global policy
  kind: "AccessPolicy";
  name: string;
  objectType?: string; // If attached to specific type
  span?: Span;

  // Policy rules
  rules: AccessRuleNode[];

  // Optional expressions
  using?: AccessExpressionNode; // Row filtering
  withCheck?: AccessExpressionNode; // Check constraint
}

/**
 * Individual access rule within a policy
 */
export interface AccessRuleNode extends SDLNode {
  action: "allow" | "deny";
  condition?: AccessExpressionNode;
  kind: "AccessRule";
  operations: AccessOperationNode[];
  span?: Span;
}

/**
 * Access operation specification
 */
export interface AccessOperationNode extends SDLNode {
  columns?: string[]; // Optional column-level restrictions
  kind: "AccessOperation";
  operation: "select" | "insert" | "update" | "delete" | "all";
  span?: Span;
}

/**
 * Access-specific expression nodes
 */
export type AccessExpressionNode =
  | AccessPathNode
  | AccessFunctionNode
  | AccessComparisonNode
  | AccessLogicalNode
  | AccessLiteralNode
  | AccessGlobalNode;

export interface AccessPathNode extends SDLNode {
  kind: "AccessPath";
  path: string[];
  span?: Span;
}

export interface AccessFunctionNode extends SDLNode {
  args: AccessExpressionNode[];
  kind: "AccessFunction";
  name: string;
  span?: Span;
}

export interface AccessComparisonNode extends SDLNode {
  kind: "AccessComparison";
  left: AccessExpressionNode;
  operator:
    | "="
    | "!="
    | "<"
    | ">"
    | "<="
    | ">="
    | "in"
    | "not in"
    | "like"
    | "ilike";
  right: AccessExpressionNode;
  span?: Span;
}

export interface AccessLogicalNode extends SDLNode {
  kind: "AccessLogical";
  operands: AccessExpressionNode[];
  operator: "and" | "or" | "not";
  span?: Span;
}

export interface AccessLiteralNode extends SDLNode {
  kind: "AccessLiteral";
  span?: Span;
  type: "string" | "number" | "boolean" | "null" | "array";
  value: string | number | boolean | null | AccessExpressionNode[];
}

export interface AccessGlobalNode extends SDLNode {
  kind: "AccessGlobal";
  name: string; // e.g., "current_user", "current_role"
  span?: Span;
}

/**
 * Helper functions for creating AST nodes
 */
export function createAccessPolicy(
  name: string,
  rules: AccessRuleNode[],
  options?: {
    errmessage?: string;
    global?: boolean;
    objectType?: string;
    span?: Span;
    using?: AccessExpressionNode;
    withCheck?: AccessExpressionNode;
  },
): AccessPolicyNode {
  return {
    kind: "AccessPolicy",
    name,
    rules,
    ...options,
  };
}

export function createAccessRule(
  action: "allow" | "deny",
  operations: AccessOperationNode[],
  condition?: AccessExpressionNode,
  span?: Span,
): AccessRuleNode {
  return {
    action,
    condition,
    kind: "AccessRule",
    operations,
    span,
  };
}

export function createAccessOperation(
  operation: AccessOperationNode["operation"],
  columns?: string[],
  span?: Span,
): AccessOperationNode {
  return {
    columns,
    kind: "AccessOperation",
    operation,
    span,
  };
}

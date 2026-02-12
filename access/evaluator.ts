/**
 * Access Policy Evaluator
 *
 * Evaluates access policies and generates SQL conditions
 */

import {
  AccessPolicy,
  AccessContext,
  AccessDecision,
  AccessOperation,
  AccessConfig,
} from "./types.ts";
import {
  AccessExpressionNode,
  AccessComparisonNode,
  AccessLogicalNode,
  AccessLiteralNode,
  AccessGlobalNode,
  AccessPathNode,
  AccessFunctionNode,
} from "./ast.ts";
import { Expression } from "../schema/ast.ts";
import { ValidationError } from "../lib/errors.ts";

export class AccessEvaluator {
  private config: AccessConfig;
  private policies: Map<string, AccessPolicy[]>;

  constructor(config: AccessConfig) {
    this.config = config;
    this.policies = new Map();
  }

  /**
   * Register an access policy
   */
  registerPolicy(policy: AccessPolicy): void {
    const key = policy.objectType || "__global__";
    const existing = this.policies.get(key) || [];
    existing.push(policy);
    this.policies.set(key, existing);
  }

  /**
   * Evaluate access for an operation on an object type
   */
  evaluate(
    objectType: string,
    operation: AccessOperation,
    context: AccessContext
  ): AccessDecision {
    const appliedPolicies: string[] = [];
    const sqlConditions: string[] = [];

    // Get applicable policies
    const typePolicies = this.policies.get(objectType) || [];
    const globalPolicies = this.policies.get("__global__") || [];
    const allPolicies = [...globalPolicies, ...typePolicies];

    if (allPolicies.length === 0) {
      // No policies defined - use default behavior
      return {
        allowed: this.config.defaultAllow,
        appliedPolicies: [],
        reason: this.config.defaultAllow ?
          "No policies defined, default allow" :
          "No policies defined, default deny"
      };
    }

    // Evaluate each policy
    let hasAllow = false;
    let hasDeny = false;

    for (const policy of allPolicies) {
      appliedPolicies.push(policy.name);

      // Check if this policy applies to the operation
      const decision = this.evaluatePolicy(policy, operation, context);

      if (decision.allowed) {
        hasAllow = true;

        if (decision.sqlCondition)
          sqlConditions.push(decision.sqlCondition);
      } else if (decision.denied) {
        hasDeny = true;

        if (this.config.mode === "restrictive") {
          // In restrictive mode, any deny immediately fails
          return {
            allowed: false,
            appliedPolicies,
            reason: `Denied by policy: ${policy.name}`
          };
        }
      }
    }

    // Determine final decision based on mode
    let allowed: boolean;
    let reason: string;

    if (this.config.mode === "permissive") {
      // Permissive: allow if any policy allows and no explicit deny
      allowed = hasAllow && !hasDeny;
      reason = allowed ?
          "Allowed by permissive policy" :
          hasDeny ?
            "Explicitly denied" :
            "No allowing policy found";
    } else {
      // Restrictive: require explicit allow and no deny
      allowed = hasAllow && !hasDeny;

      reason = allowed ?
        "Allowed by restrictive policy" :
        "Not explicitly allowed or denied";
    }

    return {
      allowed,
      appliedPolicies,
      reason,
      sqlConditions: sqlConditions.length > 0 ? sqlConditions : undefined
    };
  }

  /**
   * Evaluate a single policy
   */
  private evaluatePolicy(
    policy: AccessPolicy,
    operation: AccessOperation,
    context: AccessContext
  ): { allowed: boolean; denied: boolean; sqlCondition?: string } {
    let allowed = false;
    let denied = false;
    let sqlCondition: string | undefined;

    for (const action of policy.actions) {
      // Check if this action applies to the operation
      if (!this.operationMatches(operation, action.operations))
        continue;

      // Evaluate condition if present
      if (policy.condition) {
        const conditionMet = this.evaluateExpression(
          policy.condition,
          context
        );

        if (!conditionMet)
          continue;
      }

      // Apply the action
      if (action.allow) {
        allowed = true;

        // Generate SQL condition for row-level security
        if (policy.using && this.config.enableRLS)
          sqlCondition = this.expressionToSQL(policy.using, context);
      } else {
        denied = true;
      }
    }

    return { allowed, denied, sqlCondition };
  }

  /**
   * Check if an operation matches any of the specified operations
   */
  private operationMatches(
    operation: AccessOperation,
    operations: AccessOperation[]
  ): boolean {
    return operations.includes(operation) || operations.includes("all");
  }

  /**
   * Evaluate an expression against the context
   */
  private evaluateExpression(
    expr: Expression | AccessExpressionNode,
    context: AccessContext
  ): boolean {
    // Handle different expression types
    const node = expr as AccessExpressionNode;

    switch (node.kind) {
      case "AccessLiteral": {
        const literal = node as AccessLiteralNode;
        return Boolean(literal.value);
      }

      case "AccessGlobal": {
        const global = node as AccessGlobalNode;
        return this.evaluateGlobal(global.name, context);
      }

      case "AccessPath": {
        const path = node as AccessPathNode;
        return Boolean(this.resolvePath(path.path, context));
      }

      case "AccessComparison": {
        const comp = node as AccessComparisonNode;
        return this.evaluateComparison(comp, context);
      }

      case "AccessLogical": {
        const logical = node as AccessLogicalNode;
        return this.evaluateLogical(logical, context);
      }

      case "AccessFunction": {
        const func = node as AccessFunctionNode;
        return this.evaluateFunction(func, context);
      }

      default: {
        throw new ValidationError(`Unknown expression kind: ${(node as any).kind}`);
      }
    }
  }

  /**
   * Evaluate a global variable
   */
  private evaluateGlobal(name: string, context: AccessContext): boolean {
    switch (name) {
      case "current_user": {
        return Boolean(context.userId);
      }

      case "current_role": {
        return Boolean(context.userRole);
      }

      case "current_session": {
        return Boolean(context.sessionData);
      }

      default: {
        return false;
      }
    }
  }

  /**
   * Resolve a path in the context
   */
  private resolvePath(path: string[], context: AccessContext): any {
    let current: any = context;

    for (const segment of path) {
      if (current && typeof current === "object")
        current = current[segment];
      else
        return undefined;
    }

    return current;
  }

  /**
   * Evaluate a comparison expression
   */
  private evaluateComparison(
    comp: AccessComparisonNode,
    context: AccessContext
  ): boolean {
    const left = this.evaluateExpression(comp.left, context);
    const right = this.evaluateExpression(comp.right, context);

    switch (comp.operator) {
      case "=": {
        return left === right;
      }

      case "!=": {
        return left !== right;
      }

      case "<": {
        return left < right;
      }

      case ">": {
        return left > right;
      }

      case "<=": {
        return left <= right;
      }

      case ">=": {
        return left >= right;
      }

      case "in": {
        return Array.isArray(right) && right.includes(left);
      }

      case "not in": {
        return !Array.isArray(right) || !right.includes(left);
      }

      case "like":
      case "ilike": {
        // Simple pattern matching (would need more sophisticated impl)
        return String(left).includes(String(right));
      }

      default: {
        return false;
      }
    }
  }

  /**
   * Evaluate a logical expression
   */
  private evaluateLogical(
    logical: AccessLogicalNode,
    context: AccessContext
  ): boolean {
    switch (logical.operator) {
      case "and": {
        return logical.operands.every(op =>
          this.evaluateExpression(op, context)
        );
      }

      case "or": {
        return logical.operands.some(op =>
          this.evaluateExpression(op, context)
        );
      }

      case "not": {
        return !this.evaluateExpression(logical.operands[0], context);
      }

      default: {
        return false;
      }
    }
  }

  /**
   * Evaluate a function call
   */
  private evaluateFunction(
    func: AccessFunctionNode,
    context: AccessContext
  ): boolean {
    // Built-in functions
    switch (func.name) {
      case "has_role": {
        const requiredRole = String(this.evaluateExpression(func.args[0], context));
        return context.userRole === requiredRole;
      }

      case "is_owner": {
        // This would need to be implemented based on actual data
        return false;
      }

      default: {
        throw new ValidationError(`Unknown function: ${func.name}`);
      }
    }
  }

  /**
   * Convert an expression to SQL WHERE clause
   */
  private expressionToSQL(
    expr: Expression | AccessExpressionNode,
    context: AccessContext
  ): string {
    const node = expr as AccessExpressionNode;

    switch (node.kind) {
      case "AccessLiteral": {
        const literal = node as AccessLiteralNode;

        if (literal.type === "string")
          return `'${String(literal.value).replace(/'/g, "''")}'`;

        return String(literal.value);
      }

      case "AccessGlobal": {
        const global = node as AccessGlobalNode;

        switch (global.name) {
          case "current_user": {
            return context.userId ? `'${context.userId}'` : "NULL";
          }

          case "current_role": {
            return context.userRole ? `'${context.userRole}'` : "NULL";
          }

          default: {
            return "NULL";
          }
        }
      }

      case "AccessPath": {
        const path = node as AccessPathNode;
        // Convert path to SQL column reference
        return path.path.join(".");
      }

      case "AccessComparison": {
        const comp = node as AccessComparisonNode;
        const left = this.expressionToSQL(comp.left, context);
        const right = this.expressionToSQL(comp.right, context);

        return `(${left} ${comp.operator} ${right})`;
      }

      case "AccessLogical": {
        const logical = node as AccessLogicalNode;

        if (logical.operator === "not")
          return `NOT (${this.expressionToSQL(logical.operands[0], context)})`;

        const parts = logical.operands.map(op => this.expressionToSQL(op, context));
        return `(${parts.join(` ${logical.operator.toUpperCase()} `)})`;
      }

      case "AccessFunction": {
        const func = node as AccessFunctionNode;
        const args = func.args.map(arg => this.expressionToSQL(arg, context)).join(", ");

        return `${func.name}(${args})`;
      }

      default: {
        throw new ValidationError(`Cannot convert ${(node as any).kind} to SQL`);
      }
    }
  }

  /**
   * Clear all registered policies
   */
  clearPolicies(): void {
    this.policies.clear();
  }

  /**
   * Get all policies for a type
   */
  getPolicies(objectType?: string): AccessPolicy[] {
    if (objectType)
      return this.policies.get(objectType) || [];

    // Return all policies
    const all: AccessPolicy[] = [];

    for (const policies of this.policies.values()) {
      all.push(...policies);
    }

    return all;
  }
}

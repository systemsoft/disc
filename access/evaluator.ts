/**
 * Access Policy Evaluator
 *
 * Evaluates access policies and generates SQL conditions
 */

import { ValidationError } from "../lib/errors.ts";
import { assertSafeIdentifier, sqlStringLiteral } from "../lib/sql-escape.ts";
import type { AccessComparisonNode, AccessExpressionNode, AccessFunctionNode, AccessLogicalNode } from "./ast.ts";
import { defaultPermissionChecker, parsePermissionSpec } from "./runtime-permissions.ts";
import { AccessConfig, AccessContext, AccessDecision, AccessOperation, AccessPolicy } from "./types.ts";

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
    let allPolicies = [...globalPolicies, ...typePolicies];

    // Per-policy disable (gh/geldata#6432 slice 3). Filter out any
    // policy whose fully-qualified name appears in
    // `context.disabledPolicies`. Done before the no-policies-defined
    // check below so disabling every policy on a type falls back to
    // `defaultAllow` semantics — same shape as a type with no policies
    // declared, which is the expected mental model for testing.
    const disabled = context.disabledPolicies;
    if (disabled && disabled.size > 0) {
      allPolicies = allPolicies.filter(p => {
        const qualifiedName = `${p.objectType ?? "__global__"}.${p.name}`;
        return !disabled.has(qualifiedName);
      });
    }

    if (allPolicies.length === 0) {
      // No policies defined - use default behavior
      return {
        allowed: this.config.defaultAllow,
        appliedPolicies: [],
        reason: this.config.defaultAllow ? "No policies defined, default allow" : "No policies defined, default deny"
      };
    }

    // Evaluate each policy
    let hasAllow = false;
    let hasDeny = false;
    // Track the first denying policy's custom errmessage so we can surface
    // it on the AccessDecision (Gel #4095). Callers prefer this over the
    // generic `reason` when raising an error.
    let denialMessage: string | undefined;

    for (const policy of allPolicies) {
      appliedPolicies.push(policy.name);

      // Check if this policy applies to the operation
      const decision = this.evaluatePolicy(policy, operation, context);

      if (decision.allowed) {
        hasAllow = true;

        if (decision.sqlCondition) {
          sqlConditions.push(decision.sqlCondition);
        }
      } else if (decision.denied) {
        hasDeny = true;

        if (denialMessage === undefined && policy.errmessage !== undefined) {
          denialMessage = policy.errmessage;
        }

        if (this.config.mode === "restrictive") {
          // In restrictive mode, any deny immediately fails
          return {
            allowed: false,
            appliedPolicies,
            denialMessage: policy.errmessage,
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
      reason = allowed ? "Allowed by permissive policy" : hasDeny ? "Explicitly denied" : "No allowing policy found";
    } else {
      // Restrictive: require explicit allow and no deny
      allowed = hasAllow && !hasDeny;

      reason = allowed ? "Allowed by restrictive policy" : "Not explicitly allowed or denied";
    }

    return {
      allowed,
      appliedPolicies,
      denialMessage: !allowed ? denialMessage : undefined,
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
  ): { allowed: boolean; denied: boolean; sqlCondition?: string; } {
    let allowed = false;
    let denied = false;
    let sqlCondition: string | undefined;

    for (const action of policy.actions) {
      // Check if this action applies to the operation
      if (!this.operationMatches(operation, action.operations)) {
        continue;
      }

      // Evaluate condition if present
      if (policy.condition) {
        const conditionMet = this.evaluateExpression(
          policy.condition,
          context
        );

        if (!conditionMet) {
          continue;
        }
      }

      // Apply the action
      if (action.allow) {
        allowed = true;

        // Generate SQL condition for row-level security
        if (policy.using && this.config.enableRLS) {
          sqlCondition = this.expressionToSQL(policy.using, context);
        }
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
    expr: AccessExpressionNode,
    context: AccessContext
  ): boolean {
    switch (expr.kind) {
      case "AccessLiteral": {
        return Boolean(expr.value);
      }

      case "AccessGlobal": {
        return this.evaluateGlobal(expr.name, context);
      }

      case "AccessPath": {
        return Boolean(this.resolvePath(expr.path, context));
      }

      case "AccessComparison": {
        return this.evaluateComparison(expr, context);
      }

      case "AccessLogical": {
        return this.evaluateLogical(expr, context);
      }

      case "AccessFunction": {
        return this.evaluateFunction(expr, context);
      }

      default: {
        throw new ValidationError(
          `Unknown expression kind: ${(expr as any).kind}`
        );
      }
    }
  }

  /**
   * Evaluate a global variable
   */
  private evaluateGlobal(name: string, context: AccessContext): boolean {
    // Check custom globals map first
    if (context.globals?.has(name)) {
      return Boolean(context.globals.get(name));
    }

    // Fall back to built-in globals
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
      if (current && typeof current === "object") {
        current = current[segment];
      } else {
        return undefined;
      }
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
        return logical.operands.every(op => this.evaluateExpression(op, context));
      }

      case "or": {
        return logical.operands.some(op => this.evaluateExpression(op, context));
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
        const requiredRole = String(
          this.evaluateExpression(func.args[0], context)
        );
        return context.userRole === requiredRole;
      }

      case "is_owner": {
        // This would need to be implemented based on actual data
        return false;
      }

      case "runtime::has_permission": {
        // Disc-original feature #5: gate on the running Deno process's
        // permission set. The first argument must be a string literal —
        // anything else is a typo or expression we'd have to evaluate
        // before checking permissions, which the spec doesn't promise.
        const arg = func.args[0];
        if (!arg || arg.kind !== "AccessLiteral" || arg.type !== "string") {
          throw new ValidationError(
            "runtime::has_permission requires a string literal argument"
          );
        }
        const checker = context.permissionChecker ?? defaultPermissionChecker;
        return checker(parsePermissionSpec(String(arg.value))) === "granted";
      }

      default: {
        throw new ValidationError(`Unknown function: ${func.name}`);
      }
    }
  }

  /**
   * Convert an access expression AST node to a SQL WHERE clause fragment.
   */
  expressionToSQL(
    expr: AccessExpressionNode,
    context: AccessContext
  ): string {
    switch (expr.kind) {
      case "AccessLiteral": {
        if (expr.type === "string") {
          return sqlStringLiteral(String(expr.value));
        }

        return String(expr.value);
      }

      case "AccessGlobal": {
        // Built-in globals use direct value injection. User-derived context
        // values are escaped via sqlStringLiteral (E'...' syntax) to close
        // the SQL-injection vector flagged by the Phase 3 access audit
        // (P0-01 / P0-02): a userId like `admin'; DROP TABLE users; --`
        // previously concatenated verbatim into the generated WHERE clause.
        switch (expr.name) {
          case "current_user": {
            return context.userId ? sqlStringLiteral(context.userId) : "NULL";
          }

          case "current_role": {
            return context.userRole ? sqlStringLiteral(context.userRole) : "NULL";
          }

          case "current_session": {
            return context.sessionData ? "'true'" : "NULL";
          }

          default: {
            // Custom globals use PG current_setting mechanism. The global
            // name came from SDL and is validated to be a safe identifier
            // before being composed into the setting key — avoids an
            // injection via `current_setting('global default::…')`.
            assertSafeIdentifier(expr.name, "AccessGlobal");
            return `current_setting('global default::${expr.name}', true)`;
          }
        }
      }

      case "AccessPath": {
        return expr.path.join(".");
      }

      case "AccessComparison": {
        const left = this.expressionToSQL(expr.left, context);
        const right = this.expressionToSQL(expr.right, context);

        return `(${left} ${expr.operator} ${right})`;
      }

      case "AccessLogical": {
        if (expr.operator === "not") {
          return `NOT (${this.expressionToSQL(expr.operands[0], context)})`;
        }

        const parts = expr.operands.map(op => this.expressionToSQL(op, context));
        return `(${parts.join(` ${expr.operator.toUpperCase()} `)})`;
      }

      case "AccessFunction": {
        // `runtime::has_permission` is process-local — Postgres can't
        // call back into Deno. Pre-evaluate at SQL-emission time and
        // inline the verdict as a literal. The Deno permission set is
        // fixed for the life of the process, so caching once at SQL
        // emission is correct (the policy WHERE clause is recompiled
        // anyway when the schema changes).
        if (expr.name === "runtime::has_permission") {
          const arg = expr.args[0];
          if (!arg || arg.kind !== "AccessLiteral" || arg.type !== "string") {
            throw new ValidationError(
              "runtime::has_permission requires a string literal argument"
            );
          }
          const checker = context.permissionChecker ?? defaultPermissionChecker;
          const granted = checker(parsePermissionSpec(String(arg.value))) === "granted";
          return granted ? "TRUE" : "FALSE";
        }

        const args = expr
          .args
          .map(arg => this.expressionToSQL(arg, context))
          .join(", ");

        return `${expr.name}(${args})`;
      }

      default: {
        throw new ValidationError(
          `Cannot convert ${(expr as any).kind} to SQL`
        );
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
    if (objectType) {
      return this.policies.get(objectType) || [];
    }

    // Return all policies
    const all: AccessPolicy[] = [];

    for (const policies of this.policies.values()) {
      all.push(...policies);
    }

    return all;
  }
}

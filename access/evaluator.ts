/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Access Policy Evaluator
 *
 * Evaluates access policies and generates SQL conditions
 */

/*** UTILITY ------------------------------------------ ***/

import { assertSafeIdentifier, sqlStringLiteral } from "../lib/sql-escape.ts";
import { ValidationError } from "../lib/errors.ts";
import { globalSettingName } from "../lib/identifiers.ts";

import type {
  AccessComparisonNode,
  AccessExpressionNode,
  AccessFunctionNode,
  AccessLogicalNode
} from "./ast.ts";

import { defaultPermissionChecker, parsePermissionSpec } from "./runtime-permissions.ts";

import {
  AccessConfig,
  AccessContext,
  AccessDecision,
  AccessGlobalResolver,
  AccessOperation,
  AccessPolicy
} from "./types.ts";

/*** EXPORT ------------------------------------------- ***/

/**
 * The globals a policy reads from the request's access context (the caller's
 * identity), decided at compile time. Every other global is a custom global:
 * session state `set global` stores in PostgreSQL, read by the policy's SQL.
 */
export const BUILTIN_ACCESS_GLOBALS: ReadonlySet<string> = new Set(["current_role", "current_session", "current_user"]);

export class AccessEvaluator {
  private config: AccessConfig;
  private globalResolver?: AccessGlobalResolver;
  private policies: Map<string, AccessPolicy[]>;

  constructor(config: AccessConfig) {
    this.config = config;
    this.policies = new Map();
  }

  /**
   * Clear all registered policies
   */
  clearPolicies(): void {
    this.policies.clear();
  }

  /**
   * Evaluate access for an operation on an object type
   */
  evaluate(objectType: string, operation: AccessOperation, context: AccessContext): AccessDecision {
    const appliedPolicies: string[] = [];
    const globalPolicies = this.policies.get("__global__") || [];
    const sqlConditions: string[] = [];
    const typePolicies = this.policies.get(objectType) || [];
    let allPolicies = [...globalPolicies, ...typePolicies];

    /*** Per-policy disable (gh/geldata#6432 slice 3). Filter out any policy whose fully-qualified
         name appears in `context.disabledPolicies`. Done before the no-policies-defined check
         below so disabling every policy on a type falls back to `defaultAllow` semantics — same
         shape as a type with no policies declared, which is the expected mental model
         for testing. ***/
    const disabled = context.disabledPolicies;

    if (disabled && disabled.size > 0) {
      allPolicies = allPolicies.filter(p => {
        const qualifiedName = `${p.objectType ?? "__global__"}.${p.name}`;
        return !disabled.has(qualifiedName);
      });
    }

    if (allPolicies.length === 0) {
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
    /*** Track the first denying policy’s custom errmessage so we can surface it on the
         AccessDecision (Gel #4095). Callers prefer this over the generic `reason` when raising
         an error. ***/
    let denialMessage: string | undefined;

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

        if (denialMessage === undefined && policy.errmessage !== undefined)
          denialMessage = policy.errmessage;

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
      denialMessage: !allowed ? denialMessage : undefined,
      reason,
      sqlConditions: sqlConditions.length > 0 ? sqlConditions : undefined
    };
  }

  /**
   * Convert an access expression AST node to a SQL WHERE clause fragment.
   * `objectType` is the type whose policy the expression belongs to; a custom
   * global is resolved in its module.
   */
  expressionToSQL(expr: AccessExpressionNode, context: AccessContext, objectType?: string): string {
    switch (expr.kind) {
      case "AccessComparison": {
        const left = this.expressionToSQL(expr.left, context, objectType);
        const right = this.expressionToSQL(expr.right, context, objectType);

        return `(${left} ${expr.operator} ${right})`;
      }

      case "AccessFunction": {
        /*** `runtime::has_permission` is process-local — Postgres can’t
             call back into Deno. Pre-evaluate at SQL-emission time and
             inline the verdict as a literal. The Deno permission set is
             fixed for the life of the process, so caching once at SQL
             emission is correct (the policy WHERE clause is recompiled
             anyway when the schema changes). ***/
        if (expr.name === "runtime::has_permission") {
          const arg = expr.args[0];

          if (!arg || arg.kind !== "AccessLiteral" || arg.type !== "string")
            throw new ValidationError("runtime::has_permission requires a string literal argument");

          const checker = context.permissionChecker ?? defaultPermissionChecker;
          const granted = checker(parsePermissionSpec(String(arg.value))) === "granted";

          return granted ? "TRUE" : "FALSE";
        }

        const args = expr
          .args
          .map(arg => this.expressionToSQL(arg, context, objectType))
          .join(", ");

        return `${expr.name}(${args})`;
      }

      case "AccessGlobal": {
        /*** Built-in globals use direct value injection. User-derived context
             values are escaped via sqlStringLiteral (E'...' syntax) to close
             the SQL-injection vector flagged by the Phase 3 access audit
             (P0-01 / P0-02): a userId like `admin'; DROP TABLE users; --`
             previously concatenated verbatim into the generated WHERE clause. ***/
        switch (expr.name) {
          case "current_role": {
            return context.userRole ?
              sqlStringLiteral(context.userRole) :
              "NULL";
          }

          case "current_session": {
            return context.sessionData ? "'true'" : "NULL";
          }

          case "current_user": {
            return context.userId ? sqlStringLiteral(context.userId) : "NULL";
          }

          default: {
            /*** A custom global is the value the context supplies for it, if
                 any (as in `evaluateGlobal`). Otherwise it is read from the
                 setting `set global` writes: its declaration (type, default)
                 resolved by the compiler when one is set, else the untyped
                 setting of the global's name (default module when unqualified). An unset setting reads as '' once
                 any transaction has set it, so '' is no value. Each part of the
                 name is validated as a safe identifier before it is composed
                 into the setting key. ***/
            if (context.globals?.has(expr.name))
              return globalValueToSQL(context.globals.get(expr.name));

            const resolved = this.globalResolver?.(expr.name, objectType);

            if (resolved !== undefined)
              return resolved;

            const separator = expr.name.lastIndexOf("::");
            const module = separator === -1 ? "default" : expr.name.slice(0, separator);
            const name = separator === -1 ? expr.name : expr.name.slice(separator + 2);

            assertSafeIdentifier(module, "AccessGlobal");
            assertSafeIdentifier(name, "AccessGlobal");
            return `NULLIF(current_setting('${globalSettingName(module, name)}', true), '')`;
          }
        }
      }

      case "AccessLiteral": {
        if (expr.type === "string")
          return sqlStringLiteral(String(expr.value));

        return String(expr.value);
      }

      case "AccessLogical": {
        if (expr.operator === "not")
          return `NOT (${this.expressionToSQL(expr.operands[0], context, objectType)})`;

        const parts = expr.operands.map(op => this.expressionToSQL(op, context, objectType));
        return `(${parts.join(` ${expr.operator.toUpperCase()} `)})`;
      }

      case "AccessPath": {
        return expr.path.join(".");
      }

      default: {
        throw new ValidationError(`Cannot convert ${(expr as any).kind} to SQL`);
      }
    }
  }

  /**
   * Get all policies for a type
   */
  getPolicies(objectType?: string): AccessPolicy[] {
    if (objectType)
      return this.policies.get(objectType) || [];

    const all: AccessPolicy[] = [];

    for (const policies of this.policies.values()) {
      all.push(...policies);
    }

    return all;
  }

  /**
   * Set how a custom global in a policy becomes SQL (see `AccessGlobalResolver`).
   */
  setGlobalResolver(resolver: AccessGlobalResolver): void {
    this.globalResolver = resolver;
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

  /*** PRIVATE ------------------------------------------ ***/

  /**
   * Evaluate a comparison expression
   */
  private evaluateComparison(comp: AccessComparisonNode, context: AccessContext): boolean {
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
   * Evaluate an expression against the context
   */
  private evaluateExpression(expr: AccessExpressionNode, context: AccessContext): boolean {
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
   * Evaluate a function call
   */
  private evaluateFunction(func: AccessFunctionNode, context: AccessContext): boolean {
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

      case "runtime::has_permission": {
        /*** Disc-original feature #5: gate on the running Deno process’s permission set. The first
             argument must be a string literal — anything else is a typo or expression we’d have to
             evaluate before checking permissions, which the spec doesn’t promise. ***/
        const arg = func.args[0];

        if (!arg || arg.kind !== "AccessLiteral" || arg.type !== "string")
          throw new ValidationError("runtime::has_permission requires a string literal argument");

        const checker = context.permissionChecker ?? defaultPermissionChecker;
        return checker(parsePermissionSpec(String(arg.value))) === "granted";
      }

      default: {
        throw new ValidationError(`Unknown function: ${func.name}`);
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
   * Evaluate a logical expression
   */
  private evaluateLogical(logical: AccessLogicalNode, context: AccessContext): boolean {
    switch (logical.operator) {
      case "and": {
        return logical.operands.every(op => this.evaluateExpression(op, context));
      }

      case "not": {
        return !this.evaluateExpression(logical.operands[0], context);
      }

      case "or": {
        return logical.operands.some(op => this.evaluateExpression(op, context));
      }

      default: {
        return false;
      }
    }
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
      if (!this.operationMatches(operation, action.operations))
        continue;

      /*** Evaluate condition if present. A custom global the context does not supply is
           session state only the policy's SQL can read, so a condition over one is left to
           the SQL. ***/
      if (policy.condition && !readsSessionGlobal(policy.condition, context)) {
        const conditionMet = this.evaluateExpression(policy.condition, context);

        if (!conditionMet)
          continue;
      }

      // Apply the action
      if (action.allow) {
        allowed = true;

        // Generate SQL condition for row-level security
        if (policy.using && this.config.enableRLS)
          sqlCondition = this.expressionToSQL(policy.using, context, policy.objectType);
      } else {
        denied = true;
      }
    }

    return { allowed, denied, sqlCondition };
  }

  /**
   * Check if an operation matches any of the specified operations
   */
  private operationMatches(operation: AccessOperation, operations: AccessOperation[]): boolean {
    return operations.includes(operation) || operations.includes("all");
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
}

/*** HELPER ------------------------------------------- ***/

/*** A value from `AccessContext.globals` as a SQL literal. ***/
function globalValueToSQL(value: unknown): string {
  if (value === null || value === undefined)
    return "NULL";

  if (typeof value === "boolean")
    return value ? "TRUE" : "FALSE";

  if (typeof value === "number" && Number.isFinite(value))
    return String(value);

  return sqlStringLiteral(String(value));
}

/*** True when `expr` reads a custom global that `context.globals` does not supply. ***/
function readsSessionGlobal(expr: AccessExpressionNode, context: AccessContext): boolean {
  switch (expr.kind) {
    case "AccessGlobal": {
      return !BUILTIN_ACCESS_GLOBALS.has(expr.name) && !context.globals?.has(expr.name);
    }

    case "AccessComparison": {
      return readsSessionGlobal(expr.left, context) || readsSessionGlobal(expr.right, context);
    }

    case "AccessLogical": {
      return expr.operands.some(operand => readsSessionGlobal(operand, context));
    }

    case "AccessFunction": {
      return expr.args.some(arg => readsSessionGlobal(arg, context));
    }

    default: {
      return false;
    }
  }
}

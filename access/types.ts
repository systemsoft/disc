/**
 * Access Control Types and Interfaces
 */

import type { AccessExpressionNode } from "./ast.ts";
import type { PermissionChecker } from "./runtime-permissions.ts";

/**
 * Access control operations that can be restricted
 */
export type AccessOperation = "select" | "insert" | "update" | "delete" | "all";

/**
 * Access control action: allow or deny specific operations
 */
export interface AccessAction {
  allow: boolean;
  operations: AccessOperation[];
}

/**
 * Access policy definition attached to a type
 */
export interface AccessPolicy {
  actions: AccessAction[];
  condition?: AccessExpressionNode;
  /**
   * Optional custom error message surfaced when this policy denies an
   * operation. Falls back to a generic deny reason when omitted.
   * (Gel #4095)
   */
  errmessage?: string;
  name: string;
  objectType: string;
  using?: AccessExpressionNode; // For row-level security
  withCheck?: AccessExpressionNode; // For insert/update checks
}

/**
 * Context for evaluating access policies
 */
export interface AccessContext {
  globals?: Map<string, unknown>;
  requestContext?: Record<string, unknown>;
  sessionData?: Record<string, unknown>;
  userId?: string;
  userRole?: string;
  /**
   * Override for `runtime::has_permission(...)` evaluation. Defaults to
   * `defaultPermissionChecker` (which delegates to `Deno.permissions
   * .querySync`). Tests inject a mock so they don't depend on the
   * runner's `--allow-*` flags. (Disc-original feature #5)
   */
  permissionChecker?: PermissionChecker;
  /**
   * Per-request bypass flag (gh/geldata#6358). When `true`, the
   * compiler short-circuits `applyAccessControl` and emits unfiltered
   * SQL — equivalent to Gel's `apply_access_policies := false`
   * session config. The HTTP layer only sets this on `admin`-role
   * callers; non-admins setting the bypass header have it dropped
   * before the compiler ever sees it.
   */
  bypass?: boolean;
}

/**
 * Result of access policy evaluation
 */
export interface AccessDecision {
  allowed: boolean;
  appliedPolicies: string[];
  /**
   * Custom denial message taken from the denying policy's `errmessage`
   * field, when present. Callers that turn a deny verdict into an error
   * should prefer this over `reason`. (Gel #4095)
   */
  denialMessage?: string;
  reason?: string;
  sqlConditions?: string[]; // SQL WHERE clauses to apply
}

/**
 * Policy evaluation mode
 */
export type PolicyMode = "permissive" | "restrictive";

/**
 * Access policy configuration
 */
export interface AccessConfig {
  defaultAllow: boolean;
  enableRLS: boolean; // Row-level security
  enableAudit: boolean;
  mode: PolicyMode;
}

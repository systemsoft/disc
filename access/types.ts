/**
 * Access Control Types and Interfaces
 */

import { Expression } from "../schema/ast.ts";

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
  condition?: Expression;
  name: string;
  objectType: string;
  using?: Expression; // For row-level security
  withCheck?: Expression; // For insert/update checks
}

/**
 * Context for evaluating access policies
 */
export interface AccessContext {
  requestContext?: Record<string, unknown>;
  sessionData?: Record<string, unknown>;
  userId?: string;
  userRole?: string;
}

/**
 * Result of access policy evaluation
 */
export interface AccessDecision {
  allowed: boolean;
  appliedPolicies: string[];
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

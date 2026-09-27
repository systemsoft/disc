/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Access Control Types and Interfaces
 */

/*** UTILITY ------------------------------------------ ***/

import type { AccessExpressionNode } from "./ast.ts";
import type { PermissionChecker } from "./runtime-permissions.ts";

/*** EXPORT ------------------------------------------- ***/

/**
 * Access control operations that can be restricted. As in Gel, `update` is
 * `update read` (which objects an update may reach) plus `update write` (the
 * check on the objects it wrote), and `all` is every operation.
 */
export type AccessOperation = "all" | "delete" | "insert" | "select" | "update" | "update read" | "update write";

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
  using?: AccessExpressionNode; /*** For row-level security ***/
  /**
   * The EdgeQL source of the condition an object must meet for the policy to
   * apply to it — Gel's `when` and `using`, ANDed — when the policy came from
   * SDL. The compiler compiles it (see `AccessEvaluator.setPolicyCompiler`),
   * so it may follow links and backlinks, call functions and read globals;
   * `using` is its in-memory form, absent when it has none.
   */
  usingSource?: string;
  /*** Disc's extra condition on the objects an insert or update writes (see `AccessEvaluator.writeCheck`) ***/
  withCheck?: AccessExpressionNode;
  /*** The EdgeQL source of `withCheck` (see `usingSource`). ***/
  withCheckSource?: string;
}

/**
 * Context for evaluating access policies
 */
export interface AccessContext {
  /**
   * Per-request bypass flag (gh/geldata#6358). When `true`, the
   * compiler short-circuits `applyAccessControl` and emits unfiltered
   * SQL — equivalent to Gel’s `apply_access_policies := false`
   * session config. The HTTP layer only sets this on `admin`-role
   * callers; non-admins setting the bypass header have it dropped
   * before the compiler ever sees it.
   */
  bypass?: boolean;
  /**
   * Per-policy disable set (gh/geldata#6432 slice 3). Each entry is a
   * fully-qualified policy name in `<TypeName>.<policy_name>` form
   * (e.g. `"Doc.owner_only"`). The evaluator silently skips matching
   * policies as if they were not declared on the type — useful for
   * isolating one policy at a time during testing without nuking the
   * whole policy stack via `bypass`. Like `bypass`, this is admin-
   * gated at the HTTP boundary.
   */
  disabledPolicies?: Set<string>;
  globals?: Map<string, unknown>;
  /**
   * Override for `runtime::has_permission(...)` evaluation. Defaults to
   * `defaultPermissionChecker` (which delegates to `Deno.permissions
   * .querySync`). Tests inject a mock so they don’t depend on the
   * runner’s `--allow-*` flags. (Disc-original feature #5)
   */
  permissionChecker?: PermissionChecker;
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
  /**
   * Custom denial message taken from the denying policy’s `errmessage`
   * field, when present. Callers that turn a deny verdict into an error
   * should prefer this over `reason`. (Gel #4095)
   */
  denialMessage?: string;
  /**
   * The conditions of the deny policies that depend on the object: an object
   * meeting any of them is denied, whatever allows it (Gel: denies subtract
   * from the union of allows).
   */
  denySqlConditions?: string[];
  reason?: string;
  sqlConditions?: string[]; // SQL WHERE clauses to apply
}

/**
 * The SQL value of the custom global `name` (bare or `module::name`) read by a
 * policy of `objectType`, or undefined when the schema declares no such
 * global. Supplied by the compiler, which knows the schema's globals.
 */
export type AccessGlobalResolver = (name: string, objectType: string | undefined) => string | undefined;

/**
 * Compiles the EdgeQL source of a policy's condition (`usingSource`,
 * `withCheckSource`) on objects of `objectType` to a SQL predicate over the
 * object's row, aliased `__policy_rows`, for the compiler's access context.
 * Supplied by the compiler.
 */
export type AccessPolicyCompiler = (edgeql: string, objectType: string) => string;

/**
 * Policy evaluation mode
 */
export type PolicyMode = "permissive" | "restrictive";

/**
 * Access policy configuration
 */
export interface AccessConfig {
  defaultAllow: boolean;
  enableAudit: boolean;
  enableRLS: boolean; /*** Row-level security ***/
  mode: PolicyMode;
}

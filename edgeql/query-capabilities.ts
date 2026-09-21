/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Query capability classification.
 *
 * Determines whether an EdgeQL AST node performs writes (modifications,
 * DDL, persistent config) or is read-only. Used by the read-only-mode
 * gate in `server/edgeql-protocol.ts` to refuse write traffic when
 * `ServerConfig.readOnly` is on. (gh/geldata#5524, ports
 * geldata/gel#5543)
 *
 * Mirrors Gel's `Capability.WRITE = MODIFICATIONS | DDL | PERSISTENT_CONFIG`
 * but at the AST level rather than as a bitflag — disc's compiler doesn't
 * thread a separate capability mask through, so we evaluate per-query.
 */

import type { ConfigureQuery, EdgeQLNode, ExplainQuery, Query } from "./ast.ts";

/**
 * Returns `true` if executing the query would mutate database state.
 *
 * Writes:
 *   - INSERT / UPDATE / DELETE
 *   - CONFIGURE DATABASE / INSTANCE / SYSTEM (persistent config)
 *   - any query with an INSERT / UPDATE / DELETE nested anywhere inside it:
 *     a `with` binding (`with u := (update …) select u`), a `select (…)`
 *     operand, a `for … union (…)` body, a subquery in a filter or shape
 *   - EXPLAIN ANALYZE of any of the above (ANALYZE executes the statement)
 *
 * Reads:
 *   - SELECT, GROUP, DESCRIBE TYPE/SCHEMA, SET GLOBAL with no nested write,
 *     plain EXPLAIN (plans only), CONFIGURE SESSION (session-local — not
 *     persistent)
 *
 * SDL/DDL doesn't have its own AST node here — disc handles schema
 * mutation through the migration engine, not user-facing EdgeQL — so
 * those paths are gated separately at the migration entry point.
 */
export function isWriteQuery(ast: Query): boolean {
  switch (ast.kind) {
    case "InsertQuery":
    case "UpdateQuery":
    case "DeleteQuery":
      return true;

    case "ConfigureQuery":
      return isPersistentConfigure(ast as ConfigureQuery);

    case "ExplainQuery":
      return (ast as ExplainQuery).analyze === true &&
        isWriteQuery((ast as ExplainQuery).query);

    case "WithBlock":
    case "ForQuery":
    case "SelectQuery":
    case "GroupQuery":
    case "SetGlobalQuery":
      return containsMutation(ast);

    case "DescribeType":
    case "DescribeSchema":
      return false;

    default:
      // Unknown kinds are treated as writes — fail closed so a new AST
      // variant can't accidentally bypass the gate.
      return true;
  }
}

const MUTATION_KINDS = new Set(["InsertQuery", "UpdateQuery", "DeleteQuery"]);

/**
 * Walks every node under `node` looking for a mutation. The walk is generic
 * (any object with a `kind`) rather than per-node-type so a new expression
 * kind that can hold a subquery is covered without touching this file.
 */
function containsMutation(node: unknown): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }

  if (Array.isArray(node)) {
    return node.some(containsMutation);
  }

  const kind = (node as { kind?: unknown; }).kind;
  if (typeof kind === "string" && MUTATION_KINDS.has(kind)) {
    return true;
  }

  return Object.values(node).some(containsMutation);
}

/**
 * `CONFIGURE SESSION` is per-connection (read-only by mutation
 * standards); `CONFIGURE DATABASE | INSTANCE | SYSTEM` writes
 * persistent configuration and counts as a mutation.
 */
function isPersistentConfigure(ast: ConfigureQuery): boolean {
  return ast.scope !== "SESSION";
}

/**
 * Helper used by tests + future audit logs. Stable string.
 */
export function describeQueryKind(ast: EdgeQLNode): string {
  return ast.kind;
}

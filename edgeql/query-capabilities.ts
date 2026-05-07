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

import type { ConfigureQuery, EdgeQLNode, ForQuery, Query, WithBlock } from "./ast.ts";

/**
 * Returns `true` if executing the query would mutate database state.
 *
 * Writes:
 *   - INSERT / UPDATE / DELETE
 *   - CONFIGURE DATABASE / INSTANCE / SYSTEM (persistent config)
 *   - WITH / FOR blocks whose body contains a write
 *
 * Reads:
 *   - SELECT, GROUP, DESCRIBE TYPE/SCHEMA, EXPLAIN, SET GLOBAL,
 *     CONFIGURE SESSION (session-local — not persistent)
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

    case "WithBlock":
      return isWriteQuery((ast as WithBlock).body);

    case "ForQuery":
      return isWriteQuery((ast as ForQuery).body);

    case "SelectQuery":
    case "GroupQuery":
    case "DescribeType":
    case "DescribeSchema":
    case "ExplainQuery":
    case "SetGlobalQuery":
      return false;

    default:
      // Unknown kinds are treated as writes — fail closed so a new AST
      // variant can't accidentally bypass the gate.
      return true;
  }
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

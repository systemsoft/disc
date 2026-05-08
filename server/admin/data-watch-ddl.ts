/**
 * Data-watch DDL — Bundle L (Disc-original feature #3c).
 *
 * Live data subscriptions are powered by a tiny change-log table plus
 * a generic `AFTER INSERT/UPDATE/DELETE` trigger on every Disc-managed
 * table. The trigger appends one row per mutation; the server-side
 * `DataWatchRegistry` polls the table to demux invalidations to
 * interested SSE subscribers.
 *
 * Why a polled table rather than `LISTEN/NOTIFY`?
 *
 *   The deno-postgres v0.19 client we depend on does not surface
 *   asynchronous `NotificationResponse` messages to user code. We could
 *   either (a) fork/patch the client, or (b) poll a regular table.
 *   Option (b) is one connection's worth of overhead and zero coupling
 *   to any client-internal field — by far the simpler correct thing.
 *
 *   The trade-off is sub-second lag between mutation and invalidation
 *   (250ms by default) which is well below the human-perceptible
 *   latency floor for a "live" UI badge anyway.
 *
 * Single-channel design: every Disc-managed mutation lands in the same
 * `disc_change_log` table tagged with `(table_name, op, created_at,
 * id)`. Subscribers filter by `table_name`. This keeps trigger
 * proliferation linear and avoids the per-channel pg_listener overhead.
 *
 * Idempotent bootstrap: the DDL is wrapped in `CREATE … IF NOT
 * EXISTS` / `CREATE OR REPLACE FUNCTION` / `DROP TRIGGER IF EXISTS;
 * CREATE TRIGGER`, so calling `bootstrapDataWatch()` repeatedly is
 * safe — newly-introduced tables get wired up on the next call.
 *
 * Scope: only Disc-managed tables get triggers. The bootstrap walks
 * `pg_tables` for the `public` schema and skips a small allowlist of
 * Disc-internal tables (`disc_change_log` itself, the migrations
 * table, auth-internal tables, etc.). This avoids a feedback loop
 * where the change-log INSERT triggers itself.
 */

import { ConnectionPool } from "../../lib/connection-pool.ts";

/** Name of the change-log table. Centralized so callers stay in sync. */
export const CHANGE_LOG_TABLE = "disc_change_log";

/** Name of the trigger function. */
export const CHANGE_LOG_FN = "disc_log_change";

/**
 * Tables we never wire triggers on:
 *   - `disc_change_log` itself (would loop)
 *   - `disc_migrations` (engine-managed; high-frequency churn during
 *     migrations and not user-visible data)
 *   - Auth-internal bookkeeping (sessions/tokens/challenges churn
 *     constantly but no admin UI cares to live-watch them)
 *
 * Exposed so tests can extend or replace it.
 */
export const DEFAULT_EXCLUDED_TABLES: ReadonlySet<string> = new Set<string>([
  "disc_change_log",
  "disc_migrations",
  "disc_migration_locks",
  // Auth-internal — high-churn, not interesting for live data viewing
  "auth_sessions",
  "auth_refresh_tokens",
  "magic_link_tokens",
  "magic_code_tokens",
  "mfa_challenges",
  "webauthn_challenges"
]);

/** SQL to create the change-log table. */
export function createChangeLogTableSql(): string {
  // BIGSERIAL gives us a monotonic cursor for "rows newer than last
  // seen". We never UPDATE rows; old rows are pruned by a periodic
  // truncate (the registry caps the table at ~24h of history).
  return `
CREATE TABLE IF NOT EXISTS ${CHANGE_LOG_TABLE} (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  op TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_${CHANGE_LOG_TABLE}_id ON ${CHANGE_LOG_TABLE} (id);
`
    .trim();
}

/** SQL to create the trigger function. */
export function createChangeLogFunctionSql(): string {
  // PL/pgSQL is the simplest way to read TG_TABLE_NAME / TG_OP. The
  // function is statement-scoped (FOR EACH STATEMENT) so a single
  // bulk UPDATE of N rows produces one log row, not N — the
  // invalidate-then-refetch pattern doesn't need per-row info, so
  // this is strictly an efficiency win.
  return `
CREATE OR REPLACE FUNCTION ${CHANGE_LOG_FN}() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO ${CHANGE_LOG_TABLE} (table_name, op)
  VALUES (TG_TABLE_NAME, TG_OP);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
`
    .trim();
}

/** SQL to attach the trigger to a single table. */
export function createTriggerSql(tableName: string): string {
  // Quote the table identifier — same convention as the rest of
  // Disc's DDL emission (callers pass the lowercased PG name).
  const triggerName = `disc_data_watch_${tableName}`;
  // Drop-and-recreate so the bootstrap is idempotent even after the
  // function signature evolves. No CREATE TRIGGER IF NOT EXISTS in
  // PG <14, so we go with explicit DROP IF EXISTS.
  return `
DROP TRIGGER IF EXISTS "${triggerName}" ON "${tableName}";
CREATE TRIGGER "${triggerName}"
AFTER INSERT OR UPDATE OR DELETE ON "${tableName}"
FOR EACH STATEMENT EXECUTE FUNCTION ${CHANGE_LOG_FN}();
`
    .trim();
}

export interface BootstrapDataWatchOptions {
  /** Pool to run DDL through. */
  pool: ConnectionPool;
  /** Override the excluded-tables set (mainly for tests). */
  excludedTables?: ReadonlySet<string>;
  /**
   * Optional logger sink. When omitted, the bootstrap is silent.
   * Tests pass a sink to assert that triggers were wired.
   */
  log?: (message: string) => void;
}

/**
 * Bootstrap the data-watch infrastructure: ensure the change-log
 * table + function exist, then attach the trigger to every
 * non-excluded table in the `public` schema.
 *
 * Safe to call repeatedly. New tables created since the last run get
 * triggers added; existing triggers are dropped and recreated to pick
 * up any function-body changes.
 *
 * Skipped silently when no Disc-managed tables exist yet — bootstrap
 * is a no-op on a fresh DB; the next bootstrap (after `disc migrate`)
 * picks them up.
 */
export async function bootstrapDataWatch(
  options: BootstrapDataWatchOptions
): Promise<{ wiredTables: string[]; }> {
  const excluded = options.excludedTables ?? DEFAULT_EXCLUDED_TABLES;
  const log = options.log;

  // Step 1 — change-log table + index. Idempotent.
  await options.pool.execute(createChangeLogTableSql());
  log?.(`ensured ${CHANGE_LOG_TABLE} table + index`);

  // Step 2 — trigger function. CREATE OR REPLACE is idempotent.
  await options.pool.execute(createChangeLogFunctionSql());
  log?.(`ensured ${CHANGE_LOG_FN}() function`);

  // Step 3 — discover Disc-managed tables and wire triggers.
  // The query intentionally restricts to `schemaname = 'public'`
  // because that's where Disc's DDL emits. Custom schemas are
  // out of scope for v1.
  const result = await options.pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
  );
  const wired: string[] = [];
  for (const row of result.rows as Array<{ tablename: string; }>) {
    const tableName = row.tablename;
    if (excluded.has(tableName))
      continue;
    // Skip _SQL-internal_ tables that PG itself creates. They never
    // start with a lowercase letter so the heuristic is cheap.
    if (!/^[a-z]/.test(tableName))
      continue;
    await options.pool.execute(createTriggerSql(tableName));
    wired.push(tableName);
  }
  log?.(
    `wired data-watch triggers on ${wired.length} table(s): ${wired.join(", ")}`
  );

  return { wiredTables: wired };
}

/**
 * Prune old rows from the change-log table. Subscribers only care
 * about rows newer than their last-seen cursor, so anything older
 * than the lookback window is pure overhead.
 *
 * Default lookback: 1 hour. Anything older won't be replayed to a
 * reconnecting subscriber, which is fine — reconnects refetch
 * unconditionally anyway.
 *
 * Should be called periodically by the registry, not per-request.
 */
export async function pruneChangeLog(
  pool: ConnectionPool,
  lookbackSeconds = 3600
): Promise<number> {
  const result = await pool.query(
    `DELETE FROM ${CHANGE_LOG_TABLE} WHERE created_at < now() - ($1 || ' seconds')::interval`,
    [String(lookbackSeconds)]
  );
  return result.rowCount;
}

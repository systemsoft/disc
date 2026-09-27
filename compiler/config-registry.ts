/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Config-variable registry (#5988 + #6444 — Phase 2)
 *
 * Single source of truth for every CONFIGURE-able key. Replaces the prior
 * flat `CONFIGURE_KEY_MAP` with structured metadata so that:
 *   - the compiler maps EdgeQL keys to PostgreSQL GUC names (`pgName`)
 *   - introspection (`cfg::describe_settings()`) returns the catalogue
 *   - admin/UI surfaces know which keys carry secrets and must mask
 *     their values (`secret: true`)
 *
 * It is also the CONFIGURE allowlist: the compiler rejects any other key
 * with Gel's ConfigurationError, so no statement reaches a PostgreSQL
 * setting not listed here. The keys are Gel's documented ones that map to a
 * PostgreSQL setting (`query_execution_timeout`, `session_idle_transaction_
 * timeout`, `query_work_mem`, `shared_buffers`, `effective_cache_size`,
 * `effective_io_concurrency`, `default_statistics_target`) plus the
 * PostgreSQL-named tuning keys Disc already took. Nothing that holds a
 * secret, names a file or command, loads code, controls logging,
 * networking or replication, or is superuser-only in PostgreSQL belongs
 * here: persistent CONFIGURE is admin-only, but session CONFIGURE is open
 * to every caller.
 *
 * No CONFIGURE-able key in disc is currently a secret — `jwtSecret`,
 * OAuth `clientSecret`, and SMTP credentials live in constructor args
 * today, not in `disc_config`. The mechanism is in place for when
 * those migrate to runtime-configurable keys.
 */

export type ConfigScope = "session" | "database" | "instance" | "system";
export type ConfigType =
  | "str"
  | "int"
  | "bool"
  | "duration"
  | "memory"
  | "float";

export interface ConfigKeyDef {
  /** EdgeQL key name as users write it in CONFIGURE statements */
  name: string;
  /** PostgreSQL GUC name (often equal to `name`, but see `query_execution_timeout` → `statement_timeout`) */
  pgName: string;
  /** Type hint for UI rendering and value validation */
  edgeqlType: ConfigType;
  /**
   * `"session"`: any caller may set it for their own session (`configure
   * session`), and an administrator persistently. Any other value is a
   * system-level key (Gel's `cfg::system`): persistent scopes only, so
   * `configure session` of it is a ConfigurationError.
   */
  defaultScope: ConfigScope;
  /** When true, value is masked in introspection output and admin views */
  secret: boolean;
  /** Default value if any */
  defaultValue?: string | number | boolean;
  /** One-line description for admin UI and docs */
  description?: string;
}

/**
 * Mutable so tests can append synthetic entries to exercise the secret
 * path without shipping a real secret. Production code should treat
 * this as append-only.
 */
export const CONFIG_REGISTRY: ConfigKeyDef[] = [
  {
    name: "query_execution_timeout",
    pgName: "statement_timeout",
    edgeqlType: "duration",
    defaultScope: "session",
    secret: false,
    description: "Abort any statement that takes longer than this (ms)."
  },
  {
    name: "session_idle_transaction_timeout",
    pgName: "idle_in_transaction_session_timeout",
    edgeqlType: "duration",
    defaultScope: "session",
    secret: false,
    description: "Terminate sessions idle in a transaction longer than this (ms)."
  },
  {
    name: "shared_buffers",
    pgName: "shared_buffers",
    edgeqlType: "memory",
    defaultScope: "system",
    secret: false,
    description: "Memory dedicated to shared buffer cache."
  },
  {
    name: "query_work_mem",
    pgName: "work_mem",
    edgeqlType: "memory",
    defaultScope: "system",
    secret: false,
    description: "Memory available for query operations like sorts and hashes."
  },
  {
    name: "work_mem",
    pgName: "work_mem",
    edgeqlType: "memory",
    defaultScope: "system",
    secret: false,
    description: "Memory available for query operations like sorts and hashes."
  },
  {
    name: "maintenance_work_mem",
    pgName: "maintenance_work_mem",
    edgeqlType: "memory",
    defaultScope: "system",
    secret: false,
    description: "Memory available for maintenance operations like VACUUM."
  },
  {
    name: "effective_cache_size",
    pgName: "effective_cache_size",
    edgeqlType: "memory",
    defaultScope: "system",
    secret: false,
    description: "Planner's estimate of disk cache available to PostgreSQL."
  },
  {
    name: "effective_io_concurrency",
    pgName: "effective_io_concurrency",
    edgeqlType: "int",
    defaultScope: "system",
    secret: false,
    description: "Number of concurrent disk I/O operations PostgreSQL may issue."
  },
  {
    name: "default_statistics_target",
    pgName: "default_statistics_target",
    edgeqlType: "int",
    defaultScope: "system",
    secret: false,
    description: "Default statistics target for planner statistics on table columns."
  },
  {
    name: "max_connections",
    pgName: "max_connections",
    edgeqlType: "int",
    defaultScope: "system",
    secret: false,
    description: "Maximum number of concurrent client connections."
  },
  {
    name: "idle_in_transaction_session_timeout",
    pgName: "idle_in_transaction_session_timeout",
    edgeqlType: "duration",
    defaultScope: "session",
    secret: false,
    description: "Terminate sessions idle in a transaction longer than this (ms)."
  },
  {
    name: "lock_timeout",
    pgName: "lock_timeout",
    edgeqlType: "duration",
    defaultScope: "session",
    secret: false,
    description: "Maximum time to wait for a lock (ms)."
  }
];

export function lookupConfigKey(name: string): ConfigKeyDef | undefined {
  return CONFIG_REGISTRY.find(d => d.name === name);
}

export function getConfigRegistry(): ConfigKeyDef[] {
  return CONFIG_REGISTRY.map(d => ({ ...d }));
}

/**
 * Mask a value for surfacing through introspection or admin views.
 * Returns `null` for known-secret keys and unknown keys (fail-closed:
 * an unrecognized key could carry sensitive data we haven't catalogued).
 * Returns the value unchanged for known non-secret keys.
 */
export function maskIfSecret(name: string, value: unknown): unknown {
  const def = lookupConfigKey(name);
  if (!def) {
    return null;
  }
  return def.secret ? null : value;
}

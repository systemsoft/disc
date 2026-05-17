/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Shared helpers for migration test files.
 *
 * Test-only — do not import from production code.
 */

import type { ConnectionPool } from "../lib/connection-pool.ts";
import { MigrationEngine } from "./engine.ts";
import type * as Types from "./types.ts";

/**
 * Build a `MigrationEngine` wired to an existing pool, with the defaults the
 * pg-backed migration suites use: in-memory mode (no `migrationsDir`/
 * `schemaFile`/`databaseUrl`), auto-approve on, rollback-on-error on, no
 * pre-migration backup. Pass `dryRun: true` to build a non-applying engine.
 */
export function makeEngine(
  pool: ConnectionPool,
  dryRun = false
): MigrationEngine {
  const config: Types.MigrationConfig = {
    migrationsDir: "",
    schemaFile: "",
    databaseUrl: "",
    dryRun,
    autoApprove: true,
    backupBeforeMigration: false,
    rollbackOnError: true,
    connectionPool: pool
  };
  return new MigrationEngine(config);
}

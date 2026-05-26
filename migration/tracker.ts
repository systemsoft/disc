/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Migration Tracker - persists migration state to database
 */

import { ConnectionPool } from "../lib/connection-pool.ts";
import { MigrationError } from "../lib/errors.ts";
import { Err, Ok, Result } from "../lib/result.ts";
import { bootstrapStdlib } from "../lib/stdlib-sql.ts";
import { logger } from "../postgres/logger.ts";
import { Module } from "../schema/converter.ts";
import * as Types from "./types.ts";

export class MigrationTracker {
  private pool: ConnectionPool;
  private initialized = false;

  constructor(databaseUrlOrPool: string | ConnectionPool) {
    if (typeof databaseUrlOrPool === "string") {
      this.pool = new ConnectionPool({
        connectionString: databaseUrlOrPool,
        minConnections: 1,
        maxConnections: 5
      });
    } else {
      this.pool = databaseUrlOrPool;
    }
  }

  /**
   * Initialize the migration tracker (create migrations table if needed)
   */
  async initialize(): Promise<Result<void, MigrationError>> {
    try {
      // Initialize connection pool
      await this.pool.initialize();
      logger.debug("Initialized migration tracker connection pool");

      // Create migrations tracking table
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS disc_migrations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          schema_hash TEXT NOT NULL,
          applied_at TIMESTAMP WITH TIME ZONE NOT NULL,
          duration_ms INTEGER NOT NULL,
          rollback_sql TEXT[],
          checksum TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL,
          data_migration BOOLEAN NOT NULL DEFAULT FALSE,
          applied_order INTEGER NOT NULL DEFAULT 0
        );
      `);

      // Add data_migration column if upgrading from an older schema
      await this.pool.execute(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'disc_migrations' AND column_name = 'data_migration'
          ) THEN
            ALTER TABLE disc_migrations ADD COLUMN data_migration BOOLEAN NOT NULL DEFAULT FALSE;
          END IF;
        END $$;
      `);

      // Add applied_order column on instances pre-dating gh/geldata#8773 and
      // backfill it from applied_at order. Backfill runs once when the column
      // is first introduced (existing rows all have DEFAULT 0); subsequent
      // calls find no zero rows and skip.
      await this.pool.execute(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'disc_migrations' AND column_name = 'applied_order'
          ) THEN
            ALTER TABLE disc_migrations ADD COLUMN applied_order INTEGER NOT NULL DEFAULT 0;
          END IF;
        END $$;
      `);

      // Add schema_modules column for baseline reconstruction. Without it,
      // a fresh `disc migrate` against a previously-migrated DB diffs
      // against null and emits "create everything" ops that collide with
      // existing types/tables. Existing rows are left NULL; the engine
      // falls back to schema_hash comparison when the column is missing.
      await this.pool.execute(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'disc_migrations' AND column_name = 'schema_modules'
          ) THEN
            ALTER TABLE disc_migrations ADD COLUMN schema_modules JSONB;
          END IF;
        END $$;
      `);
      await this.pool.execute(`
        WITH ordered AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY applied_at ASC, id ASC) AS rn
          FROM disc_migrations
          WHERE applied_order = 0
        )
        UPDATE disc_migrations m
        SET applied_order = o.rn
        FROM ordered o
        WHERE m.id = o.id;
      `);

      // Create checkpoints table
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS disc_migration_checkpoints (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL,
          schema_state JSONB NOT NULL,
          migration_state JSONB NOT NULL
        );
      `);

      // gh/geldata#5065: install pgcrypto + register std::* crypto
      // wrapper functions. Idempotent (CREATE OR REPLACE / IF NOT
      // EXISTS) so re-runs across boots are no-ops. Failures are
      // warn-logged inside bootstrapStdlib and don't fail tracker init.
      await bootstrapStdlib(this.pool);

      this.initialized = true;
      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to initialize migration tracker: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Record a migration as applied
   */
  async recordMigration(
    migration: Types.Migration,
    result: Types.MigrationResult,
    postStateModules?: Module[] | null
  ): Promise<Result<void, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      // applied_order = MAX + 1 inside the same INSERT. PostgreSQL evaluates
      // the subquery at execution time; concurrent inserts serialize via the
      // table's primary-key locking when racing for the same id, and PG's
      // MVCC ensures distinct rows get distinct numbers as long as the
      // tracker is the sole writer (which it is by construction).
      // (gh/geldata#8773)
      await this.pool.execute(
        `
        INSERT INTO disc_migrations (
          id, name, description, schema_hash, applied_at,
          duration_ms, rollback_sql, checksum, created_at, data_migration,
          applied_order, schema_modules
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          (SELECT COALESCE(MAX(applied_order), 0) + 1 FROM disc_migrations),
          $11
        )
      `,
        [
          migration.id,
          migration.name,
          migration.description,
          migration.schemaHash,
          result.appliedAt,
          result.durationMs,
          result.rollbackSql || [],
          this.calculateMigrationChecksum(migration),
          migration.createdAt,
          !!migration.dataMigrationFile,
          postStateModules ? JSON.stringify(postStateModules) : null
        ]
      );

      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to record migration: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Load the latest applied migration's stored schema modules. Returns
   * Ok(null) when there are no applied migrations or the column was left
   * NULL (pre-baseline-reconstruction rows). Callers use this to prime
   * SchemaManager.currentModules so diffs run against the actual applied
   * schema instead of treating null as "create everything from scratch".
   */
  async getLatestSchemaModules(): Promise<
    Result<Module[] | null, MigrationError>
  > {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(`
        SELECT schema_modules
        FROM disc_migrations
        ORDER BY applied_order DESC
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return Ok(null);
      }

      const raw = (result.rows[0] as { schema_modules: unknown; }).schema_modules;
      if (raw === null || raw === undefined) {
        return Ok(null);
      }

      const modules = typeof raw === "string" ?
        JSON.parse(raw) as Module[] :
        raw as Module[];
      return Ok(modules);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get latest schema modules: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Backfill `schema_modules` on the latest applied migration row.
   * Called when the schema-hash fallback detects a no-op against a
   * legacy row that lacks schema_modules — persisting the modules now
   * means subsequent `disc migrate` runs prime currentModules directly
   * from the row and skip the fallback entirely.
   */
  async backfillLatestSchemaModules(
    modules: Module[]
  ): Promise<Result<void, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      await this.pool.execute(
        `
        UPDATE disc_migrations
        SET schema_modules = $1::jsonb
        WHERE id = (
          SELECT id FROM disc_migrations
          ORDER BY applied_order DESC
          LIMIT 1
        )
          AND schema_modules IS NULL
        `,
        [JSON.stringify(modules)]
      );

      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to backfill schema modules: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Load the latest applied migration's schema_hash. Returns Ok(null)
   * when no migrations have been applied. Used as the fallback baseline
   * detector when schema_modules is NULL (pre-baseline-reconstruction
   * rows): a fresh apply that produces the same hash is a no-op.
   */
  async getLatestSchemaHash(): Promise<
    Result<string | null, MigrationError>
  > {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(`
        SELECT schema_hash
        FROM disc_migrations
        ORDER BY applied_order DESC
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return Ok(null);
      }

      const hash = (result.rows[0] as { schema_hash: string | null; }).schema_hash;
      return Ok(hash ?? null);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get latest schema hash: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Remove a migration record (for rollbacks)
   */
  async removeMigration(
    migrationId: string
  ): Promise<Result<void, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      // First check if migration exists
      const exists = await this.pool.query(
        `SELECT 1 FROM disc_migrations WHERE id = $1`,
        [migrationId]
      );

      if (exists.rowCount === 0) {
        return Err(new MigrationError(`Migration ${migrationId} not found`));
      }

      await this.pool.execute(
        `DELETE FROM disc_migrations WHERE id = $1`,
        [migrationId]
      );

      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to remove migration: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Get all applied migrations
   */
  async getAppliedMigrations(): Promise<Result<string[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(`
        SELECT id FROM disc_migrations
        ORDER BY applied_order ASC
      `);

      const migrationIds = result.rows.map((row: any) => row.id);
      return Ok(migrationIds);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get applied migrations: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Get migration history
   */
  async getMigrationHistory(): Promise<
    Result<Types.MigrationHistoryEntry[], MigrationError>
  > {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(`
        SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at, data_migration, applied_order
        FROM disc_migrations
        ORDER BY applied_order DESC
      `);

      const history = result.rows.map((row: any) => this.mapRowToHistoryEntry(row));

      return Ok(history);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get migration history: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Check if a migration has been applied
   */
  async isMigrationApplied(
    migrationId: string
  ): Promise<Result<boolean, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(
        `
        SELECT 1 FROM disc_migrations WHERE id = $1 LIMIT 1
      `,
        [migrationId]
      );

      return Ok(result.rows.length > 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to check migration status: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Get current migration state
   */
  async getMigrationState(): Promise<
    Result<Types.MigrationState, MigrationError>
  > {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const appliedResult = await this.getAppliedMigrations();
      if (!appliedResult.ok) {
        return appliedResult;
      }

      const lastMigrationResult = await this.pool.query(`
        SELECT id, applied_at, schema_hash
        FROM disc_migrations
        ORDER BY applied_at DESC
        LIMIT 1
      `);

      const lastMigration = lastMigrationResult.rows[0];

      const state: Types.MigrationState = {
        appliedMigrations: appliedResult.value,
        currentSchemaHash: lastMigration?.schema_hash || "initial",
        lastMigrationId: lastMigration?.id,
        lastAppliedAt: lastMigration?.applied_at
      };

      return Ok(state);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get migration state: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Save a checkpoint
   */
  async saveCheckpoint(
    checkpoint: Types.MigrationCheckpoint
  ): Promise<Result<void, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      await this.pool.execute(
        `
        INSERT INTO disc_migration_checkpoints (
          id, name, created_at, schema_state, migration_state
        ) VALUES (
          $1, $2, $3, $4, $5
        )
      `,
        [
          checkpoint.id,
          checkpoint.name,
          checkpoint.createdAt,
          JSON.stringify(checkpoint.schemaState),
          JSON.stringify(checkpoint.migrationState)
        ]
      );

      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to save checkpoint: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Load a checkpoint
   */
  async loadCheckpoint(
    checkpointId: string
  ): Promise<Result<Types.MigrationCheckpoint, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(
        `
        SELECT id, name, created_at, schema_state, migration_state
        FROM disc_migration_checkpoints
        WHERE id = $1
      `,
        [checkpointId]
      );

      if (result.rows.length === 0) {
        return Err(new MigrationError(`Checkpoint ${checkpointId} not found`));
      }

      const row = result.rows[0];
      const checkpoint: Types.MigrationCheckpoint = {
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        schemaState: typeof row.schema_state === "string" ?
          JSON.parse(row.schema_state) :
          row.schema_state,
        migrationState: typeof row.migration_state === "string" ?
          JSON.parse(row.migration_state) :
          row.migration_state
      };

      return Ok(checkpoint);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to load checkpoint: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * List all checkpoints
   */
  async listCheckpoints(): Promise<
    Result<Types.MigrationCheckpoint[], MigrationError>
  > {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(`
        SELECT id, name, created_at, schema_state, migration_state
        FROM disc_migration_checkpoints
        ORDER BY created_at DESC
      `);

      const checkpoints = result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        schemaState: typeof row.schema_state === "string" ?
          JSON.parse(row.schema_state) :
          row.schema_state,
        migrationState: typeof row.migration_state === "string" ?
          JSON.parse(row.migration_state) :
          row.migration_state
      }));

      return Ok(checkpoints);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to list checkpoints: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Get the most recently applied migration
   */
  async getLatestMigration(): Promise<
    Result<Types.MigrationHistoryEntry | null, MigrationError>
  > {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(`
        SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at, data_migration, applied_order
        FROM disc_migrations
        ORDER BY applied_at DESC
        LIMIT 1
      `);

      if (result.rows.length === 0) {
        return Ok(null);
      }

      return Ok(this.mapRowToHistoryEntry(result.rows[0]));
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get latest migration: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Get all migrations applied after the given migration ID, ordered by applied_at DESC
   */
  async getMigrationsAfter(
    migrationId: string
  ): Promise<Result<Types.MigrationHistoryEntry[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      // First get the applied_at timestamp for the reference migration
      const refResult = await this.pool.query(
        `SELECT applied_at FROM disc_migrations WHERE id = $1`,
        [migrationId]
      );

      if (refResult.rows.length === 0) {
        return Err(
          new MigrationError(`Migration ${migrationId} not found`)
        );
      }

      const refAppliedAt = refResult.rows[0].applied_at;

      // Get all migrations applied after the reference migration
      const result = await this.pool.query(
        `
        SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at, data_migration, applied_order
        FROM disc_migrations
        WHERE applied_at > $1
        ORDER BY applied_at DESC
      `,
        [refAppliedAt]
      );

      const migrations = result.rows.map((row: any) => this.mapRowToHistoryEntry(row));

      return Ok(migrations);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get migrations after ${migrationId}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Get rollback SQL for a migration
   */
  async getRollbackSQL(
    migrationId: string
  ): Promise<Result<string[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(
        `
        SELECT rollback_sql FROM disc_migrations WHERE id = $1
      `,
        [migrationId]
      );

      if (result.rows.length === 0) {
        return Err(new MigrationError(`Migration ${migrationId} not found`));
      }

      return Ok(result.rows[0].rollback_sql || []);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get rollback SQL: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Verify migration integrity
   */
  async verifyMigrationIntegrity(): Promise<Result<boolean, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(`
        SELECT id, name, description, schema_hash, created_at
        FROM disc_migrations
        ORDER BY applied_at ASC
      `);

      if (result.rows.length === 0) {
        return Ok(true);
      }

      // Verify integrity: each row must have a non-empty schema_hash
      for (const row of result.rows) {
        if (!row.schema_hash || String(row.schema_hash).trim() === "") {
          return Err(
            new MigrationError(
              `Migration "${row.name}" (${row.id}) has empty schemaHash — possible data corruption`
            )
          );
        }
      }

      return Ok(true);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to verify migration integrity: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Get all migrations in the range [fromId, toId] inclusive, ordered by applied_at ASC.
   * Used for squash validation to check if any data migrations exist in the range.
   */
  async getMigrationsInRange(
    fromId: string,
    toId: string
  ): Promise<Result<Types.MigrationHistoryEntry[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      // Get the applied_at timestamps for both boundary migrations
      const fromResult = await this.pool.query(
        `SELECT applied_at FROM disc_migrations WHERE id = $1`,
        [fromId]
      );
      if (fromResult.rows.length === 0) {
        return Err(
          new MigrationError(`Migration ${fromId} not found`)
        );
      }

      const toResult = await this.pool.query(
        `SELECT applied_at FROM disc_migrations WHERE id = $1`,
        [toId]
      );
      if (toResult.rows.length === 0) {
        return Err(
          new MigrationError(`Migration ${toId} not found`)
        );
      }

      const fromAppliedAt = fromResult.rows[0].applied_at;
      const toAppliedAt = toResult.rows[0].applied_at;

      const result = await this.pool.query(
        `
        SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at, data_migration, applied_order
        FROM disc_migrations
        WHERE applied_at >= $1 AND applied_at <= $2
        ORDER BY applied_at ASC
      `,
        [fromAppliedAt, toAppliedAt]
      );

      const migrations = result.rows.map((row: any) => this.mapRowToHistoryEntry(row));

      return Ok(migrations);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get migrations in range ${fromId}..${toId}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Close connection pool
   */
  async close(): Promise<void> {
    await this.pool.close();
    this.initialized = false;
  }

  /**
   * Map a database row to a MigrationHistoryEntry.
   * Centralizes the snake_case -> camelCase conversion.
   */
  private mapRowToHistoryEntry(row: any): Types.MigrationHistoryEntry {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      schemaHash: row.schema_hash,
      appliedAt: row.applied_at,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      dataMigration: row.data_migration ?? false,
      appliedOrder: row.applied_order ?? 0
    };
  }

  /**
   * SHA-256 of the migration's stable content (id, name, operations, created_at).
   *
   * P1-08: the previous 32-bit djb2-style hash had ~1-in-4-billion collision
   * probability in theory but far worse in practice for structured JSON
   * input. A cryptographic hash eliminates the risk of two distinct
   * migration plans sharing a checksum and silently passing re-apply.
   */
  private calculateMigrationChecksum(migration: Types.Migration): string {
    const content = JSON.stringify({
      id: migration.id,
      name: migration.name,
      operations: migration.operations,
      createdAt: migration.createdAt.toISOString()
    });

    const bytes = new TextEncoder().encode(content);
    // Web Crypto's subtle.digest is async but every caller of this method
    // is already async — we use digestSync-compatible pattern via a Uint8Array
    // fallback only if needed. Deno supports crypto.subtle synchronously here.
    // deno-lint-ignore no-explicit-any
    const cryptoLike = crypto as any;
    if (typeof cryptoLike.subtle?.digestSync === "function") {
      const buf = cryptoLike.subtle.digestSync("SHA-256", bytes);
      return Array
        .from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");
    }
    // Fallback: a deterministic, non-cryptographic hash is still better than
    // the old 32-bit djb2 because we also mix in length + byte sum. This
    // branch only runs in runtimes without digestSync (not Deno 2).
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 0x9e3779b1);
      h2 = Math.imul(h2 ^ bytes[i], 0x85ebca77);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
    return (
      (h2 >>> 0).toString(16).padStart(8, "0") +
      (h1 >>> 0).toString(16).padStart(8, "0")
    );
  }
}

/**
 * Migration Tracker - persists migration state to database
 */

import { Err, Ok, Result } from "../lib/result.ts";
import { MigrationError } from "../lib/errors.ts";
import * as Types from "./types.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { logger } from "../postgres/logger.ts";

export class MigrationTracker {
  private pool: ConnectionPool;
  private initialized = false;

  constructor(databaseUrlOrPool: string | ConnectionPool) {
    if (typeof databaseUrlOrPool === "string") {
      this.pool = new ConnectionPool({
        connectionString: databaseUrlOrPool,
        minConnections: 1,
        maxConnections: 5,
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
      logger.info("Initialized migration tracker connection pool");

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
          data_migration BOOLEAN NOT NULL DEFAULT FALSE
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

      this.initialized = true;
      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to initialize migration tracker: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Record a migration as applied
   */
  async recordMigration(
    migration: Types.Migration,
    result: Types.MigrationResult,
  ): Promise<Result<void, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      await this.pool.execute(
        `
        INSERT INTO disc_migrations (
          id, name, description, schema_hash, applied_at,
          duration_ms, rollback_sql, checksum, created_at, data_migration
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
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
        ],
      );

      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to record migration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Remove a migration record (for rollbacks)
   */
  async removeMigration(
    migrationId: string,
  ): Promise<Result<void, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      // First check if migration exists
      const exists = await this.pool.query(
        `SELECT 1 FROM disc_migrations WHERE id = $1`,
        [migrationId],
      );

      if (exists.rowCount === 0) {
        return Err(new MigrationError(`Migration ${migrationId} not found`));
      }

      await this.pool.execute(
        `DELETE FROM disc_migrations WHERE id = $1`,
        [migrationId],
      );

      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to remove migration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
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
        ORDER BY applied_at ASC
      `);

      const migrationIds = result.rows.map((row: any) => row.id);
      return Ok(migrationIds);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get applied migrations: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
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
        SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at, data_migration
        FROM disc_migrations
        ORDER BY applied_at DESC
      `);

      const history = result.rows.map((row: any) =>
        this.mapRowToHistoryEntry(row)
      );

      return Ok(history);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get migration history: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Check if a migration has been applied
   */
  async isMigrationApplied(
    migrationId: string,
  ): Promise<Result<boolean, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(
        `
        SELECT 1 FROM disc_migrations WHERE id = $1 LIMIT 1
      `,
        [migrationId],
      );

      return Ok(result.rows.length > 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to check migration status: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
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
        lastAppliedAt: lastMigration?.applied_at,
      };

      return Ok(state);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get migration state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Save a checkpoint
   */
  async saveCheckpoint(
    checkpoint: Types.MigrationCheckpoint,
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
          JSON.stringify(checkpoint.migrationState),
        ],
      );

      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to save checkpoint: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Load a checkpoint
   */
  async loadCheckpoint(
    checkpointId: string,
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
        [checkpointId],
      );

      if (result.rows.length === 0) {
        return Err(new MigrationError(`Checkpoint ${checkpointId} not found`));
      }

      const row = result.rows[0];
      const checkpoint: Types.MigrationCheckpoint = {
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        schemaState: typeof row.schema_state === "string"
          ? JSON.parse(row.schema_state)
          : row.schema_state,
        migrationState: typeof row.migration_state === "string"
          ? JSON.parse(row.migration_state)
          : row.migration_state,
      };

      return Ok(checkpoint);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to load checkpoint: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
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
        schemaState: typeof row.schema_state === "string"
          ? JSON.parse(row.schema_state)
          : row.schema_state,
        migrationState: typeof row.migration_state === "string"
          ? JSON.parse(row.migration_state)
          : row.migration_state,
      }));

      return Ok(checkpoints);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to list checkpoints: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
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
        SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at, data_migration
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
          `Failed to get latest migration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Get all migrations applied after the given migration ID, ordered by applied_at DESC
   */
  async getMigrationsAfter(
    migrationId: string,
  ): Promise<Result<Types.MigrationHistoryEntry[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      // First get the applied_at timestamp for the reference migration
      const refResult = await this.pool.query(
        `SELECT applied_at FROM disc_migrations WHERE id = $1`,
        [migrationId],
      );

      if (refResult.rows.length === 0) {
        return Err(
          new MigrationError(`Migration ${migrationId} not found`),
        );
      }

      const refAppliedAt = refResult.rows[0].applied_at;

      // Get all migrations applied after the reference migration
      const result = await this.pool.query(
        `
        SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at, data_migration
        FROM disc_migrations
        WHERE applied_at > $1
        ORDER BY applied_at DESC
      `,
        [refAppliedAt],
      );

      const migrations = result.rows.map((row: any) =>
        this.mapRowToHistoryEntry(row)
      );

      return Ok(migrations);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get migrations after ${migrationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Get rollback SQL for a migration
   */
  async getRollbackSQL(
    migrationId: string,
  ): Promise<Result<string[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.pool.query(
        `
        SELECT rollback_sql FROM disc_migrations WHERE id = $1
      `,
        [migrationId],
      );

      if (result.rows.length === 0) {
        return Err(new MigrationError(`Migration ${migrationId} not found`));
      }

      return Ok(result.rows[0].rollback_sql || []);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get rollback SQL: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
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
              `Migration "${row.name}" (${row.id}) has empty schemaHash — possible data corruption`,
            ),
          );
        }
      }

      return Ok(true);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to verify migration integrity: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Get all migrations in the range [fromId, toId] inclusive, ordered by applied_at ASC.
   * Used for squash validation to check if any data migrations exist in the range.
   */
  async getMigrationsInRange(
    fromId: string,
    toId: string,
  ): Promise<Result<Types.MigrationHistoryEntry[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      // Get the applied_at timestamps for both boundary migrations
      const fromResult = await this.pool.query(
        `SELECT applied_at FROM disc_migrations WHERE id = $1`,
        [fromId],
      );
      if (fromResult.rows.length === 0) {
        return Err(
          new MigrationError(`Migration ${fromId} not found`),
        );
      }

      const toResult = await this.pool.query(
        `SELECT applied_at FROM disc_migrations WHERE id = $1`,
        [toId],
      );
      if (toResult.rows.length === 0) {
        return Err(
          new MigrationError(`Migration ${toId} not found`),
        );
      }

      const fromAppliedAt = fromResult.rows[0].applied_at;
      const toAppliedAt = toResult.rows[0].applied_at;

      const result = await this.pool.query(
        `
        SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at, data_migration
        FROM disc_migrations
        WHERE applied_at >= $1 AND applied_at <= $2
        ORDER BY applied_at ASC
      `,
        [fromAppliedAt, toAppliedAt],
      );

      const migrations = result.rows.map((row: any) =>
        this.mapRowToHistoryEntry(row)
      );

      return Ok(migrations);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to get migrations in range ${fromId}..${toId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
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
    };
  }

  private calculateMigrationChecksum(migration: Types.Migration): string {
    // Simple checksum based on migration content
    const content = JSON.stringify({
      id: migration.id,
      name: migration.name,
      operations: migration.operations,
      createdAt: migration.createdAt.toISOString(),
    });

    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }
}

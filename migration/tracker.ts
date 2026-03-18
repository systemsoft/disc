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
          schemaHash TEXT NOT NULL,
          appliedAt TIMESTAMP WITH TIME ZONE NOT NULL,
          durationMs INTEGER NOT NULL,
          rollbackSql TEXT[],
          checksum TEXT NOT NULL,
          createdAt TIMESTAMP WITH TIME ZONE NOT NULL
        );
      `);

      // Create checkpoints table
      await this.pool.execute(`
        CREATE TABLE IF NOT EXISTS disc_migration_checkpoints (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          createdAt TIMESTAMP WITH TIME ZONE NOT NULL,
          schemaState JSONB NOT NULL,
          migrationState JSONB NOT NULL
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
          id, name, description, schemaHash, appliedAt, 
          durationMs, rollbackSql, checksum, createdAt
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9
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
        ORDER BY appliedAt ASC
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
        SELECT id, name, description, schemaHash, appliedAt, durationMs, createdAt
        FROM disc_migrations 
        ORDER BY appliedAt DESC
      `);

      const history = result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        schemaHash: row.schemaHash,
        appliedAt: row.appliedAt,
        durationMs: row.durationMs,
        createdAt: row.createdAt,
      }));

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
        SELECT id, appliedAt, schemaHash 
        FROM disc_migrations 
        ORDER BY appliedAt DESC 
        LIMIT 1
      `);

      const lastMigration = lastMigrationResult.rows[0];

      const state: Types.MigrationState = {
        appliedMigrations: appliedResult.value,
        currentSchemaHash: lastMigration?.schemaHash || "initial",
        lastMigrationId: lastMigration?.id,
        lastAppliedAt: lastMigration?.appliedAt,
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
          id, name, createdAt, schemaState, migrationState
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
        SELECT id, name, createdAt, schemaState, migrationState
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
        createdAt: row.createdAt,
        schemaState: typeof row.schemaState === "string"
          ? JSON.parse(row.schemaState)
          : row.schemaState,
        migrationState: typeof row.migrationState === "string"
          ? JSON.parse(row.migrationState)
          : row.migrationState,
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
        SELECT id, name, createdAt, schemaState, migrationState
        FROM disc_migration_checkpoints 
        ORDER BY createdAt DESC
      `);

      const checkpoints = result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        schemaState: typeof row.schemaState === "string"
          ? JSON.parse(row.schemaState)
          : row.schemaState,
        migrationState: typeof row.migrationState === "string"
          ? JSON.parse(row.migrationState)
          : row.migrationState,
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
        SELECT rollbackSql FROM disc_migrations WHERE id = $1
      `,
        [migrationId],
      );

      if (result.rows.length === 0) {
        return Err(new MigrationError(`Migration ${migrationId} not found`));
      }

      return Ok(result.rows[0].rollbackSql || []);
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
        SELECT id, name, description, schemaHash, createdAt
        FROM disc_migrations 
        ORDER BY appliedAt ASC
      `);

      if (result.rows.length === 0) {
        return Ok(true);
      }

      // Verify integrity: each row must have a non-empty schemaHash
      for (const row of result.rows) {
        if (!row.schemaHash || String(row.schemaHash).trim() === "") {
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
   * Close connection pool
   */
  async close(): Promise<void> {
    await this.pool.close();
    this.initialized = false;
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

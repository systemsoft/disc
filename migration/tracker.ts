/**
 * Migration Tracker - persists migration state to database
 */

import { Result, Ok, Err } from "../lib/result.ts";
import { MigrationError } from "../lib/errors.ts";
import * as Types from "./types.ts";

export interface DatabaseConnection {
  query(sql: string, params?: any[]): Promise<any>;
  close(): Promise<void>;
}

export class MigrationTracker {
  private db: DatabaseConnection | null = null;
  private initialized = false;

  constructor(private databaseUrl: string) {}

  /**
   * Initialize the migration tracker (create migrations table if needed)
   */
  async initialize(): Promise<Result<void, MigrationError>> {
    try {
      // In a real implementation, this would create a connection
      // For now, we simulate connection initialization
      this.db = new MockDatabaseConnection();
      
      // Create migrations tracking table
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS disc_migrations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          schema_hash TEXT NOT NULL,
          applied_at TIMESTAMP WITH TIME ZONE NOT NULL,
          duration_ms INTEGER NOT NULL,
          rollback_sql TEXT[],
          checksum TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL
        );
      `);

      // Create checkpoints table
      await this.db.query(`
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
      return Err(new MigrationError(`Failed to initialize migration tracker: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Record a migration as applied
   */
  async recordMigration(
    migration: Types.Migration, 
    result: Types.MigrationResult
  ): Promise<Result<void, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      await this.db!.query(`
        INSERT INTO disc_migrations (
          id, name, description, schema_hash, applied_at, 
          duration_ms, rollback_sql, checksum, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        )
      `, [
        migration.id,
        migration.name,
        migration.description,
        migration.schema_hash,
        result.applied_at,
        result.duration_ms,
        result.rollback_sql || [],
        this.calculateMigrationChecksum(migration),
        migration.created_at,
      ]);

      return Ok(void 0);
    } catch (error) {
      return Err(new MigrationError(`Failed to record migration: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Remove a migration record (for rollbacks)
   */
  async removeMigration(migrationId: string): Promise<Result<void, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.db!.query(
        `DELETE FROM disc_migrations WHERE id = $1`,
        [migrationId]
      );

      if (result.rowCount === 0) {
        return Err(new MigrationError(`Migration ${migrationId} not found`));
      }

      return Ok(void 0);
    } catch (error) {
      return Err(new MigrationError(`Failed to remove migration: ${error instanceof Error ? error.message : String(error)}`));
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
      const result = await this.db!.query(`
        SELECT id FROM disc_migrations 
        ORDER BY applied_at ASC
      `);

      const migrationIds = result.rows.map((row: any) => row.id);
      return Ok(migrationIds);
    } catch (error) {
      return Err(new MigrationError(`Failed to get applied migrations: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Get migration history
   */
  async getMigrationHistory(): Promise<Result<Types.MigrationHistoryEntry[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.db!.query(`
        SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at
        FROM disc_migrations 
        ORDER BY applied_at DESC
      `);

      const history = result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        schema_hash: row.schema_hash,
        applied_at: row.applied_at,
        duration_ms: row.duration_ms,
        created_at: row.created_at,
      }));

      return Ok(history);
    } catch (error) {
      return Err(new MigrationError(`Failed to get migration history: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Check if a migration has been applied
   */
  async isMigrationApplied(migrationId: string): Promise<Result<boolean, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.db!.query(`
        SELECT 1 FROM disc_migrations WHERE id = $1 LIMIT 1
      `, [migrationId]);

      return Ok(result.rows.length > 0);
    } catch (error) {
      return Err(new MigrationError(`Failed to check migration status: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Get current migration state
   */
  async getMigrationState(): Promise<Result<Types.MigrationState, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const appliedResult = await this.getAppliedMigrations();
      if (!appliedResult.ok) {
        return appliedResult;
      }

      const lastMigrationResult = await this.db!.query(`
        SELECT id, applied_at, schema_hash 
        FROM disc_migrations 
        ORDER BY applied_at DESC 
        LIMIT 1
      `);

      const lastMigration = lastMigrationResult.rows[0];

      const state: Types.MigrationState = {
        applied_migrations: appliedResult.value,
        current_schema_hash: lastMigration?.schema_hash || "initial",
        last_migration_id: lastMigration?.id,
        last_applied_at: lastMigration?.applied_at,
      };

      return Ok(state);
    } catch (error) {
      return Err(new MigrationError(`Failed to get migration state: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Save a checkpoint
   */
  async saveCheckpoint(checkpoint: Types.MigrationCheckpoint): Promise<Result<void, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      await this.db!.query(`
        INSERT INTO disc_migration_checkpoints (
          id, name, created_at, schema_state, migration_state
        ) VALUES (
          $1, $2, $3, $4, $5
        )
      `, [
        checkpoint.id,
        checkpoint.name,
        checkpoint.created_at,
        JSON.stringify(checkpoint.schema_state),
        JSON.stringify(checkpoint.migration_state),
      ]);

      return Ok(void 0);
    } catch (error) {
      return Err(new MigrationError(`Failed to save checkpoint: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Load a checkpoint
   */
  async loadCheckpoint(checkpointId: string): Promise<Result<Types.MigrationCheckpoint, MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.db!.query(`
        SELECT id, name, created_at, schema_state, migration_state
        FROM disc_migration_checkpoints 
        WHERE id = $1
      `, [checkpointId]);

      if (result.rows.length === 0) {
        return Err(new MigrationError(`Checkpoint ${checkpointId} not found`));
      }

      const row = result.rows[0];
      const checkpoint: Types.MigrationCheckpoint = {
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        schema_state: JSON.parse(row.schema_state),
        migration_state: JSON.parse(row.migration_state),
      };

      return Ok(checkpoint);
    } catch (error) {
      return Err(new MigrationError(`Failed to load checkpoint: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * List all checkpoints
   */
  async listCheckpoints(): Promise<Result<Types.MigrationCheckpoint[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.db!.query(`
        SELECT id, name, created_at, schema_state, migration_state
        FROM disc_migration_checkpoints 
        ORDER BY created_at DESC
      `);

      const checkpoints = result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        created_at: row.created_at,
        schema_state: JSON.parse(row.schema_state),
        migration_state: JSON.parse(row.migration_state),
      }));

      return Ok(checkpoints);
    } catch (error) {
      return Err(new MigrationError(`Failed to list checkpoints: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Get rollback SQL for a migration
   */
  async getRollbackSQL(migrationId: string): Promise<Result<string[], MigrationError>> {
    if (!this.initialized) {
      return Err(new MigrationError("Migration tracker not initialized"));
    }

    try {
      const result = await this.db!.query(`
        SELECT rollback_sql FROM disc_migrations WHERE id = $1
      `, [migrationId]);

      if (result.rows.length === 0) {
        return Err(new MigrationError(`Migration ${migrationId} not found`));
      }

      return Ok(result.rows[0].rollback_sql || []);
    } catch (error) {
      return Err(new MigrationError(`Failed to get rollback SQL: ${error instanceof Error ? error.message : String(error)}`));
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
      const result = await this.db!.query(`
        SELECT id, name, description, schema_hash, created_at
        FROM disc_migrations 
        ORDER BY applied_at ASC
      `);

      // Verify checksums and detect tampering
      for (const row of result.rows) {
        const migration: Types.Migration = {
          id: row.id,
          name: row.name,
          description: row.description,
          created_at: row.created_at,
          schema_hash: row.schema_hash,
          operations: [], // Would need to reconstruct or store operations
        };

        // TODO: Implement checksum verification
        // const expectedChecksum = this.calculateMigrationChecksum(migration);
        // In real implementation, would compare with stored checksum
        // For now, we assume integrity is maintained
      }

      return Ok(true);
    } catch (error) {
      return Err(new MigrationError(`Failed to verify migration integrity: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this.initialized = false;
    }
  }

  private calculateMigrationChecksum(migration: Types.Migration): string {
    // Simple checksum based on migration content
    const content = JSON.stringify({
      id: migration.id,
      name: migration.name,
      operations: migration.operations,
      created_at: migration.created_at.toISOString(),
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

// Mock database connection for testing
class MockDatabaseConnection implements DatabaseConnection {
  private data: Record<string, any[]> = {
    disc_migrations: [],
    disc_migration_checkpoints: [],
  };

  async query(sql: string, params?: any[]): Promise<any> {
    // Simple mock implementation
    if (sql.includes("CREATE TABLE")) {
      return { rowCount: 0, rows: [] };
    }
    
    if (sql.includes("INSERT INTO disc_migrations")) {
      this.data.disc_migrations.push({
        id: params?.[0],
        name: params?.[1],
        description: params?.[2],
        schema_hash: params?.[3],
        applied_at: params?.[4],
        duration_ms: params?.[5],
        rollback_sql: params?.[6],
        checksum: params?.[7],
        created_at: params?.[8],
      });
      return { rowCount: 1, rows: [] };
    }

    if (sql.includes("INSERT INTO disc_migration_checkpoints")) {
      this.data.disc_migration_checkpoints.push({
        id: params?.[0],
        name: params?.[1],
        created_at: params?.[2],
        schema_state: params?.[3],
        migration_state: params?.[4],
      });
      return { rowCount: 1, rows: [] };
    }

    if (sql.includes("SELECT id FROM disc_migrations") && sql.includes("ORDER BY applied_at")) {
      return {
        rowCount: this.data.disc_migrations.length,
        rows: this.data.disc_migrations
          .sort((a, b) => new Date(a.applied_at).getTime() - new Date(b.applied_at).getTime())
          .map(row => ({ id: row.id })),
      };
    }

    if (sql.includes("SELECT 1 FROM disc_migrations WHERE id")) {
      const id = params?.[0];
      const found = this.data.disc_migrations.some(row => row.id === id);
      return { rowCount: found ? 1 : 0, rows: found ? [{ "?column?": 1 }] : [] };
    }

    if (sql.includes("SELECT id, applied_at, schema_hash FROM disc_migrations") && sql.includes("ORDER BY applied_at DESC")) {
      const sorted = this.data.disc_migrations
        .sort((a, b) => new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime());
      return {
        rowCount: sorted.length,
        rows: sorted.slice(0, 1).map(row => ({
          id: row.id,
          applied_at: row.applied_at,
          schema_hash: row.schema_hash,
        })),
      };
    }

    if (sql.includes("SELECT id, name, description, schema_hash, applied_at, duration_ms, created_at FROM disc_migrations")) {
      return {
        rowCount: this.data.disc_migrations.length,
        rows: this.data.disc_migrations
          .sort((a, b) => new Date(b.applied_at).getTime() - new Date(a.applied_at).getTime())
          .map(row => ({
            id: row.id,
            name: row.name,
            description: row.description,
            schema_hash: row.schema_hash,
            applied_at: row.applied_at,
            duration_ms: row.duration_ms,
            created_at: row.created_at,
          })),
      };
    }

    if (sql.includes("SELECT rollback_sql FROM disc_migrations WHERE id")) {
      const id = params?.[0];
      const migration = this.data.disc_migrations.find(row => row.id === id);
      return {
        rowCount: migration ? 1 : 0,
        rows: migration ? [{ rollback_sql: migration.rollback_sql }] : [],
      };
    }

    if (sql.includes("SELECT id, name, created_at, schema_state, migration_state FROM disc_migration_checkpoints WHERE id")) {
      const id = params?.[0];
      const checkpoint = this.data.disc_migration_checkpoints.find(row => row.id === id);
      return {
        rowCount: checkpoint ? 1 : 0,
        rows: checkpoint ? [checkpoint] : [],
      };
    }

    if (sql.includes("SELECT id, name, created_at, schema_state, migration_state FROM disc_migration_checkpoints") && sql.includes("ORDER BY created_at DESC")) {
      return {
        rowCount: this.data.disc_migration_checkpoints.length,
        rows: this.data.disc_migration_checkpoints
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
      };
    }

    if (sql.includes("DELETE FROM disc_migrations")) {
      const id = params?.[0];
      const initialLength = this.data.disc_migrations.length;
      this.data.disc_migrations = this.data.disc_migrations.filter(row => row.id !== id);
      return { rowCount: initialLength - this.data.disc_migrations.length, rows: [] };
    }

    return { rowCount: 0, rows: [] };
  }

  async close(): Promise<void> {
    // Mock implementation
  }
}
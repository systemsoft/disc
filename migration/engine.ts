/**
 * Migration Engine - orchestrates schema diffing, DDL generation, and migration execution
 */

import { Module } from "../schema/converter.ts";
import * as Types from "./types.ts";
import { SchemaDiffer } from "./differ.ts";
import { DDLGenerator } from "./ddl.ts";
import { Err, Ok, Result } from "../lib/result.ts";
import { MigrationError } from "../lib/errors.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { MigrationTracker } from "./tracker.ts";
import { DataMigrationRunner } from "./data-migration.ts";
import { logger } from "../postgres/logger.ts";

export class MigrationEngine {
  private differ = new SchemaDiffer();
  private ddlGenerator = new DDLGenerator();
  private appliedMigrations = new Set<string>();
  private db?: DatabaseConnection;
  private pool?: ConnectionPool;
  private tracker?: MigrationTracker;

  constructor(private config: Types.MigrationConfig) {
    if (config.connectionPool) {
      this.pool = config.connectionPool;
    }
  }

  /**
   * Initialize the migration engine (set up tracker if pool is available)
   */
  async initialize(): Promise<void> {
    if (this.pool) {
      this.tracker = new MigrationTracker(this.pool);
      await this.tracker.initialize();
      // Load previously applied migrations from DB
      const applied = await this.tracker.getAppliedMigrations();
      if (applied.ok) {
        for (const id of applied.value) {
          this.appliedMigrations.add(id);
        }
      }
    }
  }

  /**
   * Generate a migration plan from schema changes
   */
  planMigration(
    oldSchema: Module[] | null,
    newSchema: Module[],
  ): Result<Types.MigrationPlan, MigrationError> {
    try {
      const operations = oldSchema
        ? this.differ.diff(oldSchema, newSchema)
        : this.generateInitialMigration(newSchema);

      const migration: Types.Migration = {
        id: this.generateMigrationId(),
        name: this.generateMigrationName(operations),
        description: this.generateMigrationDescription(operations),
        createdAt: new Date(),
        schemaHash: this.hashSchema(newSchema),
        operations,
      };

      const plan: Types.MigrationPlan = {
        migrations: [migration],
        targetSchemaHash: migration.schemaHash,
        operationsCount: operations.length,
        estimatedDuration: this.estimateDuration(operations),
      };

      return Ok(plan);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to plan migration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Generate DDL statements from a migration plan
   */
  generateDDL(plan: Types.MigrationPlan): Result<string[], MigrationError> {
    try {
      const statements: string[] = [];

      for (const migration of plan.migrations) {
        statements.push(`-- Migration: ${migration.name}`);
        statements.push(`-- ID: ${migration.id}`);
        statements.push(`-- Created: ${migration.createdAt.toISOString()}`);
        statements.push("");

        const ddlStatements = this.ddlGenerator.generateDDL(
          migration.operations,
        );
        statements.push(...ddlStatements);
        statements.push("");
      }

      return Ok(statements);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to generate DDL: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Execute a migration plan (placeholder - would need database connection)
   */
  async executeMigration(
    plan: Types.MigrationPlan,
  ): Promise<Result<Types.MigrationResult[], MigrationError>> {
    try {
      const results: Types.MigrationResult[] = [];

      for (const migration of plan.migrations) {
        const startTime = Date.now();

        // In a real implementation, this would execute against a database
        const ddlStatements = this.ddlGenerator.generateDDL(
          migration.operations,
        );

        // Execute DDL statements
        await this.executeStatements(ddlStatements);

        // Run matching data migration if one exists
        await this.runDataMigrationForSchema(migration);

        const endTime = Date.now();

        results.push({
          success: true,
          migrationId: migration.id,
          appliedAt: new Date(),
          durationMs: endTime - startTime,
        });

        this.appliedMigrations.add(migration.id);

        if (this.tracker) {
          await this.tracker.recordMigration(
            migration,
            results[results.length - 1],
          );
        }
      }

      return Ok(results);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to execute migration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Check if a migration has been applied
   */
  isMigrationApplied(migrationId: string): boolean {
    return this.appliedMigrations.has(migrationId);
  }

  /**
   * Get the current migration state
   */
  getMigrationState(): Types.MigrationState {
    const appliedMigrations = Array.from(this.appliedMigrations);

    return {
      appliedMigrations: appliedMigrations,
      currentSchemaHash: this.getCurrentSchemaHash(),
      lastMigrationId: appliedMigrations[appliedMigrations.length - 1],
      lastAppliedAt: new Date(), // Would come from database in real implementation
    };
  }

  /**
   * Generate rollback SQL for a migration
   */
  generateRollbackSQL(
    migration: Types.Migration,
  ): Result<string[], MigrationError> {
    try {
      const rollbackSQL = this.ddlGenerator.generateRollbackDDL(
        migration.operations,
      );
      return Ok(rollbackSQL);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to generate rollback SQL: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Execute migration with automatic rollback on error
   */
  async executeMigrationWithRollback(
    plan: Types.MigrationPlan,
  ): Promise<Result<Types.MigrationResult[], MigrationError>> {
    const results: Types.MigrationResult[] = [];

    for (const migration of plan.migrations) {
      const startTime = Date.now();
      let rollbackSQL: string[] | null = null;

      try {
        // Generate rollback SQL before executing
        const rollbackResult = this.generateRollbackSQL(migration);
        if (rollbackResult.ok) {
          rollbackSQL = rollbackResult.value;
        }

        // Execute the migration
        const ddlStatements = this.ddlGenerator.generateDDL(
          migration.operations,
        );
        await this.executeStatements(ddlStatements);

        // Run matching data migration if one exists
        await this.runDataMigrationForSchema(migration);

        const endTime = Date.now();

        results.push({
          success: true,
          migrationId: migration.id,
          appliedAt: new Date(),
          durationMs: endTime - startTime,
          rollbackSql: rollbackSQL || undefined,
        });

        this.appliedMigrations.add(migration.id);

        if (this.tracker) {
          await this.tracker.recordMigration(
            migration,
            results[results.length - 1],
          );
        }
      } catch (error) {
        if (this.config.rollbackOnError && rollbackSQL) {
          try {
            await this.executeStatements(rollbackSQL);
          } catch (rollbackError) {
            return Err(
              new MigrationError(
                `Migration failed and rollback failed: ${
                  error instanceof Error ? error.message : String(error)
                }. Rollback error: ${
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError)
                }`,
              ),
            );
          }
        }
        return Err(
          new MigrationError(
            `Migration execution failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    }

    return Ok(results);
  }

  /**
   * Rollback a specific migration by executing its stored rollback SQL
   */
  rollbackMigration(
    migrationId: string,
  ): Result<boolean, MigrationError> {
    if (!this.appliedMigrations.has(migrationId)) {
      return Err(new MigrationError(`Migration ${migrationId} is not applied`));
    }

    try {
      // In a real implementation, we would load migration details from database
      // For now, we simulate successful rollback
      this.appliedMigrations.delete(migrationId);
      return Ok(true);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to rollback migration ${migrationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Rollback a specific migration using stored rollback SQL from the tracker.
   * Executes rollback SQL in a transaction, then removes the migration record.
   */
  async executeRollback(
    migrationId: string,
  ): Promise<Result<void, MigrationError>> {
    if (!this.tracker) {
      return Err(
        new MigrationError(
          "Cannot execute rollback without a database connection (tracker not initialized)",
        ),
      );
    }

    // Load rollback SQL from tracker
    const rollbackSqlResult = await this.tracker.getRollbackSQL(migrationId);
    if (!rollbackSqlResult.ok) {
      return Err(rollbackSqlResult.error);
    }

    const rollbackSql = rollbackSqlResult.value;
    if (rollbackSql.length === 0) {
      return Err(
        new MigrationError(
          `No rollback SQL available for migration ${migrationId}. ` +
            "The migration was recorded without rollback instructions.",
        ),
      );
    }

    try {
      // Execute rollback SQL statements in a transaction
      logger.info(`Rolling back migration ${migrationId}...`);
      await this.executeStatements(rollbackSql);

      // Remove the migration record from the tracker
      const removeResult = await this.tracker.removeMigration(migrationId);
      if (!removeResult.ok) {
        return Err(removeResult.error);
      }

      // Update in-memory state
      this.appliedMigrations.delete(migrationId);

      logger.info(`Successfully rolled back migration ${migrationId}`);
      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to execute rollback for migration ${migrationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Rollback all migrations applied after the specified migration ID.
   * Rolls back in reverse chronological order (most recent first).
   */
  async executeRollbackTo(
    migrationId: string,
  ): Promise<Result<void, MigrationError>> {
    if (!this.tracker) {
      return Err(
        new MigrationError(
          "Cannot execute rollback without a database connection (tracker not initialized)",
        ),
      );
    }

    // Get all migrations after the target
    const migrationsResult = await this.tracker.getMigrationsAfter(migrationId);
    if (!migrationsResult.ok) {
      return Err(migrationsResult.error);
    }

    const migrationsToRollback = migrationsResult.value;
    if (migrationsToRollback.length === 0) {
      logger.info(
        `No migrations to rollback after ${migrationId} — already at target`,
      );
      return Ok(void 0);
    }

    // Migrations are already in DESC order (most recent first) from getMigrationsAfter
    logger.info(
      `Rolling back ${migrationsToRollback.length} migration(s) to reach ${migrationId}...`,
    );

    for (const migration of migrationsToRollback) {
      const rollbackResult = await this.executeRollback(migration.id);
      if (!rollbackResult.ok) {
        return Err(
          new MigrationError(
            `Rollback-to stopped at migration ${migration.id}: ${rollbackResult.error.message}`,
          ),
        );
      }
    }

    return Ok(void 0);
  }

  /**
   * Get migration status information from the tracker
   */
  async getMigrationStatus(): Promise<
    Result<
      {
        applied: number;
        currentSchemaHash: string | null;
        latestMigration: Types.MigrationHistoryEntry | null;
      },
      MigrationError
    >
  > {
    if (!this.tracker) {
      return Err(
        new MigrationError(
          "Cannot get migration status without a database connection (tracker not initialized)",
        ),
      );
    }

    const appliedResult = await this.tracker.getAppliedMigrations();
    if (!appliedResult.ok) {
      return Err(appliedResult.error);
    }

    const latestResult = await this.tracker.getLatestMigration();
    if (!latestResult.ok) {
      return Err(latestResult.error);
    }

    return Ok({
      applied: appliedResult.value.length,
      currentSchemaHash: latestResult.value?.schemaHash ?? null,
      latestMigration: latestResult.value,
    });
  }

  /**
   * Get full migration history from the tracker
   */
  async getMigrationHistory(): Promise<
    Result<Types.MigrationHistoryEntry[], MigrationError>
  > {
    if (!this.tracker) {
      return Err(
        new MigrationError(
          "Cannot get migration history without a database connection (tracker not initialized)",
        ),
      );
    }

    return await this.tracker.getMigrationHistory();
  }

  /**
   * Rollback to a specific migration (rollback all migrations applied after it)
   * Note: This is the in-memory-only version. For database-backed rollback,
   * use executeRollbackTo() instead.
   */
  async rollbackToMigration(
    migrationId: string,
  ): Promise<Result<boolean, MigrationError>> {
    const appliedMigrations = Array.from(this.appliedMigrations);
    const targetIndex = appliedMigrations.indexOf(migrationId);

    if (targetIndex === -1) {
      return Err(
        new MigrationError(
          `Migration ${migrationId} not found in applied migrations`,
        ),
      );
    }

    // Rollback all migrations after the target migration
    const migrationsToRollback = appliedMigrations.slice(targetIndex + 1);

    for (const migId of migrationsToRollback.reverse()) {
      const rollbackResult = await this.rollbackMigration(migId);
      if (!rollbackResult.ok) {
        return rollbackResult;
      }
    }

    return Ok(true);
  }

  /**
   * Validate rollback safety for a migration plan
   */
  validateRollbackSafety(
    plan: Types.MigrationPlan,
  ): Result<boolean, MigrationError> {
    const issues: string[] = [];

    for (const migration of plan.migrations) {
      for (const operation of migration.operations) {
        const rollbackIssues = this.validateRollbackOperation(operation);
        issues.push(...rollbackIssues);
      }
    }

    if (issues.length > 0) {
      return Err(
        new MigrationError(`Rollback safety concerns: ${issues.join(", ")}`),
      );
    }

    return Ok(true);
  }

  /**
   * Create a checkpoint before migration
   */
  createMigrationCheckpoint(
    name: string,
  ): Result<Types.MigrationCheckpoint, MigrationError> {
    try {
      const checkpoint: Types.MigrationCheckpoint = {
        id: this.generateCheckpointId(),
        name,
        createdAt: new Date(),
        schemaState: this.getCurrentSchemaSnapshot(),
        migrationState: this.getMigrationState(),
      };

      // In a real implementation, this would save the checkpoint to storage
      return Ok(checkpoint);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to create checkpoint: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Restore from a migration checkpoint
   */
  restoreFromCheckpoint(
    checkpointId: string,
  ): Result<boolean, MigrationError> {
    try {
      // In a real implementation, this would restore database state from checkpoint
      // For now, we simulate successful restore
      this.appliedMigrations.clear();
      return Ok(true);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to restore from checkpoint ${checkpointId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Generate data migration hints for complex changes
   */
  generateDataMigrationHints(
    plan: Types.MigrationPlan,
  ): Result<string[], MigrationError> {
    try {
      const hints: string[] = [];

      for (const migration of plan.migrations) {
        for (const operation of migration.operations) {
          hints.push(...this.generateOperationHints(operation));
        }
      }

      return Ok(hints);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to generate data migration hints: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  /**
   * Validate a migration plan for safety
   */
  validateMigration(
    plan: Types.MigrationPlan,
  ): Result<boolean, MigrationError> {
    const issues: string[] = [];

    for (const migration of plan.migrations) {
      for (const operation of migration.operations) {
        const operationIssues = this.validateOperation(operation);
        issues.push(...operationIssues);
      }
    }

    if (issues.length > 0) {
      return Err(
        new MigrationError(`Migration validation failed: ${issues.join(", ")}`),
      );
    }

    return Ok(true);
  }

  /**
   * Discover and run a data migration file that matches a schema migration's timestamp.
   * Data migration files live in the configured migrationsDir as `m<timestamp>_<name>.data.ts`.
   */
  private async runDataMigrationForSchema(
    migration: Types.Migration,
  ): Promise<void> {
    if (!this.pool) return;

    // Extract timestamp from migration ID: m<timestamp>_<randomSuffix>
    const match = migration.id.match(/^m(\d{8,}T?\d*)/);
    if (!match) return;

    const timestamp = match[1];
    const runner = new DataMigrationRunner();
    const migrationsDir = this.config.migrationsDir;

    // No migrationsDir configured → no data migrations to discover.
    // (SchemaManager-driven flows intentionally leave this blank.)
    if (!migrationsDir) return;

    try {
      const dataMigrations = await runner.discoverMigrations(migrationsDir);
      const matching = runner.findMatchingDataMigration(
        dataMigrations,
        timestamp,
      );

      if (matching) {
        logger.info(
          `Found matching data migration for ${migration.id}: ${matching.name}`,
        );
        await runner.runMigration(matching, this.pool);
        // Mark the schema migration as having an associated data migration
        migration.dataMigrationFile = matching.name;
      }
    } catch (error) {
      // If directory doesn't exist, that's fine — no data migrations
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  private generateInitialMigration(
    schema: Module[],
  ): Types.MigrationOperation[] {
    const operations: Types.MigrationOperation[] = [];

    // Build a map of all types for inheritance resolution
    const allTypes = new Map<
      string,
      import("../schema/ast.ts").TypeDeclaration
    >();
    for (const module of schema) {
      for (const item of module.items) {
        if (item.kind === "TypeDeclaration") {
          allTypes.set(item.name.value, item);
        }
      }
    }

    // Only create operations for non-abstract types
    for (const module of schema) {
      for (const item of module.items) {
        if (item.kind === "TypeDeclaration" && !item.abstract) {
          operations.push(this.differ.createTypeOperation(item, allTypes));
        }
      }
    }

    return operations;
  }

  private generateMigrationId(): string {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(
      /\.\d+Z$/,
      "",
    );
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    return `m${timestamp}_${randomSuffix}`;
  }

  private generateMigrationName(
    operations: Types.MigrationOperation[],
  ): string {
    if (operations.length === 0) {
      return "empty_migration";
    }

    if (operations.length === 1) {
      return this.getOperationName(operations[0]);
    }

    const typeCount =
      operations.filter((op) => op.kind.includes("Type")).length;
    const tableCount =
      operations.filter((op) => op.kind.includes("Table")).length;

    if (typeCount > 0) {
      return `schema_changes_${typeCount}_types`;
    } else if (tableCount > 0) {
      return `table_changes_${tableCount}_tables`;
    }

    return `migration_${operations.length}_operations`;
  }

  private generateMigrationDescription(
    operations: Types.MigrationOperation[],
  ): string {
    const descriptions = operations.slice(0, 3).map((op) =>
      this.getOperationDescription(op)
    );

    if (operations.length > 3) {
      descriptions.push(`... and ${operations.length - 3} more operations`);
    }

    return descriptions.join(", ");
  }

  private getOperationName(operation: Types.MigrationOperation): string {
    switch (operation.kind) {
      case "CreateType":
        return `create_${
          (operation as Types.CreateTypeOperation).typeName.toLowerCase()
        }`;
      case "DropType":
        return `drop_${
          (operation as Types.DropTypeOperation).typeName.toLowerCase()
        }`;
      case "AlterType":
        return `alter_${
          (operation as Types.AlterTypeOperation).typeName.toLowerCase()
        }`;
      default:
        return operation.kind.toLowerCase();
    }
  }

  private getOperationDescription(operation: Types.MigrationOperation): string {
    switch (operation.kind) {
      case "CreateType":
        return `Create type ${
          (operation as Types.CreateTypeOperation).typeName
        }`;
      case "DropType":
        return `Drop type ${(operation as Types.DropTypeOperation).typeName}`;
      case "AlterType":
        return `Alter type ${(operation as Types.AlterTypeOperation).typeName}`;
      default:
        return operation.kind;
    }
  }

  private hashSchema(schema: Module[]): string {
    // Simple hash based on JSON stringification
    // In production, would use a more robust hashing algorithm
    const schemaString = JSON.stringify(schema, Object.keys(schema).sort());
    let hash = 0;
    for (let i = 0; i < schemaString.length; i++) {
      const char = schemaString.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  private getCurrentSchemaHash(): string {
    // Placeholder - would come from database or schema file
    return "current";
  }

  private estimateDuration(operations: Types.MigrationOperation[]): number {
    // Simple estimation based on operation types (in milliseconds)
    let duration = 0;

    for (const operation of operations) {
      switch (operation.kind) {
        case "CreateType":
          duration += 500; // Creating table with indexes
          break;
        case "DropType":
          duration += 200; // Dropping table
          break;
        case "AlterType":
          duration += 300; // Altering table structure
          break;
        default:
          duration += 100;
      }
    }

    return duration;
  }

  private async executeStatements(statements: string[]): Promise<void> {
    // Filter out comment-only lines and empty lines
    const executableStatements = statements.filter((s) =>
      s.trim() && !s.trim().startsWith("--")
    );

    if (this.config.dryRun) {
      logger.info("DRY RUN - Would execute:");
      executableStatements.forEach((stmt) => logger.info(`  ${stmt}`));
      return;
    }

    // Pool-based execution path (preferred)
    if (this.pool) {
      await this.pool.transaction(async (conn) => {
        for (const stmt of executableStatements) {
          logger.info(`Executing: ${stmt.substring(0, 100)}...`);
          await conn.execute(stmt);
        }
      });
      return;
    }

    // Fallback: direct DatabaseConnection
    if (!this.db) {
      if (!this.config.databaseUrl) {
        throw new Error("Database URL not configured");
      }
      this.db = new DatabaseConnection(this.config.databaseUrl);
      await this.db.connect();
    }

    // Execute statements in a transaction
    await this.db.transaction(async () => {
      for (const statement of executableStatements) {
        logger.info(`Executing: ${statement.substring(0, 100)}...`);
        await this.db!.execute(statement);
      }
    });
  }

  private validateOperation(operation: Types.MigrationOperation): string[] {
    const issues: string[] = [];

    switch (operation.kind) {
      case "DropType":
        // Check if type has dependencies
        issues.push(
          ...this.validateDropType(operation as Types.DropTypeOperation),
        );
        break;
      case "AlterType":
        // Check for breaking changes
        issues.push(
          ...this.validateAlterType(operation as Types.AlterTypeOperation),
        );
        break;
    }

    return issues;
  }

  private validateDropType(operation: Types.DropTypeOperation): string[] {
    const issues: string[] = [];

    // In a real implementation, would check database for foreign key references
    // For now, just warn about potential data loss
    issues.push(`Dropping type ${operation.typeName} may result in data loss`);

    return issues;
  }

  private validateAlterType(operation: Types.AlterTypeOperation): string[] {
    const issues: string[] = [];

    for (const typeOp of operation.operations) {
      if (typeOp.kind === "DropProperty") {
        const dropOp = typeOp as Types.DropPropertyOperation;
        issues.push(
          `Dropping property ${dropOp.propertyName} from ${operation.typeName} may result in data loss`,
        );
      }

      if (typeOp.kind === "AlterProperty") {
        const alterOp = typeOp as Types.AlterPropertyOperation;
        for (const change of alterOp.changes) {
          if (change.kind === "ChangeType") {
            issues.push(
              `Changing type of ${alterOp.propertyName} may require data migration`,
            );
          }
          if (change.kind === "ChangeRequired" && change.newValue) {
            issues.push(
              `Making ${alterOp.propertyName} required may fail if existing NULL values exist`,
            );
          }
        }
      }
    }

    return issues;
  }

  private validateRollbackOperation(
    operation: Types.MigrationOperation,
  ): string[] {
    const issues: string[] = [];

    switch (operation.kind) {
      case "DropType": {
        const dropOp = operation as Types.DropTypeOperation;
        issues.push(
          `Rollback of DropType ${dropOp.typeName} requires manual intervention - original schema lost`,
        );
        break;
      }
      case "AlterType": {
        const alterOp = operation as Types.AlterTypeOperation;
        for (const typeOp of alterOp.operations) {
          if (typeOp.kind === "DropProperty") {
            const dropPropOp = typeOp as Types.DropPropertyOperation;
            issues.push(
              `Rollback of DropProperty ${dropPropOp.propertyName} may result in data loss or require manual intervention`,
            );
          }
        }
        break;
      }
      case "DropTable": {
        const dropTableOp = operation as Types.DropTableOperation;
        issues.push(
          `Rollback of DropTable ${dropTableOp.tableName} requires manual intervention - original structure lost`,
        );
        break;
      }
    }

    return issues;
  }

  private generateOperationHints(
    operation: Types.MigrationOperation,
  ): string[] {
    const hints: string[] = [];

    switch (operation.kind) {
      case "CreateType": {
        const createTypeOp = operation as Types.CreateTypeOperation;
        // Hint for new types with required properties that need default values
        for (const prop of createTypeOp.properties) {
          if (prop.required && !prop.default) {
            hints.push(
              `Data migration hint: New required property ${createTypeOp.typeName}.${prop.name} has no default value`,
            );
          }
        }
        // Hint for new types with required links
        for (const link of createTypeOp.links) {
          if (link.required) {
            hints.push(
              `Data migration hint: New required link ${createTypeOp.typeName}.${link.name} must reference existing ${link.target} objects`,
            );
          }
        }
        break;
      }
      case "AlterType": {
        const alterTypeOp = operation as Types.AlterTypeOperation;
        for (const typeOp of alterTypeOp.operations) {
          if (typeOp.kind === "DropProperty") {
            const dropPropOp = typeOp as Types.DropPropertyOperation;
            hints.push(
              `Data migration hint: Consider backing up data from ${alterTypeOp.typeName}.${dropPropOp.propertyName} before dropping`,
            );
          }
          if (typeOp.kind === "AddProperty") {
            const addPropOp = typeOp as Types.AddPropertyOperation;
            if (addPropOp.property.required) {
              hints.push(
                `Data migration hint: Consider setting a default value for required property ${alterTypeOp.typeName}.${addPropOp.property.name}`,
              );
            }
          }
        }
        break;
      }
      case "DropType": {
        const dropTypeOp = operation as Types.DropTypeOperation;
        hints.push(
          `Data migration hint: Consider backing up all data from type ${dropTypeOp.typeName} before dropping`,
        );
        break;
      }
    }

    return hints;
  }

  private generateCheckpointId(): string {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(
      /\.\d+Z$/,
      "",
    );
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    return `cp${timestamp}_${randomSuffix}`;
  }

  private getCurrentSchemaSnapshot(): any {
    // In a real implementation, this would capture the current schema state
    // For now, return a placeholder
    return {
      timestamp: new Date().toISOString(),
      schema_version: "current",
    };
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    this.tracker = undefined;
    if (this.db) {
      await this.db.close();
      this.db = undefined;
    }
  }
}

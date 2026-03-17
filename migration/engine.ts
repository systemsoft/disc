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
import { logger } from "../postgres/logger.ts";

export class MigrationEngine {
  private differ = new SchemaDiffer();
  private ddlGenerator = new DDLGenerator();
  private appliedMigrations = new Set<string>();
  private db?: DatabaseConnection;
  private pool?: ConnectionPool;
  private tracker?: MigrationTracker;

  constructor(private config: Types.MigrationConfig) {
    if (config.connection_pool) {
      this.pool = config.connection_pool;
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
        created_at: new Date(),
        schema_hash: this.hashSchema(newSchema),
        operations,
      };

      const plan: Types.MigrationPlan = {
        migrations: [migration],
        target_schema_hash: migration.schema_hash,
        operations_count: operations.length,
        estimated_duration: this.estimateDuration(operations),
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
        statements.push(`-- Created: ${migration.created_at.toISOString()}`);
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

        const endTime = Date.now();

        results.push({
          success: true,
          migration_id: migration.id,
          applied_at: new Date(),
          duration_ms: endTime - startTime,
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
      applied_migrations: appliedMigrations,
      current_schema_hash: this.getCurrentSchemaHash(),
      last_migration_id: appliedMigrations[appliedMigrations.length - 1],
      last_applied_at: new Date(), // Would come from database in real implementation
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

        const endTime = Date.now();

        results.push({
          success: true,
          migration_id: migration.id,
          applied_at: new Date(),
          duration_ms: endTime - startTime,
          rollback_sql: rollbackSQL || undefined,
        });

        this.appliedMigrations.add(migration.id);

        if (this.tracker) {
          await this.tracker.recordMigration(
            migration,
            results[results.length - 1],
          );
        }
      } catch (error) {
        if (this.config.rollback_on_error && rollbackSQL) {
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
   * Rollback a specific migration
   */
  async rollbackMigration(
    migrationId: string,
  ): Promise<Result<boolean, MigrationError>> {
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
   * Rollback to a specific migration (rollback all migrations applied after it)
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
  async createMigrationCheckpoint(
    name: string,
  ): Promise<Result<Types.MigrationCheckpoint, MigrationError>> {
    try {
      const checkpoint: Types.MigrationCheckpoint = {
        id: this.generateCheckpointId(),
        name,
        created_at: new Date(),
        schema_state: this.getCurrentSchemaSnapshot(),
        migration_state: this.getMigrationState(),
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
  async restoreFromCheckpoint(
    checkpointId: string,
  ): Promise<Result<boolean, MigrationError>> {
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
          (operation as Types.CreateTypeOperation).type_name.toLowerCase()
        }`;
      case "DropType":
        return `drop_${
          (operation as Types.DropTypeOperation).type_name.toLowerCase()
        }`;
      case "AlterType":
        return `alter_${
          (operation as Types.AlterTypeOperation).type_name.toLowerCase()
        }`;
      default:
        return operation.kind.toLowerCase();
    }
  }

  private getOperationDescription(operation: Types.MigrationOperation): string {
    switch (operation.kind) {
      case "CreateType":
        return `Create type ${
          (operation as Types.CreateTypeOperation).type_name
        }`;
      case "DropType":
        return `Drop type ${(operation as Types.DropTypeOperation).type_name}`;
      case "AlterType":
        return `Alter type ${
          (operation as Types.AlterTypeOperation).type_name
        }`;
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

    if (this.config.dry_run) {
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
      if (!this.config.database_url) {
        throw new Error("Database URL not configured");
      }
      this.db = new DatabaseConnection(this.config.database_url);
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
    issues.push(`Dropping type ${operation.type_name} may result in data loss`);

    return issues;
  }

  private validateAlterType(operation: Types.AlterTypeOperation): string[] {
    const issues: string[] = [];

    for (const typeOp of operation.operations) {
      if (typeOp.kind === "DropProperty") {
        const dropOp = typeOp as Types.DropPropertyOperation;
        issues.push(
          `Dropping property ${dropOp.property_name} from ${operation.type_name} may result in data loss`,
        );
      }

      if (typeOp.kind === "AlterProperty") {
        const alterOp = typeOp as Types.AlterPropertyOperation;
        for (const change of alterOp.changes) {
          if (change.kind === "ChangeType") {
            issues.push(
              `Changing type of ${alterOp.property_name} may require data migration`,
            );
          }
          if (change.kind === "ChangeRequired" && change.new_value) {
            issues.push(
              `Making ${alterOp.property_name} required may fail if existing NULL values exist`,
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
          `Rollback of DropType ${dropOp.type_name} requires manual intervention - original schema lost`,
        );
        break;
      }
      case "AlterType": {
        const alterOp = operation as Types.AlterTypeOperation;
        for (const typeOp of alterOp.operations) {
          if (typeOp.kind === "DropProperty") {
            const dropPropOp = typeOp as Types.DropPropertyOperation;
            issues.push(
              `Rollback of DropProperty ${dropPropOp.property_name} may result in data loss or require manual intervention`,
            );
          }
        }
        break;
      }
      case "DropTable": {
        const dropTableOp = operation as Types.DropTableOperation;
        issues.push(
          `Rollback of DropTable ${dropTableOp.table_name} requires manual intervention - original structure lost`,
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
              `Data migration hint: New required property ${createTypeOp.type_name}.${prop.name} has no default value`,
            );
          }
        }
        // Hint for new types with required links
        for (const link of createTypeOp.links) {
          if (link.required) {
            hints.push(
              `Data migration hint: New required link ${createTypeOp.type_name}.${link.name} must reference existing ${link.target} objects`,
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
              `Data migration hint: Consider backing up data from ${alterTypeOp.type_name}.${dropPropOp.property_name} before dropping`,
            );
          }
          if (typeOp.kind === "AddProperty") {
            const addPropOp = typeOp as Types.AddPropertyOperation;
            if (addPropOp.property.required) {
              hints.push(
                `Data migration hint: Consider setting a default value for required property ${alterTypeOp.type_name}.${addPropOp.property.name}`,
              );
            }
          }
        }
        break;
      }
      case "DropType": {
        const dropTypeOp = operation as Types.DropTypeOperation;
        hints.push(
          `Data migration hint: Consider backing up all data from type ${dropTypeOp.type_name} before dropping`,
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

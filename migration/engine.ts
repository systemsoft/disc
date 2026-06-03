/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Migration Engine - orchestrates schema diffing, DDL generation, and migration execution
 */

import { ConnectionPool } from "../lib/connection-pool.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { MigrationError } from "../lib/errors.ts";
import { Err, Ok, Result } from "../lib/result.ts";
import { logger } from "../postgres/logger.ts";
import { Module } from "../schema/converter.ts";
import { DataMigrationRunner } from "./data-migration.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { MigrationTracker } from "./tracker.ts";
import * as Types from "./types.ts";

export class MigrationEngine {
  private differ = new SchemaDiffer();
  private ddlGenerator = new DDLGenerator();
  private appliedMigrations = new Set<string>();
  private db?: DatabaseConnection;
  private pool?: ConnectionPool;
  private tracker?: MigrationTracker;
  /**
   * Cached post-state modules from the latest applied migration. Populated
   * during `initialize()` from `disc_migrations.schema_modules`. SchemaManager
   * reads this via `getLatestAppliedModules()` to prime `currentModules` so
   * a fresh CLI `disc migrate` diffs against the actual applied schema
   * rather than null.
   */
  private latestAppliedModules: Module[] | null = null;
  /**
   * Cached schema_hash from the latest applied migration. Used as the
   * fallback "is this a no-op?" check when `latestAppliedModules` is null
   * (migrations recorded before the schema_modules column existed).
   */
  private latestAppliedSchemaHash: string | null = null;

  constructor(private config: Types.MigrationConfig) {
    if (config.connectionPool)
      this.pool = config.connectionPool;
  }

  /**
   * Emit a progress event to the configured listener. Listener errors are
   * swallowed and logged at warn level so listener bugs never break a
   * migration. (gh/geldata#7490)
   */
  private emit(event: Types.MigrationProgressEvent): void {
    if (!this.config.onProgress)
      return;

    try {
      this.config.onProgress(event);
    } catch (err) {
      logger.warn("migration progress listener threw", {
        error: err instanceof Error ? err.message : String(err),
        kind: event.kind
      });
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

      // Load the post-state schema of the latest applied migration so
      // SchemaManager can prime its `currentModules` baseline. Without
      // this, a fresh `disc migrate` against a previously-migrated DB
      // diffs against null and emits "create everything" ops that
      // collide with existing types/tables.
      const modules = await this.tracker.getLatestSchemaModules();

      if (modules.ok && modules.value !== null)
        this.latestAppliedModules = modules.value;

      // Also cache the latest schema_hash as a fallback baseline
      // detector for rows that pre-date the schema_modules column.
      const hash = await this.tracker.getLatestSchemaHash();

      if (hash.ok && hash.value !== null)
        this.latestAppliedSchemaHash = hash.value;
    }
  }

  /**
   * Return the post-state schema modules of the latest applied migration
   * (null when no migrations are recorded or the latest row pre-dates the
   * schema_modules column). SchemaManager calls this in `initialize()` to
   * prime its `currentModules` baseline.
   */
  getLatestAppliedModules(): Module[] | null {
    return this.latestAppliedModules;
  }

  /**
   * Return the schema_hash of the latest applied migration, or null if no
   * migrations have been recorded. Used as the fallback "is this a no-op?"
   * detector when `getLatestAppliedModules()` returns null.
   */
  getLatestAppliedSchemaHash(): string | null {
    return this.latestAppliedSchemaHash;
  }

  /**
   * Compute the stable hash of the given schema in the same format used
   * for `disc_migrations.schema_hash`. Exposed so SchemaManager can detect
   * the no-op case when only `latestAppliedSchemaHash` is available
   * (legacy rows without stored schema_modules): if the on-disk schema
   * hashes to the stored value, the new migrate is a no-op.
   */
  hashSchemaForBaseline(schema: Module[]): string {
    return this.hashSchema(schema);
  }

  /**
   * Number of migrations recorded in `disc_migrations`. Used by
   * SchemaManager to distinguish "fresh DB" from "DB has migrations but
   * we couldn't recover the baseline".
   */
  appliedMigrationCount(): number {
    return this.appliedMigrations.size;
  }

  /**
   * Backfill the post-state modules onto the latest applied migration
   * row. Called by SchemaManager when the schema-hash fallback detects
   * a no-op against a legacy row — persisting the modules means future
   * runs prime currentModules directly and skip the fallback.
   */
  async backfillLatestAppliedModules(modules: Module[]): Promise<void> {
    if (!this.tracker)
      return;

    const result = await this.tracker.backfillLatestSchemaModules(modules);

    if (result.ok)
      this.latestAppliedModules = modules;
    else
      logger.warn("failed to backfill schema_modules on latest row", { error: result.error.message });
  }

  /**
   * Generate a migration plan from schema changes
   */
  planMigration(oldSchema: Module[] | null, newSchema: Module[]): Result<Types.MigrationPlan, MigrationError> {
    try {
      // Prime the DDL generator's enum scalar registry from the
      // post-state schema. (gh/geldata#8517) Without this, properties
      // typed as a user-declared enum scalar (`status: Status`) would
      // emit columns of type TEXT instead of `disc_enum_status`. The
      // cascade reorder pass in the differ guarantees scalar
      // `CREATE TYPE`s fire before any column referencing them, so
      // setting the registry from `newSchema` is safe even mid-batch.
      this.ddlGenerator.setEnumScalars(this.differ.enumScalarNames(newSchema));

      const operations = oldSchema ?
        this.differ.diff(oldSchema, newSchema) :
        this.generateInitialMigration(newSchema);

      const migration: Types.Migration = {
        createdAt: new Date(),
        description: this.generateMigrationDescription(operations),
        id: this.generateMigrationId(),
        name: this.generateMigrationName(operations),
        operations,
        schemaHash: this.hashSchema(newSchema)
      };

      const plan: Types.MigrationPlan = {
        estimatedDuration: this.estimateDuration(operations),
        migrations: [migration],
        operationsCount: operations.length,
        targetSchemaHash: migration.schemaHash
      };

      return Ok(plan);
    } catch (error) {
      return Err(new MigrationError(`Failed to plan migration: ${error instanceof Error ? error.message : String(error)}`));
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

        const ddlStatements = this.ddlGenerator.generateDDL(migration.operations);
        statements.push(...ddlStatements);
        statements.push("");
      }

      return Ok(statements);
    } catch (error) {
      return Err(new MigrationError(`Failed to generate DDL: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Execute a migration plan against the configured database.
   *
   * `skipHistory` (gh/geldata#3761): when true, DDL still executes
   * but the engine doesn't record the migration in `disc_migrations`.
   * This is the path `disc db push` takes — push compacts a series
   * of dev iterations into the live schema without leaving migration
   * artifacts; a real `disc migrate` later sees the diff from the
   * recorded baseline to current and produces a single clean
   * migration.
   */
  async executeMigration(
    plan: Types.MigrationPlan,
    options?: { postStateModules?: Module[]; skipHistory?: boolean; }
  ): Promise<Result<Types.MigrationResult[], MigrationError>> {
    const planStartTime = Date.now();
    const results: Types.MigrationResult[] = [];

    this.emit({
      kind: "plan-started",
      totalMigrations: plan.migrations.length,
      totalOperations: plan.migrations.reduce((sum, m) => sum + m.operations.length, 0)
    });

    let migrationIndex = 0;

    for (const migration of plan.migrations) {
      migrationIndex += 1;
      const startTime = Date.now();

      this.emit({
        index: migrationIndex,
        kind: "migration-started",
        migrationId: migration.id,
        name: migration.name,
        total: plan.migrations.length
      });

      try {
        // In a real implementation, this would execute against a database
        const ddlStatements = this.ddlGenerator.generateDDL(migration.operations);

        if (ddlStatements.length > 0) {
          this.emit({
            kind: "ddl-executing",
            migrationId: migration.id,
            statementCount: ddlStatements.length
          });
        }

        // Execute DDL statements
        await this.executeStatements(ddlStatements);

        // Run matching data migration if one exists
        const dataMigrationName = await this.runDataMigrationForSchema(migration);

        if (dataMigrationName) {
          this.emit({
            kind: "data-migration-running",
            migrationId: migration.id
          });
        }

        const endTime = Date.now();

        results.push({
          appliedAt: new Date(),
          durationMs: endTime - startTime,
          migrationId: migration.id,
          success: true
        });

        this.appliedMigrations.add(migration.id);

        // Record in tracker unless caller asked to skip history
        // (gh/geldata#3761 — `disc db push` path).
        if (this.tracker && !options?.skipHistory) {
          await this.tracker.recordMigration(
            migration,
            results[results.length - 1],
            options?.postStateModules ?? null
          );

          // Refresh the cached baseline so subsequent plan/apply calls
          // on this engine instance see the just-applied state.
          if (options?.postStateModules)
            this.latestAppliedModules = options.postStateModules;

          this.latestAppliedSchemaHash = migration.schemaHash;
        }

        this.emit({
          durationMs: endTime - startTime,
          kind: "migration-completed",
          migrationId: migration.id
        });
      } catch (error) {
        const errorMessage = error instanceof Error ?
          error.message :
          String(error);

        const failureDuration = Date.now() - startTime;

        this.emit({
          durationMs: failureDuration,
          error: errorMessage,
          kind: "migration-failed",
          migrationId: migration.id,
          rollbackAttempted: false
        });

        this.emit({
          durationMs: Date.now() - planStartTime,
          error: errorMessage,
          kind: "plan-failed"
        });

        return Err(new MigrationError(`Failed to execute migration: ${errorMessage}`));
      }
    }

    this.emit({
      durationMs: Date.now() - planStartTime,
      kind: "plan-completed",
      migrationCount: results.length
    });

    return Ok(results);
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
      lastAppliedAt: new Date(), // Would come from database in real implementation
      lastMigrationId: appliedMigrations[appliedMigrations.length - 1]
    };
  }

  /**
   * Generate rollback SQL for a migration
   */
  generateRollbackSQL(migration: Types.Migration): Result<string[], MigrationError> {
    try {
      const rollbackSQL = this.ddlGenerator.generateRollbackDDL(migration.operations);
      return Ok(rollbackSQL);
    } catch (error) {
      return Err(new MigrationError(`Failed to generate rollback SQL: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Execute migration with automatic rollback on error
   */
  async executeMigrationWithRollback(
    plan: Types.MigrationPlan,
    options?: { postStateModules?: Module[]; }
  ): Promise<Result<Types.MigrationResult[], MigrationError>> {
    const planStartTime = Date.now();
    const results: Types.MigrationResult[] = [];

    this.emit({
      kind: "plan-started",
      totalMigrations: plan.migrations.length,
      totalOperations: plan.migrations.reduce((sum, m) => sum + m.operations.length, 0)
    });

    let migrationIndex = 0;

    for (const migration of plan.migrations) {
      migrationIndex += 1;
      const startTime = Date.now();
      let rollbackSQL: string[] | null = null;

      this.emit({
        index: migrationIndex,
        kind: "migration-started",
        migrationId: migration.id,
        name: migration.name,
        total: plan.migrations.length
      });

      try {
        // Generate rollback SQL before executing
        const rollbackResult = this.generateRollbackSQL(migration);

        if (rollbackResult.ok)
          rollbackSQL = rollbackResult.value;

        // Execute the migration
        const ddlStatements = this.ddlGenerator.generateDDL(migration.operations);

        if (ddlStatements.length > 0) {
          this.emit({
            kind: "ddl-executing",
            migrationId: migration.id,
            statementCount: ddlStatements.length
          });
        }

        await this.executeStatements(ddlStatements);

        // Run matching data migration if one exists
        const dataMigrationName = await this.runDataMigrationForSchema(migration);

        if (dataMigrationName) {
          this.emit({
            kind: "data-migration-running",
            migrationId: migration.id
          });
        }

        const endTime = Date.now();

        results.push({
          appliedAt: new Date(),
          durationMs: endTime - startTime,
          migrationId: migration.id,
          rollbackSql: rollbackSQL || undefined,
          success: true
        });

        this.appliedMigrations.add(migration.id);

        if (this.tracker) {
          await this.tracker.recordMigration(
            migration,
            results[results.length - 1],
            options?.postStateModules ?? null
          );

          if (options?.postStateModules)
            this.latestAppliedModules = options.postStateModules;

          this.latestAppliedSchemaHash = migration.schemaHash;
        }

        this.emit({
          durationMs: endTime - startTime,
          kind: "migration-completed",
          migrationId: migration.id
        });
      } catch (error) {
        const errorMessage = error instanceof Error ?
          error.message :
          String(error);

        const failureDuration = Date.now() - startTime;
        const rollbackAttempted = !!(this.config.rollbackOnError && rollbackSQL);

        this.emit({
          durationMs: failureDuration,
          error: errorMessage,
          kind: "migration-failed",
          migrationId: migration.id,
          rollbackAttempted
        });

        if (rollbackAttempted) {
          try {
            await this.executeStatements(rollbackSQL!);
          } catch (rollbackError) {
            const combined = `Migration failed and rollback failed: ${errorMessage}. Rollback error: ${
              rollbackError instanceof Error ?
                rollbackError.message :
                String(rollbackError)
            }`;

            this.emit({
              durationMs: Date.now() - planStartTime,
              error: combined,
              kind: "plan-failed"
            });

            return Err(new MigrationError(combined));
          }
        }

        const planFailureMessage = `Migration execution failed: ${errorMessage}`;

        this.emit({
          durationMs: Date.now() - planStartTime,
          error: planFailureMessage,
          kind: "plan-failed"
        });

        return Err(new MigrationError(planFailureMessage));
      }
    }

    this.emit({
      durationMs: Date.now() - planStartTime,
      kind: "plan-completed",
      migrationCount: results.length
    });

    return Ok(results);
  }

  /**
   * Rollback a specific migration by executing its stored rollback SQL
   */
  rollbackMigration(migrationId: string): Result<boolean, MigrationError> {
    if (!this.appliedMigrations.has(migrationId))
      return Err(new MigrationError(`Migration ${migrationId} is not applied`));

    try {
      // In a real implementation, we would load migration details from database
      // For now, we simulate successful rollback
      this.appliedMigrations.delete(migrationId);
      return Ok(true);
    } catch (error) {
      return Err(new MigrationError(`Failed to rollback migration ${migrationId}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Rollback a specific migration using stored rollback SQL from the tracker.
   * Executes rollback SQL in a transaction, then removes the migration record.
   */
  async executeRollback(migrationId: string): Promise<Result<void, MigrationError>> {
    if (!this.tracker)
      return Err(new MigrationError("Cannot execute rollback without a database connection (tracker not initialized)"));

    // Load rollback SQL from tracker
    const rollbackSqlResult = await this.tracker.getRollbackSQL(migrationId);

    if (!rollbackSqlResult.ok)
      return Err(rollbackSqlResult.error);

    const rollbackSql = rollbackSqlResult.value;

    if (rollbackSql.length === 0) {
      return Err(
        new MigrationError(`No rollback SQL available for migration ${migrationId}. The migration was recorded without rollback instructions.`)
      );
    }

    try {
      // Execute rollback SQL statements in a transaction
      logger.info(`Rolling back migration ${migrationId}…`);
      await this.executeStatements(rollbackSql);

      // Remove the migration record from the tracker
      const removeResult = await this.tracker.removeMigration(migrationId);

      if (!removeResult.ok)
        return Err(removeResult.error);

      // Update in-memory state
      this.appliedMigrations.delete(migrationId);

      logger.info(`Successfully rolled back migration ${migrationId}`);
      return Ok(void 0);
    } catch (error) {
      return Err(
        new MigrationError(`Failed to execute rollback for migration ${migrationId}: ${error instanceof Error ? error.message : String(error)}`)
      );
    }
  }

  /**
   * Rollback all migrations applied after the specified migration ID.
   * Rolls back in reverse chronological order (most recent first).
   */
  async executeRollbackTo(migrationId: string): Promise<Result<void, MigrationError>> {
    if (!this.tracker)
      return Err(new MigrationError("Cannot execute rollback without a database connection (tracker not initialized)"));

    // Get all migrations after the target
    const migrationsResult = await this.tracker.getMigrationsAfter(migrationId);

    if (!migrationsResult.ok)
      return Err(migrationsResult.error);

    const migrationsToRollback = migrationsResult.value;

    if (migrationsToRollback.length === 0) {
      logger.info(`No migrations to rollback after ${migrationId} — already at target`);
      return Ok(void 0);
    }

    // Migrations are already in DESC order (most recent first) from getMigrationsAfter
    logger.info(`Rolling back ${migrationsToRollback.length} migration(s) to reach ${migrationId}…`);

    for (const migration of migrationsToRollback) {
      const rollbackResult = await this.executeRollback(migration.id);
      if (!rollbackResult.ok) {
        return Err(
          new MigrationError(
            `Rollback-to stopped at migration ${migration.id}: ${rollbackResult.error.message}`
          )
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
          "Cannot get migration status without a database connection (tracker not initialized)"
        )
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
      latestMigration: latestResult.value
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
          "Cannot get migration history without a database connection (tracker not initialized)"
        )
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
    migrationId: string
  ): Promise<Result<boolean, MigrationError>> {
    const appliedMigrations = Array.from(this.appliedMigrations);
    const targetIndex = appliedMigrations.indexOf(migrationId);

    if (targetIndex === -1) {
      return Err(
        new MigrationError(
          `Migration ${migrationId} not found in applied migrations`
        )
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
    plan: Types.MigrationPlan
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
        new MigrationError(`Rollback safety concerns: ${issues.join(", ")}`)
      );
    }

    return Ok(true);
  }

  /**
   * Scan a forward-direction migration plan for operations that delete
   * data or schema definitions. The CLI uses this to refuse `disc migrate`
   * unless the operator passes `--unsafe`. Rollback already has its own
   * gate via `validateRollbackSafety`; this is the matching forward
   * gate. (gh/geldata#1838, gh/geldata#1840, gh/geldata#2564)
   *
   * Each entry carries a `classification` mirroring
   * `MigrationOperation.classification`:
   *
   *  - `"unsafe"`    — destructive (DropType, DropTable, DropProperty,
   *                    DropLink, RecreateScalar, DropScalar).
   *  - `"ambiguous"` — could be interpreted multiple ways
   *                    (`ChangeType` without an explicit cast,
   *                    `ChangeRequired` from optional → required without
   *                    a default, `ChangeMulti`/`ChangeCardinality` link
   *                    flips). The operator should clarify intent
   *                    before applying.
   *
   * Returns the list of unsafe + ambiguous operations. Empty list means
   * the plan is safe to apply unattended.
   *
   * The classifier also writes the verdict back onto each op via
   * `op.classification`, so non-CLI callers can render their own UX
   * (e.g. the admin UI) without re-running the gate.
   */
  classifyUnsafeOperations(
    plan: Types.MigrationPlan
  ): ReadonlyArray<
    {
      operation: string;
      reason: string;
      classification: "unsafe" | "ambiguous";
    }
  > {
    const flagged: {
      operation: string;
      reason: string;
      classification: "unsafe" | "ambiguous";
    }[] = [];

    const flagUnsafe = (
      op: Types.MigrationOperation,
      label: string,
      reason: string
    ) => {
      op.classification = "unsafe";
      flagged.push({ operation: label, reason, classification: "unsafe" });
    };
    const flagSafe = (op: Types.MigrationOperation) => {
      if (!op.classification) {
        op.classification = "safe";
      }
    };

    for (const migration of plan.migrations) {
      for (const op of migration.operations) {
        switch (op.kind) {
          case "DropType": {
            const drop = op as Types.DropTypeOperation;
            flagUnsafe(
              op,
              `DropType ${drop.typeName}`,
              "drops the table and all rows; data is unrecoverable from migration history alone"
            );
            break;
          }
          case "DropTable": {
            const drop = op as Types.DropTableOperation;
            flagUnsafe(
              op,
              `DropTable ${drop.tableName}`,
              "drops the table and all rows"
            );
            break;
          }
          case "DropScalar": {
            const drop = op as Types.DropScalarOperation;
            flagUnsafe(
              op,
              `DropScalar ${drop.module}::${drop.scalarName}`,
              "drops an enum/scalar type; any column referencing it must already be migrated"
            );
            break;
          }
          case "RecreateScalar": {
            const recreate = op as Types.RecreateScalarOperation;
            flagUnsafe(
              op,
              `RecreateScalar ${recreate.module}::${recreate.scalarName}`,
              recreate.reason === "removed-values" ?
                "removing enum values requires recreating the type — dependent columns must be migrated first" :
                "reordering enum values requires recreating the type (PG enum order is positional)"
            );
            break;
          }
          case "AlterType": {
            const alter = op as Types.AlterTypeOperation;
            // Track whether anything in this alter was flagged so we can
            // mark the parent op accordingly.
            let parentFlagged: "unsafe" | "ambiguous" | undefined;
            const upgradeParent = (level: "unsafe" | "ambiguous") => {
              if (level === "unsafe" || parentFlagged !== "unsafe") {
                parentFlagged = level;
              }
            };

            for (const sub of alter.operations) {
              if (sub.kind === "DropProperty") {
                const drop = sub as Types.DropPropertyOperation;
                flagged.push({
                  operation: `AlterType ${alter.typeName} → DropProperty ${drop.propertyName}`,
                  reason: "drops a column and all values stored in it",
                  classification: "unsafe"
                });
                upgradeParent("unsafe");
              } else if (sub.kind === "DropLink") {
                const dropLink = sub as Types.DropLinkOperation;
                flagged.push({
                  operation: `AlterType ${alter.typeName} → DropLink ${dropLink.linkName}`,
                  reason: "drops a relationship and all foreign-key data",
                  classification: "unsafe"
                });
                upgradeParent("unsafe");
              } else if (sub.kind === "AlterProperty") {
                const altProp = sub as Types.AlterPropertyOperation;
                for (const change of altProp.changes) {
                  if (change.kind === "ChangeType") {
                    flagged.push({
                      operation: `AlterType ${alter.typeName} → ChangeType ${altProp.propertyName}`,
                      reason:
                        `type changed from '${change.oldValue}' to '${change.newValue}' without an explicit cast — PG may refuse the conversion or coerce values lossily`,
                      classification: "ambiguous"
                    });
                    upgradeParent("ambiguous");
                  } else if (
                    change.kind === "ChangeRequired" && change.newValue === true
                  ) {
                    flagged.push({
                      operation: `AlterType ${alter.typeName} → ChangeRequired ${altProp.propertyName}`,
                      reason: "optional → required without a default — existing NULL rows will fail the SET NOT NULL",
                      classification: "ambiguous"
                    });
                    upgradeParent("ambiguous");
                  } else if (change.kind === "ChangeMulti") {
                    flagged.push({
                      operation: `AlterType ${alter.typeName} → ChangeMulti ${altProp.propertyName}`,
                      reason: "single ↔ multi cardinality change — disc cannot infer how to fan in/out existing values",
                      classification: "ambiguous"
                    });
                    upgradeParent("ambiguous");
                  }
                }
              } else if (sub.kind === "AlterLink") {
                const altLink = sub as Types.AlterLinkOperation;
                for (const change of altLink.changes) {
                  if (
                    change.kind === "ChangeCardinality" ||
                    change.kind === "ChangeMulti"
                  ) {
                    flagged.push({
                      operation: `AlterType ${alter.typeName} → AlterLink ${altLink.linkName} (${change.kind})`,
                      reason: "link cardinality changed — junction-table vs FK column conversion needs explicit data-migration steps",
                      classification: "ambiguous"
                    });
                    upgradeParent("ambiguous");
                  } else if (change.kind === "ChangeTarget") {
                    flagged.push({
                      operation: `AlterType ${alter.typeName} → AlterLink ${altLink.linkName} (ChangeTarget)`,
                      reason:
                        `link target changed from '${change.oldValue}' to '${change.newValue}' — existing FK values almost certainly point to the wrong table`,
                      classification: "ambiguous"
                    });
                    upgradeParent("ambiguous");
                  }
                }
              }
            }

            if (parentFlagged === "unsafe") {
              op.classification = "unsafe";
            } else if (parentFlagged === "ambiguous") {
              op.classification = "ambiguous";
            } else {
              flagSafe(op);
            }
            break;
          }
          default:
            flagSafe(op);
        }
      }
    }

    return flagged;
  }

  /**
   * Create a checkpoint before migration
   */
  createMigrationCheckpoint(
    name: string
  ): Result<Types.MigrationCheckpoint, MigrationError> {
    try {
      const checkpoint: Types.MigrationCheckpoint = {
        id: this.generateCheckpointId(),
        name,
        createdAt: new Date(),
        schemaState: this.getCurrentSchemaSnapshot(),
        migrationState: this.getMigrationState()
      };

      // In a real implementation, this would save the checkpoint to storage
      return Ok(checkpoint);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to create checkpoint: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Restore from a migration checkpoint
   */
  restoreFromCheckpoint(
    checkpointId: string
  ): Result<boolean, MigrationError> {
    try {
      // In a real implementation, this would restore database state from checkpoint
      // For now, we simulate successful restore
      this.appliedMigrations.clear();
      return Ok(true);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to restore from checkpoint ${checkpointId}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Generate data migration hints for complex changes
   */
  generateDataMigrationHints(
    plan: Types.MigrationPlan
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
          `Failed to generate data migration hints: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Validate a migration plan for safety
   */
  validateMigration(
    plan: Types.MigrationPlan
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
        new MigrationError(`Migration validation failed: ${issues.join(", ")}`)
      );
    }

    return Ok(true);
  }

  /**
   * Discover and run a data migration file that matches a schema migration's timestamp.
   * Data migration files live in the configured migrationsDir as `m<timestamp>_<name>.data.ts`.
   *
   * Returns the matched data migration's name when one was run, or `null`
   * when no matching file existed (callers use this to decide whether to
   * emit the `data-migration-running` progress event).
   */
  private async runDataMigrationForSchema(
    migration: Types.Migration
  ): Promise<string | null> {
    if (!this.pool) {
      return null;
    }

    // Extract timestamp from migration ID: m<timestamp>_<randomSuffix>
    const match = migration.id.match(/^m(\d{8,}T?\d*)/);
    if (!match) {
      return null;
    }

    const timestamp = match[1];
    const runner = new DataMigrationRunner();
    const migrationsDir = this.config.migrationsDir;

    // No migrationsDir configured → no data migrations to discover.
    // (SchemaManager-driven flows intentionally leave this blank.)
    if (!migrationsDir) {
      return null;
    }

    try {
      const dataMigrations = await runner.discoverMigrations(migrationsDir);
      const matching = runner.findMatchingDataMigration(
        dataMigrations,
        timestamp
      );

      if (matching) {
        logger.info(
          `Found matching data migration for ${migration.id}: ${matching.name}`
        );
        await runner.runMigration(matching, this.pool);
        // Mark the schema migration as having an associated data migration
        migration.dataMigrationFile = matching.name;
        return matching.name;
      }
      return null;
    } catch (error) {
      // If directory doesn't exist, that's fine — no data migrations
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
      return null;
    }
  }

  private generateInitialMigration(
    schema: Module[]
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

    // Emit scalar/enum CREATE TYPEs first so subsequent base tables can
    // reference them. (gh/geldata#8517) The differ already extracts
    // scalars; we just have to mirror that for the initial-only path
    // where we have a single new schema and no old one to diff against.
    for (const module of schema) {
      for (const item of module.items) {
        if (item.kind === "ScalarTypeDeclaration") {
          const isEnum = (item.extending ?? []).some(ext => ext.name.parts[0] === "enum");
          const enumValues = isEnum ?
            ((item.extending ?? []).find(ext => ext.name.parts[0] === "enum")?.params ?? []).map(p => p.name.parts.join("::")) :
            undefined;
          const op: Types.CreateScalarOperation = {
            kind: "CreateScalar",
            scalarName: item.name.value,
            module: module.name,
            baseType: isEnum ? "enum" : ((item.extending ?? [])
              .map(ext => ext.name.parts.join("::"))
              .join(", ") || "anyscalar"),
            ...(enumValues ? { enumValues } : {})
          };
          operations.push(op);
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
      ""
    );
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    return `m${timestamp}_${randomSuffix}`;
  }

  private generateMigrationName(
    operations: Types.MigrationOperation[]
  ): string {
    if (operations.length === 0) {
      return "empty_migration";
    }

    if (operations.length === 1) {
      return this.getOperationName(operations[0]);
    }

    const typeCount = operations.filter(op => op.kind.includes("Type")).length;
    const tableCount = operations.filter(op => op.kind.includes("Table")).length;

    if (typeCount > 0) {
      return `schema_changes_${typeCount}_types`;
    } else if (tableCount > 0) {
      return `table_changes_${tableCount}_tables`;
    }

    return `migration_${operations.length}_operations`;
  }

  private generateMigrationDescription(operations: Types.MigrationOperation[]): string {
    const descriptions = operations.slice(0, 3).map(op => this.getOperationDescription(op));

    if (operations.length > 3)
      descriptions.push(`…and ${operations.length - 3} more operations`);

    return descriptions.join(", ");
  }

  private getOperationName(operation: Types.MigrationOperation): string {
    switch (operation.kind) {
      case "CreateType":
        return `create_${(operation as Types.CreateTypeOperation).typeName.toLowerCase()}`;
      case "DropType":
        return `drop_${(operation as Types.DropTypeOperation).typeName.toLowerCase()}`;
      case "AlterType":
        return `alter_${(operation as Types.AlterTypeOperation).typeName.toLowerCase()}`;
      default:
        return operation.kind.toLowerCase();
    }
  }

  private getOperationDescription(operation: Types.MigrationOperation): string {
    switch (operation.kind) {
      case "CreateType":
        return `Create type ${(operation as Types.CreateTypeOperation).typeName}`;
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
    const executableStatements = statements.filter(s => s.trim() && !s.trim().startsWith("--"));

    if (this.config.dryRun) {
      logger.info("DRY RUN - Would execute:");
      executableStatements.forEach(stmt => logger.info(`  ${stmt}`));
      return;
    }

    // gh/geldata#6304: prefix the migration transaction with safety
    // pragmas so a long-running concurrent query can't deadlock the
    // schema apply.
    //
    //  - `lock_timeout` bounds how long any single DDL statement waits
    //    for an exclusive lock; on timeout PG raises a clear error
    //    instead of hanging the migration.
    //  - A session-scoped advisory lock (`pg_advisory_xact_lock`)
    //    serializes concurrent `disc migrate` runs on the same DB so
    //    two operators can't race. The lock is automatically released
    //    when the transaction ends.
    const lockTimeoutMs = this.config.lockTimeoutMs ?? 60_000;
    const useAdvisoryLock = this.config.useAdvisoryLock ?? true;

    const pragmaPrefix: string[] = [];
    if (lockTimeoutMs > 0) {
      pragmaPrefix.push(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms';`);
    }
    if (useAdvisoryLock) {
      // pg_advisory_xact_lock takes a bigint and is auto-released on
      // commit/rollback. The key is a constant derived from
      // "disc_migrations" (see migration/types.ts) so concurrent
      // migrators contend on the same lock.
      pragmaPrefix.push(
        `SELECT pg_advisory_xact_lock(${Types.MIGRATION_ADVISORY_LOCK_KEY}::bigint);`
      );
    }

    // Pool-based execution path (preferred)
    if (this.pool) {
      await this.pool.transaction(async conn => {
        for (const stmt of pragmaPrefix) {
          await conn.execute(stmt);
        }
        for (const stmt of executableStatements) {
          logger.debug(`Executing: ${stmt.split("\n")[0].substring(0, 100)}…`);
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
      for (const stmt of pragmaPrefix) {
        await this.db!.execute(stmt);
      }
      for (const statement of executableStatements) {
        logger.debug(`Executing: ${statement.split("\n")[0].substring(0, 100)}…`);
        await this.db!.execute(statement);
      }
    });
  }

  private validateOperation(operation: Types.MigrationOperation): string[] {
    const issues: string[] = [];

    switch (operation.kind) {
      case "DropType":
        // Check if type has dependencies
        issues.push(...this.validateDropType(operation as Types.DropTypeOperation));
        break;
      case "AlterType":
        // Check for breaking changes
        issues.push(...this.validateAlterType(operation as Types.AlterTypeOperation));
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
          `Dropping property ${dropOp.propertyName} from ${operation.typeName} may result in data loss`
        );
      }

      if (typeOp.kind === "AlterProperty") {
        const alterOp = typeOp as Types.AlterPropertyOperation;
        for (const change of alterOp.changes) {
          if (change.kind === "ChangeType") {
            issues.push(
              `Changing type of ${alterOp.propertyName} may require data migration`
            );
          }
          if (change.kind === "ChangeRequired" && change.newValue) {
            issues.push(
              `Making ${alterOp.propertyName} required may fail if existing NULL values exist`
            );
          }
        }
      }
    }

    return issues;
  }

  private validateRollbackOperation(
    operation: Types.MigrationOperation
  ): string[] {
    const issues: string[] = [];

    switch (operation.kind) {
      case "DropType": {
        const dropOp = operation as Types.DropTypeOperation;
        issues.push(
          `Rollback of DropType ${dropOp.typeName} requires manual intervention - original schema lost`
        );
        break;
      }
      case "AlterType": {
        const alterOp = operation as Types.AlterTypeOperation;
        for (const typeOp of alterOp.operations) {
          if (typeOp.kind === "DropProperty") {
            const dropPropOp = typeOp as Types.DropPropertyOperation;
            issues.push(
              `Rollback of DropProperty ${dropPropOp.propertyName} may result in data loss or require manual intervention`
            );
          }
        }
        break;
      }
      case "DropTable": {
        const dropTableOp = operation as Types.DropTableOperation;
        issues.push(
          `Rollback of DropTable ${dropTableOp.tableName} requires manual intervention - original structure lost`
        );
        break;
      }
    }

    return issues;
  }

  private generateOperationHints(
    operation: Types.MigrationOperation
  ): string[] {
    const hints: string[] = [];

    switch (operation.kind) {
      case "CreateType": {
        const createTypeOp = operation as Types.CreateTypeOperation;
        // Hint for new types with required properties that need default values
        for (const prop of createTypeOp.properties) {
          if (prop.required && !prop.default) {
            hints.push(
              `Data migration hint: New required property ${createTypeOp.typeName}.${prop.name} has no default value`
            );
          }
        }
        // Hint for new types with required links
        for (const link of createTypeOp.links) {
          if (link.required) {
            hints.push(
              `Data migration hint: New required link ${createTypeOp.typeName}.${link.name} must reference existing ${link.target} objects`
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
              `Data migration hint: Consider backing up data from ${alterTypeOp.typeName}.${dropPropOp.propertyName} before dropping`
            );
          }
          if (typeOp.kind === "AddProperty") {
            const addPropOp = typeOp as Types.AddPropertyOperation;
            if (addPropOp.property.required) {
              hints.push(
                `Data migration hint: Consider setting a default value for required property ${alterTypeOp.typeName}.${addPropOp.property.name}`
              );
            }
          }
        }
        break;
      }
      case "DropType": {
        const dropTypeOp = operation as Types.DropTypeOperation;
        hints.push(
          `Data migration hint: Consider backing up all data from type ${dropTypeOp.typeName} before dropping`
        );
        break;
      }
    }

    return hints;
  }

  private generateCheckpointId(): string {
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(
      /\.\d+Z$/,
      ""
    );
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    return `cp${timestamp}_${randomSuffix}`;
  }

  private getCurrentSchemaSnapshot(): any {
    // In a real implementation, this would capture the current schema state
    // For now, return a placeholder
    return {
      timestamp: new Date().toISOString(),
      schema_version: "current"
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

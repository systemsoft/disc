/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Schema Manager - bridges SDL parsing, query compilation context, and migration planning
 *
 * Connects three currently disconnected systems:
 * - SDL parsing (schema/parser.ts + schema/converter.ts) -> Module[]
 * - Query compilation context (compiler/context.ts) -> Schema with TypeDef/PropertyDef/LinkDef
 * - Migration planning (migration/engine.ts) -> MigrationPlan
 */

import { Schema } from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { MigrationError } from "../lib/errors.ts";
import { Err, Ok, Result } from "../lib/result.ts";
import { Declaration, SDLDocument } from "../schema/ast.ts";
import { Module, normalizeModules, SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { MigrationEngine } from "./engine.ts";
import { detectComputedPointerErrors, detectMutualStoredMultiLinks, modulesToSchema } from "./runtime-schema.ts";
import * as Types from "./types.ts";

/**
 * Run semantic validation on a parsed SDL document, returning a MigrationError
 * with all collected messages when validation fails.
 */
function validateDocument(
  document: SDLDocument
): Result<void, MigrationError> {
  const validation = new SchemaValidator().validate(document);
  if (validation.ok) {
    return Ok(undefined);
  }
  const errors = validation.errors!;
  const lines = errors.map(e => `  • ${e.message}`).join("\n");
  return Err(
    new MigrationError(
      `Schema validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}):\n${lines}`
    )
  );
}

export interface SchemaManagerOptions {
  pool?: ConnectionPool;
  dryRun?: boolean;
  onSchemaChange?: (schema: Schema) => void;
  /**
   * Optional progress listener forwarded to the underlying MigrationEngine.
   * Receives per-step events for plan/migration/DDL execution.
   * (gh/geldata#7490)
   */
  onProgress?: Types.MigrationProgressListener;
}

export class SchemaManager {
  private pool?: ConnectionPool;
  private dryRun: boolean;
  private engine?: MigrationEngine;
  private currentModules: Module[] | null = null;
  private currentSchema: Schema | null = null;
  private onSchemaChange?: (schema: Schema) => void;
  private onProgress?: Types.MigrationProgressListener;

  constructor(options: SchemaManagerOptions) {
    this.pool = options.pool;
    this.dryRun = options.dryRun ?? false;
    this.onSchemaChange = options.onSchemaChange;
    this.onProgress = options.onProgress;
  }

  /**
   * Parse SDL source text into Module[] representation.
   *
   * Creates an SDLParser to tokenize and parse the source into an SDLDocument,
   * then uses SDLConverter to normalize into Module[].
   *
   * Semantic validation runs by default. Callers that parse one fragment of a
   * multi-file schema (where types may be defined in a sibling file) should
   * pass `{ validate: false }` and validate the merged module set afterwards
   * via `validateModules()`, so cross-file references don't read as undefined.
   */
  parseSDL(
    source: string,
    opts: { validate?: boolean; } = {}
  ): Result<Module[], MigrationError> {
    const validate = opts.validate ?? true;
    try {
      // P2-06: parse with error recovery so all SDL syntax errors surface
      // in a single MigrationError message instead of just the first one.
      // Callers that previously matched on the first-error string will
      // still find their error in the multi-line list.
      const parser = new SDLParser(source);
      const { document, errors } = parser.parseWithRecovery();
      if (errors.length > 0) {
        const lines = errors
          .map(e => {
            const hint = e.context?.hint;
            return hint ?
              `  • ${e.message}\n      Hint: ${hint}` :
              `  • ${e.message}`;
          })
          .join("\n");
        return Err(
          new MigrationError(
            `Failed to parse SDL (${errors.length} error${errors.length === 1 ? "" : "s"}):\n${lines}`
          )
        );
      }
      // Semantic validation (undefined types, bad cardinality, unknown
      // constraints, …) runs after a clean parse and before conversion, so
      // schema mistakes are reported up front rather than as opaque DDL or
      // runtime failures.
      if (validate) {
        const validation = validateDocument(document);
        if (!validation.ok) {
          return Err(validation.error);
        }
      }
      const converter = new SDLConverter();
      const modules = converter.convertToModules(document);

      // Reject mutual stored `multi` links between two types — Disc can't
      // tell which pairs with which (the pairing is ambiguous), so the DDL
      // and query layers can disagree on the junction table. Bidirectional
      // M2M is modeled with one stored side + one computed backlink.
      if (validate) {
        const schema = this.modulesToSchema(modules);
        const mutual = detectMutualStoredMultiLinks(schema);
        if (mutual) {
          return Err(new MigrationError(mutual));
        }
        const computed = detectComputedPointerErrors(schema);
        if (computed) {
          return Err(new MigrationError(`Invalid computed pointers:\n${computed}`));
        }
      }
      return Ok(modules);
    } catch (error) {
      return Err(
        new MigrationError(
          `Failed to parse SDL: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }
  }

  /**
   * Validate an already-parsed (and merged) module set, e.g. a multi-file
   * schema assembled from several `.disc` files. Reconstructs an SDLDocument
   * from the modules so cross-file references resolve against the full schema.
   */
  validateModules(modules: Module[]): Result<void, MigrationError> {
    // Coalesce declarations by module name. Multiple Module entries can share
    // a name (e.g. one `module default` block per file); the validator treats
    // a repeated module declaration as an error, so merge them into one.
    const byName = new Map<string, Declaration[]>();
    for (const m of modules) {
      const items = byName.get(m.name) ?? [];
      items.push(...(m.items as Declaration[]));
      byName.set(m.name, items);
    }
    const document: SDLDocument = {
      kind: "SDLDocument",
      declarations: [...byName.entries()].map(([name, declarations]) => ({
        kind: "ModuleDeclaration" as const,
        name: { kind: "QualifiedName" as const, parts: name.split("::") },
        declarations
      }))
    };
    return validateDocument(document);
  }

  /**
   * Convert Module[] (SDL AST) into a Schema suitable for the query compiler
   * (see `modulesToSchema` in runtime-schema.ts).
   */
  modulesToSchema(sdlModules: Module[]): Schema {
    return modulesToSchema(sdlModules);
  }

  /**
   * Parse SDL source, diff against current schema, plan and optionally execute
   * a migration, then update internal state.
   *
   * Returns the migration results on success.
   */
  async applySchema(
    sdlSource: string,
    options?: { allowUnsafe?: boolean; skipHistory?: boolean; }
  ): Promise<Result<Types.MigrationResult[], MigrationError>> {
    // Parse SDL
    const parseResult = this.parseSDL(sdlSource);
    if (!parseResult.ok) {
      return parseResult;
    }
    // Reclassify arrow shorthand `name -> ScalarType` as properties before
    // the differ sees the AST. Without this, the differ treats every arrow
    // as a link and emits FK constraints to non-existent scalar tables
    // (e.g. `REFERENCES datetime (id)`).
    const newModules = normalizeModules(parseResult.value);

    // Ensure engine exists
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before applySchema()."
        )
      );
    }

    // Hash-fallback baseline check (see applyModules for details).
    if (
      this.currentModules === null &&
      this.engine.appliedMigrationCount() > 0
    ) {
      const latestHash = this.engine.getLatestAppliedSchemaHash();
      const newHash = this.engine.hashSchemaForBaseline(newModules);
      if (latestHash !== null && latestHash === newHash) {
        this.currentModules = newModules;
        this.currentSchema = this.modulesToSchema(newModules);
        this.onSchemaChange?.(this.currentSchema);
        return Ok([]);
      }
      if (latestHash !== null && latestHash !== newHash) {
        return Err(
          new MigrationError(
            "Schema changes detected but the applied baseline can't be reconstructed: " +
              "the latest disc_migrations row was recorded before schema snapshots were stored. " +
              "Re-apply the existing schema once to record a baseline, then re-run `disc migrate`. " +
              "If the database is empty / stale, delete the disc_migrations table and retry."
          )
        );
      }
    }

    // Plan migration: diff currentModules vs newModules, then add the index
    // backfill (declared indexes the database lacks — see withIndexBackfill).
    const planResult = await this.backfillIndexes(
      this.engine.planMigration(this.currentModules, newModules),
      newModules
    );
    if (!planResult.ok) {
      return planResult;
    }
    const plan = planResult.value;

    // Early-return for no-op plans (no operations to apply). See
    // applyModules() for the same guard — keeps disc_migrations clean
    // when a fresh process re-applies an unchanged schema.
    if (plan.operationsCount === 0) {
      this.currentModules = newModules;
      this.currentSchema = this.modulesToSchema(newModules);
      this.onSchemaChange?.(this.currentSchema);
      return Ok([]);
    }

    // gh/geldata#1838 + gh/geldata#1840: refuse data-destroying *and*
    // ambiguous ops by default. Callers pass `{ allowUnsafe: true }` to
    // bypass — the CLI exposes this via `--unsafe`. Dry-run still
    // surfaces the list (caller renders it) but doesn't refuse, since
    // dry-run mutates nothing.
    if (!options?.allowUnsafe && !this.dryRun) {
      const flagged = this.engine.classifyUnsafeOperations(plan);
      if (flagged.length > 0) {
        const lines = flagged.map(u => `  - [${u.classification}] ${u.operation}: ${u.reason}`);
        const unsafeCount = flagged.filter(u => u.classification === "unsafe").length;
        const ambiguousCount = flagged.length - unsafeCount;
        const summary = [
          unsafeCount > 0 ? `${unsafeCount} unsafe` : null,
          ambiguousCount > 0 ? `${ambiguousCount} ambiguous` : null
        ]
          .filter(Boolean)
          .join(" + ");
        return Err(
          new MigrationError(
            `Migration contains ${summary} operation(s):\n${lines.join("\n")}\n\nPass { allowUnsafe: true } (or --unsafe at the CLI) to apply anyway.`
          )
        );
      }
    }

    // If dryRun, skip execution
    if (this.dryRun) {
      // Update internal state even in dry-run so subsequent calls see the new schema
      this.currentModules = newModules;
      this.currentSchema = this.modulesToSchema(newModules);
      this.onSchemaChange?.(this.currentSchema);

      // Return synthetic results for each planned migration
      const results: Types.MigrationResult[] = plan.migrations.map(m => ({
        success: true,
        migrationId: m.id,
        appliedAt: new Date(),
        durationMs: 0
      }));
      return Ok(results);
    }

    // Execute the migration plan. `skipHistory` (gh/geldata#3761) is
    // the `db push` path — DDL still applies, but the engine doesn't
    // record the migration in `disc_migrations`.
    const execResult = await this.engine.executeMigration(plan, {
      skipHistory: options?.skipHistory,
      postStateModules: newModules
    });
    if (!execResult.ok) {
      return execResult;
    }

    // Update internal state on success
    this.currentModules = newModules;
    this.currentSchema = this.modulesToSchema(newModules);
    this.onSchemaChange?.(this.currentSchema);

    return execResult;
  }

  /**
   * Parse SDL and generate a migration plan without executing it.
   *
   * This is the planning-only path used by `disc migrate --create`. It parses
   * the SDL source, diffs against the current schema state, and returns the
   * resulting MigrationPlan. No DDL is executed and no internal state is
   * mutated.
   */
  planSchema(
    sdlSource: string
  ): Result<Types.MigrationPlan, MigrationError> {
    // Parse SDL
    const parseResult = this.parseSDL(sdlSource);
    if (!parseResult.ok) {
      return parseResult;
    }
    // Reclassify scalar arrows as properties so the differ doesn't emit
    // FK constraints to scalar "tables".
    const newModules = normalizeModules(parseResult.value);

    // Ensure engine exists
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before planSchema()."
        )
      );
    }

    // Plan migration: diff currentModules vs newModules
    return this.engine.planMigration(this.currentModules, newModules);
  }

  /**
   * Apply pre-parsed Module[] (multi-file schema path).
   *
   * Mirrors `applySchema()` but skips the parseSDL step — callers that have
   * already merged Module arrays from multiple `.disc` files (via
   * `Codegen.loadMultiFileSchemaModules`) feed them straight in. Diff,
   * unsafe-op gating, dry-run handling, and engine execution behave
   * identically to `applySchema()`.
   */
  async applyModules(
    rawModules: Module[],
    options?: { allowUnsafe?: boolean; skipHistory?: boolean; }
  ): Promise<Result<Types.MigrationResult[], MigrationError>> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before applyModules()."
        )
      );
    }

    // Reclassify scalar arrows as properties so the differ doesn't emit
    // FK constraints to scalar "tables".
    const newModules = normalizeModules(rawModules);

    // Hash-fallback baseline check: when `currentModules` couldn't be
    // primed (latest applied migration row pre-dates the schema_modules
    // column) but the engine has applied migrations recorded, comparing
    // the new schema's hash against the latest applied schema_hash lets
    // us detect the no-op case without a baseline. Without this, we'd
    // diff against null and emit "create everything" ops that collide
    // with existing types/tables.
    if (
      this.currentModules === null &&
      this.engine.appliedMigrationCount() > 0
    ) {
      const latestHash = this.engine.getLatestAppliedSchemaHash();
      const newHash = this.engine.hashSchemaForBaseline(newModules);
      if (latestHash !== null && latestHash === newHash) {
        // No-op: schema unchanged since last migrate. Adopt newModules
        // as the baseline so subsequent calls on this instance don't
        // re-trigger the fallback, and backfill the row in disc_migrations
        // so future runs prime directly from schema_modules.
        this.currentModules = newModules;
        this.currentSchema = this.modulesToSchema(newModules);
        this.onSchemaChange?.(this.currentSchema);
        if (!this.dryRun) {
          await this.engine.backfillLatestAppliedModules(newModules);
        }
        return Ok([]);
      }
      if (latestHash !== null && latestHash !== newHash) {
        return Err(
          new MigrationError(
            "Schema changes detected but the applied baseline can't be reconstructed: " +
              "the latest disc_migrations row was recorded before schema snapshots were stored. " +
              "Re-apply the existing schema once to record a baseline, then re-run `disc migrate`. " +
              "If the database is empty / stale, delete the disc_migrations table and retry."
          )
        );
      }
    }

    const planResult = await this.backfillIndexes(
      this.engine.planMigration(this.currentModules, newModules),
      newModules
    );
    if (!planResult.ok) {
      return planResult;
    }
    const plan = planResult.value;

    // Early-return for no-op plans: the differ found zero changes
    // between the current baseline and the new schema. Without this,
    // executeMigration would still record an empty row in disc_migrations
    // (no DDL runs, but the bookkeeping insert fires), bloating history
    // with synthetic "nothing changed" entries on every re-apply.
    if (plan.operationsCount === 0) {
      this.currentModules = newModules;
      this.currentSchema = this.modulesToSchema(newModules);
      this.onSchemaChange?.(this.currentSchema);
      return Ok([]);
    }

    if (!options?.allowUnsafe && !this.dryRun) {
      const flagged = this.engine.classifyUnsafeOperations(plan);
      if (flagged.length > 0) {
        const lines = flagged.map(u => `  - [${u.classification}] ${u.operation}: ${u.reason}`);
        const unsafeCount = flagged.filter(u => u.classification === "unsafe").length;
        const ambiguousCount = flagged.length - unsafeCount;
        const summary = [
          unsafeCount > 0 ? `${unsafeCount} unsafe` : null,
          ambiguousCount > 0 ? `${ambiguousCount} ambiguous` : null
        ]
          .filter(Boolean)
          .join(" + ");
        return Err(
          new MigrationError(
            `Migration contains ${summary} operation(s):\n${lines.join("\n")}\n\nPass { allowUnsafe: true } (or --unsafe at the CLI) to apply anyway.`
          )
        );
      }
    }

    if (this.dryRun) {
      this.currentModules = newModules;
      this.currentSchema = this.modulesToSchema(newModules);
      this.onSchemaChange?.(this.currentSchema);

      const results: Types.MigrationResult[] = plan.migrations.map(m => ({
        success: true,
        migrationId: m.id,
        appliedAt: new Date(),
        durationMs: 0
      }));
      return Ok(results);
    }

    const execResult = await this.engine.executeMigration(plan, {
      skipHistory: options?.skipHistory,
      postStateModules: newModules
    });
    if (!execResult.ok) {
      return execResult;
    }

    this.currentModules = newModules;
    this.currentSchema = this.modulesToSchema(newModules);
    this.onSchemaChange?.(this.currentSchema);

    return execResult;
  }

  /**
   * Report whether `rawModules` has drifted from the applied baseline.
   *
   * Read-only twin of the checks at the top of `applyModules()`: no DDL, no
   * history rows, nothing written. `disc serve` uses it to decide whether
   * "run disc migrate" is worth saying — before this existed, callers could
   * only ask "are there applied migrations?", which is true forever once the
   * first one lands and says nothing about whether the SDL still matches.
   *
   * Mirrors `applyModules`' baseline fallback: when the latest applied row
   * pre-dates stored schema snapshots, `currentModules` is null and diffing
   * against it would report "create everything". Comparing schema hashes
   * still answers the only question asked here — same or different.
   */
  hasPendingChanges(rawModules: Module[]): Result<boolean, MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before hasPendingChanges()."
        )
      );
    }

    const newModules = normalizeModules(rawModules);

    if (
      this.currentModules === null &&
      this.engine.appliedMigrationCount() > 0
    ) {
      const latestHash = this.engine.getLatestAppliedSchemaHash();
      if (latestHash !== null) {
        return Ok(latestHash !== this.engine.hashSchemaForBaseline(newModules));
      }
    }

    const planResult = this.engine.planMigration(
      this.currentModules,
      newModules
    );
    if (!planResult.ok) {
      return planResult;
    }

    return Ok(planResult.value.operationsCount > 0);
  }

  /**
   * Plan a migration from pre-parsed Module[] without executing.
   *
   * Multi-file twin of `planSchema()`. Used by `disc migrate --create
   * --schema-dir` to generate a plan from merged module arrays.
   */
  planModules(
    rawModules: Module[]
  ): Result<Types.MigrationPlan, MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before planModules()."
        )
      );
    }

    const newModules = normalizeModules(rawModules);
    return this.engine.planMigration(this.currentModules, newModules);
  }

  /**
   * Add the index backfill to a plan: `CREATE … INDEX IF NOT EXISTS` for every
   * index the schema declares that the database lacks and the plan does not
   * already create. The diff cannot see these — it compares two schema
   * snapshots, never the database — so a constraint that was declared before
   * Disc enforced it would otherwise never get its index. The other database
   * repairs (link-property columns, delete rules, TEXT columns) join it — see
   * `MigrationEngine.withIndexBackfill`.
   *
   * `applySchema()` / `applyModules()` do this themselves. Callers that only
   * plan (`disc migrate --create` / `--dry-run`) call it to preview the same
   * statements. Only reads the database; a manager without a pool returns the
   * plan unchanged.
   */
  withIndexBackfill(
    plan: Types.MigrationPlan,
    rawModules: Module[]
  ): Promise<Result<Types.MigrationPlan, MigrationError>> {
    return this.backfillIndexes(Ok(plan), normalizeModules(rawModules));
  }

  private async backfillIndexes(
    planResult: Result<Types.MigrationPlan, MigrationError>,
    newModules: Module[]
  ): Promise<Result<Types.MigrationPlan, MigrationError>> {
    if (!planResult.ok || !this.engine) {
      return planResult;
    }

    try {
      return Ok(await this.engine.withIndexBackfill(planResult.value, newModules));
    } catch (error) {
      return Err(new MigrationError(`Failed to plan the index backfill: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /**
   * Extract DDL statements from a migration plan.
   *
   * Pass-through to the migration engine's DDL generator. Returns the array
   * of SQL strings that would be executed if the plan were applied.
   */
  generateDDL(
    plan: Types.MigrationPlan
  ): Result<string[], MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before generateDDL()."
        )
      );
    }

    return this.engine.generateDDL(plan);
  }

  /**
   * Validate that a migration plan is safe to apply.
   *
   * Delegates to the migration engine's validation logic which checks for
   * breaking changes, data loss risks, and structural issues. Returns
   * ok(undefined) when the plan passes validation.
   */
  validateMigration(
    plan: Types.MigrationPlan
  ): Result<void, MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before validateMigration()."
        )
      );
    }

    const result = this.engine.validateMigration(plan);
    if (!result.ok) {
      return result;
    }

    // Engine returns Result<boolean>, normalize to Result<void>
    return Ok(undefined);
  }

  /**
   * Rollback the most recently applied migration.
   *
   * Loads the latest migration from the tracker and delegates rollback
   * execution to the migration engine. Warning: rolling back a DROP TABLE
   * cannot restore data.
   */
  async rollbackLastMigration(): Promise<Result<void, MigrationError>> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before rollbackLastMigration()."
        )
      );
    }

    return this.adoptRolledBackBaseline(
      await this.engine.executeRollback(await this.getLatestMigrationId())
    );
  }

  /**
   * Rollback all migrations applied after the specified migration ID.
   * The target migration itself is preserved.
   */
  async rollbackToMigration(
    migrationId: string
  ): Promise<Result<void, MigrationError>> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before rollbackToMigration()."
        )
      );
    }

    return this.adoptRolledBackBaseline(await this.engine.executeRollbackTo(migrationId));
  }

  /**
   * After a rollback, the applied baseline is the snapshot of the latest migration still
   * recorded, so the next apply on this instance diffs against it instead of the rolled-back
   * schema. A partial `rollback-to` failure has still removed some records, so this runs
   * either way.
   */
  private adoptRolledBackBaseline(
    result: Result<void, MigrationError>
  ): Result<void, MigrationError> {
    if (this.dryRun || !this.engine) {
      return result;
    }

    const baseline = this.engine.getLatestAppliedModules();
    this.currentModules = baseline === null ? null : normalizeModules(baseline);
    this.currentSchema = this.currentModules === null ? null : this.modulesToSchema(this.currentModules);

    if (this.currentSchema !== null) {
      this.onSchemaChange?.(this.currentSchema);
    }

    return result;
  }

  /**
   * Get migration status information.
   */
  async getMigrationStatus(): Promise<
    Result<
      {
        applied: number;
        currentSchemaHash: string | null;
        latestMigration: {
          id: string;
          name: string;
          appliedAt: Date;
        } | null;
      },
      MigrationError
    >
  > {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before getMigrationStatus()."
        )
      );
    }

    const statusResult = await this.engine.getMigrationStatus();
    if (!statusResult.ok) {
      return statusResult;
    }

    const status = statusResult.value;
    return Ok({
      applied: status.applied,
      currentSchemaHash: status.currentSchemaHash,
      latestMigration: status.latestMigration ?
        {
          id: status.latestMigration.id,
          name: status.latestMigration.name,
          appliedAt: status.latestMigration.appliedAt
        } :
        null
    });
  }

  /**
   * Detect connections from a running Disc server attached to the
   * same database (gh/geldata#9034). Used by `disc migrate` as a
   * preflight: if a server is connected, its in-memory schema cache
   * will go stale after migration unless the operator triggers a
   * reload. Returns the list of `(pid, application_name)` pairs the
   * scan found. Best-effort — silently returns an empty list on
   * permission errors (operator may have restricted
   * `pg_stat_activity`).
   */
  async detectRunningServers(): Promise<
    Result<Array<{ pid: number; applicationName: string; }>, MigrationError>
  > {
    if (!this.pool) {
      // Dry-run / no pool — nothing to probe.
      return Ok([]);
    }
    try {
      const conn = await this.pool.acquire();
      try {
        // Filter to disc-server tagged connections that aren't this
        // CLI session. `pg_backend_pid()` excludes our own row even
        // though our app name should be `disc-cli`.
        const result = await conn.query(
          `SELECT pid, COALESCE(application_name, '') AS application_name
             FROM pg_stat_activity
            WHERE application_name = 'disc-server'
              AND pid <> pg_backend_pid()`
        );
        const rows = result.rows.map(r => ({
          pid: Number((r as Record<string, unknown>).pid),
          applicationName: String(
            (r as Record<string, unknown>).application_name
          )
        }));
        return Ok(rows);
      } finally {
        this.pool.release(conn);
      }
    } catch (err) {
      // pg_stat_activity may be restricted on hardened deployments;
      // fail soft so the migration itself isn't blocked.
      return Err(
        new MigrationError(
          `running-server probe failed: ${(err as Error).message}`
        )
      );
    }
  }

  /**
   * Preview the migration operations that would run if the given SDL
   * were applied against the current state, without executing them.
   * Used by `disc migrate --status` to surface drift between the SDL
   * file on disk and the applied schema (gh/geldata#8899).
   */
  previewMigrationOps(
    sdlSource: string
  ): Result<Types.MigrationOperation[], MigrationError> {
    const parseResult = this.parseSDL(sdlSource);
    if (!parseResult.ok) {
      return parseResult;
    }

    return this.previewMigrationOpsFromModules(parseResult.value);
  }

  /**
   * Multi-file twin of `previewMigrationOps()`. Skips the parseSDL step so
   * callers that already merged Module[] from several `.disc` files (via
   * `Codegen.loadMultiFileSchemaModules`) can drift-check without
   * re-serializing back to SDL.
   */
  previewMigrationOpsFromModules(
    rawModules: Module[]
  ): Result<Types.MigrationOperation[], MigrationError> {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before previewMigrationOpsFromModules()."
        )
      );
    }

    const newModules = normalizeModules(rawModules);
    const planResult = this.engine.planMigration(
      this.currentModules,
      newModules
    );
    if (!planResult.ok) {
      return planResult;
    }

    const ops: Types.MigrationOperation[] = [];
    for (const m of planResult.value.migrations) {
      ops.push(...m.operations);
    }
    return Ok(ops);
  }

  /**
   * Get full migration history, ordered by applied_at DESC.
   */
  async getMigrationHistory(): Promise<
    Result<Types.MigrationHistoryEntry[], MigrationError>
  > {
    if (!this.engine) {
      return Err(
        new MigrationError(
          "SchemaManager not initialized. Call initialize() before getMigrationHistory()."
        )
      );
    }

    return await this.engine.getMigrationHistory();
  }

  /**
   * Get the ID of the latest applied migration. Throws if no migrations exist.
   */
  private async getLatestMigrationId(): Promise<string> {
    const statusResult = await this.engine!.getMigrationStatus();
    if (!statusResult.ok) {
      throw statusResult.error;
    }

    const latest = statusResult.value.latestMigration;
    if (!latest) {
      throw new MigrationError("No migrations have been applied");
    }

    return latest.id;
  }

  /**
   * Prime the SchemaManager's "currently applied" baseline from an
   * existing SDL string without running any migrations. Used by the
   * live-schema-diff admin endpoint (Bundle K — Disc #3a) so a fresh
   * SchemaManager instance per request can still produce a correct
   * diff against the running server's schema.
   *
   * Returns Err if the baseline SDL fails to parse — callers should
   * surface that as a server-side data-integrity issue.
   */
  loadBaseline(sdlSource: string): Result<void, MigrationError> {
    const parseResult = this.parseSDL(sdlSource);

    if (!parseResult.ok)
      return Err(parseResult.error);

    /*** Match the normalization every other SDL-ingesting path applies (see applySchema,
         planMigrationFromSDL, etc). Without this, the baseline keeps arrow-syntax fields as links
         while applySchema normalizes them to properties — every existing field then diffs as a
         DropLink, falsely tripping the unsafe-op gate. ***/
    const normalized = normalizeModules(parseResult.value);
    this.currentModules = normalized;
    this.currentSchema = this.modulesToSchema(normalized);

    return Ok(undefined);
  }

  /**
   * Get the current compiler Schema, or null if no schema has been loaded.
   */
  getSchema(): Schema | null {
    return this.currentSchema;
  }

  /**
   * Get the current Module[] representation, or null if no schema has been loaded.
   */
  getModules(): Module[] | null {
    return this.currentModules;
  }

  /**
   * Initialize the SchemaManager. If a ConnectionPool was provided, creates
   * and initializes a MigrationEngine backed by that pool.
   *
   * After engine initialization, primes `currentModules` from the latest
   * applied migration's stored schema_modules (when available). Without
   * this, a fresh `disc migrate` against a previously-migrated DB would
   * diff against null and emit "create everything" ops that collide with
   * existing types/tables.
   */
  async initialize(): Promise<void> {
    const config: Types.MigrationConfig = {
      migrationsDir: "",
      schemaFile: "",
      databaseUrl: "",
      dryRun: this.dryRun,
      autoApprove: true,
      backupBeforeMigration: false,
      rollbackOnError: true,
      connectionPool: this.pool,
      onProgress: this.onProgress
    };

    this.engine = new MigrationEngine(config);

    if (this.pool) {
      await this.engine.initialize();

      // Prime the baseline from the latest applied migration's stored
      // schema modules. Rows from before this column existed will return
      // null — for those we fall back to schema_hash comparison inside
      // applyModules/applySchema (no-op when hashes match, error
      // otherwise).
      const baseline = this.engine.getLatestAppliedModules();
      if (baseline !== null) {
        this.currentModules = normalizeModules(baseline);
        this.currentSchema = this.modulesToSchema(this.currentModules);
      }
    }
  }

  /**
   * Close the underlying MigrationEngine and release resources.
   */
  async close(): Promise<void> {
    if (this.engine) {
      await this.engine.close();
      this.engine = undefined;
    }
  }
}

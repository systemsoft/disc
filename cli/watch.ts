// deno-lint-ignore-file no-console
/**
 * CLI Watch Command Implementation - File watching for development
 */

import { ensureDir } from "@std/fs";
import { dirname } from "@std/path";
import { generateTypeScript, writeGeneratedFiles } from "../codegen/mod.ts";
import * as Context from "../compiler/context.ts";
import { MigrationEngine } from "../migration/engine.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { MigrationTracker } from "../migration/tracker.ts";
import * as Types from "../migration/types.ts";
import { Module, SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";

export interface WatchOptions {
  schemaFile?: string;
  outputDir?: string;
  delayMs?: number;
}

export interface FileChangeEvent {
  path: string;
  type: "create" | "modify" | "remove";
  timestamp: Date;
}

export class WatchCommand {
  private isWatching = false;
  private abortController?: AbortController;
  private debounceTimer?: number;
  private lastSchemaHash?: string;

  /**
   * Watch schema files for changes and trigger migrations/codegen
   */
  async execute(options: WatchOptions): Promise<void> {
    console.log("🔍 Watching schema files for changes...");

    const schemaFile = options.schemaFile || "./dbschema/default.disc";
    const outputDir = options.outputDir || "./generated";
    const delayMs = options.delayMs || 1000;

    console.log(`📂 Watching: ${schemaFile}`);
    console.log(`📁 Output: ${outputDir}`);
    console.log(`⏱️  Debounce: ${delayMs}ms`);
    console.log("");

    try {
      // Verify schema file exists
      const schemaExists = await Deno.stat(schemaFile).then(() => true).catch(
        () => false
      );
      if (!schemaExists) {
        console.log(`⚠️  Schema file not found: ${schemaFile}`);
        console.log("💡 Creating a basic schema file...");
        await this.createDefaultSchema(schemaFile);
      }

      // Set up signal handlers for graceful shutdown
      this.setupSignalHandlers();

      // Start watching
      this.isWatching = true;
      this.abortController = new AbortController();

      console.log("✅ File watcher started. Press Ctrl+C to stop.");
      console.log("");

      // Initial build
      console.log("🚀 Performing initial build...");
      await this.processSchemaChanges(schemaFile, outputDir);

      // Start file watching
      await this.startFileWatcher(schemaFile, outputDir, delayMs);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        console.log("\n🛑 File watcher stopped");
      } else {
        console.error(
          `❌ Failed to start file watcher: ${(error as Error).message}`
        );
        throw error;
      }
    }
  }

  private async startFileWatcher(
    schemaFile: string,
    outputDir: string,
    delayMs: number
  ): Promise<void> {
    if (!this.abortController) {
      throw new Error("AbortController not initialized");
    }

    try {
      // Watch the directory containing the schema file
      const schemaDir = schemaFile.includes("/") ? schemaFile.substring(0, schemaFile.lastIndexOf("/")) : ".";

      const watcher = Deno.watchFs([schemaDir], {
        recursive: false
      });

      for await (const event of watcher) {
        if (!this.isWatching)
          break;

        // Check if this is our schema file
        const changedFile = event.paths.find(path => path.endsWith(".disc"));
        if (!changedFile)
          continue;

        const changeEvent: FileChangeEvent = {
          path: changedFile,
          type: this.getChangeType(event.kind),
          timestamp: new Date()
        };

        console.log(`📝 Detected ${changeEvent.type} in ${changeEvent.path}`);

        // Debounce changes to avoid rapid rebuilds
        this.debounceSchemaChange(schemaFile, outputDir, delayMs);
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        return; // Expected when stopping the watcher
      }
      throw error;
    }
  }

  private debounceSchemaChange(
    schemaFile: string,
    outputDir: string,
    delayMs: number
  ): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      try {
        await this.processSchemaChanges(schemaFile, outputDir);
      } catch (error) {
        console.error(
          `❌ Failed to process schema changes: ${(error as Error).message}`
        );
      }
    }, delayMs);
  }

  private async processSchemaChanges(
    schemaFile: string,
    outputDir: string
  ): Promise<void> {
    console.log("🔄 Processing schema changes...");

    try {
      // Parse current schema with error recovery so all SDL syntax errors
      // surface in one go — `parse()` would bail on the first one and the
      // user would have to fix-save-fix-save in a hot loop. (P2-06)
      const schemaContent = await Deno.readTextFile(schemaFile);
      const parser = new SDLParser(schemaContent);
      const { document: ast, errors } = parser.parseWithRecovery();
      if (errors.length > 0) {
        console.log(
          `⚠️  ${errors.length} SDL syntax error${errors.length === 1 ? "" : "s"}:`
        );
        for (const e of errors) {
          console.log(`   • ${e.message}`);
        }
        console.log("");
        // If the parser couldn't recover anything, bail; otherwise carry
        // on with the partial AST so codegen/migration plan can still run
        // against whatever did parse cleanly.
        if (ast.declarations.length === 0)
          return;
        console.log(
          `   (Continuing with the ${ast.declarations.length} declaration${ast.declarations.length === 1 ? "" : "s"} that did parse.)\n`
        );
      }
      const converter = new SDLConverter();
      const modules = converter.convertToModules(ast);
      const currentHash = this.hashSchema(modules);

      // Check for migration changes
      const migrationNeeded = currentHash !== this.lastSchemaHash &&
        this.lastSchemaHash !== undefined;

      if (migrationNeeded) {
        console.log("📋 Schema changes detected, creating migration...");
        await this.runMigration(modules, true); // dry run first

        console.log("💡 Review migration and run 'disc migrate' to apply");
      } else if (this.lastSchemaHash === undefined) {
        console.log("📋 Initial schema detected");
        // For initial schema, we might want to create the initial migration
        await this.runMigration(modules, true);
      } else {
        console.log("✅ No migration needed");
      }

      // Always regenerate types for development, using the real parsed
      // modules rather than the dummy test schema. (P1-19)
      console.log("🔧 Regenerating TypeScript types...");
      await this.runCodegen(outputDir, modules);

      // Update last hash
      this.lastSchemaHash = currentHash;

      console.log("✅ Schema processing complete");
      console.log("");
    } catch (error) {
      // P1-14: detect the "file was deleted mid-watch" case and print a
      // specific message so the user knows why we stopped working.
      if (error instanceof Deno.errors.NotFound) {
        console.error(
          `⚠️  Schema file disappeared: ${schemaFile}. Restore it or run 'disc watch' again to pick up a different path.`
        );
      } else {
        console.error(
          `❌ Schema processing failed: ${(error as Error).message}`
        );
      }
      console.log("");
    }
  }

  private hashSchema(modules: Module[]): string {
    const content = JSON.stringify(modules);
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  private async runMigration(
    newModules: Module[],
    dryRun = false
  ): Promise<void> {
    try {
      // Get database URL
      const databaseUrl = Deno.env.get("DATABASE_URL") ||
        "postgresql://localhost:5432/disc";

      // Initialize tracker
      const tracker = new MigrationTracker(databaseUrl);
      const initResult = await tracker.initialize();
      if (!initResult.ok) {
        console.log(
          "   ⚠️  Migration tracker not initialized, skipping migration"
        );
        return;
      }

      // Get migration history to determine old schema
      const historyResult = await tracker.getMigrationHistory();
      const hasHistory = historyResult.ok && historyResult.value.length > 0;

      // For now, we'll need to reconstruct old modules from history
      // In a real implementation, we'd store the full schema state
      const oldModules: Module[] | null = hasHistory ? [] : null;

      // Create migration engine
      const config: Types.MigrationConfig = {
        databaseUrl: databaseUrl,
        dryRun: dryRun,
        autoApprove: false,
        migrationsDir: "./migrations",
        schemaFile: "./dbschema/default.disc",
        backupBeforeMigration: false,
        rollbackOnError: true
      };
      const engine = new MigrationEngine(config);

      // Plan migration
      const planResult = engine.planMigration(oldModules, newModules);
      if (!planResult.ok) {
        console.error(
          `   ❌ Migration planning failed: ${planResult.error.message}`
        );
        return;
      }

      const plan = planResult.value;
      const firstMigration = plan.migrations[0];
      if (!firstMigration || firstMigration.operations.length === 0) {
        console.log("   ℹ️  No operations in migration");
        await tracker.close();
        await engine.close();
        return;
      }

      if (dryRun) {
        console.log("   📋 Migration plan (dry run):");
        for (const op of firstMigration.operations) {
          console.log(`      - ${this.formatOperation(op)}`);
        }
        console.log("   💡 Run 'disc migrate' to apply");
      } else {
        // Execute migration
        const execResult = await engine.executeMigration(plan);
        if (execResult.ok) {
          console.log(
            `   ✅ Migration applied successfully (${execResult.value[0].durationMs}ms)`
          );

          // Record migration
          await tracker.recordMigration(firstMigration, execResult.value[0]);
        } else {
          console.error(`   ❌ Migration failed: ${execResult.error.message}`);
        }
      }

      await tracker.close();
      await engine.close();
    } catch (error) {
      console.error(`   ❌ Migration error: ${(error as Error).message}`);
    }
  }

  private formatOperation(op: Types.MigrationOperation): string {
    switch (op.kind) {
      case "CreateType":
        return `Create type '${(op as Types.CreateTypeOperation).typeName}'`;
      case "DropType":
        return `Drop type '${(op as Types.DropTypeOperation).typeName}'`;
      case "AlterType":
        return `Alter type '${(op as Types.AlterTypeOperation).typeName}'`;
      case "AddProperty":
        return `Add property '${(op as Types.AddPropertyOperation).property.name}'`;
      case "DropProperty":
        return `Drop property '${(op as Types.DropPropertyOperation).propertyName}'`;
      case "AlterProperty":
        return `Alter property '${(op as Types.AlterPropertyOperation).propertyName}'`;
      default:
        return `${op.kind}: ${JSON.stringify(op)}`;
    }
  }

  private async runCodegen(
    outputDir: string,
    modules?: Module[]
  ): Promise<void> {
    try {
      // Create output directory
      await ensureDir(outputDir);

      // Prefer the real parsed modules (P1-19). Fall back to the built-in
      // test schema only when the caller didn't have modules — e.g. during
      // startup before the first file-change event.
      let schema;
      if (modules && modules.length > 0) {
        const manager = new SchemaManager({ dryRun: true });
        await manager.initialize();
        schema = manager.modulesToSchema(modules);
      } else {
        schema = Context.createTestSchema();
      }
      const result = generateTypeScript(schema, {
        outputDir: outputDir
      });

      // Write generated files
      await writeGeneratedFiles(result, ".");

      console.log(`   ✅ Generated ${result.files.length} TypeScript file${result.files.length === 1 ? "" : "s"}`);
    } catch (error) {
      console.error(`   ❌ Codegen failed: ${(error as Error).message}`);
    }
  }

  private async createDefaultSchema(schemaFile: string): Promise<void> {
    const defaultSchema = `module default {
  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    createdAt: datetime {
      default := datetime_current();
    };
  };
};`;

    // Create directory if needed
    const dir = dirname(schemaFile);
    if (dir && dir !== ".") {
      await ensureDir(dir);
    }

    await Deno.writeTextFile(schemaFile, defaultSchema);
    console.log(`✅ Created default schema at ${schemaFile}`);
    console.log("");
  }

  private getChangeType(kind: string): "create" | "modify" | "remove" {
    switch (kind) {
      case "create":
        return "create";
      case "remove":
        return "remove";
      default:
        return "modify";
    }
  }

  private setupSignalHandlers(): void {
    const handler = () => {
      console.log("\n⏹️  Stopping file watcher...");
      this.stop();
    };

    Deno.addSignalListener("SIGINT", handler);
    Deno.addSignalListener("SIGTERM", handler);
  }

  stop(): void {
    this.isWatching = false;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  getStatus(): { watching: boolean; files: string[]; uptime: number; } {
    return {
      watching: this.isWatching,
      files: [], // Would track watched files in real implementation
      uptime: 0 // Would track uptime in real implementation
    };
  }
}

/**
 * Watch command instance with execute method for CLI integration
 */
export const watchCommand = new WatchCommand();

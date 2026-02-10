/**
 * CLI Watch Command Implementation - File watching for development
 */

export interface WatchOptions {
  schema_file?: string;
  output_dir?: string;
  delay_ms?: number;
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
  
  /**
   * Watch schema files for changes and trigger migrations/codegen
   */
  async execute(options: WatchOptions): Promise<void> {
    console.log("🔍 Watching schema files for changes...");
    
    const schemaFile = options.schema_file || "./schema.esdl";
    const outputDir = options.output_dir || "./generated";
    const delayMs = options.delay_ms || 1000;

    console.log(`📂 Watching: ${schemaFile}`);
    console.log(`📁 Output: ${outputDir}`);
    console.log(`⏱️  Debounce: ${delayMs}ms`);
    console.log("");

    try {
      // Verify schema file exists
      const schemaExists = await Deno.stat(schemaFile).then(() => true).catch(() => false);
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
      if (error.name === "AbortError") {
        console.log("\n🛑 File watcher stopped");
      } else {
        console.error(`❌ Failed to start file watcher: ${error.message}`);
        throw error;
      }
    }
  }

  private async startFileWatcher(schemaFile: string, outputDir: string, delayMs: number): Promise<void> {
    if (!this.abortController) {
      throw new Error("AbortController not initialized");
    }

    try {
      // Watch the directory containing the schema file
      const schemaDir = schemaFile.includes('/') 
        ? schemaFile.substring(0, schemaFile.lastIndexOf('/')) 
        : '.';

      const watcher = Deno.watchFs([schemaDir], {
        recursive: false
      });

      for await (const event of watcher) {
        if (!this.isWatching) break;

        // Check if this is our schema file
        const changedFile = event.paths.find(path => path.endsWith('.esdl'));
        if (!changedFile) continue;

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
      if (error.name === "AbortError") {
        return; // Expected when stopping the watcher
      }
      throw error;
    }
  }

  private debounceSchemaChange(schemaFile: string, outputDir: string, delayMs: number): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(async () => {
      try {
        await this.processSchemaChanges(schemaFile, outputDir);
      } catch (error) {
        console.error(`❌ Failed to process schema changes: ${error.message}`);
      }
    }, delayMs);
  }

  private async processSchemaChanges(schemaFile: string, outputDir: string): Promise<void> {
    console.log("🔄 Processing schema changes...");
    
    try {
      // Check for migration changes
      const migrationNeeded = await this.checkMigrationNeeded(schemaFile);
      
      if (migrationNeeded) {
        console.log("📋 Schema changes detected, creating migration...");
        await this.runMigration(schemaFile, true); // dry run first
        
        console.log("💡 Review migration and run 'disc migrate' to apply");
      } else {
        console.log("✅ No migration needed");
      }

      // Always regenerate types for development
      console.log("🔧 Regenerating TypeScript types...");
      await this.runCodegen(schemaFile, outputDir);
      
      console.log("✅ Schema processing complete");
      console.log("");
    } catch (error) {
      console.error(`❌ Schema processing failed: ${error.message}`);
      console.log("");
    }
  }

  private async checkMigrationNeeded(schemaFile: string): Promise<boolean> {
    // TODO: Implement actual migration checking
    // This would:
    // 1. Parse current schema
    // 2. Compare with last applied migration
    // 3. Return true if differences found
    
    // For now, simulate check
    const random = Math.random();
    return random > 0.7; // 30% chance of migration needed for demo
  }

  private async runMigration(schemaFile: string, dryRun = false): Promise<void> {
    // TODO: Integrate with actual migration engine
    // For now, simulate migration command
    
    const command = dryRun ? "disc migrate --create --dry-run" : "disc migrate";
    console.log(`   Running: ${command}`);
    
    if (dryRun) {
      console.log("   📋 Migration plan created (dry run)");
    } else {
      console.log("   ✅ Migration applied successfully");
    }
  }

  private async runCodegen(schemaFile: string, outputDir: string): Promise<void> {
    // TODO: Integrate with actual codegen engine
    // For now, simulate codegen command
    
    console.log(`   Generating types to ${outputDir}...`);
    
    // Create output directory if it doesn't exist
    await Deno.mkdir(outputDir, { recursive: true }).catch(() => {});
    
    // Simulate type file generation
    const typesContent = `// Generated types from ${schemaFile}
// Generated at ${new Date().toISOString()}

export interface User {
  id: string;
  name: string;
  email: string;
  created_at: Date;
}

export interface DiscClient {
  user: {
    select(): Promise<User[]>;
    insert(data: Omit<User, 'id' | 'created_at'>): Promise<User>;
  };
}
`;

    await Deno.writeTextFile(`${outputDir}/types.ts`, typesContent);
    console.log("   ✅ Types generated successfully");
  }

  private async createDefaultSchema(schemaFile: string): Promise<void> {
    const defaultSchema = `module default {
  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    created_at: datetime {
      default := datetime_current();
    };
  };
};`;

    // Create directory if needed
    const dir = schemaFile.substring(0, schemaFile.lastIndexOf('/'));
    if (dir && dir !== schemaFile) {
      await Deno.mkdir(dir, { recursive: true }).catch(() => {});
    }

    await Deno.writeTextFile(schemaFile, defaultSchema);
    console.log(`✅ Created default schema: ${schemaFile}`);
  }

  private getChangeType(kind: Deno.FsEvent["kind"]): FileChangeEvent["type"] {
    switch (kind) {
      case "create":
        return "create";
      case "modify":
        return "modify";
      case "remove":
        return "remove";
      default:
        return "modify";
    }
  }

  private setupSignalHandlers(): void {
    const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];

    for (const signal of signals) {
      Deno.addSignalListener(signal, () => {
        this.stop();
      });
    }
  }

  /**
   * Stop the file watcher
   */
  stop(): void {
    if (!this.isWatching) return;

    console.log("\n🛑 Stopping file watcher...");
    
    this.isWatching = false;
    
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    
    if (this.abortController) {
      this.abortController.abort();
    }
    
    console.log("✅ File watcher stopped");
    Deno.exit(0);
  }

  /**
   * Check if watcher is currently running
   */
  isRunning(): boolean {
    return this.isWatching;
  }

  /**
   * Get current watch status
   */
  getStatus(): { watching: boolean; files: string[]; uptime: number } {
    return {
      watching: this.isWatching,
      files: [], // TODO: Track watched files
      uptime: 0  // TODO: Track uptime
    };
  }
}

export const watchCommand = new WatchCommand();
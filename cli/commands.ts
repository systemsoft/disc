// deno-lint-ignore-file no-console
/**
 * CLI Commands Implementation - Core command functionality
 */

import { SchemaManager } from "../migration/schema-manager.ts";
import type { Module } from "../schema/converter.ts";
import { createServerFromEnv } from "../server/server.ts";
import * as Codegen from "../codegen/mod.ts";
import * as Context from "../compiler/context.ts";
import type { Schema } from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { initCommand, InitOptions } from "./init.ts";
import { shellCommand, ShellOptions } from "./shell.ts";
import { watchCommand, WatchOptions } from "./watch.ts";
import { buildCommand, BuildOptions } from "./build.ts";
import { deployCommand, DeployOptions } from "./deploy.ts";
import { pgLogCommand, PgLogOptions } from "./pg-log.ts";
import { pgUpgradeCommand, PgUpgradeOptions } from "./pg-upgrade.ts";
import { dbCommand } from "./db.ts";
import { PostgresManager } from "../postgres/mod.ts";
import { MigrationSquasher, SquashableMigration } from "../migration/squash.ts";

export interface CLIArgs {
  [key: string]: any;
  _: (string | number)[];
}

export interface ServeOptions {
  port?: number;
  host?: string;
  config?: string;
  jwtSecret?: string;
  enableAuth?: boolean;
  enableAccessPolicies?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  binaryPort?: number;
}

export class CLICommands {
  private postgresManager: PostgresManager;

  constructor() {
    this.postgresManager = new PostgresManager();
  }
  /**
   * Initialize a new Disc project
   */
  async init(options: InitOptions): Promise<void> {
    await initCommand.execute(options);
  }

  /**
   * Handle migration commands (create and apply)
   */
  async migrate(args: CLIArgs): Promise<void> {
    const schemaFile = args.schema || "./dbschema/default.esdl";
    const dryRun = args["dry-run"] || false;
    const databaseUrl = args["backend-dsn"] ||
      Deno.env.get("DATABASE_URL") ||
      "postgresql://localhost:5432/disc_dev";

    let pool: ConnectionPool | undefined;
    let manager: SchemaManager | undefined;

    try {
      if (dryRun) {
        // Dry-run mode: no pool needed, no PostgreSQL connection required
        manager = new SchemaManager({ dryRun: true });
        await manager.initialize();
      } else {
        // Live mode: create pool and wire to SchemaManager
        pool = new ConnectionPool({ connectionString: databaseUrl });
        await pool.initialize();

        manager = new SchemaManager({ pool, dryRun: false });
        await manager.initialize();
      }

      if (args.status) {
        await this.showMigrationStatus(manager);
      } else if (args.rollback || args["rollback-to"]) {
        await this.handleRollback(manager, args);
      } else if (args.squash) {
        await this.handleSquash(manager, args);
      } else if (args.create) {
        await this.createMigration(manager, schemaFile);
      } else {
        await this.applyMigrations(manager, schemaFile, dryRun);
      }
    } catch (error) {
      console.error(`Migration failed: ${(error as Error).message}`);
      throw error;
    } finally {
      if (manager) {
        await manager.close();
      }
      if (pool) {
        await pool.close();
      }
    }
  }

  /**
   * Start the Disc server
   */
  async serve(options: ServeOptions): Promise<void> {
    console.log("🚀 Starting Disc Database Server...");

    try {
      // Start PostgreSQL instance first
      const projectName = await this.getProjectName();
      console.log(`📦 Starting PostgreSQL for project: ${projectName}`);

      // Check if instance exists, create if not
      let instance = this.postgresManager.getInstance(projectName);
      if (!instance) {
        console.log("📋 Creating PostgreSQL instance...");
        instance = await this.postgresManager.createInstance(projectName, {
          port: 5432,
        });
      }

      // Start the PostgreSQL instance with monitoring
      await this.postgresManager.startInstance(projectName, true);
      console.log("✅ PostgreSQL started successfully");
      console.log(`📡 Connection: ${instance.dsn()}`);

      // Set DATABASE_URL for the server
      Deno.env.set("DATABASE_URL", instance.dsn());

      // Set auth env vars from CLI flags
      if (options.jwtSecret) {
        Deno.env.set("DISC_JWT_SECRET", options.jwtSecret);
      }
      if (options.enableAuth) {
        Deno.env.set("DISC_ENABLE_AUTH", "true");
      }
      if (options.enableAccessPolicies) {
        Deno.env.set("DISC_ENABLE_ACCESS_POLICIES", "true");
      }

      // Set TLS env vars from CLI flags
      if (options.tlsCert) {
        Deno.env.set("DISC_TLS_CERT", options.tlsCert);
      }
      if (options.tlsKey) {
        Deno.env.set("DISC_TLS_KEY", options.tlsKey);
      }

      // Try to load the project schema from SDL
      const schema = await this.readSchemaAsCompilerSchema(
        "./dbschema/default.esdl",
      );

      if (schema) {
        const objectTypeCount = Array.from(schema.types.values()).filter(
          (t) => t.kind === "object",
        ).length;
        console.log(
          `  Loaded schema with ${objectTypeCount} object types`,
        );
      } else {
        console.log("  No schema file found, using default test schema");
      }

      // Log auth status
      if (options.jwtSecret || Deno.env.get("DISC_JWT_SECRET")) {
        console.log("🔐 Authentication enabled");
      }
      if (
        options.enableAccessPolicies ||
        Deno.env.get("DISC_ENABLE_ACCESS_POLICIES")
      ) {
        console.log("🛡️ Access policies enabled");
      }

      // Create server from environment variables, passing schema if available
      const server = schema
        ? createServerFromEnv(undefined, schema)
        : createServerFromEnv();

      // Override with CLI arguments if provided
      const config = server.get_config();
      if (options.port) config.port = options.port;
      if (options.host) config.host = options.host;
      if (options.binaryPort) config.binaryPort = options.binaryPort;

      server.update_config(config);

      // Set up signal handlers for graceful shutdown
      const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];

      for (const signal of signals) {
        Deno.addSignalListener(signal, async () => {
          console.log(`\n📡 Received ${signal}, shutting down gracefully...`);
          await server.stop();
          await this.postgresManager.stopInstance(projectName);
          console.log("✅ PostgreSQL stopped");
          Deno.exit(0);
        });
      }

      // Start the server
      await server.start();
    } catch (error) {
      console.error(`❌ Failed to start server: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Open interactive EdgeQL shell
   */
  async shell(options: ShellOptions): Promise<void> {
    await shellCommand.execute(options);
  }

  /**
   * Generate TypeScript types from schema
   */
  async codegen(args: CLIArgs): Promise<void> {
    console.log("🚀 Generating TypeScript types...");

    const outputDir = args.output || "./dbschema/disc-client";
    const schemaDir = args["schema-dir"] || "./dbschema";
    const schemaFile = args.schema as string | undefined;
    const target = args.target || "client";

    try {
      let schema: Schema;

      if (schemaFile) {
        // Single-file mode (explicit --schema flag)
        console.log(`📋 Schema: ${schemaFile}`);
        const loaded = await this.readSchemaAsCompilerSchema(schemaFile);

        if (loaded) {
          schema = loaded;
          const typeNames = Array.from(schema.types.keys()).join(", ");
          console.log(`📖 Loaded types: ${typeNames}`);
        } else {
          console.log(
            `⚠️  No schema found at ${schemaFile}, falling back to test schema`,
          );
          schema = Context.createTestSchema();
        }
      } else {
        // Multi-file mode: discover schema files from directory
        console.log(`📋 Schema dir: ${schemaDir}`);
        const files = await Codegen.discoverSchemaFiles(schemaDir);

        if (files.length > 0) {
          console.log(
            `📖 Discovered ${files.length} schema file(s): ${
              files.map((f) => f.split("/").pop()).join(", ")
            }`,
          );
          schema = await Codegen.loadMultiFileSchema(files);
          const typeNames = Array.from(schema.types.keys()).join(", ");
          console.log(`📖 Loaded types: ${typeNames}`);
        } else {
          console.log(
            `⚠️  No schema files found in ${schemaDir}, falling back to test schema`,
          );
          schema = Context.createTestSchema();
        }
      }

      console.log(`📋 Output: ${outputDir}`);
      console.log(`📋 Target: ${target}`);

      // Generate TypeScript code
      const config: Partial<Codegen.CodegenConfig> = {
        outputDir: outputDir,
        schemaSource: schemaFile || schemaDir,
        schemaDir: schemaDir,
        target: target as "client" | "server" | "both",
        includeQueryBuilders: args["no-queries"] !== true,
        includeMutations: args["no-mutations"] !== true,
        includeClient: args["no-client"] !== true,
        formatOutput: args["no-format"] !== true,
      };

      console.log(`⚙️  Generating code...`);
      const result = Codegen.generateTypeScript(schema, config);

      if (result.errors.length > 0) {
        console.error(`❌ Generation failed with errors:`);
        result.errors.forEach((error) => console.error(`   ${error}`));
        return;
      }

      // Write files to disk
      console.log(`💾 Writing ${result.files.length} files...`);
      await Codegen.writeGeneratedFiles(result, ".");

      // Show summary
      console.log(`\n📊 Generation Summary:`);
      console.log(`   Files generated: ${result.files.length}`);
      console.log(
        `   Types generated: ${Array.from(schema.types.keys()).length}`,
      );
      console.log(`   Warnings: ${result.warnings.length}`);
      console.log(`   Errors: ${result.errors.length}`);

      if (result.warnings.length > 0) {
        console.log(`\n⚠️  Warnings:`);
        result.warnings.forEach((warning) => console.log(`   ${warning}`));
      }

      console.log(`\n✅ TypeScript generation complete!`);
      console.log(`💡 Usage example:`);
      console.log(`   import { DiscClient } from "./${outputDir}/index.ts";`);
      console.log(
        `   const client = new DiscClient({ host: "localhost", port: 5656 });`,
      );
      console.log(`   const users = await client.user.select();`);
    } catch (error) {
      console.error(`❌ Failed to generate types: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Watch schema files for changes
   */
  async watch(options: WatchOptions): Promise<void> {
    await watchCommand.execute(options);
  }

  /**
   * Start PostgreSQL instance
   */
  async start(args: CLIArgs): Promise<void> {
    const projectName = await this.getProjectName();
    console.log(`🚀 Starting PostgreSQL for project: ${projectName}`);

    try {
      // Check if instance exists
      let instance = this.postgresManager.getInstance(projectName);

      if (!instance) {
        console.log("📋 Creating new PostgreSQL instance...");
        instance = await this.postgresManager.createInstance(projectName, {
          port: args.port || 5432,
        });
      }

      // Start the instance with monitoring
      await this.postgresManager.startInstance(
        projectName,
        !args["no-monitor"],
      );

      const status = await instance.status();
      console.log("✅ PostgreSQL started successfully");
      console.log(`📊 Status:`);
      console.log(`   PID: ${status.pid || "N/A"}`);
      console.log(`   Port: ${status.port || "Unix socket"}`);
      console.log(`   Data: ${status.dataDir}`);
      console.log(`   DSN: ${instance.dsn()}`);
    } catch (error) {
      console.error(
        `❌ Failed to start PostgreSQL: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Stop PostgreSQL instance
   */
  async stop(_args: CLIArgs): Promise<void> {
    const projectName = await this.getProjectName();
    console.log(`🛑 Stopping PostgreSQL for project: ${projectName}`);

    try {
      await this.postgresManager.stopInstance(projectName);
      console.log("✅ PostgreSQL stopped successfully");
    } catch (error) {
      console.error(
        `❌ Failed to stop PostgreSQL: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Show PostgreSQL status
   */
  async status(_args: CLIArgs): Promise<void> {
    const projectName = await this.getProjectName();
    console.log(`📊 PostgreSQL Status for project: ${projectName}\n`);

    try {
      const status = await this.postgresManager.getInstanceStatus(projectName);

      if (!status) {
        console.log("❌ No PostgreSQL instance found for this project");
        console.log("💡 Run 'disc init' to create a new instance");
        return;
      }

      const statusIcon = status.running ? "🟢" : "🔴";
      console.log(
        `${statusIcon} Status: ${status.running ? "Running" : "Stopped"}`,
      );

      if (status.running) {
        console.log(`   PID: ${status.pid}`);
        console.log(`   Port: ${status.port || "Unix socket only"}`);
        console.log(
          `   Started: ${status.startedAt?.toLocaleString() || "Unknown"}`,
        );

        if (status.health) {
          console.log(`\n🏥 Health Check:`);
          console.log(`   Healthy: ${status.health.healthy ? "Yes" : "No"}`);
          console.log(`   Connections: ${status.health.connections}`);
          console.log(`   Latency: ${status.health.latencyMs}ms`);
          console.log(
            `   Uptime: ${
              Math.floor((status.health.uptime || 0) / 60)
            } minutes`,
          );
        }
      }

      console.log(`\n📁 Data Directory: ${status.dataDir}`);
      console.log(`🔗 Socket Path: ${status.socketPath}`);
      console.log(`📦 Version: PostgreSQL ${status.version}`);
    } catch (error) {
      console.error(`❌ Failed to get status: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Open the admin UI in browser
   */
  async ui(args: CLIArgs): Promise<void> {
    const port = args.port || 5656;
    console.log(`🌐 Opening Disc Admin UI...`);

    try {
      // Import the UI server module
      const { uiServer } = await import("../ui/server-integration.ts");

      // Check if UI is built
      const isBuilt = await uiServer.isBuilt();
      if (!isBuilt) {
        console.error("❌ UI not built. Please run:");
        console.error("   cd ui && npm install && npm run build");
        return;
      }

      // Open in browser
      await uiServer.openInBrowser(port);
    } catch (error) {
      console.error(`❌ Failed to open UI: ${(error as Error).message}`);
    }
  }

  /**
   * Restart PostgreSQL instance
   */
  async restart(args: CLIArgs): Promise<void> {
    const projectName = await this.getProjectName();
    console.log(`🔄 Restarting PostgreSQL for project: ${projectName}`);

    try {
      const instance = this.postgresManager.getInstance(projectName);
      if (!instance) {
        console.error("❌ No PostgreSQL instance found for this project");
        return;
      }

      await instance.restart();
      console.log("✅ PostgreSQL restarted successfully");

      // Show new status
      await this.status(args);
    } catch (error) {
      console.error(
        `❌ Failed to restart PostgreSQL: ${(error as Error).message}`,
      );
      throw error;
    }
  }

  /**
   * Build a self-contained binary via deno compile
   */
  async build(options: BuildOptions): Promise<void> {
    await buildCommand.execute(options);
  }

  /**
   * Generate deployment artifacts
   */
  async deploy(options: DeployOptions): Promise<void> {
    await deployCommand.execute(options);
  }

  /**
   * View PostgreSQL logs
   */
  async pgLog(options: PgLogOptions): Promise<void> {
    await pgLogCommand.execute(options);
  }

  /**
   * Upgrade PostgreSQL version
   */
  async pgUpgrade(options: PgUpgradeOptions): Promise<void> {
    await pgUpgradeCommand.execute(options);
  }

  /**
   * Create a new Disc-managed database
   */
  async dbCreate(name: string, args: CLIArgs): Promise<void> {
    const databaseUrl = args["database-url"] ||
      Deno.env.get("DATABASE_URL") ||
      "postgresql://localhost:5432/disc";
    await dbCommand.create({ name, databaseUrl });
  }

  /**
   * List all Disc-managed databases
   */
  async dbList(args: CLIArgs): Promise<void> {
    const databaseUrl = args["database-url"] ||
      Deno.env.get("DATABASE_URL") ||
      "postgresql://localhost:5432/disc";
    await dbCommand.list({ databaseUrl });
  }

  /**
   * Drop a Disc-managed database
   */
  async dbDrop(name: string, args: CLIArgs): Promise<void> {
    const databaseUrl = args["database-url"] ||
      Deno.env.get("DATABASE_URL") ||
      "postgresql://localhost:5432/disc";
    await dbCommand.drop({
      name,
      databaseUrl,
      force: args.force || false,
    });
  }

  private async showMigrationStatus(
    manager: SchemaManager,
  ): Promise<void> {
    console.log("Migration Status\n");

    const statusResult = await manager.getMigrationStatus();
    if (!statusResult.ok) {
      console.error(
        `Failed to get migration status: ${statusResult.error.message}`,
      );
      return;
    }

    const status = statusResult.value;

    console.log(`  Applied migrations: ${status.applied}`);
    console.log(
      `  Current schema hash: ${status.currentSchemaHash || "(none)"}`,
    );

    if (status.latestMigration) {
      console.log(`\n  Latest migration:`);
      console.log(`    ID: ${status.latestMigration.id}`);
      console.log(`    Name: ${status.latestMigration.name}`);
      console.log(
        `    Applied at: ${status.latestMigration.appliedAt.toISOString()}`,
      );
    } else {
      console.log(`\n  No migrations have been applied yet.`);
    }
  }

  private async handleRollback(
    manager: SchemaManager,
    args: CLIArgs,
  ): Promise<void> {
    if (!args.force) {
      console.error(
        "Error: Rollback is a destructive operation that may cause data loss.",
      );
      console.error(
        "       Rolling back DROP TABLE cannot restore lost data.",
      );
      console.error(
        "       Use --force to confirm you understand the risks.",
      );
      return;
    }

    if (args["rollback-to"]) {
      const targetId = args["rollback-to"];
      console.log(`Rolling back all migrations after ${targetId}...`);

      const result = await manager.rollbackToMigration(targetId);
      if (!result.ok) {
        console.error(`Rollback failed: ${result.error.message}`);
        return;
      }

      console.log(`Successfully rolled back to migration ${targetId}`);
    } else {
      console.log("Rolling back the most recent migration...");

      const result = await manager.rollbackLastMigration();
      if (!result.ok) {
        console.error(`Rollback failed: ${result.error.message}`);
        return;
      }

      console.log("Successfully rolled back the last migration");
    }
  }

  private async handleSquash(
    manager: SchemaManager,
    args: CLIArgs,
  ): Promise<void> {
    console.log("Squashing migrations...");

    const fromId = args["squash-from"] as string | undefined;
    const toId = args["squash-to"] as string | undefined;

    // Get migration history to build squashable list
    const statusResult = await manager.getMigrationStatus();
    if (!statusResult.ok) {
      console.error(
        `Failed to get migration status: ${statusResult.error.message}`,
      );
      return;
    }

    if (statusResult.value.applied === 0) {
      console.log("No migrations to squash.");
      return;
    }

    // Build SquashableMigration list from history
    // Note: In a full implementation, we'd load DDL statements from stored migration files.
    // For now, we create entries from the history and rely on the squasher for validation.
    const historyResult = await manager.getMigrationHistory();
    if (!historyResult.ok) {
      console.error(
        `Failed to get migration history: ${historyResult.error.message}`,
      );
      return;
    }

    // History is DESC by default, reverse to ASC for squashing
    const history = historyResult.value.reverse();

    const squashable: SquashableMigration[] = history.map((entry) => ({
      id: entry.id,
      name: entry.name,
      statements: [], // Would be loaded from migration files in production
      rollbackStatements: [],
      hasDataMigration: entry.dataMigration,
    }));

    const squasher = new MigrationSquasher();

    try {
      const result = squasher.squash(squashable, fromId, toId);

      if (result.squashedIds.length === 0) {
        console.log("No migrations in the specified range to squash.");
        return;
      }

      console.log(`\nSquash Result:`);
      console.log(`  Name: ${result.name}`);
      console.log(`  Migrations squashed: ${result.squashedIds.length}`);
      console.log(`  Combined statements: ${result.statements.length}`);
      console.log(
        `  Combined rollback statements: ${result.rollbackStatements.length}`,
      );
      console.log(`\n  Squashed migration IDs:`);
      result.squashedIds.forEach((id) => console.log(`    - ${id}`));

      console.log(
        "\nSquash preview complete. In production, this would replace the individual migrations with the squashed result.",
      );
    } catch (error) {
      console.error(`Squash failed: ${(error as Error).message}`);
    }
  }

  private async createMigration(
    manager: SchemaManager,
    schemaFile: string,
  ): Promise<void> {
    console.log("Creating new migration...");

    // Read SDL source from schema file
    let sdlSource: string;

    try {
      sdlSource = await Deno.readTextFile(schemaFile);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.error(`Schema file not found: ${schemaFile}`);
        return;
      }
      throw error;
    }

    // Plan the migration
    const planResult = manager.planSchema(sdlSource);

    if (!planResult.ok) {
      console.error(`Migration planning failed: ${planResult.error.message}`);
      return;
    }

    const plan = planResult.value;

    if (plan.operationsCount === 0) {
      console.log("No changes detected - schema is up to date");
      return;
    }

    console.log(`Migration Plan:`);
    console.log(`   Operations: ${plan.operationsCount}`);
    console.log(`   Estimated Duration: ${plan.estimatedDuration || 0}ms\n`);

    plan.migrations.forEach((migration, i) => {
      console.log(`${i + 1}. ${migration.name} (${migration.id})`);
      console.log(`   ${migration.description}`);
      console.log(`   Operations: ${migration.operations.length}\n`);
    });

    // Generate DDL for preview
    const ddlResult = manager.generateDDL(plan);
    if (ddlResult.ok) {
      console.log("Generated DDL:");
      ddlResult.value.forEach((stmt, i) => {
        if (stmt.trim() && !stmt.startsWith("--")) {
          console.log(`   ${i + 1}. ${stmt}`);
        }
      });
    }

    // Validate the migration
    const validationResult = manager.validateMigration(plan);
    if (!validationResult.ok) {
      console.log(`Validation warning: ${validationResult.error.message}`);
    }

    console.log("\nMigration created successfully");
    console.log("Run 'disc migrate' to apply the migration");
  }

  private async applyMigrations(
    manager: SchemaManager,
    schemaFile: string,
    dryRun: boolean,
  ): Promise<void> {
    console.log("Applying migrations...");

    // Read SDL source from schema file
    let sdlSource: string;

    try {
      sdlSource = await Deno.readTextFile(schemaFile);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.error(`Schema file not found: ${schemaFile}`);
        return;
      }
      throw error;
    }

    if (dryRun) {
      // Dry-run: plan and show DDL without executing
      const planResult = manager.planSchema(sdlSource);

      if (!planResult.ok) {
        console.error(
          `Migration planning failed: ${planResult.error.message}`,
        );
        return;
      }

      const plan = planResult.value;

      if (plan.operationsCount === 0) {
        console.log("No migrations to apply - schema is up to date");
        return;
      }

      console.log(`DRY RUN - ${plan.migrations.length} migration(s) planned:`);
      plan.migrations.forEach((migration, i) => {
        console.log(`  ${i + 1}. ${migration.name}`);
        console.log(`     ${migration.description}`);
      });

      const ddlResult = manager.generateDDL(plan);
      if (ddlResult.ok) {
        console.log("\nDDL that would be executed:");
        ddlResult.value.forEach((stmt, i) => {
          if (stmt.trim() && !stmt.startsWith("--")) {
            console.log(`   ${i + 1}. ${stmt}`);
          }
        });
      }

      console.log("\nNo changes applied (dry-run mode)");
    } else {
      // Live execution: applySchema handles parse + diff + execute
      const applyResult = await manager.applySchema(sdlSource);

      if (!applyResult.ok) {
        console.error(
          `Migration execution failed: ${applyResult.error.message}`,
        );
        return;
      }

      const results = applyResult.value;

      if (results.length === 0) {
        console.log("No migrations to apply - schema is up to date");
        return;
      }

      console.log("\nMigration Results:");

      results.forEach((result, i) => {
        const status = result.success ? "Success" : "Failed";
        console.log(`  ${i + 1}. Migration ${result.migrationId}: ${status}`);
        console.log(`     Duration: ${result.durationMs}ms`);
        console.log(`     Applied: ${result.appliedAt.toISOString()}`);

        if (result.error) {
          console.log(`     Error: ${result.error}`);
        }
      });

      const allSucceeded = results.every((r) => r.success);
      if (allSucceeded) {
        console.log("\nAll migrations applied successfully!");
      } else {
        console.error("\nSome migrations failed. Review the errors above.");
      }
    }
  }

  /**
   * Get the project name from disc.toml or current directory
   */
  private async getProjectName(): Promise<string> {
    try {
      // Try to read from disc.toml
      const configFile = await Deno.readTextFile("disc.toml").catch(() => null);
      if (configFile) {
        // Simple extraction - in production use proper TOML parser
        const match = configFile.match(/name\s*=\s*"([^"]+)"/);
        if (match) return match[1];
      }
    } catch {
      // Ignore errors
    }

    // Fall back to current directory name
    const cwd = Deno.cwd();
    const parts = cwd.split("/");
    return parts[parts.length - 1] || "default";
  }

  /**
   * Read and parse an SDL schema file into Module[] representation.
   *
   * Reads the file from disk and parses the SDL source via SchemaManager.
   * Returns null if the file does not exist or parsing fails.
   */
  private async readSchemaFile(filePath: string): Promise<Module[] | null> {
    try {
      console.log(`📖 Reading schema from ${filePath}`);

      let sdlSource: string;

      try {
        sdlSource = await Deno.readTextFile(filePath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return null;
        }
        throw error;
      }

      const manager = new SchemaManager({});
      const result = manager.parseSDL(sdlSource);

      if (!result.ok) {
        console.error(`❌ Failed to parse schema: ${result.error.message}`);
        return null;
      }

      return result.value;
    } catch (error) {
      console.error(`Failed to read schema file: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Read an SDL schema file and convert it to a compiler Schema.
   *
   * Calls readSchemaFile() to get Module[], then converts to a Schema
   * via SchemaManager.modulesToSchema(). Returns null if the file cannot
   * be read or parsing fails.
   */
  private async readSchemaAsCompilerSchema(
    filePath: string,
  ): Promise<Schema | null> {
    const modules = await this.readSchemaFile(filePath);

    if (!modules) {
      return null;
    }

    try {
      const manager = new SchemaManager({});
      return manager.modulesToSchema(modules);
    } catch (error) {
      console.error(
        `❌ Failed to convert schema: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

// Export the commands instance
export const commands = new CLICommands();

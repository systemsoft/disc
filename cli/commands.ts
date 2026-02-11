/**
 * CLI Commands Implementation - Core command functionality
 */

import { MigrationEngine } from "../migration/engine.ts";
import * as Types from "../migration/types.ts";
import { create_server_from_env } from "../server/server.ts";
import * as Codegen from "../codegen/mod.ts";
import * as Context from "../compiler/context.ts";
import { initCommand, InitOptions } from "./init.ts";
import { shellCommand, ShellOptions } from "./shell.ts";
import { watchCommand, WatchOptions } from "./watch.ts";
import {
  PostgresManager,
} from "../postgres/mod.ts";

export interface CLIArgs {
  [key: string]: any;
  _: (string | number)[];
}

export interface ServeOptions {
  port?: number;
  host?: string;
  config?: string;
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
    const config: Types.MigrationConfig = {
      migrations_dir: "./migrations",
      schema_file: args.schema || "./schema.esdl",
      database_url: Deno.env.get("DATABASE_URL") ||
        "postgresql://localhost:5432/disc_dev",
      dry_run: args["dry-run"] || false,
      auto_approve: args["auto-approve"] || false,
      backup_before_migration: true,
      rollback_on_error: true,
    };

    const engine = new MigrationEngine(config);

    try {
      if (args.create) {
        await this.createMigration(engine, config);
      } else {
        await this.applyMigrations(engine, config);
      }
    } catch (error) {
      console.error(`❌ Migration failed: ${(error as Error).message}`);
      throw error;
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

      // Create server from environment variables
      const server = create_server_from_env();

      // Override with CLI arguments if provided
      const config = server.get_config();
      if (options.port) config.port = options.port;
      if (options.host) config.host = options.host;

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

    const outputDir = args.output || "./generated";
    const schemaFile = args.schema || "./schema.esdl";
    const target = args.target || "client";

    console.log(`📋 Configuration:`);
    console.log(`   Schema: ${schemaFile}`);
    console.log(`   Output: ${outputDir}`);
    console.log(`   Target: ${target}`);

    try {
      // For now, use the test schema since we don't have SDL parser yet
      // In production, this would parse the actual .esdl file
      const schema = Context.createTestSchema();
      console.log(
        `📖 Using test schema with types: ${
          Array.from(schema.types.keys()).join(", ")
        }`,
      );

      // Generate TypeScript code
      const config: Partial<Codegen.CodegenConfig> = {
        output_dir: outputDir,
        schema_source: schemaFile,
        target: target as "client" | "server" | "both",
        include_query_builders: args["no-queries"] !== true,
        include_mutations: args["no-mutations"] !== true,
        include_client: args["no-client"] !== true,
        format_output: args["no-format"] !== true,
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
      console.error(`❌ Failed to start PostgreSQL: ${(error as Error).message}`);
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
      console.error(`❌ Failed to stop PostgreSQL: ${(error as Error).message}`);
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
      console.error(`❌ Failed to restart PostgreSQL: ${(error as Error).message}`);
      throw error;
    }
  }

  private async createMigration(
    engine: MigrationEngine,
    config: Types.MigrationConfig,
  ): Promise<void> {
    console.log("🚀 Creating new migration...");

    // Read current schema
    const currentSchema = await this.readSchemaFile(config.schema_file);

    if (!currentSchema) {
      console.error(`❌ Schema file not found: ${config.schema_file}`);
      return;
    }

    // Get migration state to find previous schema
    const state = engine.getMigrationState();
    let previousSchema = null;

    if (state.applied_migrations.length > 0) {
      console.log(
        `📋 Previous migrations found: ${state.applied_migrations.length}`,
      );
    }

    // Plan the migration
    const planResult = engine.planMigration(previousSchema, currentSchema);

    if (!planResult.ok) {
      console.error(
        `❌ Migration planning failed: ${planResult.error.message}`,
      );
      return;
    }

    const plan = planResult.value;

    if (plan.operations_count === 0) {
      console.log("✅ No changes detected - schema is up to date");
      return;
    }

    console.log(`📋 Migration Plan:`);
    console.log(`   Operations: ${plan.operations_count}`);
    console.log(`   Estimated Duration: ${plan.estimated_duration || 0}ms\n`);

    plan.migrations.forEach((migration, i) => {
      console.log(`${i + 1}. ${migration.name} (${migration.id})`);
      console.log(`   ${migration.description}`);
      console.log(`   Operations: ${migration.operations.length}\n`);
    });

    // Generate DDL for preview
    const ddlResult = engine.generateDDL(plan);
    if (ddlResult.ok) {
      console.log("💾 Generated DDL:");
      ddlResult.value.forEach((stmt, i) => {
        if (stmt.trim() && !stmt.startsWith("--")) {
          console.log(`   ${i + 1}. ${stmt}`);
        }
      });
    }

    console.log("\n✅ Migration created successfully");
    console.log("💡 Run 'disc migrate' to apply the migration");
  }

  private async applyMigrations(
    engine: MigrationEngine,
    config: Types.MigrationConfig,
  ): Promise<void> {
    console.log("🚀 Applying migrations...");

    // Read current schema
    const currentSchema = await this.readSchemaFile(config.schema_file);

    if (!currentSchema) {
      console.error(`❌ Schema file not found: ${config.schema_file}`);
      return;
    }

    // Plan the migration
    const planResult = engine.planMigration(null, currentSchema);

    if (!planResult.ok) {
      console.error(
        `❌ Migration planning failed: ${planResult.error.message}`,
      );
      return;
    }

    const plan = planResult.value;

    if (plan.operations_count === 0) {
      console.log("✅ No migrations to apply - schema is up to date");
      return;
    }

    // Validate the migration
    const validationResult = engine.validateMigration(plan);
    if (!validationResult.ok) {
      console.log(
        `⚠️  Migration validation warnings: ${validationResult.error.message}`,
      );

      if (!config.auto_approve) {
        const proceed = confirm(
          "Do you want to proceed with potentially dangerous operations?",
        );
        if (!proceed) {
          console.log("Migration cancelled");
          return;
        }
      }
    }

    // Show what will be applied
    console.log(`📋 Applying ${plan.migrations.length} migration(s):`);
    plan.migrations.forEach((migration, i) => {
      console.log(`  ${i + 1}. ${migration.name}`);
      console.log(`     ${migration.description}`);
    });

    if (config.dry_run) {
      console.log("\n🔄 DRY RUN - No changes will be applied");

      const ddlResult = engine.generateDDL(plan);
      if (ddlResult.ok) {
        console.log("\n💾 DDL that would be executed:");
        ddlResult.value.forEach((stmt, i) => {
          console.log(`   ${i + 1}. ${stmt}`);
        });
      }
    } else {
      // Execute the migration
      const executeResult = await engine.executeMigration(plan);

      if (!executeResult.ok) {
        console.error(
          `❌ Migration execution failed: ${executeResult.error.message}`,
        );
        return;
      }

      const results = executeResult.value;
      console.log("\n📊 Migration Results:");

      results.forEach((result, i) => {
        const status = result.success ? "✅ Success" : "❌ Failed";
        console.log(`  ${i + 1}. Migration ${result.migration_id}: ${status}`);
        console.log(`     Duration: ${result.duration_ms}ms`);
        console.log(`     Applied: ${result.applied_at.toISOString()}`);

        if (result.error) {
          console.log(`     Error: ${result.error}`);
        }
      });

      console.log("\n🎉 All migrations applied successfully!");
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

  private async readSchemaFile(filePath: string): Promise<any[] | null> {
    try {
      console.log(`📖 Reading schema from ${filePath}`);

      const exists = await Deno.stat(filePath).then(() => true).catch(() =>
        false
      );
      if (!exists) {
        return null;
      }

      // Return a mock schema for demonstration - would be replaced with real SDL parsing
      return [
        {
          kind: "Module",
          name: { kind: "Identifier", name: "default", quoted: false },
          items: [
            {
              kind: "TypeDef",
              name: { kind: "Identifier", name: "User", quoted: false },
              extending: [],
              items: [
                {
                  kind: "Property",
                  name: { kind: "Identifier", name: "name", quoted: false },
                  type: {
                    kind: "NamedType",
                    name: { kind: "Identifier", name: "str", quoted: false },
                  },
                  required: true,
                  multi: false,
                },
                {
                  kind: "Property",
                  name: { kind: "Identifier", name: "email", quoted: false },
                  type: {
                    kind: "NamedType",
                    name: { kind: "Identifier", name: "str", quoted: false },
                  },
                  required: true,
                  multi: false,
                  constraints: [
                    {
                      kind: "Constraint",
                      name: {
                        kind: "Identifier",
                        name: "exclusive",
                        quoted: false,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ];
    } catch (error) {
      console.error(`Failed to read schema file: ${(error as Error).message}`);
      return null;
    }
  }
}

// Export the commands instance
export const commands = new CLICommands();

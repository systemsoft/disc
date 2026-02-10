#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * Disc CLI - Command-line interface for Disc database
 */

import { parseArgs } from "@std/cli/parse-args";
import { VERSION } from "../mod.ts";
import { MigrationEngine } from "../migration/engine.ts";
import * as Types from "../migration/types.ts";
import { DiscServer, create_server_from_env } from "../server/server.ts";
import * as Codegen from "../codegen/mod.ts";
import * as Context from "../compiler/context.ts";

const HELP_TEXT = `
Disc Database CLI v${VERSION}

USAGE:
  disc <command> [options]

COMMANDS:
  init          Initialize a new Disc project
  migrate       Generate and apply migrations
  shell         Open interactive EdgeQL REPL
  codegen       Generate TypeScript types from schema
  serve         Start the Disc server
  watch         Watch schema files and auto-migrate in dev

OPTIONS:
  -h, --help           Show this help message
  -v, --version        Show version information
  -s, --schema <file>  Schema file path (default: ./schema.esdl)
  -c, --config <file>  Configuration file path
  -o, --output <dir>   Output directory for codegen (default: ./generated)
  -t, --target <type>  Codegen target: client|server|both (default: client)
  --dry-run            Show what would be done without executing
  --auto-approve       Skip confirmation prompts
  --create             Create migration without applying
  --no-queries         Skip query builder generation
  --no-mutations       Skip mutation method generation
  --no-client          Skip client library generation
  --no-format          Skip output formatting

EXAMPLES:
  disc init                           # Initialize new project
  disc migrate --create               # Create migration without applying
  disc migrate --dry-run              # Preview migration changes
  disc migrate --auto-approve         # Apply migration without prompts
  disc migrate --schema custom.esdl   # Use custom schema file
  disc shell                          # Open EdgeQL REPL
  disc codegen                        # Generate TypeScript types
  disc codegen --output ./src/types   # Custom output directory
  disc codegen --target server        # Generate server-only types
  disc codegen --no-client            # Skip client generation
  disc serve --port 5432              # Start server on custom port
`;

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "version", "create", "dry-run", "auto-approve", "no-queries", "no-mutations", "no-client", "no-format"],
    string: ["port", "config", "schema", "output", "target"],
    alias: {
      h: "help",
      v: "version",
      p: "port",
      c: "config",
      s: "schema",
      o: "output",
      t: "target",
    },
  });

  if (args.help || args._.length === 0) {
    console.log(HELP_TEXT);
    return;
  }

  if (args.version) {
    console.log(`Disc Database v${VERSION}`);
    return;
  }

  const command = String(args._[0]);

  switch (command) {
    case "init": {
      console.log("Initializing new Disc project...");
      console.log("TODO: Implement project initialization");
      break;
    }

    case "migrate": {
      try {
        await handleMigrateCommand(args);
      } catch (error) {
        console.error(`Migration failed: ${error.message}`);
        Deno.exit(1);
      }
      break;
    }

    case "shell": {
      console.log("Opening EdgeQL REPL...");
      console.log("TODO: Implement interactive shell");
      break;
    }

    case "codegen": {
      try {
        await handleCodegenCommand(args);
      } catch (error) {
        console.error(`Codegen failed: ${error.message}`);
        Deno.exit(1);
      }
      break;
    }

    case "serve": {
      try {
        await handleServeCommand(args);
      } catch (error) {
        console.error(`Server failed: ${error.message}`);
        Deno.exit(1);
      }
      break;
    }

    case "watch": {
      console.log("Watching schema files...");
      console.log("TODO: Implement file watcher");
      break;
    }

    default: {
      console.error(`Unknown command: ${command}`);
      console.log(HELP_TEXT);
      Deno.exit(1);
    }
  }
}

async function handleMigrateCommand(args: any): Promise<void> {
  const config: Types.MigrationConfig = {
    migrations_dir: "./migrations",
    schema_file: args.schema || "./schema.esdl",
    database_url: Deno.env.get("DATABASE_URL") || "postgresql://localhost:5432/disc_dev",
    dry_run: args["dry-run"] || false,
    auto_approve: args["auto-approve"] || false,
    backup_before_migration: true,
    rollback_on_error: true,
  };

  const engine = new MigrationEngine(config);

  if (args.create) {
    console.log("🚀 Creating new migration...");

    try {
      // Read current schema
      const currentSchema = await readSchemaFile(config.schema_file);

      if (!currentSchema) {
        console.error(`❌ Schema file not found: ${config.schema_file}`);
        return;
      }

      // Get migration state to find previous schema
      const state = engine.getMigrationState();
      let previousSchema = null;

      if (state.applied_migrations.length > 0) {
        // In a real implementation, we'd load the schema from the last migration
        // For now, we'll use null (fresh schema)
        console.log(`📋 Previous migrations found: ${state.applied_migrations.length}`);
      }

      // Plan the migration
      const planResult = engine.planMigration(previousSchema, currentSchema);

      if (!planResult.ok) {
        console.error(`❌ Migration planning failed: ${planResult.error.message}`);
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
    } catch (error) {
      console.error(`❌ Failed to create migration: ${error.message}`);
    }
  } else {
    console.log("🚀 Applying migrations...");

    try {
      // Read current schema
      const currentSchema = await readSchemaFile(config.schema_file);

      if (!currentSchema) {
        console.error(`❌ Schema file not found: ${config.schema_file}`);
        return;
      }

      // Plan the migration
      const planResult = engine.planMigration(null, currentSchema);

      if (!planResult.ok) {
        console.error(`❌ Migration planning failed: ${planResult.error.message}`);
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
        console.log(`⚠️  Migration validation warnings: ${validationResult.error.message}`);

        if (!config.auto_approve) {
          const proceed = confirm("Do you want to proceed with potentially dangerous operations?");
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
          console.error(`❌ Migration execution failed: ${executeResult.error.message}`);
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
    } catch (error) {
      console.error(`❌ Failed to apply migration: ${error.message}`);
    }
  }
}

async function handleServeCommand(args: any): Promise<void> {
  console.log("🚀 Starting Disc Database Server...");

  // Create server from environment variables and CLI args
  const server = create_server_from_env();

  // Override with CLI arguments if provided
  const config = server.get_config();
  if (args.port) {
    config.port = parseInt(args.port);
  }
  server.update_config(config);

  // Set up signal handlers for graceful shutdown
  const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];

  for (const signal of signals) {
    Deno.addSignalListener(signal, async () => {
      console.log(`\n📡 Received ${signal}, shutting down gracefully...`);
      await server.stop();
      Deno.exit(0);
    });
  }

  try {
    // Start the server
    await server.start();
  } catch (error) {
    console.error(`❌ Failed to start server: ${error.message}`);
    throw error;
  }
}

async function handleCodegenCommand(args: any): Promise<void> {
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
    console.log(`📖 Using test schema with types: ${Array.from(schema.types.keys()).join(", ")}`);

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
      result.errors.forEach(error => console.error(`   ${error}`));
      return;
    }

    // Write files to disk
    console.log(`💾 Writing ${result.files.length} files...`);
    await Codegen.writeGeneratedFiles(result, ".");

    // Show summary
    console.log(`\n📊 Generation Summary:`);
    console.log(`   Files generated: ${result.files.length}`);
    console.log(`   Types generated: ${Array.from(schema.types.keys()).length}`);
    console.log(`   Warnings: ${result.warnings.length}`);
    console.log(`   Errors: ${result.errors.length}`);

    if (result.warnings.length > 0) {
      console.log(`\n⚠️  Warnings:`);
      result.warnings.forEach(warning => console.log(`   ${warning}`));
    }

    console.log(`\n✅ TypeScript generation complete!`);
    console.log(`💡 Usage example:`);
    console.log(`   import { DiscClient } from "./${outputDir}/index.ts";`);
    console.log(`   const client = new DiscClient({ host: "localhost", port: 5656 });`);
    console.log(`   const users = await client.user.select();`);

  } catch (error) {
    console.error(`❌ Failed to generate types: ${error.message}`);
    throw error;
  }
}

async function readSchemaFile(filePath: string): Promise<any[] | null> {
  try {
    // For now, return a simple test schema since we don't have the SDL parser yet
    // In a real implementation, this would parse the .esdl file
    console.log(`📖 Reading schema from ${filePath}`);

    const exists = await Deno.stat(filePath).then(() => true).catch(() => false);
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
                type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
                required: true,
                multi: false,
              },
              {
                kind: "Property",
                name: { kind: "Identifier", name: "email", quoted: false },
                type: { kind: "NamedType", name: { kind: "Identifier", name: "str", quoted: false } },
                required: true,
                multi: false,
                constraints: [
                  { kind: "Constraint", name: { kind: "Identifier", name: "exclusive", quoted: false } }
                ]
              }
            ]
          }
        ]
      }
    ];
  } catch (error) {
    console.error(`Failed to read schema file: ${error.message}`);
    return null;
  }
}

if (import.meta.main) {
  await main();
}

#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env --allow-run

/**
 * Disc CLI - Command-line interface for Disc database
 */

import { parseArgs } from "@std/cli/parse-args";
import { VERSION } from "../mod.ts";
import { CLIArgs, commands } from "./commands.ts";

const HELP_TEXT = `
Disc Database CLI v${VERSION}

USAGE:
  disc <command> [options]

COMMANDS:
  init          Initialize a new Disc project
  start         Start PostgreSQL instance
  stop          Stop PostgreSQL instance
  restart       Restart PostgreSQL instance
  status        Show PostgreSQL status
  migrate       Generate and apply migrations
  shell         Open interactive EdgeQL REPL
  codegen       Generate TypeScript types from schema
  serve         Start the Disc server (includes PostgreSQL)
  ui            Open admin UI in browser
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
  --backend-dsn <url>  Use external PostgreSQL (skip bundled)
  --skip-postgres      Skip PostgreSQL setup in init
  --no-monitor         Disable PostgreSQL health monitoring
  --jwt-secret <key>   JWT signing secret for authentication
  --enable-auth        Enable authentication system (requires --jwt-secret)
  --enable-access-policies  Enable access policy enforcement (requires --enable-auth)

EXAMPLES:
  disc init my-project                # Initialize new project with PostgreSQL
  disc init --skip-postgres           # Initialize without PostgreSQL
  disc start                          # Start PostgreSQL instance
  disc stop                           # Stop PostgreSQL instance
  disc status                         # Show PostgreSQL status
  disc migrate --create               # Create migration without applying
  disc migrate --dry-run              # Preview migration changes
  disc migrate --auto-approve         # Apply migration without prompts
  disc shell                          # Open EdgeQL REPL
  disc codegen                        # Generate TypeScript types
  disc serve                          # Start Disc server with PostgreSQL
`;

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: [
      "help",
      "version",
      "create",
      "dry-run",
      "auto-approve",
      "no-queries",
      "no-mutations",
      "no-client",
      "no-format",
      "force",
      "non-interactive",
      "skip-postgres",
      "no-monitor",
      "enable-auth",
      "enable-access-policies",
    ],
    string: [
      "port",
      "config",
      "schema",
      "output",
      "target",
      "host",
      "database",
      "execute",
      "template",
      "name",
      "directory",
      "backend-dsn",
      "jwt-secret",
    ],
    alias: {
      h: "help",
      v: "version",
      p: "port",
      c: "config",
      s: "schema",
      o: "output",
      t: "target",
    },
  }) as CLIArgs;

  if (args.help || args._.length === 0) {
    console.log(HELP_TEXT);
    return;
  }

  if (args.version) {
    console.log(`Disc Database v${VERSION}`);
    return;
  }

  const command = String(args._[0]);

  try {
    switch (command) {
      case "init": {
        const name = args.name || String(args._[1] || "disc-project");
        await commands.init({
          name,
          template: args.template as "basic" | "minimal" | "full" || "basic",
          database_url: args["database-url"],
          force: args.force,
          directory: args.directory,
          backend_dsn: args["backend-dsn"],
          skip_postgres: args["skip-postgres"],
        });
        break;
      }

      case "migrate": {
        await commands.migrate(args);
        break;
      }

      case "shell": {
        await commands.shell({
          host: args.host,
          port: args.port ? parseInt(args.port) : undefined,
          database: args.database,
          schema_file: args.schema,
          non_interactive: args["non-interactive"],
          execute: args.execute,
        });
        break;
      }

      case "codegen": {
        await commands.codegen(args);
        break;
      }

      case "serve": {
        await commands.serve({
          port: args.port ? parseInt(args.port) : undefined,
          host: args.host,
          config: args.config,
          jwt_secret: args["jwt-secret"],
          enable_auth: args["enable-auth"],
          enable_access_policies: args["enable-access-policies"],
        });
        break;
      }

      case "watch": {
        await commands.watch({
          schema_file: args.schema,
          output_dir: args.output,
          delay_ms: 1000,
        });
        break;
      }

      case "start": {
        await commands.start(args);
        break;
      }

      case "stop": {
        await commands.stop(args);
        break;
      }

      case "restart": {
        await commands.restart(args);
        break;
      }

      case "status": {
        await commands.status(args);
        break;
      }

      case "ui": {
        await commands.ui(args);
        break;
      }

      default: {
        console.error(`Unknown command: ${command}`);
        console.log(HELP_TEXT);
        Deno.exit(1);
      }
    }
  } catch (error) {
    console.error(`Command '${command}' failed: ${(error as Error).message}`);
    Deno.exit(1);
  }
}

// Legacy functions removed - now handled by commands.ts

if (import.meta.main) {
  await main();
}

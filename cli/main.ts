#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env --allow-run
// deno-lint-ignore-file no-console

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
  build         Compile Disc into a self-contained binary
  deploy        Generate deployment artifacts (Dockerfile, compose, systemd, env)
  pg log         View PostgreSQL logs
  pg upgrade     Upgrade PostgreSQL version

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
  --tls-cert <path>    Path to TLS certificate file
  --tls-key <path>     Path to TLS private key file
  -f, --follow           Follow log output (pg log)
  --lines <n>            Number of log lines to show (default: 50)
  --level <level>        Filter logs by level (ERROR, WARNING, LOG, FATAL, PANIC)
  --target-version <v>   Target PostgreSQL version for upgrade
  --platform <platform>  Target platform for build (linux-x64, linux-arm64, darwin-x64, darwin-arm64)
  --lite                 Skip UI assets in build (future use)
  --format <format>      Deploy format: docker, compose, systemd, env

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
  disc pg log                           # View last 50 lines of PostgreSQL log
  disc pg log -f                        # Follow PostgreSQL log output
  disc pg log --level ERROR             # Show only ERROR level log lines
  disc pg upgrade --target-version 17.0 # Upgrade PostgreSQL to version 17.0
  disc pg upgrade --target-version 17.0 --dry-run  # Preview upgrade plan
  disc build                                       # Build binary for current platform
  disc build --platform linux-x64                  # Cross-compile for Linux x64
  disc build --output ./my-disc                    # Custom output path
  disc deploy --format docker                      # Generate Dockerfile
  disc deploy --format compose                     # Generate docker-compose.yml
  disc deploy --format systemd                     # Generate systemd service unit
  disc deploy --format env                         # Generate .env.production template
  disc deploy --format docker --output ./infra     # Custom output directory
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
      "follow",
      "lite",
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
      "tls-cert",
      "tls-key",
      "lines",
      "level",
      "target-version",
      "platform",
      "format",
    ],
    alias: {
      h: "help",
      v: "version",
      p: "port",
      c: "config",
      s: "schema",
      o: "output",
      t: "target",
      f: "follow",
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
          databaseUrl: args["database-url"],
          force: args.force,
          directory: args.directory,
          backendDsn: args["backend-dsn"],
          skipPostgres: args["skip-postgres"],
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
          schemaFile: args.schema,
          nonInteractive: args["non-interactive"],
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
          jwtSecret: args["jwt-secret"],
          enableAuth: args["enable-auth"],
          enableAccessPolicies: args["enable-access-policies"],
          tlsCert: args["tls-cert"],
          tlsKey: args["tls-key"],
        });
        break;
      }

      case "watch": {
        await commands.watch({
          schemaFile: args.schema,
          outputDir: args.output,
          delayMs: 1000,
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

      case "build": {
        await commands.build({
          platform: args.platform,
          output: args.output,
          lite: args.lite,
        });
        break;
      }

      case "deploy": {
        if (!args.format) {
          console.error(
            "Error: --format is required for deploy. Valid formats: docker, compose, systemd, env",
          );
          Deno.exit(1);
        }
        await commands.deploy({
          format: args.format,
          output: args.output,
        });
        break;
      }

      case "pg": {
        const subcommand = String(args._[1] || "");
        switch (subcommand) {
          case "log":
            await commands.pgLog({
              lines: args.lines ? parseInt(String(args.lines)) : 50,
              follow: args.follow || false,
              level: args.level,
              project: args.name,
            });
            break;
          case "upgrade":
            if (!args["target-version"]) {
              console.error(
                "Error: --target-version is required for pg upgrade",
              );
              Deno.exit(1);
            }
            await commands.pgUpgrade({
              targetVersion: args["target-version"],
              dryRun: args["dry-run"] || false,
              backup: true,
              project: args.name,
            });
            break;
          default:
            console.error(`Unknown pg subcommand: ${subcommand}`);
            console.log("Available: pg log, pg upgrade");
            Deno.exit(1);
        }
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

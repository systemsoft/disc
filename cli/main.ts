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
  db create      Create a new Disc-managed database
  db list        List all Disc-managed databases
  db drop        Drop a Disc-managed database (requires --force)
  pg log         View PostgreSQL logs
  pg upgrade     Upgrade PostgreSQL version

OPTIONS:
  -h, --help           Show this help message
  -v, --version        Show version information
  -s, --schema <file>  Schema file path (single-file mode)
  --schema-dir <dir>   Schema directory for multi-file discovery (default: ./dbschema)
  -c, --config <file>  Configuration file path
  -o, --output <dir>   Output directory for codegen (default: ./dbschema/disc-client)
  -t, --target <type>  Codegen target: client|server|both (default: client)
  --js                 Generate JavaScript output (future use)
  --dry-run            Show what would be done without executing
  --auto-approve       Skip confirmation prompts
  --create             Create migration without applying
  --no-queries         Skip query builder generation
  --no-mutations       Skip mutation method generation
  --no-client          Skip client library generation
  --no-format          Skip output formatting
  --database-url <url> PostgreSQL connection URL for db commands
  --backend-dsn <url>  Use external PostgreSQL (skip bundled)
  --skip-postgres      Skip PostgreSQL setup in init
  --no-monitor         Disable PostgreSQL health monitoring
  --jwt-secret <key>   JWT signing secret for authentication
  --enable-auth        Enable authentication system (requires --jwt-secret)
  --enable-access-policies  Enable access policy enforcement (requires --enable-auth)
  --binary-port <port> Start binary wire protocol server on this port
  --tls-cert <path>    Path to TLS certificate file
  --tls-key <path>     Path to TLS private key file
  -f, --follow           Follow log output (pg log)
  --lines <n>            Number of log lines to show (default: 50)
  --level <level>        Filter logs by level (ERROR, WARNING, LOG, FATAL, PANIC)
  --target-version <v>   Target PostgreSQL version for upgrade
  --platform <platform>  Target platform for build (linux-x64, linux-arm64, darwin-x64, darwin-arm64)
  --lite                 Skip UI assets in build (future use)
  --format <format>      Deploy format: docker, compose, systemd, env
  --status               Show migration status (applied count, latest migration)
  --rollback             Rollback the most recent migration (requires --force)
  --rollback-to <id>     Rollback all migrations after the specified ID (requires --force)
  --squash               Squash multiple migrations into one
  --squash-from <id>     Start of squash range (inclusive)
  --squash-to <id>       End of squash range (inclusive)

EXAMPLES:
  disc init my-project                # Initialize new project with PostgreSQL
  disc init --skip-postgres           # Initialize without PostgreSQL
  disc start                          # Start PostgreSQL instance
  disc stop                           # Stop PostgreSQL instance
  disc status                         # Show PostgreSQL status
  disc migrate --create               # Create migration without applying
  disc migrate --dry-run              # Preview migration changes
  disc migrate --auto-approve         # Apply migration without prompts
  disc migrate --status               # Show migration status
  disc migrate --rollback --force     # Rollback the most recent migration
  disc migrate --rollback-to m20240101T100000_abc123 --force  # Rollback to a specific migration
  disc migrate --squash                            # Squash all migrations
  disc migrate --squash --squash-from m001 --squash-to m005  # Squash a range
  disc shell                          # Open EdgeQL REPL
  disc codegen                        # Generate TypeScript types from ./dbschema/
  disc codegen --schema-dir ./schema  # Generate from custom schema directory
  disc codegen --schema ./schema.disc # Generate from single schema file
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
  disc db create my_app                            # Create database disc_my_app
  disc db list                                     # List all Disc-managed databases
  disc db drop my_app --force                      # Drop database disc_my_app
`;

/**
 * Per-subcommand help strings (P1-16). Keys may be single commands
 * ("init") or 2-word sub-commands ("pg log", "db create"). Missing
 * entries fall back to the global HELP_TEXT.
 */
const COMMAND_HELP: Record<string, string> = {
  init: `Initialize a new Disc project

USAGE:
  disc init <project-name> [options]

OPTIONS:
  --template <t>        Template: basic | minimal | full (default: basic)
  --backend-dsn <url>   Use external PostgreSQL (skip bundled PG setup)
  --skip-postgres       Skip PostgreSQL setup entirely
  --force               Overwrite existing directory

EXAMPLES:
  disc init my-app
  disc init my-app --template full
  disc init my-app --backend-dsn postgres://user:pass@host/db`,
  start: `Start PostgreSQL for the current project

USAGE:
  disc start [options]

OPTIONS:
  --no-monitor          Disable PostgreSQL health monitoring`,
  stop: `Stop PostgreSQL for the current project

USAGE:
  disc stop`,
  migrate: `Generate and apply schema migrations

USAGE:
  disc migrate [options]

OPTIONS:
  -s, --schema <file>   Schema file (default: ./dbschema/default.disc)
  --dry-run             Preview migration without executing
  --auto-approve        Apply without interactive confirmation
  --create              Create migration file without applying
  --status              Show applied / pending migration summary
  --rollback            Rollback the most recent migration (requires --force)
  --rollback-to <id>    Rollback all migrations after the given ID
  --squash              Squash migrations into a single migration
  --backend-dsn <url>   Connect to external PostgreSQL instead of bundled`,
  shell: `Open an interactive EdgeQL REPL

USAGE:
  disc shell [options]

OPTIONS:
  --backend-dsn <url>   Connect to external PostgreSQL`,
  codegen: `Generate TypeScript types + client from your schema

USAGE:
  disc codegen [options]

OPTIONS:
  -s, --schema <file>   Single-file schema (default: ./dbschema/default.disc)
  --schema-dir <dir>    Multi-file schema directory (default: ./dbschema)
  -o, --output <dir>    Output directory (default: ./dbschema/disc-client)
  -t, --target <type>   Output target: client | server | both
  --no-queries          Skip query-builder generation
  --no-mutations        Skip mutation method generation
  --no-client           Skip client library generation
  --no-format           Skip output formatting`,
  serve: `Start the Disc HTTP/WebSocket server

USAGE:
  disc serve [options]

OPTIONS:
  --backend-dsn <url>       External PostgreSQL DSN
  --jwt-secret <key>        JWT signing secret (enables auth)
  --enable-auth             Enable authentication system
  --enable-access-policies  Enable row-level access policy enforcement
  --binary-port <port>      Enable binary wire protocol on this port
  --tls-cert <path>         Path to TLS certificate
  --tls-key <path>          Path to TLS private key`,
  build: `Compile Disc into a self-contained native binary

USAGE:
  disc build [options]

OPTIONS:
  --platform <p>        Target: linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64
  -o, --output <path>   Output binary path
  --lite                Skip bundling UI assets (smaller binary)`,
  deploy: `Generate deployment artifacts for a given format

USAGE:
  disc deploy --format <fmt> [options]

OPTIONS:
  --format <fmt>        One of: docker | compose | systemd | env
  -o, --output <dir>    Output directory (default: ./)`,
  watch: `Watch schema files and auto-run migrate + codegen on change

USAGE:
  disc watch [options]

OPTIONS:
  -s, --schema <file>   Schema to watch (default: ./dbschema/default.disc)
  -o, --output <dir>    Codegen output dir (default: ./generated)`,
  ui: `Open the admin UI in your browser

USAGE:
  disc ui

Requires the UI to be built first (cd ui && bun install && bun run build).`,
  status: `Show PostgreSQL status for the current project

USAGE:
  disc status`,
  "pg log": `View PostgreSQL logs for the current project

USAGE:
  disc pg log [options]

OPTIONS:
  -f, --follow          Follow log output
  --lines <n>           Number of lines to show (default: 50)
  --level <lvl>         Filter by level: ERROR | WARNING | LOG | FATAL | PANIC`,
  "pg upgrade": `Upgrade the bundled PostgreSQL version

USAGE:
  disc pg upgrade --target-version <version>

OPTIONS:
  --target-version <v>  Target PostgreSQL version (e.g. 17.0)
  --dry-run             Preview upgrade plan`,
  "db create": `Create a Disc-managed database

USAGE:
  disc db create <name> [--database-url <url>]`,
  "db list": `List Disc-managed databases

USAGE:
  disc db list [--database-url <url>]`,
  "db drop": `Drop a Disc-managed database

USAGE:
  disc db drop <name> --force [--database-url <url>]`,
};

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
      "foreground",
      "enable-auth",
      "enable-access-policies",
      "follow",
      "lite",
      "status",
      "rollback",
      "squash",
      "js",
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
      "database-url",
      "backend-dsn",
      "jwt-secret",
      "tls-cert",
      "tls-key",
      "lines",
      "level",
      "target-version",
      "platform",
      "format",
      "rollback-to",
      "squash-from",
      "squash-to",
      "binary-port",
      "schema-dir",
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

  if (args._.length === 0) {
    console.log(HELP_TEXT);
    return;
  }

  if (args.version) {
    console.log(`Disc Database v${VERSION}`);
    return;
  }

  const command = String(args._[0]);

  // P1-16: `disc <command> --help` prints command-specific help instead of
  // the global help text. Falls back to global when no per-command entry.
  if (args.help) {
    const sub = args._[1] ? String(args._[1]) : undefined;
    const key = sub ? `${command} ${sub}` : command;
    const specific = COMMAND_HELP[key] ?? COMMAND_HELP[command];
    if (specific) {
      console.log(specific);
      return;
    }
    console.log(HELP_TEXT);
    return;
  }

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
          binaryPort: args["binary-port"]
            ? parseInt(args["binary-port"])
            : undefined,
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

      case "db": {
        const dbSubcommand = String(args._[1] || "");
        switch (dbSubcommand) {
          case "create": {
            const dbName = String(args._[2] || "");
            if (!dbName) {
              console.error(
                "Error: database name is required. Usage: disc db create <name>",
              );
              Deno.exit(1);
            }
            await commands.dbCreate(dbName, args);
            break;
          }
          case "list":
            await commands.dbList(args);
            break;
          case "drop": {
            const dropName = String(args._[2] || "");
            if (!dropName) {
              console.error(
                "Error: database name is required. Usage: disc db drop <name> --force",
              );
              Deno.exit(1);
            }
            await commands.dbDrop(dropName, args);
            break;
          }
          default:
            console.error(`Unknown db subcommand: ${dbSubcommand}`);
            console.log("Available: db create, db list, db drop");
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

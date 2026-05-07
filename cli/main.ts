#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env --allow-run
// deno-lint-ignore-file no-console

/**
 * Disc CLI - Command-line interface for Disc database
 */

import { parseArgs } from "@std/cli/parse-args";
import { bgBrightRed, bgBrightYellow, brightWhite, gray, inverse } from "@std/fmt/colors";

import { runStdio as runLspStdio } from "../lsp/server.ts";
import { VERSION } from "../mod.ts";
import { adminCommand } from "./admin.ts";
import { CLIArgs, commands } from "./commands.ts";

const HELP_TEXT = `
█▀▀▀▄ █ ▄▀▀▀▀ ▄▀▀▀▀ v${VERSION}
█   █ █ ▀▀▀▀█ █     https://disc.sh
▀▀▀▀  ▀ ▀▀▀▀   ▀▀▀▀
╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱╱

${inverse("  USAGE ")}

  disc ${gray("<command> [options]")}

${inverse("  COMMANDS ")}

  init ${gray(".".repeat(21))} Initialize a new Disc project
  start ${gray(".".repeat(20))} Start PostgreSQL instance
  stop ${gray(".".repeat(21))} Stop PostgreSQL instance
  restart ${gray(".".repeat(18))} Restart PostgreSQL instance
  status ${gray(".".repeat(19))} Show PostgreSQL status
  migrate ${gray(".".repeat(18))} Generate and apply migrations
  shell ${gray(".".repeat(20))} Open interactive EdgeQL REPL
  codegen ${gray(".".repeat(18))} Generate TypeScript types from schema
  serve ${gray(".".repeat(20))} Start the Disc server (includes PostgreSQL)
  ui ${gray(".".repeat(23))} Open admin UI in browser
  watch ${gray(".".repeat(20))} Watch schema files and auto-migrate in dev
  build ${gray(".".repeat(20))} Compile Disc into a self-contained binary
  deploy ${gray(".".repeat(19))} Generate deployment artifacts (Dockerfile, compose, systemd, env)
  db create ${gray(".".repeat(16))} Create a new Disc-managed database
  db list ${gray(".".repeat(18))} List all Disc-managed databases
  db drop ${gray(".".repeat(18))} Drop a Disc-managed database (requires ${bgBrightRed(brightWhite("--force"))})
  db wipe ${gray(".".repeat(18))} Drop and recreate a database (requires ${bgBrightRed(brightWhite("--force"))})
  db dump ${gray(".".repeat(18))} Dump a database to stdout or a file
  db restore ${gray(".".repeat(15))} Restore a database from stdin or a file
  db push ${gray(".".repeat(18))} Push schema directly (no migration history; requires ${bgBrightRed(brightWhite("--force"))})
  schema export ${gray(".".repeat(12))} Export the current schema as a single SDL file
  schema introspect ${gray(".".repeat(8))} Generate SDL from an existing PostgreSQL database
  admin create-superuser  Create a user and assign the superuser role
  admin set-password ${gray(".".repeat(7))} Reset a user's password (admin override)
  admin assign-role ${gray(".".repeat(8))} Assign a role to a user (creating it if needed)
  admin list-roles ${gray(".".repeat(9))} List all defined roles
  admin list-policies ${gray(".".repeat(6))} List access policies on a type (or all types) from SDL
  admin test-policy ${gray(".".repeat(8))} Evaluate a policy in isolation against a synthetic context
  lsp ${gray(".".repeat(22))} Run the Disc language server (stdio JSON-RPC)
  pg log ${gray(".".repeat(19))} View PostgreSQL logs
  pg upgrade ${gray(".".repeat(15))} Upgrade PostgreSQL version

${inverse("  OPTIONS ")}

  -h, --help ${gray(".".repeat(15))} Show this help message
  -v, --version ${gray(".".repeat(12))} Show version information
  -H, --host ${gray("<host>")} ${gray(".".repeat(8))} Hostname for shell/serve commands
  -s, --schema ${gray("<file>")} ${gray(".".repeat(6))} Schema file path (single-file mode)
  --schema-dir ${gray("<dir>")} ${gray(".".repeat(7))} Schema directory for multi-file discovery (default: ${bgBrightYellow("./dbschema")})
  -c, --config ${gray("<file>")} ${gray(".".repeat(6))} Configuration file path
  -o, --output ${gray("<dir>")} ${gray(".".repeat(7))} Output directory for codegen (default: ${bgBrightYellow("./dbschema/disc-client")})
  -t, --target ${gray("<type>")} ${gray(".".repeat(6))} Codegen target: client|server|both (default: ${bgBrightYellow("client")})
  --js ${gray(".".repeat(21))} Generate JavaScript output (future use)
  --dry-run ${gray(".".repeat(16))} Show what would be done without executing
  --auto-approve ${gray(".".repeat(11))} Skip confirmation prompts
  --create ${gray(".".repeat(17))} Create migration without applying
  --no-queries ${gray(".".repeat(13))} Skip query builder generation
  --no-mutations ${gray(".".repeat(11))} Skip mutation method generation
  --no-client ${gray(".".repeat(14))} Skip client library generation
  --no-format ${gray(".".repeat(14))} Skip output formatting
  --database-url ${gray("<url>")} ${gray(".".repeat(5))} PostgreSQL connection URL for db commands
  --backend-dsn ${gray("<url>")} ${gray(".".repeat(6))} Use external PostgreSQL (skip bundled)
  --skip-postgres ${gray(".".repeat(10))} Skip PostgreSQL setup in init
  --no-monitor ${gray(".".repeat(13))} Disable PostgreSQL health monitoring
  --jwt-secret ${gray("<key>")} ${gray(".".repeat(7))} JWT signing secret for authentication
  --enable-auth ${gray(".".repeat(12))} Enable authentication system (requires ${bgBrightYellow("--jwt-secret")})
  --enable-access-policies ${gray(".")} Enable access policy enforcement (requires ${bgBrightYellow("--enable-auth")})
  --binary-port ${gray("<port>")} ${gray(".".repeat(5))} Start binary wire protocol server on this port
  --tls-cert ${gray("<path>")} ${gray(".".repeat(8))} Path to TLS certificate file
  --tls-key ${gray("<path>")} ${gray(".".repeat(9))} Path to TLS private key file
  -f, --follow ${gray(".".repeat(13))} Follow log output (pg log)
  --lines ${gray("<n>")} ${gray(".".repeat(14))} Number of log lines to show (default: ${bgBrightYellow("50")})
  --level ${gray("<level>")} ${gray(".".repeat(10))} Filter logs by level (ERROR, WARNING, LOG, FATAL, PANIC)
  --target-version ${gray("<v>")} ${gray(".".repeat(5))} Target PostgreSQL version for upgrade
  --platform ${gray("<platform>")} ${gray(".".repeat(4))} Target platform for build (linux-x64, linux-arm64, darwin-x64, darwin-arm64)
  --lite ${gray(".".repeat(19))} Skip UI assets in build (future use)
  --format ${gray("<format>")} ${gray(".".repeat(8))} Deploy format: docker, compose, systemd, env
  --status ${gray(".".repeat(17))} Show migration status (applied count, latest migration)
  --rollback ${gray(".".repeat(15))} Rollback the most recent migration (requires ${bgBrightRed(brightWhite("--force"))})
  --rollback-to ${gray("<id>")} ${gray(".".repeat(7))} Rollback all migrations after the specified ID (requires ${bgBrightRed(brightWhite("--force"))})
  --squash ${gray(".".repeat(17))} Squash multiple migrations into one
  --squash-from ${gray("<id>")} ${gray(".".repeat(7))} Start of squash range (inclusive)
  --squash-to ${gray("<id>")} ${gray(".".repeat(9))} End of squash range (inclusive)
  --unsafe ${gray(".".repeat(17))} Permit data-destroying migrations (DropType, DropTable, DropProperty, DropLink).
                             Off by default, refused with a summary of the unsafe operations.

${inverse("  FLAG SCOPE ")} (run \`disc <command> --help\` for command-specific details)

  Global ${gray(".".repeat(19))} --help, --version
  init ${gray(".".repeat(21))} --template, --backend-dsn, --skip-postgres, --force, --directory
  start/stop/restart/status  --no-monitor (start only), --foreground (start only)
  migrate ${gray(".".repeat(18))} --schema, --dry-run, --auto-approve, --create, --status,
                             --rollback, --rollback-to, --squash, --squash-{from,to},
                             --unsafe, --backend-dsn
  shell/serve ${gray(".".repeat(14))} --backend-dsn; serve adds --jwt-secret, --enable-auth,
                             --enable-access-policies, --binary-port, --tls-cert, --tls-key
  codegen ${gray(".".repeat(18))} --schema, --schema-dir, --output, --target, --no-queries,
                             --no-mutations, --no-client, --no-format, --js
  watch ${gray(".".repeat(20))} --schema, --output
  build ${gray(".".repeat(20))} --platform, --output, --lite
  deploy ${gray(".".repeat(19))} --format, --output
  db create/list/drop ${gray(".".repeat(6))} --force (drop), --database-url
  db wipe/dump/restore ${gray(".".repeat(5))} --force (wipe), --output (dump), --format (dump),
                             --input (restore), --clean (restore), --database-url
  pg log ${gray(".".repeat(19))} --follow, --lines, --level
  pg upgrade ${gray(".".repeat(15))} --target-version, --dry-run

${inverse("  EXAMPLES ")}

  ${gray("# Initialize new project with PostgreSQL")}
  disc init my-project

  ${gray("# Initialize without PostgreSQL")}
  disc init --skip-postgres

  ${gray("# Start PostgreSQL instance")}
  disc start

  ${gray("# Stop PostgreSQL instance")}
  disc stop

  ${gray("# Show PostgreSQL status")}
  disc status

  ${gray("# Create migration without applying")}
  disc migrate --create

  ${gray("# Preview migration changes")}
  disc migrate --dry-run

  ${gray("# Apply migration without prompts")}
  disc migrate --auto-approve

  ${gray("# Show migration status")}
  disc migrate --status

  ${gray("# Rollback the most recent migration")}
  disc migrate --rollback --force

  ${gray("# Rollback to a specific migration")}
  disc migrate --rollback-to m20240101T100000_abc123 --force

  ${gray("# Squash all migrations")}
  disc migrate --squash

  ${gray("# Squash a range")}
  disc migrate --squash --squash-from m001 --squash-to m005

  ${gray("# Open EdgeQL REPL")}
  disc shell

  ${gray("# Generate TypeScript types from ./dbschema/")}
  disc codegen

  ${gray("# Generate from custom schema directory")}
  disc codegen --schema-dir ./schema

  ${gray("# Generate from single schema file")}
  disc codegen --schema ./schema.disc

  ${gray("# Start Disc server with PostgreSQL")}
  disc serve

  ${gray("# View last 50 lines of PostgreSQL log")}
  disc pg log

  ${gray("# Follow PostgreSQL log output")}
  disc pg log -f

  ${gray("# Show only ERROR level log lines")}
  disc pg log --level ERROR

  ${gray("# Upgrade PostgreSQL to version 17.0")}
  disc pg upgrade --target-version 17.0

  ${gray("# Preview upgrade plan")}
  disc pg upgrade --target-version 17.0 --dry-run

  ${gray("# Build binary for current platform")}
  disc build

  ${gray("# Cross-compile for Linux x64")}
  disc build --platform linux-x64

  ${gray("# Custom output path")}
  disc build --output ./my-disc

  ${gray("# Generate Dockerfile")}
  disc deploy --format docker

  ${gray("# Generate docker-compose.yml")}
  disc deploy --format compose

  ${gray("# Generate systemd service unit")}
  disc deploy --format systemd

  ${gray("# Generate .env.production template")}
  disc deploy --format env

  ${gray("# Custom output directory")}
  disc deploy --format docker --output ./infra

  ${gray("# Create database disc_my_app")}
  disc db create my_app

  ${gray("# List all Disc-managed databases")}
  disc db list

  ${gray("# Drop database disc_my_app")}
  disc db drop my_app --force

  ${gray("# Wipe database disc_my_app to known-empty state")}
  disc db wipe my_app --force

  ${gray("# Dump database to stdout (plain SQL)")}
  disc db dump my_app > backup.sql

  ${gray("# Dump in custom (compressed) format")}
  disc db dump my_app --format custom --output backup.dump

  ${gray("# Restore from a dump file")}
  disc db restore my_app --input backup.sql

  ${gray("# Restore from stdin into a clean database")}
  cat backup.sql | disc db restore my_app --clean
`;

/**
 * Per-subcommand help strings. Keys may be single commands
 * ("init") or 2-word sub-commands ("pg log", "db create").
 * Missing entries fall back to the global HELP_TEXT.
 */
const COMMAND_HELP: Record<string, string> = {
  init: `
  Initialize a new Disc project

${inverse("  USAGE ")}

  disc init ${gray("<project-name> [options]")}

${inverse("  OPTIONS ")}

  --template ${gray("<t>")} ${gray(".".repeat(11))} Template: basic | minimal | full (default: ${bgBrightYellow("basic")})
  --backend-dsn ${gray("<url>")} ${gray(".".repeat(6))} Use external PostgreSQL (skip bundled PG setup)
  --skip-postgres ${gray(".".repeat(10))} Skip PostgreSQL setup entirely
  --force ${gray(".".repeat(18))} Overwrite existing directory

${inverse("  EXAMPLES ")}

  disc init my-app
  disc init my-app --template full
  disc init my-app --backend-dsn postgres://user:pass@host/db`,
  start: `
  Start PostgreSQL for the current project

${inverse("  USAGE ")}

  disc start ${gray("[options]")}

${inverse("  OPTIONS ")}

  --no-monitor ${gray(".".repeat(13))} Disable PostgreSQL health monitoring`,
  stop: `
  Stop PostgreSQL for the current project

${inverse("  USAGE ")}

  disc stop`,
  migrate: `
  Generate and apply schema migrations

${inverse("  USAGE ")}

  disc migrate ${gray("[options]")}

${inverse("  OPTIONS ")}

  -s, --schema ${gray("<file>")} ${gray(".".repeat(6))} Schema file (default: ${bgBrightYellow("./dbschema/default.disc")})
  --dry-run ${gray(".".repeat(16))} Preview migration without executing
  --auto-approve ${gray(".".repeat(11))} Apply without interactive confirmation
  --create ${gray(".".repeat(17))} Create migration file without applying
  --status ${gray(".".repeat(17))} Show applied / pending migration summary
  --rollback ${gray(".".repeat(15))} Rollback the most recent migration (requires ${bgBrightRed(brightWhite("--force"))})
  --rollback-to ${gray("<id>")} ${gray(".".repeat(7))} Rollback all migrations after the given ID
  --squash ${gray(".".repeat(17))} Squash migrations into a single migration
  --backend-dsn ${gray("<url>")} ${gray(".".repeat(6))} Connect to external PostgreSQL instead of bundled`,
  shell: `
  Open an interactive EdgeQL REPL

${inverse("  USAGE ")}

  disc shell ${gray("[options]")}

${inverse("  OPTIONS ")}

  --backend-dsn ${gray("<url>")} ${gray(".".repeat(6))} Connect to external PostgreSQL`,
  codegen: `
  Generate TypeScript types + client from your schema

${inverse("  USAGE ")}

  disc codegen ${gray("[options]")}

${inverse("  OPTIONS ")}

  -o, --output ${gray("<dir>")} ${gray(".".repeat(7))} Output directory (default: ${bgBrightYellow("./dbschema/disc-client")})
  -s, --schema ${gray("<file>")} ${gray(".".repeat(6))} Single-file schema (default: ${bgBrightYellow("./dbschema/default.disc")})
  --schema-dir ${gray("<dir>")} ${gray(".".repeat(7))} Multi-file schema directory (default: ${bgBrightYellow("./dbschema")})
  -t, --target ${gray("<type>")} ${gray(".".repeat(6))} Output target: client | server | both
  --no-client ${gray(".".repeat(14))} Skip client library generation
  --no-format ${gray(".".repeat(14))} Skip output formatting
  --no-mutations ${gray(".".repeat(11))} Skip mutation method generation
  --no-queries ${gray(".".repeat(14))}Skip query-builder generation`,
  serve: `
  Start the Disc HTTP/WebSocket server

${inverse("  USAGE ")}

  disc serve ${gray("[options]")}

${inverse("  OPTIONS ")}

  --backend-dsn ${gray("<url>")} ${gray(".".repeat(6))} External PostgreSQL DSN
  --binary-port ${gray("<port>")} ${gray(".".repeat(5))} Enable binary wire protocol on this port
  --enable-auth ${gray(".".repeat(12))} Enable authentication system
  --enable-access-policies ${gray(".")} Enable row-level access policy enforcement
  --jwt-secret ${gray("<key>")} ${gray(".".repeat(7))} JWT signing secret (enables auth)
  --read-only ${gray(".".repeat(14))} Refuse writes (DDL + INSERT/UPDATE/DELETE)
  --require-auth ${gray(".".repeat(11))} Reject unauthenticated requests on protected routes
  --tls-cert ${gray("<path>")} ${gray(".".repeat(8))} Path to TLS certificate
  --tls-key ${gray("<path>")} ${gray(".".repeat(9))} Path to TLS private key
  --trust-proxy ${gray(".".repeat(12))} Trust X-Forwarded-* headers (rate-limit + auth IP source)`,
  build: `
  Compile Disc into a self-contained native binary

${inverse("  USAGE ")}

  disc build ${gray("[options]")}

${inverse("  OPTIONS ")}

  --lite ${gray(".".repeat(19))} Skip bundling UI assets (smaller binary)
  -o, --output ${gray("<path>")} ${gray(".".repeat(6))} Output binary path
  --platform ${gray("<p>")} ${gray(".".repeat(11))} Target: linux-x64 | linux-arm64 | darwin-x64 | darwin-arm64`,
  deploy: `
  Generate deployment artifacts for a given format

${inverse("  USAGE ")}

  disc deploy ${gray("--format <fmt> [options]")}

${inverse("  OPTIONS ")}

  --format ${gray("<fmt>")} ${gray(".".repeat(11))} One of: docker | compose | systemd | env
  -o, --output ${gray("<dir>")} ${gray(".".repeat(7))} Output directory (default: ${bgBrightYellow("./")})`,
  watch: `
  Watch schema files and auto-run migrate + codegen on change

${inverse("  USAGE ")}

  disc watch ${gray("[options]")}

${inverse("  OPTIONS ")}

  -o, --output ${gray("<dir>")} ${gray(".".repeat(7))} Codegen output dir (default: ${bgBrightYellow("./generated")})
  -s, --schema ${gray("<file>")} ${gray(".".repeat(6))} Schema to watch (default: ${bgBrightYellow("./dbschema/default.disc")})`,
  ui: `
  Open the admin UI in your browser

${inverse("  USAGE ")}

  disc ui

Requires the UI to be built first (cd ui && bun install && bun run build).`,
  status: `
  Show PostgreSQL status for the current project

${inverse("  USAGE ")}

  disc status`,
  "pg log": `
  View PostgreSQL logs for the current project

${inverse("  USAGE ")}

  disc pg log ${gray("[options]")}

${inverse("  OPTIONS ")}

  -f, --follow ${gray(".".repeat(13))} Follow log output
  --level ${gray("<lvl>")} ${gray(".".repeat(12))} Filter by level: ERROR | WARNING | LOG | FATAL | PANIC
  --lines ${gray("<n>")} ${gray(".".repeat(14))} Number of lines to show (default: ${bgBrightYellow("50")})`,
  "pg upgrade": `
  Upgrade the bundled PostgreSQL version

${inverse("  USAGE ")}

  disc pg upgrade --target-version ${gray("<version>")}

${inverse("  OPTIONS ")}

  --target-version ${gray("<v>")} ${gray(".".repeat(5))} Target PostgreSQL version (e.g. 17.0)
  --dry-run ${gray(".".repeat(16))} Preview upgrade plan`,
  "db create": `
  Create a Disc-managed database

${inverse("  USAGE ")}

  disc db create ${gray("<name> [--database-url <url>]")}`,
  "db list": `
  List Disc-managed databases

${inverse("  USAGE ")}

  disc db list ${gray("[--database-url <url>]")}`,
  "db drop": `
  Drop a Disc-managed database

${inverse("  USAGE ")}

  disc db drop ${gray("<name>")} --force ${gray("[--database-url <url>]")}`,
  "db wipe": `
  Drop and recreate a Disc-managed database (wipe to empty)

${inverse("  USAGE ")}

  disc db wipe ${gray("<name>")} --force ${gray("[--database-url <url>]")}`,
  "db dump": `
  Dump a Disc-managed database to stdout or a file

${inverse("  USAGE ")}

  disc db dump ${gray("<name> [--output <path>] [--format plain|custom] [--database-url <url>]")}

${inverse("  OPTIONS ")}

  -o, --output ${gray("<path>")} ${gray(".".repeat(6))} Output file path (default: stdout)
  --format ${gray("<fmt>")} ${gray(".".repeat(11))} Dump format: ${bgBrightYellow("plain")} (default) or ${bgBrightYellow("custom")}`,
  "db restore": `
  Restore a Disc-managed database from stdin or a file

${inverse("  USAGE ")}

  disc db restore ${gray("<name> [--input <path>] [--clean] [--database-url <url>]")}

${inverse("  OPTIONS ")}

  --input ${gray("<path>")} ${gray(".".repeat(11))} Input file path (default: stdin). Auto-detects plain vs custom format.
  --clean ${gray(".".repeat(18))} Wipe target db before restoring (drop + recreate)`,
  "schema export": `
  Export the current schema as a single SDL file

${inverse("  USAGE ")}

  disc schema export ${gray("[--schema <file>] [--schema-dir <dir>] [--output <path>]")}

${inverse("  OPTIONS ")}

  --schema ${gray("<file>")} ${gray(".".repeat(10))} Single SDL file to load (skips multi-file discovery)
  --schema-dir ${gray("<dir>")} ${gray(".".repeat(7))} Directory to discover .disc files in (default: ./dbschema)
  -o, --output ${gray("<path>")} ${gray(".".repeat(6))} Output file path (default: stdout)`,
  "schema introspect": `
  Generate SDL from an existing PostgreSQL database

${inverse("  USAGE ")}

  disc schema introspect ${gray("--database-url <dsn> [--schemas <a,b>] [--output <path>]")}

${inverse("  OPTIONS ")}

  --database-url ${gray("<dsn>")} ${gray(".".repeat(5))} Postgres connection string (or via DATABASE_URL env)
  --schemas ${gray("<list>")} ${gray(".".repeat(9))} Comma-separated PG schemas to introspect (default: ${bgBrightYellow("public")})
  -o, --output ${gray("<path>")} ${gray(".".repeat(6))} Output file path (default: stdout)`,
  "admin create-superuser": `
  Create a user and assign the superuser role

${inverse("  USAGE ")}

  disc admin create-superuser ${gray("<email> --password <pw> [--name <display>] [--role <role>]")}

${inverse("  OPTIONS ")}

  --database-url ${gray("<dsn>")} ${gray(".".repeat(5))} Postgres connection string (or via DATABASE_URL env)
  --jwt-secret ${gray("<sec>")} ${gray(".".repeat(7))} JWT signing secret (≥32 bytes; or DISC_JWT_SECRET env)
  --password ${gray("<pw>")} ${gray(".".repeat(10))} Initial password (must not be empty)
  --name ${gray("<display>")} ${gray(".".repeat(8))} Display name (defaults to email's local part)
  --role ${gray("<role>")} ${gray(".".repeat(11))} Role name to grant (default: ${bgBrightYellow("superuser")})`,
  "admin set-password": `
  Reset a user's password without their old one

${inverse("  USAGE ")}

  disc admin set-password ${gray("<email|id> --password <pw>")}

${inverse("  OPTIONS ")}

  --database-url ${gray("<dsn>")} ${gray(".".repeat(5))} Postgres connection string (or via DATABASE_URL env)
  --jwt-secret ${gray("<sec>")} ${gray(".".repeat(7))} JWT signing secret (≥32 bytes; or DISC_JWT_SECRET env)
  --password ${gray("<pw>")} ${gray(".".repeat(10))} New password (must not be empty)`,
  "admin assign-role": `
  Assign a role to a user, creating the role if needed

${inverse("  USAGE ")}

  disc admin assign-role ${gray("<email|id> <role> [--description <text>]")}

${inverse("  OPTIONS ")}

  --database-url ${gray("<dsn>")} ${gray(".".repeat(5))} Postgres connection string (or via DATABASE_URL env)
  --jwt-secret ${gray("<sec>")} ${gray(".".repeat(7))} JWT signing secret (≥32 bytes; or DISC_JWT_SECRET env)
  --description ${gray("<txt>")} ${gray(".".repeat(7))} Description if the role doesn't exist yet`,
  "admin list-roles": `
  List all defined roles with their descriptions

${inverse("  USAGE ")}

  disc admin list-roles ${gray("[--database-url <dsn>] [--jwt-secret <sec>]")}`,
  "lsp": `
  Run the Disc language server (stdio JSON-RPC)

  Spoken to by editors via JSON-RPC over stdin/stdout. Phase 1
  surfaces SDL parse + validation diagnostics on every save. Hover,
  completion, and EdgeQL support land in follow-up phases.

${inverse("  USAGE ")}

  disc lsp

${inverse("  EDITOR HINTS ")}

  - VS Code: configure ${bgBrightYellow("disc-lsp")} as the language server for
    files matching ${bgBrightYellow("*.disc")}.
  - Neovim/lspconfig: pass ${bgBrightYellow("cmd = { 'disc', 'lsp' }")} and
    ${bgBrightYellow("filetypes = { 'disc' }")}.`,
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
      // Instance-level security toggles (gh/geldata#5234). Each pairs
      // with a `DISC_*` env var and a `[server]` key in `disc.toml`;
      // the CLI flag wins over both when supplied.
      "require-auth",
      "read-only",
      "trust-proxy",
      "follow",
      "lite",
      "status",
      "rollback",
      "squash",
      "js",
      "clean",
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
      "input",
    ],
    alias: {
      // gh/geldata#1030: pair `-h`/`--help` with `-H`/`--host` so the CLI
      // matches standard Unix conventions (psql, ssh, curl). Lowercase `h`
      // stays the help short flag; uppercase `H` is the hostname.
      h: "help",
      H: "host",
      v: "version",
      p: "port",
      c: "config",
      s: "schema",
      o: "output",
      t: "target",
      f: "follow",
    },
  }) as CLIArgs;

  /*** --version takes precedence over empty positional args. Without
       this ordering, `disc --version` (no subcommand) falls into the "no args
       → print help" branch and the version flag never fires. ***/
  if (args.version) {
    console.log(`Disc Database v${VERSION}`);
    return;
  }

  if (args._.length === 0) {
    console.log(HELP_TEXT);
    return;
  }

  const command = String(args._[0]);

  /*** `disc <command> --help` prints command-specific help instead of
       the global help text. Falls back to global when no per-command entry. ***/
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
          backendDsn: args["backend-dsn"],
          databaseUrl: args["database-url"],
          directory: args.directory,
          force: args.force,
          name,
          skipPostgres: args["skip-postgres"],
          template: args.template as "basic" | "minimal" | "full" || "basic",
        });

        break;
      }

      case "migrate": {
        await commands.migrate(args);
        break;
      }

      case "shell": {
        await commands.shell({
          database: args.database,
          execute: args.execute,
          host: args.host,
          nonInteractive: args["non-interactive"],
          port: args.port ? parseInt(args.port) : undefined,
          schemaFile: args.schema,
        });

        break;
      }

      case "codegen": {
        await commands.codegen(args);
        break;
      }

      case "schema": {
        const schemaSubcommand = String(args._[1] || "");

        switch (schemaSubcommand) {
          case "export": {
            await commands.schemaExport({
              schema: args.schema,
              "schema-dir": args["schema-dir"],
              output: args.output,
            });
            break;
          }

          case "introspect": {
            await commands.schemaIntrospect({
              "database-url": args["database-url"],
              schemas: args.schemas,
              output: args.output,
            });
            break;
          }

          default: {
            console.error(`Unknown schema subcommand: ${schemaSubcommand}`);
            console.log("Available: schema export, schema introspect");
            Deno.exit(1);
          }
        }

        break;
      }

      case "lsp": {
        const exitCode = await runLspStdio();
        Deno.exit(exitCode);
        break;
      }

      case "admin": {
        const adminSub = String(args._[1] || "");
        const baseOpts = {
          "database-url": args["database-url"],
          "jwt-secret": args["jwt-secret"],
        };

        switch (adminSub) {
          case "create-superuser": {
            await adminCommand.createSuperuser({
              ...baseOpts,
              email: String(args._[2] || ""),
              password: args.password ?? "",
              name: args.name,
              role: args.role,
            });
            break;
          }

          case "set-password": {
            await adminCommand.setPassword({
              ...baseOpts,
              user: String(args._[2] || ""),
              password: args.password ?? "",
            });
            break;
          }

          case "assign-role": {
            await adminCommand.assignRole({
              ...baseOpts,
              user: String(args._[2] || ""),
              role: String(args._[3] || ""),
              description: args.description,
            });
            break;
          }

          case "list-roles": {
            await adminCommand.listRoles(baseOpts);
            break;
          }

          case "list-policies": {
            // gh/geldata#6432 — pure SDL introspection, no auth/DB
            // hookup needed (operates on the schema file directly).
            await adminCommand.listPolicies({
              schema: args.schema,
              type: args._[2] ? String(args._[2]) : undefined,
            });
            break;
          }

          case "test-policy": {
            // gh/geldata#6432 slice 4 — run a single policy in
            // isolation against a synthetic context. Pure SDL
            // introspection + in-memory evaluator; no DB hookup.
            const target = args._[2] ? String(args._[2]) : "";
            const action = args.action
              ? String(args.action) as
                | "select"
                | "insert"
                | "update"
                | "delete"
                | "all"
              : "select";
            // Globals come in as repeated `--global key=value` flags
            // or a single `--globals "k1=v1,k2=v2"` shorthand. The
            // parser collapses repeats into an array; normalize both
            // forms into a record.
            const globals: Record<string, unknown> = {};
            const globalArg = args.global ?? args.globals;
            if (globalArg !== undefined) {
              const list: string[] = Array.isArray(globalArg)
                ? globalArg.map((v: unknown) => String(v))
                : String(globalArg).split(",").map((s: string) => s.trim());
              for (const kv of list) {
                const eq = kv.indexOf("=");
                if (eq < 1) continue;
                globals[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
              }
            }
            await adminCommand.testPolicy({
              schema: args.schema,
              target,
              action,
              userId: args["user-id"] ? String(args["user-id"]) : undefined,
              userRole: args["user-role"] ? String(args["user-role"]) : undefined,
              globals: Object.keys(globals).length > 0 ? globals : undefined,
              all: args.all === true,
            });
            break;
          }

          default: {
            console.error(`Unknown admin subcommand: ${adminSub}`);
            console.log(
              "Available: admin create-superuser, admin set-password, admin assign-role, admin list-roles, admin list-policies, admin test-policy",
            );
            Deno.exit(1);
          }
        }

        break;
      }

      case "serve": {
        await commands.serve({
          binaryPort: args["binary-port"] ? parseInt(args["binary-port"]) : undefined,
          config: args.config,
          enableAccessPolicies: args["enable-access-policies"],
          enableAuth: args["enable-auth"],
          host: args.host,
          jwtSecret: args["jwt-secret"],
          port: args.port ? parseInt(args.port) : undefined,
          readOnly: args["read-only"],
          requireAuth: args["require-auth"],
          tlsCert: args["tls-cert"],
          tlsKey: args["tls-key"],
          trustProxy: args["trust-proxy"],
        });

        break;
      }

      case "watch": {
        await commands.watch({
          delayMs: 1000,
          outputDir: args.output,
          schemaFile: args.schema,
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
          lite: args.lite,
          output: args.output,
          platform: args.platform,
        });

        break;
      }

      case "deploy": {
        if (!args.format) {
          console.error("Error: --format is required for deploy. Valid formats: docker, compose, systemd, env");
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
          case "log": {
            await commands.pgLog({
              follow: args.follow || false,
              level: args.level,
              lines: args.lines ? parseInt(String(args.lines)) : 50,
              project: args.name,
            });

            break;
          }

          case "upgrade": {
            if (!args["target-version"]) {
              console.error("Error: --target-version is required for pg upgrade");
              Deno.exit(1);
            }

            await commands.pgUpgrade({
              backup: true,
              dryRun: args["dry-run"] || false,
              project: args.name,
              targetVersion: args["target-version"],
            });

            break;
          }

          default: {
            console.error(`Unknown pg subcommand: ${subcommand}`);
            console.log("Available: pg log, pg upgrade");

            Deno.exit(1);
          }
        }

        break;
      }

      case "db": {
        const dbSubcommand = String(args._[1] || "");

        switch (dbSubcommand) {
          case "create": {
            const dbName = String(args._[2] || "");

            if (!dbName) {
              console.error("Error: database name is required. Usage: disc db create <name>");
              Deno.exit(1);
            }

            await commands.dbCreate(dbName, args);
            break;
          }

          case "list": {
            await commands.dbList(args);
            break;
          }

          case "drop": {
            const dropName = String(args._[2] || "");

            if (!dropName) {
              console.error("Error: database name is required. Usage: disc db drop <name> --force");
              Deno.exit(1);
            }

            await commands.dbDrop(dropName, args);
            break;
          }

          case "wipe": {
            const wipeName = String(args._[2] || "");

            if (!wipeName) {
              console.error("Error: database name is required. Usage: disc db wipe <name> --force");
              Deno.exit(1);
            }

            await commands.dbWipe(wipeName, args);
            break;
          }

          case "dump": {
            const dumpName = String(args._[2] || "");

            if (!dumpName) {
              console.error("Error: database name is required. Usage: disc db dump <name> [--output <path>] [--format plain|custom]");
              Deno.exit(1);
            }

            await commands.dbDump(dumpName, args);
            break;
          }

          case "restore": {
            const restoreName = String(args._[2] || "");

            if (!restoreName) {
              console.error("Error: database name is required. Usage: disc db restore <name> [--input <path>] [--clean]");
              Deno.exit(1);
            }

            await commands.dbRestore(restoreName, args);
            break;
          }

          case "push": {
            // gh/geldata#3761 — Prisma-style push. Applies the current
            // schema to the live DB without recording a migration. The
            // dev-loop iteration command: rapid schema-edit → push →
            // test, no migration files until you're ready for one.
            await commands.dbPush(args);
            break;
          }

          default: {
            console.error(`Unknown db subcommand: ${dbSubcommand}`);
            console.log(
              "Available: db create, db list, db drop, db wipe, db dump, db restore, db push",
            );

            Deno.exit(1);
          }
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

if (import.meta.main) {
  await main();
}

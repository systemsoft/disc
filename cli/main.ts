#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env

/**
 * Disc CLI - Command-line interface for Disc database
 */

import { parseArgs } from "@std/cli/parse-args";
import { VERSION } from "../mod.ts";

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
  -h, --help    Show this help message
  -v, --version Show version information

EXAMPLES:
  disc init                 # Initialize new project
  disc migrate --create     # Create migration without applying
  disc shell                # Open EdgeQL REPL
  disc serve --port 5432    # Start server on custom port
`;

async function main() {
  const args = parseArgs(Deno.args, {
    boolean: ["help", "version", "create"],
    string: ["port"],
    alias: {
      h: "help",
      v: "version",
      p: "port",
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
      if (args.create) {
        console.log("Creating migration...");
      } else {
        console.log("Applying migrations...");
      }

      console.log("TODO: Implement migration engine");
      break;
    }

    case "shell": {
      console.log("Opening EdgeQL REPL...");
      console.log("TODO: Implement interactive shell");
      break;
    }

    case "codegen": {
      console.log("Generating TypeScript types...");
      console.log("TODO: Implement code generation");
      break;
    }

    case "serve": {
      const port = args.port || "5656";
      console.log(`Starting Disc server on port ${port}...`);
      console.log("TODO: Implement server");
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

if (import.meta.main) {
  await main();
}

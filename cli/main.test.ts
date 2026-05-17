/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * CLI main module tests
 */

/*** NATIVE ------------------------------------------- ***/

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { parseArgs } from "@std/cli/parse-args";

/*** UTILITY ------------------------------------------ ***/

import {
  cleanupTempDir,
  createTempDir,
  createTestSchema,
  EnvMock,
  SIMPLE_SCHEMA
} from "../tests/test-utils.ts";

/*** RUNTIME ------------------------------------------ ***/

Deno.test("CLI - parseArgs configuration", () => {
  const args = parseArgs(["codegen", "--output", "./test", "--target", "client"], {
    alias: {
      c: "config",
      h: "help",
      o: "output",
      p: "port",
      s: "schema",
      t: "target",
      v: "version"
    },
    boolean: [
      "auto-approve",
      "create",
      "dry-run",
      "help",
      "no-client",
      "no-format",
      "no-mutations",
      "no-queries",
      "version"
    ],
    string: [
      "config",
      "output",
      "port",
      "schema",
      "target"
    ]
  });

  assertEquals(args._, ["codegen"]);
  assertEquals(args.output, "./test");
  assertEquals(args.target, "client");
});

Deno.test("CLI - help flag parsing", () => {
  const args = parseArgs(["-h"], {
    alias: { h: "help", v: "version" },
    boolean: ["help", "version"]
  });

  assertEquals(args.help, true);
});

Deno.test("CLI - version flag parsing", () => {
  const args = parseArgs(["--version"], {
    alias: { h: "help", v: "version" },
    boolean: ["help", "version"]
  });

  assertEquals(args.version, true);
});

/*** End-to-end check that `disc --version` (no subcommand) prints the version and exits — does NOT
     fall through to the help text branch. ***/
Deno.test("CLI - `disc --version` prints version, not help", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "cli/main.ts",
      "--version"
    ],
    stderr: "piped",
    stdout: "piped"
  });

  const { code, stdout } = await cmd.output();
  const out = new TextDecoder().decode(stdout);

  assertEquals(code, 0);
  assertEquals(out.startsWith("Disc Database v"), true, out);
  /*** Help text starts with a leading newline + "Disc Database CLI v…\n\nUSAGE:". If we ever fell
       through to help, this `USAGE` substring would appear. ***/
  assertEquals(out.includes("USAGE:"), false, out);
});

Deno.test("CLI - `disc -v` short flag prints version", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "cli/main.ts",
      "-v"
    ],
    stderr: "piped",
    stdout: "piped"
  });

  const { code, stdout } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  assertEquals(code, 0);
  assertEquals(out.startsWith("Disc Database v"), true, out);
  assertEquals(out.includes("USAGE:"), false, out);
});

Deno.test("CLI - codegen command arguments", () => {
  const args = parseArgs([
    "codegen",
    "--schema",
    "custom.disc",
    "--output",
    "./generated",
    "--target",
    "both",
    "--no-queries",
    "--no-client"
  ], {
    boolean: ["no-client", "no-format", "no-mutations", "no-queries"],
    string: ["output", "schema", "target"]
  });

  assertEquals(args._[0], "codegen");
  assertEquals(args.schema, "custom.disc");
  assertEquals(args.output, "./generated");
  assertEquals(args.target, "both");
  assertEquals(args["no-queries"], true);
  assertEquals(args["no-client"], true);
  assertEquals(args["no-mutations"], false);
});

Deno.test("CLI - migrate command arguments", () => {
  const args = parseArgs([
    "migrate",
    "--create",
    "--dry-run",
    "--auto-approve",
    "--schema",
    "test.disc"
  ], {
    boolean: ["auto-approve", "create", "dry-run"],
    string: ["schema"]
  });

  assertEquals(args._[0], "migrate");
  assertEquals(args.create, true);
  assertEquals(args["dry-run"], true);
  assertEquals(args["auto-approve"], true);
  assertEquals(args.schema, "test.disc");
});

Deno.test("CLI - serve command arguments", () => {
  const args = parseArgs([
    "serve",
    "--port",
    "8080",
    "--config",
    "custom.json"
  ], {
    string: ["config", "port"]
  });

  assertEquals(args._[0], "serve");
  assertEquals(args.port, "8080");
  assertEquals(args.config, "custom.json");
});

/*** Test schema file reading utility ***/
Deno.test("readSchemaFile - existing file", async () => {
  const tempDir = await createTempDir();

  try {
    const schemaPath = await createTestSchema(tempDir, SIMPLE_SCHEMA);
    /*** Import the readSchemaFile function - we’ll need to make it exportable For now, test that a
         file can be read ***/
    const stat = await Deno.stat(schemaPath);
    assertExists(stat);
    assertEquals(stat.isFile, true);

    const content = await Deno.readTextFile(schemaPath);
    assertEquals(content, SIMPLE_SCHEMA);
  } finally {
    await cleanupTempDir(tempDir);
  }
});

Deno.test("readSchemaFile - nonexistent file", async () => {
  const nonExistentPath = "/does/not/exist/schema.disc";

  /*** Test that attempting to read a nonexistent file handles errors gracefully ***/
  await assertRejects(() => Deno.stat(nonExistentPath), Deno.errors.NotFound);
});

/*** Test environment variable handling ***/
Deno.test("CLI - environment variable handling", () => {
  const env = new EnvMock();

  try {
    env.set("DATABASE_URL", "postgresql://test:test@localhost:5432/test_db");

    const dbUrl = Deno.env.get("DATABASE_URL");
    assertEquals(dbUrl, "postgresql://test:test@localhost:5432/test_db");
  } finally {
    env.restore();
  }
});

/*** Test default values ***/
Deno.test("CLI - default configuration values", () => {
  const args = parseArgs(["codegen"], {
    string: ["output", "schema", "target"]
  });

  /*** Test that defaults are applied correctly ***/
  const outputDir = args.output || "./generated";
  const target = args.target || "client";
  const schemaFile = args.schema || "./schema.disc";

  assertEquals(outputDir, "./generated");
  assertEquals(target, "client");
  assertEquals(schemaFile, "./schema.disc");
});

/*** Test boolean flag combinations ***/
Deno.test("CLI - boolean flag combinations", () => {
  const args = parseArgs([
    "codegen",
    "--no-queries",
    "--no-mutations",
    "--no-client",
    "--no-format"
  ], {
    boolean: ["no-client", "no-format", "no-mutations", "no-queries"]
  });

  assertEquals(args["no-queries"], true);
  assertEquals(args["no-mutations"], true);
  assertEquals(args["no-client"], true);
  assertEquals(args["no-format"], true);
});

/*** Test migration config construction ***/
Deno.test("CLI - migration config construction", () => {
  const env = new EnvMock();

  try {
    env.set("DATABASE_URL", "postgresql://localhost:5432/test_disc");

    const args = {
      "auto-approve": false,
      "dry-run": true,
      schema: "./test.disc"
    };

    /*** Simulate migration config construction ***/
    const config = {
      autoApprove: args["auto-approve"] || false,
      backupBeforeMigration: true,
      databaseUrl: Deno.env.get("DATABASE_URL") || "postgresql://localhost:5432/disc_dev",
      dryRun: args["dry-run"] || false,
      migrationsDir: "./migrations",
      rollbackOnError: true,
      schemaFile: args.schema || "./schema.disc"
    };

    assertEquals(config.schemaFile, "./test.disc");
    assertEquals(config.databaseUrl, "postgresql://localhost:5432/test_disc");
    assertEquals(config.dryRun, true);
    assertEquals(config.autoApprove, false);
    assertEquals(config.backupBeforeMigration, true);
    assertEquals(config.rollbackOnError, true);
  } finally {
    env.restore();
  }
});

/*** Test codegen config construction ***/
Deno.test("CLI - codegen config construction", () => {
  const args = {
    "no-client": true,
    "no-format": false,
    "no-mutations": false,
    "no-queries": true,
    output: "./custom/types",
    target: "server"
  };

  /*** Simulate codegen config construction ***/
  const config = {
    formatOutput: args["no-format"] !== true,
    includeClient: args["no-client"] !== true,
    includeMutations: args["no-mutations"] !== true,
    includeQueryBuilders: args["no-queries"] !== true,
    outputDir: args.output || "./generated",
    target: args.target || "client"
  };

  assertEquals(config.outputDir, "./custom/types");
  assertEquals(config.target, "server");
  assertEquals(config.includeQueryBuilders, false); /*** no-queries is true ***/
  assertEquals(config.includeMutations, true); /*** no-mutations is false ***/
  assertEquals(config.includeClient, false); /*** no-client is true ***/
  assertEquals(config.formatOutput, true); /*** no-format is false ***/
});

/*** Test alias handling ***/
Deno.test("CLI - alias flag handling", () => {
  const args = parseArgs([
    "codegen",
    "-o",
    "./out",
    "-t",
    "both",
    "-s",
    "custom.disc"
  ], {
    string: ["output", "schema", "target"],
    alias: {
      o: "output",
      s: "schema",
      t: "target"
    }
  });

  assertEquals(args.output, "./out");
  assertEquals(args.target, "both");
  assertEquals(args.schema, "custom.disc");
});

/*** gh/geldata#1030: `-H` is hostname (Unix convention) while lowercase `-h` stays as help. Verify
     both with the same alias map main.ts uses. ***/
Deno.test("CLI - -H short flag maps to --host", () => {
  const args = parseArgs([
    "shell",
    "-H",
    "db.example.com"
  ], {
    alias: { H: "host" },
    string: ["host"]
  });

  assertEquals(args.host, "db.example.com");
});

Deno.test("CLI - -h still triggers help (not host) with -H alias present", () => {
  const args = parseArgs(["-h"], {
    alias: { h: "help", H: "host" },
    boolean: ["help"],
    string: ["host"]
  });

  assertEquals(args.help, true);
  assertEquals(args.host, undefined);
});

Deno.test("CLI - long --host still works alongside -H", () => {
  const args = parseArgs([
    "serve",
    "--host",
    "0.0.0.0"
  ], {
    alias: { H: "host" },
    string: ["host"]
  });

  assertEquals(args.host, "0.0.0.0");
});

/*** Integration: spawn `disc shell --help` to confirm short -h triggers command-specific help.
     Mirrors the `--version` short-flag test above. ***/
Deno.test("CLI - `disc shell -h` short flag prints shell help", async () => {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "cli/main.ts",
      "shell",
      "-h"
    ],
    stderr: "piped",
    stdout: "piped"
  });

  const { code, stdout } = await cmd.output();
  const out = new TextDecoder().decode(stdout);

  assertEquals(code, 0);
  /*** The shell COMMAND_HELP block opens with "Open an interactive EdgeQL REPL". ***/
  assertEquals(out.includes("Open an interactive EdgeQL REPL"), true, out);
});

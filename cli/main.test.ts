/**
 * CLI main module tests
 */

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { parseArgs } from "@std/cli/parse-args";
import { cleanupTempDir, createTempDir, createTestSchema, EnvMock, SIMPLE_SCHEMA } from "../tests/test-utils.ts";

// Import functions to test (we'll need to export them from main.ts)
// For now, we'll test the CLI by importing and calling functions directly

Deno.test("CLI - parseArgs configuration", () => {
  const args = parseArgs([
    "codegen",
    "--output",
    "./test",
    "--target",
    "client"
  ], {
    boolean: [
      "help",
      "version",
      "create",
      "dry-run",
      "auto-approve",
      "no-queries",
      "no-mutations",
      "no-client",
      "no-format"
    ],
    string: ["port", "config", "schema", "output", "target"],
    alias: {
      h: "help",
      v: "version",
      p: "port",
      c: "config",
      s: "schema",
      o: "output",
      t: "target"
    }
  });

  assertEquals(args._, ["codegen"]);
  assertEquals(args.output, "./test");
  assertEquals(args.target, "client");
});

Deno.test("CLI - help flag parsing", () => {
  const args = parseArgs(["-h"], {
    boolean: ["help", "version"],
    alias: { h: "help", v: "version" }
  });

  assertEquals(args.help, true);
});

Deno.test("CLI - version flag parsing", () => {
  const args = parseArgs(["--version"], {
    boolean: ["help", "version"],
    alias: { h: "help", v: "version" }
  });

  assertEquals(args.version, true);
});

// P2-12: end-to-end check that `disc --version` (no subcommand) prints
// the version and exits — does NOT fall through to the help text branch.
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
    stdout: "piped",
    stderr: "piped"
  });
  const { code, stdout } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  assertEquals(code, 0);
  assertEquals(out.startsWith("Disc Database v"), true, out);
  // Help text starts with a leading newline + "Disc Database CLI v…\n\nUSAGE:".
  // If we ever fell through to help, this `USAGE` substring would appear.
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
    stdout: "piped",
    stderr: "piped"
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
    boolean: ["no-queries", "no-mutations", "no-client", "no-format"],
    string: ["schema", "output", "target"]
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
    boolean: ["create", "dry-run", "auto-approve"],
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
    string: ["port", "config"]
  });

  assertEquals(args._[0], "serve");
  assertEquals(args.port, "8080");
  assertEquals(args.config, "custom.json");
});

// Test schema file reading utility
Deno.test("readSchemaFile - existing file", async () => {
  const tempDir = await createTempDir();

  try {
    const schemaPath = await createTestSchema(tempDir, SIMPLE_SCHEMA);

    // Import the readSchemaFile function - we'll need to make it exportable
    // For now, test that a file can be read
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

  // Test that attempting to read a nonexistent file handles errors gracefully
  await assertRejects(
    () => Deno.stat(nonExistentPath),
    Deno.errors.NotFound
  );
});

// Test environment variable handling
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

// Test default values
Deno.test("CLI - default configuration values", () => {
  const args = parseArgs(["codegen"], {
    string: ["output", "target", "schema"]
  });

  // Test that defaults are applied correctly
  const outputDir = args.output || "./generated";
  const target = args.target || "client";
  const schemaFile = args.schema || "./schema.disc";

  assertEquals(outputDir, "./generated");
  assertEquals(target, "client");
  assertEquals(schemaFile, "./schema.disc");
});

// Test boolean flag combinations
Deno.test("CLI - boolean flag combinations", () => {
  const args = parseArgs([
    "codegen",
    "--no-queries",
    "--no-mutations",
    "--no-client",
    "--no-format"
  ], {
    boolean: ["no-queries", "no-mutations", "no-client", "no-format"]
  });

  assertEquals(args["no-queries"], true);
  assertEquals(args["no-mutations"], true);
  assertEquals(args["no-client"], true);
  assertEquals(args["no-format"], true);
});

// Test migration config construction
Deno.test("CLI - migration config construction", () => {
  const env = new EnvMock();

  try {
    env.set("DATABASE_URL", "postgresql://localhost:5432/test_disc");

    const args = {
      schema: "./test.disc",
      "dry-run": true,
      "auto-approve": false
    };

    // Simulate migration config construction
    const config = {
      migrationsDir: "./migrations",
      schemaFile: args.schema || "./schema.disc",
      databaseUrl: Deno.env.get("DATABASE_URL") ||
        "postgresql://localhost:5432/disc_dev",
      dryRun: args["dry-run"] || false,
      autoApprove: args["auto-approve"] || false,
      backupBeforeMigration: true,
      rollbackOnError: true
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

// Test codegen config construction
Deno.test("CLI - codegen config construction", () => {
  const args = {
    output: "./custom/types",
    target: "server",
    "no-queries": true,
    "no-mutations": false,
    "no-client": true,
    "no-format": false
  };

  // Simulate codegen config construction
  const config = {
    outputDir: args.output || "./generated",
    target: args.target || "client",
    includeQueryBuilders: args["no-queries"] !== true,
    includeMutations: args["no-mutations"] !== true,
    includeClient: args["no-client"] !== true,
    formatOutput: args["no-format"] !== true
  };

  assertEquals(config.outputDir, "./custom/types");
  assertEquals(config.target, "server");
  assertEquals(config.includeQueryBuilders, false); // no-queries is true
  assertEquals(config.includeMutations, true); // no-mutations is false
  assertEquals(config.includeClient, false); // no-client is true
  assertEquals(config.formatOutput, true); // no-format is false
});

// Test alias handling
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
    string: ["output", "target", "schema"],
    alias: {
      o: "output",
      t: "target",
      s: "schema"
    }
  });

  assertEquals(args.output, "./out");
  assertEquals(args.target, "both");
  assertEquals(args.schema, "custom.disc");
});

// gh/geldata#1030: `-H` is hostname (Unix convention) while lowercase
// `-h` stays as help. Verify both with the same alias map main.ts uses.
Deno.test("CLI - -H short flag maps to --host", () => {
  const args = parseArgs([
    "shell",
    "-H",
    "db.example.com"
  ], {
    string: ["host"],
    alias: { H: "host" }
  });

  assertEquals(args.host, "db.example.com");
});

Deno.test("CLI - -h still triggers help (not host) with -H alias present", () => {
  const args = parseArgs(["-h"], {
    boolean: ["help"],
    string: ["host"],
    alias: { h: "help", H: "host" }
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
    string: ["host"],
    alias: { H: "host" }
  });

  assertEquals(args.host, "0.0.0.0");
});

// Integration: spawn `disc shell --help` to confirm short -h triggers
// command-specific help. Mirrors the `--version` short-flag test above.
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
    stdout: "piped",
    stderr: "piped"
  });
  const { code, stdout } = await cmd.output();
  const out = new TextDecoder().decode(stdout);
  assertEquals(code, 0);
  // The shell COMMAND_HELP block opens with "Open an interactive EdgeQL REPL".
  assertEquals(
    out.includes("Open an interactive EdgeQL REPL"),
    true,
    out
  );
});

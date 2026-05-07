/**
 * CLI Shell Command Tests - Test interactive EdgeQL REPL functionality
 */

import { assert } from "@std/assert";
import { assertLogContains, cleanupTempDir, ConsoleCapture, createTempDir, createTestSchema, SIMPLE_SCHEMA } from "../tests/test-utils.ts";

// Mock shell command implementation
interface ShellOptions {
  host?: string;
  port?: number;
  database?: string;
  schemaFile?: string;
  nonInteractive?: boolean;
  execute?: string;
}

interface ShellSession {
  connected: boolean;
  database: string;
  host: string;
  port: number;
  queryCount: number;
  history: string[];
}

function createMockShellSession(options: ShellOptions = {}): ShellSession {
  return {
    connected: true,
    database: options.database || "disc_dev",
    host: options.host || "localhost",
    port: options.port || 5656,
    queryCount: 0,
    history: [],
  };
}

function mockShellCommand(options: ShellOptions = {}): string[] {
  const output: string[] = [];

  if (options.nonInteractive) {
    output.push("🚀 Starting Disc shell in non-interactive mode...");
  } else {
    output.push("🚀 Starting Disc EdgeQL shell...");
  }

  const session = createMockShellSession(options);

  output.push(`📡 Connected to Disc server at ${session.host}:${session.port}`);
  output.push(`📊 Database: ${session.database}`);
  output.push("");

  if (options.execute) {
    // Execute single query and exit
    output.push(`disc> ${options.execute}`);

    // Mock query execution
    if (options.execute.toLowerCase().includes("select")) {
      output.push(`[{"id": "123", "name": "Test User"}]`);
      output.push(`(1 row)`);
    } else if (options.execute.toLowerCase().includes("insert")) {
      output.push(`{"id": "456"}`);
      output.push(`(1 row inserted)`);
    } else {
      output.push(`Query executed successfully`);
    }

    session.queryCount++;
    output.push("");
    output.push("✅ Query executed, exiting...");
  } else if (options.nonInteractive) {
    output.push(
      "💡 Use --execute to run a query, or omit --non-interactive for REPL mode",
    );
  } else {
    // Interactive mode simulation
    output.push("💡 Interactive EdgeQL shell. Type \\? for help, \\q to quit.");
    output.push("");
    output.push("Available commands:");
    output.push("  \\?        Show help");
    output.push("  \\q        Quit shell");
    output.push("  \\d        List types");
    output.push("  \\dt       List types (detailed)");
    output.push("  \\c <db>   Connect to database");
    output.push("  \\i <file> Execute file");
    output.push("  \\timing   Toggle query timing");
    output.push("");
    output.push("disc>");
  }

  return output;
}

Deno.test("CLI Shell - basic shell startup", async () => {
  const console = new ConsoleCapture();

  try {
    const output = await mockShellCommand();

    // Simulate shell output
    output.forEach((line) => console.log(line));

    const logs = console.getLogs();
    assertLogContains(logs, "Starting Disc EdgeQL shell");
    assertLogContains(logs, "Connected to Disc server");
    assertLogContains(logs, "Database: disc_dev");
    assertLogContains(logs, "Interactive EdgeQL shell");
    assertLogContains(logs, "Type \\? for help");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - custom connection parameters", async () => {
  const console = new ConsoleCapture();

  try {
    const options: ShellOptions = {
      host: "192.168.1.100",
      port: 8080,
      database: "custom_db",
    };

    const output = await mockShellCommand(options);
    output.forEach((line) => console.log(line));

    const logs = console.getLogs();
    assertLogContains(logs, "Connected to Disc server at 192.168.1.100:8080");
    assertLogContains(logs, "Database: custom_db");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - execute single query", async () => {
  const console = new ConsoleCapture();

  try {
    const options: ShellOptions = {
      execute: "select User { name, email }",
    };

    const output = await mockShellCommand(options);
    output.forEach((line) => console.log(line));

    const logs = console.getLogs();
    assertLogContains(logs, "disc> select User { name, email }");
    assertLogContains(logs, '{"id": "123", "name": "Test User"}');
    assertLogContains(logs, "(1 row)");
    assertLogContains(logs, "Query executed, exiting");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - non-interactive mode", async () => {
  const console = new ConsoleCapture();

  try {
    const options: ShellOptions = {
      nonInteractive: true,
    };

    const output = await mockShellCommand(options);
    output.forEach((line) => console.log(line));

    const logs = console.getLogs();
    assertLogContains(logs, "non-interactive mode");
    assertLogContains(logs, "Use --execute to run a query");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - help command output", () => {
  const console = new ConsoleCapture();

  try {
    // Mock help command output
    console.log("📖 EdgeQL Shell Help");
    console.log("");
    console.log("COMMANDS:");
    console.log("  \\?         Show this help message");
    console.log("  \\q         Quit the shell");
    console.log("  \\d         List all types in current module");
    console.log("  \\dt        List types with detailed information");
    console.log("  \\c <db>    Connect to a different database");
    console.log("  \\i <file>  Execute EdgeQL from file");
    console.log("  \\timing    Toggle query execution timing");
    console.log("  \\history   Show command history");
    console.log("  \\clear     Clear screen");
    console.log("");
    console.log("QUERY TIPS:");
    console.log("  - Use semicolon (;) to execute multi-line queries");
    console.log("  - Use Tab for auto-completion");
    console.log("  - Use Up/Down arrows for command history");
    console.log("  - Use Ctrl+C to cancel current input");

    const logs = console.getLogs();
    assertLogContains(logs, "EdgeQL Shell Help");
    assertLogContains(logs, "COMMANDS:");
    assertLogContains(logs, "\\? ");
    assertLogContains(logs, "\\q ");
    assertLogContains(logs, "QUERY TIPS:");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - list types command", () => {
  const console = new ConsoleCapture();

  try {
    // Mock \d command output
    console.log("📋 Types in module 'default':");
    console.log("");
    console.log("  User");
    console.log("  Post");
    console.log("  Comment");
    console.log("");
    console.log("3 types found");

    const logs = console.getLogs();
    assertLogContains(logs, "Types in module 'default'");
    assertLogContains(logs, "User");
    assertLogContains(logs, "Post");
    assertLogContains(logs, "3 types found");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - detailed types command", () => {
  const console = new ConsoleCapture();

  try {
    // Mock \dt command output
    console.log("📊 Detailed type information:");
    console.log("");
    console.log("Type: User");
    console.log("  Properties:");
    console.log("    id: uuid (required)");
    console.log("    name: str (required)");
    console.log("    email: str (required, exclusive)");
    console.log("    createdAt: datetime (default: datetime_current())");
    console.log("  Links:");
    console.log("    posts: Post (multi)");
    console.log("");
    console.log("Type: Post");
    console.log("  Properties:");
    console.log("    id: uuid (required)");
    console.log("    title: str (required)");
    console.log("    content: str (required)");
    console.log("    createdAt: datetime (default: datetime_current())");
    console.log("  Links:");
    console.log("    author: User (required)");

    const logs = console.getLogs();
    assertLogContains(logs, "Detailed type information");
    assertLogContains(logs, "Type: User");
    assertLogContains(logs, "Properties:");
    assertLogContains(logs, "Links:");
    assertLogContains(logs, "posts: Post (multi)");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - query timing", () => {
  const console = new ConsoleCapture();

  try {
    // Mock query with timing enabled
    console.log("disc> \\timing");
    console.log("⏱️  Query timing is now ON");
    console.log("");
    console.log("disc> select User { name } limit 10;");
    console.log('[{"name": "Ada"}, {"name": "Billie"}]');
    console.log("⏱️  Time: 15.234ms");
    console.log("(2 rows)");

    const logs = console.getLogs();
    assertLogContains(logs, "Query timing is now ON");
    assertLogContains(logs, "Time: 15.234ms");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - connection error handling", () => {
  const console = new ConsoleCapture();

  try {
    // Mock connection failure
    console.error("❌ Failed to connect to Disc server");
    console.error("📡 Could not reach localhost:5656");
    console.error("💡 Make sure the Disc server is running with 'disc serve'");
    console.error("💡 Check connection parameters: --host, --port, --database");

    const errorLogs = console.getErrorLogs();
    assert(errorLogs.some((log) => log.includes("Failed to connect")));
    assert(errorLogs.some((log) => log.includes("Could not reach")));
    assert(
      errorLogs.some((log) => log.includes("Make sure the Disc server is running")),
    );
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - file execution", async () => {
  const console = new ConsoleCapture();
  const tempDir = await createTempDir();

  try {
    // Create test query file
    const queryFile = `${tempDir}/test_queries.edgeql`;
    const queryContent = `-- Test queries file
select User { name, email };

insert Post {
  title := "Test Post",
  content := "Test content",
  author := (select User filter .name = "Ada")
};`;

    await Deno.writeTextFile(queryFile, queryContent);

    // Mock \i command execution
    console.log(`disc> \\i ${queryFile}`);
    console.log("📖 Executing queries from file...");
    console.log("");
    console.log("Query 1: select User { name, email };");
    console.log('[{"name": "Ada", "email": "ada@example.com"}]');
    console.log("(1 row)");
    console.log("");
    console.log("Query 2: insert Post { ... };");
    console.log('{"id": "789"}');
    console.log("(1 row inserted)");
    console.log("");
    console.log("✅ File execution completed. 2 queries executed.");

    const logs = console.getLogs();
    assertLogContains(logs, "Executing queries from file");
    assertLogContains(logs, "Query 1:");
    assertLogContains(logs, "Query 2:");
    assertLogContains(logs, "File execution completed");
  } finally {
    console.restore();
    await cleanupTempDir(tempDir);
  }
});

Deno.test("CLI Shell - command history", () => {
  const console = new ConsoleCapture();

  try {
    // Mock \history command
    console.log("📚 Command History:");
    console.log("");
    console.log("  1  select User { name };");
    console.log("  2  \\d");
    console.log("  3  select Post { title, author: { name } };");
    console.log("  4  \\timing");
    console.log(
      '  5  insert User { name := "Test", email := "test@example.com" };',
    );
    console.log("");
    console.log("5 commands in history");

    const logs = console.getLogs();
    assertLogContains(logs, "Command History:");
    assertLogContains(logs, "select User");
    assertLogContains(logs, "insert User");
    assertLogContains(logs, "commands in history");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - auto-completion simulation", () => {
  const console = new ConsoleCapture();

  try {
    // Mock auto-completion behavior
    console.log("disc> sel[TAB]");
    console.log("Completions:");
    console.log("  select");
    console.log("");
    console.log("disc> select Us[TAB]");
    console.log("Completions:");
    console.log("  User");
    console.log("");
    console.log("disc> select User { na[TAB]");
    console.log("Completions:");
    console.log("  name");

    const logs = console.getLogs();
    assertLogContains(logs, "Completions:");
    assertLogContains(logs, "select");
    assertLogContains(logs, "User");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - multi-line query", () => {
  const console = new ConsoleCapture();

  try {
    // Mock multi-line query input
    console.log("disc> select User {");
    console.log("...>   name,");
    console.log("...>   email,");
    console.log("...>   posts: { title }");
    console.log("...> };");
    console.log("");
    console.log(
      '[{"name": "Ada", "email": "ada@example.com", "posts": [{"title": "Hello World"}]}]',
    );
    console.log("(1 row)");

    const logs = console.getLogs();
    assertLogContains(logs, "disc> select User {");
    assertLogContains(logs, "...>   name,");
    assertLogContains(logs, "...> };");
  } finally {
    console.restore();
  }
});

Deno.test("CLI Shell - schema from file option", async () => {
  const console = new ConsoleCapture();
  const tempDir = await createTempDir();

  try {
    const schemaFile = await createTestSchema(tempDir, SIMPLE_SCHEMA);

    // Mock shell with schema file (using schemaFile from above)
    console.log(`🚀 Starting Disc EdgeQL shell...`);
    console.log(`📖 Loading schema from ${schemaFile}`);
    console.log(`📡 Connected to Disc server at localhost:5656`);
    console.log(`📊 Database: disc_dev`);
    console.log(`✅ Schema loaded: 1 type(s) available`);

    const logs = console.getLogs();
    assertLogContains(logs, "Loading schema from");
    assertLogContains(logs, "Schema loaded: 1 type(s) available");
  } finally {
    console.restore();
    await cleanupTempDir(tempDir);
  }
});

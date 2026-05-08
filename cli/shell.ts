// deno-lint-ignore-file no-console
/**
 * CLI Shell Command Implementation - Interactive EdgeQL REPL
 */

import { TextLineStream } from "jsr:@std/streams@1.0.8/text-line-stream";
import { discoverSchemaFiles, loadMultiFileSchema } from "../codegen/mod.ts";
import type { Schema } from "../compiler/context.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { resolveProjectContext } from "../lib/project-context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { ensurePgRunning } from "../postgres/ensure-running.ts";
import { describeAllTypes, describeType } from "./describe.ts";

export interface ShellOptions {
  host?: string;
  port?: number;
  database?: string;
  schemaFile?: string;
  nonInteractive?: boolean;
  execute?: string;
}

export interface ShellSession {
  host: string;
  port: number;
  database: string;
  user?: string;
  connected: boolean;
  timingEnabled: boolean;
}

export class DiscShell {
  private db?: DatabaseConnection;
  private commandHistory: string[] = [];
  private multilineBuffer = "";
  private isMultiline = false;
  private session: ShellSession | null = null;
  /**
   * Schema loaded for the `\d` meta-command. Populated either from an
   * explicit `--schema` file or by auto-discovering `dbschema/` in the
   * resolved project context. Stays null when no schema can be located,
   * in which case `\d` falls back to listing PostgreSQL tables.
   */
  private schema?: Schema;

  async run(options: ShellOptions = {}): Promise<void> {
    console.log("🎯 Disc Interactive Shell");
    console.log("");

    const host = options.host || "localhost";
    const port = options.port || 5656;
    // P2-13: default to the project's instance name (from disc.toml) if
    // available; the prior default "disc" was an artifact of the old
    // hardcoded superuser db and mis-labeled what we actually connect to.
    const ctx = resolveProjectContext();
    const database = options.database ||
      ctx?.instanceName ||
      "disc";

    try {
      this.session = {
        host,
        port,
        database,
        user: Deno.env.get("USER") || "disc",
        connected: false,
        timingEnabled: false
      };

      // Connect to database
      await this.connectToDatabase(host, port, database);
      console.log(`📡 Connected to database: ${this.session.database}`);
      console.log("");

      if (options.schemaFile) {
        await this.loadSchema(options.schemaFile);
      } else {
        // Auto-discover the project's schema (./dbschema by default) so
        // `\d` can describe types without the user passing --schema.
        // Failure here is non-fatal: the REPL still works, `\d` just
        // falls back to listing PG tables.
        await this.autoLoadSchema();
      }

      if (options.execute) {
        // Execute single query and exit
        await this.executeSingleQuery(options.execute);
        console.log("");
        console.log("✅ Query executed, exiting...");
        return;
      }

      if (options.nonInteractive) {
        console.log(
          "💡 Use --execute to run a query, or omit --non-interactive for REPL mode"
        );
        return;
      }

      // Start interactive mode
      await this.startInteractiveMode();
    } catch (error) {
      console.error("❌ Failed to start shell:", (error as Error).message);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  private async connectToDatabase(
    host: string,
    port: number,
    database: string
  ): Promise<void> {
    // Try project context first (auto-discovery via disc.toml)
    const ctx = resolveProjectContext();

    if (ctx?.managed) {
      const { dsn } = await ensurePgRunning(ctx);
      this.db = new DatabaseConnection(dsn);
      await this.db.connect();
      if (this.session) {
        this.session.connected = true;
      }
      return;
    }

    if (ctx?.backendDsn) {
      this.db = new DatabaseConnection(ctx.backendDsn);
      await this.db.connect();
      if (this.session) {
        this.session.connected = true;
      }
      return;
    }

    // Fallback: direct TCP connection with provided parameters
    this.db = new DatabaseConnection({
      host,
      port,
      database,
      user: Deno.env.get("DB_USER") || "disc",
      password: Deno.env.get("DB_PASSWORD") || ""
    });
    await this.db.connect();
    if (this.session) {
      this.session.connected = true;
    }
  }

  private async loadSchema(schemaFile: string): Promise<void> {
    console.log(`📖 Loading schema from ${schemaFile}`);

    try {
      const exists = await Deno.stat(schemaFile).then(() => true).catch(() => false);
      if (!exists) {
        console.log(`⚠️  Schema file not found: ${schemaFile}`);
        return;
      }

      const schemaContent = await Deno.readTextFile(schemaFile);
      const manager = new SchemaManager({});
      const parseResult = manager.parseSDL(schemaContent);
      if (!parseResult.ok) {
        console.log(`⚠️  Schema parse failed: ${parseResult.error.message}`);
        return;
      }
      this.schema = manager.modulesToSchema(parseResult.value);
      const typeCount = this.schema.types.size;
      console.log(`✅ Schema loaded: ${typeCount} type${typeCount === 1 ? "" : "s"} available`);
      console.log("");
    } catch (error) {
      console.error(`❌ Failed to load schema: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Best-effort discovery of the project's schema directory so `\d`
   * can describe types out of the box. Walks `./dbschema` (or the
   * project root's dbschema) for `.disc`/`.gel`/`.esdl` files. Silent
   * on every failure path — `\d` just won't have schema data, which
   * is the same as the pre-discovery behaviour.
   */
  private async autoLoadSchema(): Promise<void> {
    try {
      const ctx = resolveProjectContext();
      const dir = ctx ? `${ctx.projectRoot}/dbschema` : "./dbschema";
      const files = await discoverSchemaFiles(dir);
      if (files.length === 0)
        return;
      this.schema = await loadMultiFileSchema(files);
    } catch {
      // Non-fatal — `\d` falls back to listTables() when schema is missing.
    }
  }

  private async startInteractiveMode(): Promise<void> {
    // Show welcome and help
    console.log("🌟 Welcome to Disc Interactive Shell");
    console.log("📖 Type \\? for help, \\q to quit");
    console.log("");

    this.showHelp();
    console.log("");

    // Show initial prompt
    await Deno.stdout.write(new TextEncoder().encode("disc> "));

    // Start REPL loop - using modern Deno streams
    const reader = Deno
      .stdin
      .readable
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());

    for await (const line of reader) {
      try {
        const result = await this.processInput(line);
        if (result === "quit") {
          console.log("👋 Goodbye!");
          break;
        }
      } catch (error) {
        console.error(`❌ Error: ${(error as Error).message}`);
        await Deno.stdout.write(new TextEncoder().encode("\ndisc> "));
      }
    }
  }

  private async processInput(input: string): Promise<string> {
    const trimmed = input.trim();

    // Handle shell commands
    if (trimmed.startsWith("\\")) {
      return await this.processShellCommand(trimmed);
    }

    // Handle empty input
    if (!trimmed && !this.isMultiline) {
      await Deno.stdout.write(new TextEncoder().encode("disc> "));
      return "continue";
    }

    // Handle multiline input
    if (this.isMultiline || !trimmed.endsWith(";")) {
      this.multilineBuffer += (this.multilineBuffer ? "\n" : "") + input;

      if (trimmed.endsWith(";")) {
        // Execute complete query
        const query = this.multilineBuffer;
        this.multilineBuffer = "";
        this.isMultiline = false;

        await this.executeRealQuery(query);
        this.commandHistory.push(query);
      } else {
        // Continue multiline
        this.isMultiline = true;
        await Deno.stdout.write(new TextEncoder().encode("... "));
        return "continue";
      }
    } else {
      // Single line query
      await this.executeRealQuery(trimmed);
      this.commandHistory.push(trimmed);
    }

    // Show prompt
    await Deno.stdout.write(new TextEncoder().encode("\ndisc> "));
    return "continue";
  }

  private async processShellCommand(command: string): Promise<string> {
    const parts = command.split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case "\\q":
      case "\\quit":
        return "quit";

      case "\\?":
      case "\\help":
        this.showHelp();
        break;

      case "\\d":
        // psql convention: `\d` lists every type, `\d <Type>` describes
        // a single type with its full schema metadata. Falls back to a
        // PG-table listing when no schema is loaded so the REPL still
        // gives the user something useful in a fresh database.
        if (parts[1]) {
          this.describeTypeByName(parts[1]);
        } else {
          await this.listTypes();
        }
        break;

      case "\\dt":
        await this.listTables(true);
        break;

      case "\\timing":
        if (this.session) {
          this.session.timingEnabled = !this.session.timingEnabled;
          console.log(
            `⏱️  Timing ${this.session.timingEnabled ? "enabled" : "disabled"}`
          );
        }
        break;

      case "\\history":
        this.showHistory();
        break;

      case "\\clear":
        console.clear();
        break;

      case "\\c":
        if (parts[1]) {
          await this.changeDatabase(parts[1]);
        } else {
          console.log("Usage: \\c <database>");
        }
        break;

      case "\\i":
        if (parts[1]) {
          await this.executeFile(parts[1]);
        } else {
          console.log("Usage: \\i <file>");
        }
        break;

      default:
        console.log(`Unknown command: ${cmd}`);
    }

    await Deno.stdout.write(new TextEncoder().encode("\ndisc> "));
    return "continue";
  }

  private async executeRealQuery(query: string): Promise<void> {
    if (!this.db) {
      console.error("❌ Not connected to database");
      return;
    }

    const startTime = Date.now();

    try {
      const result = await this.db.query(query);

      // Display results
      if (result.rows.length > 0) {
        console.table(result.rows);
        console.log(
          `(${result.rows.length} row${result.rows.length === 1 ? "" : "s"})`
        );
      } else {
        console.log("✅ Query executed successfully");
      }

      if (this.session?.timingEnabled) {
        const duration = Date.now() - startTime;
        console.log(`⏱️  Time: ${duration}ms`);
      }
    } catch (error) {
      console.error(`❌ Query failed: ${(error as Error).message}`);
    }
  }

  private async executeSingleQuery(query: string): Promise<void> {
    console.log("📊 Executing query...");
    console.log("");

    const startTime = Date.now();
    await this.executeRealQuery(query);

    if (this.session?.timingEnabled) {
      const duration = Date.now() - startTime;
      console.log(`⏱️  Total time: ${duration}ms`);
    }
  }

  /**
   * `\d` (no args): show every Disc type known to the loaded schema.
   * Falls back to listing PostgreSQL tables when no schema is available.
   */
  private async listTypes(): Promise<void> {
    if (this.schema && this.schema.types.size > 0) {
      console.log(describeAllTypes(this.schema));
      return;
    }
    // No schema in scope — show PG tables so the user still gets something.
    await this.listTables();
  }

  /**
   * `\d <Type>`: render a verbose description of a single type. Reports
   * a clear error when the type can't be found.
   */
  private describeTypeByName(name: string): void {
    if (!this.schema || this.schema.types.size === 0) {
      console.log(
        "⚠️  No schema loaded. Pass --schema <file> or run from a project " +
          "with a dbschema/ directory."
      );
      return;
    }
    const out = describeType(this.schema, name);
    if (!out) {
      console.log(`Type not found: ${name}`);
      return;
    }
    console.log(out);
  }

  private async listTables(detailed = false): Promise<void> {
    if (!this.db) {
      console.error("❌ Not connected to database");
      return;
    }

    const query = detailed ?
      `SELECT
           tablename as name,
           pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
           obj_description((schemaname||'.'||tablename)::regclass) as description
         FROM pg_tables
         WHERE schemaname = 'public'
         ORDER BY tablename` :
      `SELECT tablename as name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;

    try {
      const result = await this.db.query(query);

      if (result.rows.length > 0) {
        console.table(result.rows);
      } else {
        console.log("No tables found");
      }
    } catch (error) {
      console.error(`❌ Failed to list tables: ${(error as Error).message}`);
    }
  }

  private async changeDatabase(database: string): Promise<void> {
    console.log(`Connecting to database: ${database}...`);

    // Close current connection
    if (this.db) {
      await this.db.close();
    }

    // Connect to new database
    try {
      await this.connectToDatabase(
        this.session?.host || "localhost",
        this.session?.port || 5656,
        database
      );

      if (this.session) {
        this.session.database = database;
      }

      console.log(`✅ Connected to ${database}`);
    } catch (error) {
      console.error(`❌ Failed to connect: ${(error as Error).message}`);
    }
  }

  private async executeFile(filename: string): Promise<void> {
    try {
      const content = await Deno.readTextFile(filename);
      const queries = content.split(";").filter(q => q.trim());

      console.log(`Executing ${queries.length} queries from ${filename}...`);

      for (const query of queries) {
        if (query.trim()) {
          await this.executeRealQuery(query.trim() + ";");
        }
      }
    } catch (error) {
      console.error(`❌ Failed to execute file: ${(error as Error).message}`);
    }
  }

  private showHistory(): void {
    if (this.commandHistory.length === 0) {
      console.log("No command history");
      return;
    }

    console.log("Command history:");
    this.commandHistory.forEach((cmd, i) => {
      console.log(`  ${i + 1}: ${cmd}`);
    });
  }

  private showHelp(): void {
    console.log("Available commands:");
    console.log("  \\?          Show help");
    console.log("  \\q          Quit shell");
    console.log("  \\d          List all schema types");
    console.log("  \\d <Type>   Describe one type in full detail");
    console.log("  \\dt         List tables (detailed)");
    console.log("  \\c <db>     Connect to database");
    console.log("  \\i <file>   Execute file");
    console.log("  \\timing     Toggle query timing");
    console.log("  \\history    Show command history");
    console.log("  \\clear      Clear screen");
  }

  private async cleanup(): Promise<void> {
    // P2-14: print a newline BEFORE close so any log lines that follow
    // (pool shutdown, connection closed) don't collide with the last
    // `disc>` prompt. Previously: "disc> {\"ts\":...Database closed\"}".
    await Deno.stdout.write(new TextEncoder().encode("\n"));
    if (this.db) {
      await this.db.close();
    }
  }
}

/**
 * Shell command instance with execute method for CLI integration
 */
export const shellCommand = {
  async execute(options: ShellOptions): Promise<void> {
    const shell = new DiscShell();
    await shell.run(options);
  }
};

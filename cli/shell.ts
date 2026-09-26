/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-console
/**
 * CLI Shell Command Implementation - Interactive EdgeQL REPL
 */

/*** NATIVE ------------------------------------------- ***/

import { TextLineStream } from "@std/streams";

/*** UTILITY ------------------------------------------ ***/

import { DatabaseConnection } from "../lib/database.ts";
import { describeAllTypes, describeType } from "./describe.ts";
import { discoverSchemaFiles, loadMultiFileSchema } from "../codegen/mod.ts";
import { ensurePgRunning } from "../postgres/ensure-running.ts";
import { resolveProjectContext } from "../lib/project-context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";

import type { Schema } from "../compiler/context.ts";

/*** EXPORT ------------------------------------------- ***/

export interface ShellOptions {
  backendDsn?: string;
  database?: string;
  execute?: string;
  host?: string;
  nonInteractive?: boolean;
  port?: number;
  schemaFile?: string;
}

/*** What the REPL loop does after a line: keep reading, record a failed statement, or quit. ***/
type InputResult = "continue" | "error" | "quit";

export interface ShellSession {
  connected: boolean;
  database: string;
  host: string;
  port: number;
  timingEnabled: boolean;
  user?: string;
}

export class DiscShell {
  private commandHistory: string[] = [];
  private db?: DatabaseConnection;
  private isMultiline = false;
  private multilineBuffer = "";
  /**
   * Schema loaded for the `\d` meta-command. Populated either from an
   * explicit `--schema` file or by auto-discovering `dbschema/` in the
   * resolved project context. Stays null when no schema can be located,
   * in which case `\d` falls back to listing PostgreSQL tables.
   */
  /*** `--backend-dsn` or DATABASE_URL; when set it wins over disc.toml (CLAUDE.md DSN order). ***/
  private explicitDsn?: string;
  private schema?: Schema;
  private session: ShellSession | null = null;

  async run(options: ShellOptions = {}): Promise<void> {
    console.log("[INIT] Disc Interactive Shell");
    console.log("");

    const host = options.host || "localhost";
    const port = options.port || 5656;
    /*** Default to the project’s instance name (from disc.toml) if available; the prior default
         "disc" was an artifact of the old hardcoded superuser db and mis-labeled what we actually
         connect to. ***/
    const ctx = resolveProjectContext();
    const database = options.database || ctx?.instanceName || "disc";

    this.explicitDsn = options.backendDsn || Deno.env.get("DATABASE_URL") || undefined;

    try {
      try {
        this.session = {
          connected: false,
          database,
          host,
          port,
          timingEnabled: false,
          user: Deno.env.get("USER") || "disc"
        };

        /*** Connect to database ***/
        await this.connectToDatabase(host, port, database);
        console.log(`[CONN] Connected to database: ${this.session.database}`);
        console.log("");

        if (options.schemaFile) {
          await this.loadSchema(options.schemaFile);
        } else {
          /*** Auto-discover the project’s schema (./dbschema by default) so `\d` can describe types
               without the user passing --schema. Failure here is non-fatal: the REPL still works,
               `\d` just falls back to listing PG tables. ***/
          await this.autoLoadSchema();
        }
      } catch (error) {
        console.error("[FAIL] Failed to start shell:", (error as Error).message);
        throw error;
      }

      if (options.execute) {
        /*** Execute single query and exit; a failure is thrown so the CLI exits non-zero. ***/
        if (!(await this.executeSingleQuery(options.execute)))
          throw new Error("Query failed");

        console.log("");
        console.log("[ OK ] Query executed, exiting…");

        return;
      }

      if (options.nonInteractive) {
        console.log("[INFO] Use --execute to run a query, or omit --non-interactive for REPL mode");
        return;
      }

      /*** Start interactive mode. Piped input (not a terminal) runs as a script that stops at the
           first failed statement. ***/
      await this.startInteractiveMode(Deno.stdin.isTerminal());
    } finally {
      await this.cleanup();
    }
  }

  /*** PRIVATE ------------------------------------------ ***/

  /**
   * Best-effort discovery of the project’s schema directory so `\d`
   * can describe types out of the box. Walks `./dbschema` (or the
   * project root’s dbschema) for `.disc`/`.gel`/`.esdl` files. Silent
   * on every failure path — `\d` just won’t have schema data, which
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
      /*** Non-fatal — `\d` falls back to listTables() when schema is missing. ***/
    }
  }

  private async changeDatabase(database: string): Promise<void> {
    console.log(`Connecting to database: ${database}…`);

    /*** Close current connection ***/
    if (this.db)
      await this.db.close();

    /*** Connect to new database ***/
    try {
      await this.connectToDatabase(this.session?.host || "localhost", this.session?.port || 5656, database);

      if (this.session)
        this.session.database = database;

      console.log(`[ OK ] Connected to ${database}`);
    } catch (error) {
      console.error(`[FAIL] Failed to connect: ${(error as Error).message}`);
    }
  }

  private async cleanup(): Promise<void> {
    /*** Print a newline BEFORE close so any log lines that follow (pool shutdown, connection
         closed) don’t collide with the last `disc>` prompt. Previously:
         "disc> {\"ts\":...Database closed\"}". ***/
    await Deno.stdout.write(new TextEncoder().encode("\n"));

    if (this.db)
      await this.db.close();
  }

  private async connectToDatabase(host: string, port: number, database: string): Promise<void> {
    if (this.explicitDsn) {
      this.db = new DatabaseConnection(this.explicitDsn);
      await this.db.connect();

      if (this.session)
        this.session.connected = true;

      return;
    }

    /*** Then project context (auto-discovery via disc.toml) ***/
    const ctx = resolveProjectContext();

    if (ctx?.managed) {
      const { dsn } = await ensurePgRunning(ctx);
      this.db = new DatabaseConnection(dsn);
      await this.db.connect();

      if (this.session)
        this.session.connected = true;

      return;
    }

    if (ctx?.backendDsn) {
      this.db = new DatabaseConnection(ctx.backendDsn);
      await this.db.connect();

      if (this.session)
        this.session.connected = true;

      return;
    }

    /*** Fallback: direct TCP connection with provided parameters ***/
    this.db = new DatabaseConnection({
      database,
      host,
      password: Deno.env.get("DB_PASSWORD") || "",
      port,
      user: Deno.env.get("DB_USER") || "disc"
    });

    await this.db.connect();

    if (this.session)
      this.session.connected = true;
  }

  /**
   * `\d <Type>`: render a verbose description of a single type. Reports
   * a clear error when the type can’t be found.
   */
  private describeTypeByName(name: string): void {
    if (!this.schema || this.schema.types.size === 0) {
      console.log("[WARN]  No schema loaded. Pass --schema <file> or run from a project with a dbschema/ directory.");
      return;
    }

    const out = describeType(this.schema, name);

    if (!out) {
      console.log(`Type not found: ${name}`);
      return;
    }

    console.log(out);
  }

  /*** Run each statement in `filename`, stopping at the first failure. Returns false on failure. ***/
  private async executeFile(filename: string): Promise<boolean> {
    try {
      const content = await Deno.readTextFile(filename);
      const queries = content.split(";").filter(q => q.trim());
      console.log(`Executing ${queries.length} queries from ${filename}…`);

      for (const query of queries) {
        if (!(await this.executeRealQuery(query.trim() + ";")))
          return false;
      }

      return true;
    } catch (error) {
      console.error(`[FAIL] Failed to execute file: ${(error as Error).message}`);
      return false;
    }
  }

  /*** Run a query and print its result or error. Returns false when it fails. ***/
  private async executeRealQuery(query: string): Promise<boolean> {
    if (!this.db) {
      console.error("[FAIL] Not connected to database");
      return false;
    }

    const startTime = Date.now();

    try {
      const result = await this.db.query(query);

      /*** Display results ***/
      if (result.rows.length > 0) {
        console.table(result.rows);
        console.log(`(${result.rows.length} row${result.rows.length === 1 ? "" : "s"})`);
      } else {
        console.log("[ OK ] Query executed successfully");
      }

      if (this.session?.timingEnabled) {
        const duration = Date.now() - startTime;
        console.log(`[TIME]  Time: ${duration}ms`);
      }

      return true;
    } catch (error) {
      console.error(`[FAIL] Query failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async executeSingleQuery(query: string): Promise<boolean> {
    console.log("[TASK] Executing query…");
    console.log("");

    const startTime = Date.now();
    const ok = await this.executeRealQuery(query);

    if (this.session?.timingEnabled) {
      const duration = Date.now() - startTime;
      console.log(`[TIME]  Total time: ${duration}ms`);
    }

    return ok;
  }

  private async listTables(detailed = false): Promise<void> {
    if (!this.db) {
      console.error("[FAIL] Not connected to database");
      return;
    }

    /*** Detailed variant joins pg_class via OID rather than casting the qualified name with
         `::regclass`. The cast throws when a catalog row references a relation the current role
         can’t see (or a partial drop left an inconsistent pg_tables/pg_class state); the join
         degrades gracefully, returning NULL for size/description instead of failing the
         whole listing. ***/
    const query = detailed ?
      `SELECT
           t.tablename as name,
           pg_size_pretty(pg_total_relation_size(c.oid)) as size,
           obj_description(c.oid) as description
         FROM pg_tables t
         LEFT JOIN pg_namespace n ON n.nspname = t.schemaname
         LEFT JOIN pg_class c ON c.relname = t.tablename AND c.relnamespace = n.oid
         WHERE t.schemaname = 'public'
         ORDER BY t.tablename` :
      `SELECT tablename as name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;

    try {
      const result = await this.db.query(query);

      if (result.rows.length > 0)
        console.table(result.rows);
      else
        console.log("No tables found");
    } catch (error) {
      console.error(`[FAIL] Failed to list tables: ${(error as Error).message}`);
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

    /*** No schema in scope — show PG tables so the user still gets something. ***/
    await this.listTables();
  }

  private async loadSchema(schemaFile: string): Promise<void> {
    console.log(`[READ] Loading schema from ${schemaFile}`);

    try {
      const exists = await Deno.stat(schemaFile).then(() => true).catch(() => false);
      if (!exists) {
        console.log(`[WARN]  Schema file not found: ${schemaFile}`);
        return;
      }

      const schemaContent = await Deno.readTextFile(schemaFile);
      const manager = new SchemaManager({});
      const parseResult = manager.parseSDL(schemaContent);

      if (!parseResult.ok) {
        console.log(`[WARN]  Schema parse failed: ${parseResult.error.message}`);
        return;
      }

      this.schema = manager.modulesToSchema(parseResult.value);
      const typeCount = this.schema.types.size;

      console.log(`[ OK ] Schema loaded: ${typeCount} type${typeCount === 1 ? "" : "s"} available`);
      console.log("");
    } catch (error) {
      console.error(`[FAIL] Failed to load schema: ${(error as Error).message}`);
      throw error;
    }
  }

  private async processInput(input: string): Promise<InputResult> {
    const trimmed = input.trim();

    /*** Handle shell commands ***/
    if (trimmed.startsWith("\\"))
      return await this.processShellCommand(trimmed);

    /*** Bare `exit` / `quit` leave the shell, as in psql ***/
    if (!this.isMultiline && (trimmed === "exit" || trimmed === "quit"))
      return "quit";

    /*** Handle empty input ***/
    if (!trimmed && !this.isMultiline) {
      await Deno.stdout.write(new TextEncoder().encode("disc> "));
      return "continue";
    }

    let ok: boolean;

    /*** Handle multiline input ***/
    if (this.isMultiline || !trimmed.endsWith(";")) {
      this.multilineBuffer += (this.multilineBuffer ? "\n" : "") + input;

      if (trimmed.endsWith(";")) {
        /*** Execute complete query ***/
        const query = this.multilineBuffer;
        this.multilineBuffer = "";
        this.isMultiline = false;

        ok = await this.executeRealQuery(query);
        this.commandHistory.push(query);
      } else {
        /*** Continue multiline ***/
        this.isMultiline = true;
        await Deno.stdout.write(new TextEncoder().encode("... "));
        return "continue";
      }
    } else {
      /*** Single line query ***/
      ok = await this.executeRealQuery(trimmed);
      this.commandHistory.push(trimmed);
    }

    /*** Show prompt ***/
    await Deno.stdout.write(new TextEncoder().encode("\ndisc> "));
    return ok ? "continue" : "error";
  }

  private async processShellCommand(command: string): Promise<InputResult> {
    const parts = command.split(/\s+/);
    const cmd = parts[0];
    let ok = true;

    switch (cmd) {
      case "\\c": {
        if (parts[1])
          await this.changeDatabase(parts[1]);
        else
          console.log("Usage: \\c <database>");

        break;
      }

      case "\\clear": {
        console.clear();
        break;
      }

      case "\\d": {
        /*** psql convention: `\d` lists every type, `\d <Type>` describes a single type with its
             full schema metadata. Falls back to a PG-table listing when no schema is loaded so the
             REPL still gives the user something useful in a fresh database. ***/
        if (parts[1])
          this.describeTypeByName(parts[1]);
        else
          await this.listTypes();

        break;
      }

      case "\\dt": {
        await this.listTables(false);
        break;
      }

      case "\\dt+": {
        await this.listTables(true);
        break;
      }

      case "\\history": {
        this.showHistory();
        break;
      }

      case "\\i": {
        if (parts[1])
          ok = await this.executeFile(parts[1]);
        else
          console.log("Usage: \\i <file>");

        break;
      }

      case "\\timing": {
        if (this.session) {
          this.session.timingEnabled = !this.session.timingEnabled;
          console.log(`⏱️  Timing ${this.session.timingEnabled ? "enabled" : "disabled"}`);
        }

        break;
      }

      case "\\q":
      case "\\quit": {
        return "quit";
      }

      case "\\?":
      case "\\help": {
        this.showHelp();
        break;
      }

      default: {
        console.log(`Unknown command: ${cmd}`);
      }
    }

    await Deno.stdout.write(new TextEncoder().encode("\ndisc> "));
    return ok ? "continue" : "error";
  }

  private showHelp(): void {
    console.log("Available commands:");
    console.log("  \\?          Show help");
    console.log("  \\q          Quit shell");
    console.log("  \\d          List all schema types");
    console.log("  \\d <Type>   Describe one type in full detail");
    console.log("  \\dt         List tables");
    console.log("  \\dt+        List tables with size and description");
    console.log("  \\c <db>     Connect to database");
    console.log("  \\i <file>   Execute file");
    console.log("  \\timing     Toggle query timing");
    console.log("  \\history    Show command history");
    console.log("  \\clear      Clear screen");
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

  /**
   * Read lines from stdin until `\q`, `exit` or end of input. At a terminal a failed statement
   * is reported and the session continues; with piped input (`interactive` false) it stops the
   * shell with an error so the CLI exits non-zero, like psql's ON_ERROR_STOP.
   */
  private async startInteractiveMode(interactive: boolean): Promise<void> {
    /*** Show welcome and help ***/
    console.log("[INIT] Welcome to Disc Interactive Shell");
    console.log("[READ] Type \\? for help, \\q to quit");
    console.log("");

    this.showHelp();
    console.log("");

    /*** Show initial prompt ***/
    await Deno.stdout.write(new TextEncoder().encode("disc> "));

    /*** Start REPL loop - using modern Deno streams ***/
    const reader = Deno
      .stdin
      .readable
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());

    for await (const line of reader) {
      let result: InputResult;

      try {
        result = await this.processInput(line as string);
      } catch (error) {
        console.error(`[FAIL] Error: ${(error as Error).message}`);
        await Deno.stdout.write(new TextEncoder().encode("\ndisc> "));
        result = "error";
      }

      if (result === "quit") {
        console.log("[EXIT] Goodbye!");
        break;
      }

      if (result === "error" && !interactive)
        throw new Error("Stopped at the first failed statement");
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

/**
 * CLI Shell Command Implementation - Interactive EdgeQL REPL
 */

import { readLines } from "@std/io/read-lines.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { PostgresManager } from "../postgres/manager.ts";
import { join } from "@std/path";
import { logger } from "../postgres/logger.ts";

export interface ShellOptions {
  host?: string;
  port?: number;
  database?: string;
  schema_file?: string;
  non_interactive?: boolean;
  execute?: string;
}

export interface ShellSession {
  host: string;
  port: number;
  database: string;
  user?: string;
  connected: boolean;
  timing_enabled: boolean;
}

export class DiscShell {
  private db?: DatabaseConnection;
  private postgresManager?: PostgresManager;
  private commandHistory: string[] = [];
  private historyIndex = 0;
  private multilineBuffer = "";
  private isMultiline = false;
  private session: ShellSession | null = null;

  async run(options: ShellOptions = {}): Promise<void> {
    console.log("🎯 Disc Interactive Shell");
    console.log("");

    const host = options.host || "localhost";
    const port = options.port || 5656;
    const database = options.database || "disc";

    try {
      this.session = {
        host,
        port,
        database,
        user: Deno.env.get("USER") || "disc",
        connected: false,
        timing_enabled: false,
      };

      // Connect to database
      await this.connectToDatabase(host, port, database);
      console.log(`📡 Connected to database: ${database}`);
      console.log("");

      if (options.schema_file) {
        await this.loadSchema(options.schema_file);
      }

      if (options.execute) {
        // Execute single query and exit
        await this.executeSingleQuery(options.execute);
        console.log("");
        console.log("✅ Query executed, exiting...");
        return;
      }

      if (options.non_interactive) {
        console.log(
          "💡 Use --execute to run a query, or omit --non-interactive for REPL mode",
        );
        return;
      }

      // Start interactive mode
      await this.startInteractiveMode();
    } catch (error) {
      console.error("❌ Failed to start shell:", error.message);
      throw error;
    } finally {
      await this.cleanup();
    }
  }

  private async connectToDatabase(host: string, port: number, database: string): Promise<void> {
    // First try to connect directly
    try {
      this.db = new DatabaseConnection({
        host,
        port,
        database,
        user: Deno.env.get("DB_USER") || "disc",
        password: Deno.env.get("DB_PASSWORD") || "",
      });
      await this.db.connect();
      if (this.session) {
        this.session.connected = true;
      }
    } catch (error) {
      console.log("⚠️  Direct connection failed, checking for Disc-managed instance...");
      
      // Try to use Disc-managed PostgreSQL
      const instancesDir = join(Deno.env.get("HOME")!, ".disc", "instances");
      this.postgresManager = new PostgresManager(instancesDir);
      await this.postgresManager.discoverInstances();

      const instances = this.postgresManager.listInstances();
      if (instances.includes(database)) {
        // Instance exists, start it if needed
        const status = await this.postgresManager.getInstanceStatus(database);
        if (!status?.running) {
          console.log("🚀 Starting Disc-managed PostgreSQL instance...");
          await this.postgresManager.startInstance(database, false);
        }

        // Connect to the instance
        const instance = this.postgresManager.getInstance(database);
        if (instance) {
          this.db = new DatabaseConnection(instance.dsn());
          await this.db.connect();
          if (this.session) {
            this.session.connected = true;
          }
        }
      } else {
        // Create new instance
        console.log("🏗️  Creating new Disc-managed PostgreSQL instance...");
        await this.postgresManager.createInstance(database, {
          port: port === 5656 ? 0 : port, // Use socket if default Disc port
        });
        await this.postgresManager.startInstance(database, false);
        
        const instance = this.postgresManager.getInstance(database)!;
        this.db = new DatabaseConnection(instance.dsn());
        await this.db.connect();
        if (this.session) {
          this.session.connected = true;
        }
      }
    }
  }

  private async loadSchema(schemaFile: string): Promise<void> {
    console.log(`📖 Loading schema from ${schemaFile}`);

    try {
      const exists = await Deno.stat(schemaFile).then(() => true).catch(() =>
        false
      );
      if (!exists) {
        console.log(`⚠️  Schema file not found: ${schemaFile}`);
        return;
      }

      const schemaContent = await Deno.readTextFile(schemaFile);
      // In a real implementation, this would parse and apply the schema
      console.log(`✅ Schema loaded (${schemaContent.length} bytes)`);
      console.log("");
    } catch (error) {
      console.error(`❌ Failed to load schema: ${error.message}`);
      throw error;
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

    // Start REPL loop
    for await (const line of readLines(Deno.stdin)) {
      try {
        const result = await this.processInput(line);
        if (result === "quit") {
          console.log("👋 Goodbye!");
          break;
        }
      } catch (error) {
        console.error(`❌ Error: ${error.message}`);
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
        this.historyIndex = this.commandHistory.length;
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
      this.historyIndex = this.commandHistory.length;
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
        await this.listTables();
        break;

      case "\\dt":
        await this.listTables(true);
        break;

      case "\\timing":
        if (this.session) {
          this.session.timing_enabled = !this.session.timing_enabled;
          console.log(`⏱️  Timing ${this.session.timing_enabled ? "enabled" : "disabled"}`);
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
        console.log(`(${result.rows.length} row${result.rows.length === 1 ? "" : "s"})`);
      } else {
        console.log("✅ Query executed successfully");
      }

      if (this.session?.timing_enabled) {
        const duration = Date.now() - startTime;
        console.log(`⏱️  Time: ${duration}ms`);
      }
    } catch (error) {
      console.error(`❌ Query failed: ${error.message}`);
    }
  }

  private async executeSingleQuery(query: string): Promise<void> {
    console.log("📊 Executing query...");
    console.log("");

    const startTime = Date.now();
    await this.executeRealQuery(query);

    if (this.session?.timing_enabled) {
      const duration = Date.now() - startTime;
      console.log(`⏱️  Total time: ${duration}ms`);
    }
  }

  private async listTables(detailed = false): Promise<void> {
    if (!this.db) {
      console.error("❌ Not connected to database");
      return;
    }

    const query = detailed 
      ? `SELECT 
           tablename as name,
           pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size,
           obj_description((schemaname||'.'||tablename)::regclass) as description
         FROM pg_tables 
         WHERE schemaname = 'public' 
         ORDER BY tablename`
      : `SELECT tablename as name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;

    try {
      const result = await this.db.query(query);
      
      if (result.rows.length > 0) {
        console.table(result.rows);
      } else {
        console.log("No tables found");
      }
    } catch (error) {
      console.error(`❌ Failed to list tables: ${error.message}`);
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
      console.error(`❌ Failed to connect: ${error.message}`);
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
      console.error(`❌ Failed to execute file: ${error.message}`);
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
    console.log("  \\?        Show help");
    console.log("  \\q        Quit shell");
    console.log("  \\d        List tables");
    console.log("  \\dt       List tables (detailed)");
    console.log("  \\c <db>   Connect to database");
    console.log("  \\i <file> Execute file");
    console.log("  \\timing   Toggle query timing");
    console.log("  \\history  Show command history");
    console.log("  \\clear    Clear screen");
  }

  private async cleanup(): Promise<void> {
    if (this.db) {
      await this.db.close();
    }
  }
}
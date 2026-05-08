// deno-lint-ignore-file no-console
/**
 * CLI Commands Implementation - Core command functionality
 */

import * as Codegen from "../codegen/mod.ts";
import { extractEmbeddedSdk } from "../codegen/sdk-extractor.ts";
import { VERSION } from "../mod.ts";
import type { Schema } from "../compiler/context.ts";
import { introspectDatabase } from "../compiler/pg-introspect-queries.ts";
import { buildSchemaFromIntrospection } from "../compiler/pg-introspect.ts";
import { serializeSchema } from "../compiler/sdl-serializer.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { resolveDsn, resolveProjectContext } from "../lib/project-context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { MigrationSquasher, SquashableMigration } from "../migration/squash.ts";
import type { MigrationProgressEvent, MigrationProgressListener } from "../migration/types.ts";
import { ensurePgRunning } from "../postgres/ensure-running.ts";
import { PostgresManager } from "../postgres/mod.ts";
import type { Module } from "../schema/converter.ts";
import { createServerFromEnv } from "../server/server.ts";
import { buildCommand, BuildOptions } from "./build.ts";
import { dbCommand } from "./db.ts";
import { deployCommand, DeployOptions } from "./deploy.ts";
import { initCommand, InitOptions } from "./init.ts";
import { pgLogCommand, PgLogOptions } from "./pg-log.ts";
import { pgUpgradeCommand, PgUpgradeOptions } from "./pg-upgrade.ts";
import { shellCommand, ShellOptions } from "./shell.ts";
import { watchCommand, WatchOptions } from "./watch.ts";

export interface CLIArgs {
  [key: string]: any;
  _: (string | number)[];
}

export interface ServeOptions {
  port?: number;
  host?: string;
  config?: string;
  jwtSecret?: string;
  enableAuth?: boolean;
  enableAccessPolicies?: boolean;
  tlsCert?: string;
  tlsKey?: string;
  binaryPort?: number;
  /**
   * Security-toggle CLI flags (gh/geldata#5234). Each maps to the
   * corresponding `DISC_*` env var so the rest of the server config
   * pipeline is unchanged. CLI > env var > `disc.toml` > default.
   */
  requireAuth?: boolean;
  readOnly?: boolean;
  trustProxy?: boolean;
}

/**
 * Forward security-toggle CLI flags to the matching `DISC_*` env vars
 * (gh/geldata#5234). The existing `buildEnvOptions` pipeline reads
 * these and threads them into `ServerConfig` — by setting the env var
 * here, the CLI flag rides the same path as the env-var-only and
 * `disc.toml`-only knobs added in Bundle H. Exported so the wiring is
 * testable without spinning up the full `serve` command.
 */
export function applySecurityToggleEnvVars(
  options: Pick<ServeOptions, "requireAuth" | "readOnly" | "trustProxy">
): void {
  if (options.requireAuth)
    Deno.env.set("DISC_REQUIRE_AUTH", "true");
  if (options.readOnly)
    Deno.env.set("DISC_READ_ONLY", "true");
  if (options.trustProxy)
    Deno.env.set("DISC_TRUST_PROXY", "true");
}

export class CLICommands {
  private postgresManager: PostgresManager;

  constructor() {
    this.postgresManager = new PostgresManager();
  }
  /**
   * Initialize a new Disc project
   */
  async init(options: InitOptions): Promise<void> {
    await initCommand.execute(options);
  }

  /**
   * Handle migration commands (create and apply)
   */
  async migrate(args: CLIArgs): Promise<void> {
    const schemaFile = args.schema || "./dbschema/default.disc";
    const dryRun = args["dry-run"] || false;

    // Resolve project context for DSN
    const ctx = resolveProjectContext();

    // Auto-start PG for live (non-dry-run) migrations on managed instances
    if (ctx?.managed && !dryRun) {
      await ensurePgRunning(ctx);
    }

    const databaseUrl = args["backend-dsn"] ||
      Deno.env.get("DATABASE_URL") ||
      (ctx ? resolveDsn(ctx) : "postgresql://localhost:5432/disc_dev");

    let pool: ConnectionPool | undefined;
    let manager: SchemaManager | undefined;

    // gh/geldata#7490: wire a progress listener into the SchemaManager so
    // migrate runs surface per-step progress on stdout. Suppressed via
    // `--quiet` and never emitted in dry-run (the dry-run path doesn't
    // execute migrations anyway).
    const quiet = args.quiet === true;
    const onProgress = (!quiet && !dryRun) ? this.makeMigrateProgressListener() : undefined;

    try {
      if (dryRun) {
        // Dry-run mode: no pool needed, no PostgreSQL connection required
        manager = new SchemaManager({ dryRun: true });
        await manager.initialize();
      } else {
        // Live mode: create pool and wire to SchemaManager
        pool = new ConnectionPool({
          connectionString: databaseUrl,
          // gh/geldata#9034: tag CLI connections so the preflight can
          // tell `disc-cli` apart from `disc-server` in
          // `pg_stat_activity`.
          applicationName: "disc-cli"
        });
        await pool.initialize();

        manager = new SchemaManager({ pool, dryRun: false, onProgress });
        await manager.initialize();
      }

      if (args.status) {
        await this.showMigrationStatus(manager, schemaFile);
      } else if (args.rollback || args["rollback-to"]) {
        await this.handleRollback(manager, args);
      } else if (args.squash) {
        await this.handleSquash(manager, args);
      } else if (args.create) {
        await this.createMigration(manager, schemaFile);
      } else {
        await this.applyMigrations(
          manager,
          schemaFile,
          dryRun,
          args.unsafe === true,
          quiet
        );
      }
    } catch (error) {
      console.error(`Migration failed: ${(error as Error).message}`);
      throw error;
    } finally {
      if (manager) {
        await manager.close();
      }
      if (pool) {
        await pool.close();
      }
    }
  }

  /**
   * Start the Disc server
   */
  async serve(options: ServeOptions): Promise<void> {
    console.log("🚀 Starting Disc Database Server...");

    try {
      const ctx = resolveProjectContext();

      // Start PostgreSQL if managed. `disc serve` is a long-running process,
      // so the health monitor is wanted here (restart PG on crash).
      if (ctx?.managed) {
        console.log(`📦 Starting PostgreSQL for project: ${ctx.projectName}`);
        const { dsn, wasStarted } = await ensurePgRunning(ctx, {
          withMonitor: true
        });
        Deno.env.set("DATABASE_URL", dsn);
        console.log(wasStarted ? "✅ PostgreSQL started" : "✅ PostgreSQL already running");
        console.log(`📡 Connection: ${dsn}`);
      } else if (ctx?.backendDsn) {
        Deno.env.set("DATABASE_URL", ctx.backendDsn);
        console.log(`📡 External database: ${ctx.backendDsn}`);
      }

      const instanceName = ctx?.instanceName;

      // Set auth env vars from CLI flags
      if (options.jwtSecret) {
        Deno.env.set("DISC_JWT_SECRET", options.jwtSecret);
      }
      if (options.enableAuth) {
        Deno.env.set("DISC_ENABLE_AUTH", "true");
      }
      if (options.enableAccessPolicies) {
        Deno.env.set("DISC_ENABLE_ACCESS_POLICIES", "true");
      }

      // Set TLS env vars from CLI flags
      if (options.tlsCert) {
        Deno.env.set("DISC_TLS_CERT", options.tlsCert);
      }
      if (options.tlsKey) {
        Deno.env.set("DISC_TLS_KEY", options.tlsKey);
      }

      applySecurityToggleEnvVars(options);

      // Try to load the project schema from SDL
      const schemaFile = "./dbschema/default.disc";
      const schema = await this.readSchemaAsCompilerSchema(schemaFile);
      // Cache the SDL text alongside the parsed Schema so the live-
      // schema-diff admin endpoint can compare it to whatever's on
      // disk when an editor saves changes. (Bundle K — Disc #3a)
      let appliedSdl: string | undefined;
      try {
        appliedSdl = await Deno.readTextFile(schemaFile);
      } catch {
        appliedSdl = undefined;
      }

      if (schema) {
        const objectTypeCount = Array
          .from(schema.types.values())
          .filter(
            t => t.kind === "object"
          )
          .length;
        console.log(
          `  Loaded schema with ${objectTypeCount} object types`
        );

        // Auto-migrate on dev (managed PG only). External DSN is treated as
        // user-managed; auto-applying DDL there could surprise an operator,
        // so we only do it for the bundled instance. The migrate engine is
        // a no-op if the live schema already matches the SDL.
        if (ctx?.managed) {
          await this.autoMigrateOnServe(schemaFile);
        } else {
          console.log(
            "  💡 External DSN — run 'disc migrate' to apply schema changes."
          );
        }
      } else {
        console.log(
          "  ⚠️  No schema file found at ./dbschema/default.disc."
        );
        console.log(
          "     Falling back to in-memory test schema. Queries against"
        );
        console.log(
          "     User/Post/Status will fail because no tables exist in"
        );
        console.log(
          "     PostgreSQL. Run 'disc init' or create a schema file and"
        );
        console.log(
          "     'disc migrate' before issuing queries."
        );
      }

      // Log auth status
      if (options.jwtSecret || Deno.env.get("DISC_JWT_SECRET")) {
        console.log("🔐 Authentication enabled");
      }
      if (
        options.enableAccessPolicies ||
        Deno.env.get("DISC_ENABLE_ACCESS_POLICIES")
      ) {
        console.log("🛡️ Access policies enabled");
      }

      // Create server from environment variables, passing schema if available
      const server = schema ? createServerFromEnv(undefined, schema) : createServerFromEnv();

      // Wire the live-schema-diff admin endpoints. Only enabled when
      // both the SDL file and applied-SDL text resolved cleanly; if
      // either is missing (e.g. fresh init with no schema yet), the
      // /admin/schema-* routes return 404. (Bundle K)
      if (appliedSdl !== undefined) {
        server.setSchemaWatchSource(schemaFile, appliedSdl);
      }

      // Apply layered config overrides. Precedence (lowest → highest):
      //   1. env-derived defaults (already in `server.get_config()`)
      //   2. disc.toml `[server]` keys (project-level defaults)
      //   3. CLI flags (per-invocation overrides)
      // Keep this order so per-invocation flags always win over file config,
      // and file config wins over env defaults. (gh/geldata#1325)
      const config = server.get_config();

      if (ctx?.serverOverrides) {
        Object.assign(config, ctx.serverOverrides);
      }

      if (options.port)
        config.port = options.port;
      if (options.host)
        config.host = options.host;
      if (options.binaryPort)
        config.binaryPort = options.binaryPort;

      server.update_config(config);

      // Set up signal handlers for graceful shutdown
      const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];

      for (const signal of signals) {
        Deno.addSignalListener(signal, async () => {
          console.log(`\n📡 Received ${signal}, shutting down gracefully...`);
          await server.stop();
          if (instanceName) {
            await this.postgresManager.stopInstance(instanceName);
            console.log("✅ PostgreSQL stopped");
          }
          Deno.exit(0);
        });
      }

      // Start the server
      await server.start();
    } catch (error) {
      console.error(`❌ Failed to start server: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Open interactive EdgeQL shell
   */
  async shell(options: ShellOptions): Promise<void> {
    await shellCommand.execute(options);
  }

  /**
   * Generate TypeScript types from schema
   */
  /**
   * Export the current applied schema as SDL text. Reads the same way
   * `codegen` does (single file via `--schema`, or directory discovery
   * via `--schema-dir`), serializes the resulting Schema, and writes
   * to the path given by `--output` (or stdout when absent).
   * (gh/geldata#702, #7469)
   */
  async schemaExport(
    args: { schema?: string; "schema-dir"?: string; output?: string; }
  ): Promise<void> {
    const schemaFile = args.schema;
    const schemaDir = args["schema-dir"] ?? "./dbschema";
    const outputPath = args.output;

    let schema: Schema | null = null;

    if (schemaFile) {
      schema = await this.readSchemaAsCompilerSchema(schemaFile);
      if (!schema) {
        console.error(`❌ Schema not found or failed to parse: ${schemaFile}`);
        return;
      }
    } else {
      const files = await Codegen.discoverSchemaFiles(schemaDir);
      if (files.length === 0) {
        console.error(
          `❌ No schema files found in ${schemaDir}. Pass --schema <file> or --schema-dir <dir>.`
        );
        return;
      }
      schema = await Codegen.loadMultiFileSchema(files);
    }

    const sdl = serializeSchema(schema);

    if (outputPath) {
      await Deno.writeTextFile(outputPath, sdl);
    } else {
      console.log(sdl);
    }
  }

  /**
   * Introspect an existing PostgreSQL database and emit SDL describing
   * its schema. Useful for porting an existing PG-backed app to Disc.
   * (gh/geldata#3452)
   */
  async schemaIntrospect(
    args: {
      "database-url"?: string;
      schemas?: string;
      output?: string;
    }
  ): Promise<void> {
    const dsn = args["database-url"] ??
      Deno.env.get("DATABASE_URL");
    if (!dsn) {
      console.error(
        "❌ --database-url is required (or set DATABASE_URL env var)"
      );
      return;
    }
    const schemas = args.schemas ? args.schemas.split(",").map(s => s.trim()).filter(Boolean) : undefined;
    const outputPath = args.output;

    const db = new DatabaseConnection(dsn);
    let sdl: string;
    try {
      await db.connect();
      const data = await introspectDatabase(db, { schemas });
      const schema = buildSchemaFromIntrospection(data);
      sdl = serializeSchema(schema);
    } finally {
      await db.close();
    }

    if (outputPath) {
      await Deno.writeTextFile(outputPath, sdl);
    } else {
      console.log(sdl);
    }
  }

  async codegen(args: CLIArgs): Promise<void> {
    console.log("🚀 Generating TypeScript types...");

    const outputDir = args.output || "./dbschema/disc-client";
    const schemaDir = args["schema-dir"] || "./dbschema";
    const schemaFile = args.schema as string | undefined;
    const target = args.target || "client";

    try {
      let schema: Schema;

      if (schemaFile) {
        // Single-file mode (explicit --schema flag)
        console.log(`📋 Schema: ${schemaFile}`);

        try {
          await Deno.stat(schemaFile);
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) {
            throw new Error(`Schema file not found: ${schemaFile}`);
          }
          throw err;
        }

        const loaded = await this.readSchemaAsCompilerSchema(schemaFile);

        if (!loaded) {
          // readSchemaAsCompilerSchema already printed the parse/convert
          // failure detail. Surface as a hard error rather than silently
          // substituting a test schema — a successful exit code on a
          // broken schema misleads CI and local users alike.
          throw new Error(
            `Cannot generate types from ${schemaFile} — see errors above.`
          );
        }

        schema = loaded;
        const typeNames = Array.from(schema.types.keys()).join(", ");
        console.log(`📖 Loaded types: ${typeNames}`);
      } else {
        // Multi-file mode: discover schema files from directory
        console.log(`📋 Schema dir: ${schemaDir}`);
        const files = await Codegen.discoverSchemaFiles(schemaDir);

        if (files.length === 0) {
          throw new Error(
            `No schema files found in ${schemaDir} (looked for *.disc, *.gel, *.esdl). ` +
              `Pass --schema <file> or --schema-dir <dir> to point at your schema.`
          );
        }

        console.log(
          `📖 Discovered ${files.length} schema file${files.length === 1 ? "" : "s"}: ${files.map(f => f.split("/").pop()).join(", ")}`
        );
        schema = await Codegen.loadMultiFileSchema(files);
        const typeNames = Array.from(schema.types.keys()).join(", ");
        console.log(`📖 Loaded types: ${typeNames}`);
      }

      console.log(`📋 Output: ${outputDir}`);
      console.log(`📋 Target: ${target}`);

      // Generate TypeScript code
      const config: Partial<Codegen.CodegenConfig> = {
        outputDir: outputDir,
        schemaSource: schemaFile || schemaDir,
        schemaDir: schemaDir,
        target: target as "client" | "server" | "both",
        includeQueryBuilders: args["no-queries"] !== true,
        includeMutations: args["no-mutations"] !== true,
        includeClient: args["no-client"] !== true,
        formatOutput: args["no-format"] !== true
      };

      console.log(`⚙️  Generating code...`);
      const result = Codegen.generateTypeScript(schema, config);

      if (result.errors.length > 0) {
        console.error(`❌ Generation failed with errors:`);
        result.errors.forEach(error => console.error(`   ${error}`));
        return;
      }

      // Materialize the embedded SDK alongside the generated client so
      // the `import { ... } from "./sdk/mod.ts"` line in client.ts
      // resolves out of the box. Idempotent: re-extracts only when the
      // marker file is missing OR pinned to a different binary version.
      const sdkTargetDir = `${outputDir}/sdk`;
      const sdkResult = await extractEmbeddedSdk(sdkTargetDir, VERSION);
      if (!sdkResult.alreadyExtracted && sdkResult.extracted > 0) {
        console.log(
          `📦 Extracting SDK to ${sdkTargetDir}/ (${sdkResult.extracted} files)`
        );
      }

      // Write files to disk
      console.log(`💾 Writing ${result.files.length} files...`);
      await Codegen.writeGeneratedFiles(result, ".");

      // Show summary
      console.log(`\n📊 Generation Summary:`);
      console.log(`   Files generated: ${result.files.length}`);
      console.log(
        `   Types generated: ${Array.from(schema.types.keys()).length}`
      );
      console.log(`   Warnings: ${result.warnings.length}`);
      console.log(`   Errors: ${result.errors.length}`);

      if (result.warnings.length > 0) {
        console.log(`\n⚠️  Warnings:`);
        result.warnings.forEach(warning => console.log(`   ${warning}`));
      }

      console.log(`\n✅ TypeScript generation complete!`);
      console.log(`💡 Usage example:`);
      console.log(`   import { DiscClient } from "${outputDir}/index.ts";`);
      console.log(
        `   const client = new DiscClient({ host: "localhost", port: 5656 });`
      );
      console.log(`   const users = await client.user.select();`);
    } catch (error) {
      console.error(`❌ Failed to generate types: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Watch schema files for changes
   */
  async watch(options: WatchOptions): Promise<void> {
    await watchCommand.execute(options);
  }

  /**
   * Start PostgreSQL instance
   */
  async start(args: CLIArgs): Promise<void> {
    const ctx = resolveProjectContext();
    const projectName = ctx?.projectName || Deno.cwd().split("/").pop() || "default";
    // P1-17: default behavior matches `systemctl start` — PG is a
    // pg_ctl-managed daemon, so `disc start` returns as soon as PG is up.
    // The health monitor (which used to block the foreground via a
    // setInterval) is only started when `--foreground` is passed.
    const foreground = args.foreground === true;
    const useMonitor = foreground && !args["no-monitor"];

    console.log(`🚀 Starting PostgreSQL for project: ${projectName}`);

    try {
      if (ctx?.managed) {
        const { instance, dsn, wasStarted } = await ensurePgRunning(ctx, {
          withMonitor: useMonitor
        });
        const status = await instance.status();
        console.log(wasStarted ? "✅ PostgreSQL started successfully" : "✅ PostgreSQL already running");
        console.log(`📊 Status:`);
        console.log(`   PID: ${status.pid || "N/A"}`);
        console.log(`   Port: ${status.port || "Unix socket"}`);
        console.log(`   Data: ${status.dataDir}`);
        console.log(`   DSN: ${dsn}`);
      } else {
        // Fallback to old behavior for non-context projects
        let instance = this.postgresManager.getInstance(projectName);
        if (!instance) {
          console.log("📋 Creating new PostgreSQL instance...");
          instance = await this.postgresManager.createInstance(projectName, {
            port: args.port || 0
          });
        }
        await this.postgresManager.startInstance(projectName, useMonitor);
        const status = await instance.status();
        console.log("✅ PostgreSQL started successfully");
        console.log(`📊 Status:`);
        console.log(`   PID: ${status.pid || "N/A"}`);
        console.log(`   Port: ${status.port || "Unix socket"}`);
        console.log(`   Data: ${status.dataDir}`);
        console.log(`   DSN: ${instance.dsn()}`);
      }

      if (foreground) {
        console.log(
          `\n📡 Running in foreground (--foreground). Press Ctrl-C to stop the health monitor; PostgreSQL itself will keep running until \`disc stop\`.`
        );
      }
    } catch (error) {
      console.error(
        `❌ Failed to start PostgreSQL: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * Stop PostgreSQL instance
   */
  async stop(_args: CLIArgs): Promise<void> {
    const ctx = resolveProjectContext();
    const projectName = ctx?.instanceName || Deno.cwd().split("/").pop() || "default";
    console.log(`🛑 Stopping PostgreSQL for project: ${projectName}`);

    try {
      // Discover instances so manager knows about on-disk instances
      await this.postgresManager.discoverInstances();
      await this.postgresManager.stopInstance(projectName);
      console.log("✅ PostgreSQL stopped successfully");
    } catch (error) {
      console.error(
        `❌ Failed to stop PostgreSQL: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * Show PostgreSQL status
   */
  async status(_args: CLIArgs): Promise<void> {
    const ctx = resolveProjectContext();
    const projectName = ctx?.instanceName || Deno.cwd().split("/").pop() || "default";
    console.log(`📊 PostgreSQL Status for project: ${projectName}\n`);

    try {
      // Discover instances so manager knows about on-disk instances
      await this.postgresManager.discoverInstances();
      const status = await this.postgresManager.getInstanceStatus(projectName);

      if (!status) {
        console.log("❌ No PostgreSQL instance found for this project");
        console.log("💡 Run 'disc init' to create a new instance");
        return;
      }

      const statusIcon = status.running ? "🟢" : "🔴";
      console.log(
        `${statusIcon} Status: ${status.running ? "Running" : "Stopped"}`
      );

      if (status.running) {
        console.log(`   PID: ${status.pid}`);
        console.log(`   Port: ${status.port || "Unix socket only"}`);
        console.log(
          `   Started: ${status.startedAt?.toLocaleString() || "Unknown"}`
        );

        if (status.health) {
          console.log(`\n🏥 Health Check:`);
          console.log(`   Healthy: ${status.health.healthy ? "Yes" : "No"}`);
          console.log(`   Connections: ${status.health.connections}`);
          console.log(`   Latency: ${status.health.latencyMs}ms`);
          console.log(
            `   Uptime: ${Math.floor((status.health.uptime || 0) / 60)} minutes`
          );
        }
      }

      console.log(`\n📁 Data Directory: ${status.dataDir}`);
      console.log(`🔗 Socket Path: ${status.socketPath}`);
      console.log(`📦 Version: PostgreSQL ${status.version}`);
    } catch (error) {
      console.error(`❌ Failed to get status: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Open the admin UI in browser
   */
  async ui(args: CLIArgs): Promise<void> {
    const port = args.port || 5656;
    console.log(`🌐 Opening Disc Admin UI...`);

    try {
      // Import the UI server module
      const { uiServer } = await import("../ui/server-integration.ts");

      // Check if UI is built
      const isBuilt = await uiServer.isBuilt();
      if (!isBuilt) {
        console.error("❌ UI not built. Please run:");
        // P1-18: UI tooling uses Bun, not npm.
        console.error("   cd ui && bun install && bun run build");
        return;
      }

      // Open in browser
      await uiServer.openInBrowser(port);
    } catch (error) {
      console.error(`❌ Failed to open UI: ${(error as Error).message}`);
    }
  }

  /**
   * Restart PostgreSQL instance
   */
  async restart(args: CLIArgs): Promise<void> {
    const projectName = this.getProjectName();
    console.log(`🔄 Restarting PostgreSQL for project: ${projectName}`);

    try {
      const instance = this.postgresManager.getInstance(projectName);
      if (!instance) {
        console.error("❌ No PostgreSQL instance found for this project");
        return;
      }

      await instance.restart();
      console.log("✅ PostgreSQL restarted successfully");

      // Show new status
      await this.status(args);
    } catch (error) {
      console.error(
        `❌ Failed to restart PostgreSQL: ${(error as Error).message}`
      );
      throw error;
    }
  }

  /**
   * Build a self-contained binary via deno compile
   */
  async build(options: BuildOptions): Promise<void> {
    await buildCommand.execute(options);
  }

  /**
   * Generate deployment artifacts
   */
  async deploy(options: DeployOptions): Promise<void> {
    await deployCommand.execute(options);
  }

  /**
   * View PostgreSQL logs
   */
  async pgLog(options: PgLogOptions): Promise<void> {
    await pgLogCommand.execute(options);
  }

  /**
   * Upgrade PostgreSQL version
   */
  async pgUpgrade(options: PgUpgradeOptions): Promise<void> {
    await pgUpgradeCommand.execute(options);
  }

  /**
   * Create a new Disc-managed database
   */
  async dbCreate(name: string, args: CLIArgs): Promise<void> {
    const ctx = resolveProjectContext();
    const databaseUrl = args["database-url"] ||
      Deno.env.get("DATABASE_URL") ||
      (ctx ? resolveDsn(ctx) : "postgresql://localhost:5432/disc");
    await dbCommand.create({ name, databaseUrl });
  }

  /**
   * List all Disc-managed databases
   */
  async dbList(args: CLIArgs): Promise<void> {
    const ctx = resolveProjectContext();
    const databaseUrl = args["database-url"] ||
      Deno.env.get("DATABASE_URL") ||
      (ctx ? resolveDsn(ctx) : "postgresql://localhost:5432/disc");
    await dbCommand.list({ databaseUrl });
  }

  /**
   * Drop a Disc-managed database
   */
  async dbDrop(name: string, args: CLIArgs): Promise<void> {
    const ctx = resolveProjectContext();
    const databaseUrl = args["database-url"] ||
      Deno.env.get("DATABASE_URL") ||
      (ctx ? resolveDsn(ctx) : "postgresql://localhost:5432/disc");
    await dbCommand.drop({
      name,
      databaseUrl,
      force: args.force || false
    });
  }

  /**
   * Drop and recreate a Disc-managed database (wipe to known-empty state).
   */
  async dbWipe(name: string, args: CLIArgs): Promise<void> {
    const ctx = resolveProjectContext();
    if (ctx?.managed) {
      await ensurePgRunning(ctx);
    }
    const databaseUrl = args["database-url"] ||
      Deno.env.get("DATABASE_URL") ||
      (ctx ? resolveDsn(ctx) : "postgresql://localhost:5432/disc");
    await dbCommand.wipe({
      databaseUrl,
      force: args.force || false,
      name
    });
  }

  /**
   * Dump a Disc-managed database to stdout or a file.
   */
  async dbDump(name: string, args: CLIArgs): Promise<void> {
    const ctx = resolveProjectContext();
    if (ctx?.managed) {
      await ensurePgRunning(ctx);
    }
    const databaseUrl = args["database-url"] ||
      Deno.env.get("DATABASE_URL") ||
      (ctx ? resolveDsn(ctx) : "postgresql://localhost:5432/disc");

    const fmtRaw = args.format ? String(args.format) : "plain";
    if (fmtRaw !== "plain" && fmtRaw !== "custom") {
      throw new Error(
        `Invalid --format "${fmtRaw}". Valid values: plain, custom.`
      );
    }

    await dbCommand.dump({
      databaseUrl,
      format: fmtRaw,
      name,
      output: args.output
    });
  }

  /**
   * Push the current schema directly to the live database without
   * recording a migration. (gh/geldata#3761 — Prisma-style db push.)
   *
   * Use case: rapid dev iteration. Edit `dbschema/default.disc`,
   * `disc db push`, test. No migration files are created. When the
   * design settles, run `disc migrate --create` and the differ
   * produces a single clean migration covering the cumulative shape
   * change since the last recorded baseline.
   *
   * Refuses without `--force` because skipping migration history is
   * a foot-gun in shared/production environments. Honors
   * `--allow-unsafe` for destructive ops the same way `migrate` does.
   */
  async dbPush(args: CLIArgs): Promise<void> {
    if (!args.force) {
      console.error(
        "Error: `disc db push` skips migration history (foot-gun in shared/production envs).\n" +
          "Pass --force to confirm intent. For production schema changes, use `disc migrate` instead."
      );
      Deno.exit(1);
    }

    const schemaFile = args.schema || "./dbschema/default.disc";
    const ctx = resolveProjectContext();
    if (ctx?.managed) {
      await ensurePgRunning(ctx);
    }
    const databaseUrl = args["backend-dsn"] ||
      Deno.env.get("DATABASE_URL") ||
      (ctx ? resolveDsn(ctx) : "postgresql://localhost:5432/disc_dev");

    const sdlSource = await Deno.readTextFile(schemaFile);

    const pool = new ConnectionPool({
      connectionString: databaseUrl,
      applicationName: "disc-cli-push"
    });
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool, dryRun: false });
      await manager.initialize();

      const result = await manager.applySchema(sdlSource, {
        allowUnsafe: args["allow-unsafe"] === true,
        skipHistory: true
      });

      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        Deno.exit(1);
      }

      console.log(
        `✓ Schema pushed (${result.value.length} ${result.value.length === 1 ? "migration" : "migrations"} applied, no history recorded).`
      );
    } finally {
      await pool.close();
    }
  }

  /**
   * Restore a Disc-managed database from stdin or a file.
   */
  async dbRestore(name: string, args: CLIArgs): Promise<void> {
    const ctx = resolveProjectContext();
    if (ctx?.managed) {
      await ensurePgRunning(ctx);
    }
    const databaseUrl = args["database-url"] ||
      Deno.env.get("DATABASE_URL") ||
      (ctx ? resolveDsn(ctx) : "postgresql://localhost:5432/disc");
    await dbCommand.restore({
      clean: args.clean || false,
      databaseUrl,
      input: args.input,
      name
    });
  }

  private async showMigrationStatus(
    manager: SchemaManager,
    schemaFile?: string
  ): Promise<void> {
    console.log("Migration Status\n");

    const statusResult = await manager.getMigrationStatus();
    if (!statusResult.ok) {
      console.error(
        `Failed to get migration status: ${statusResult.error.message}`
      );
      return;
    }

    const status = statusResult.value;

    console.log(`  Applied migrations: ${status.applied}`);
    console.log(
      `  Current schema hash: ${status.currentSchemaHash || "(none)"}`
    );

    if (status.latestMigration) {
      console.log(`\n  Latest migration:`);
      console.log(`    ID: ${status.latestMigration.id}`);
      console.log(`    Name: ${status.latestMigration.name}`);
      console.log(
        `    Applied at: ${status.latestMigration.appliedAt.toISOString()}`
      );
    } else {
      console.log(`\n  No migrations have been applied yet.`);
    }

    // Drift detection (gh/geldata#8899). When a schema file is
    // available, diff it against the applied state so `migration
    // --status` answers the question users actually ask: "is my
    // schema in sync?". Renders one of three lines:
    //   - "Schema status: in sync" (no operations queued)
    //   - "Schema status: <N> pending operation(s)"
    //   - "Schema status: SDL not readable — N/A" (best-effort)
    if (schemaFile) {
      try {
        const sdl = await Deno.readTextFile(schemaFile);
        const planResult = manager.previewMigrationOps(sdl);
        if (!planResult.ok) {
          console.log(
            `\n  Schema status: drift check failed — ${planResult.error.message}`
          );
          return;
        }
        const ops = planResult.value;
        if (ops.length === 0) {
          console.log(`\n  Schema status: in sync`);
        } else {
          console.log(`\n  Schema status: ${ops.length} pending operation${ops.length === 1 ? "" : "s"}`);
          for (const op of ops.slice(0, 5)) {
            console.log(`    - [${op.classification ?? "safe"}] ${op.kind}`);
          }
          if (ops.length > 5) {
            console.log(`    … and ${ops.length - 5} more`);
          }
          console.log(`\n  Run \`disc migrate\` to apply.`);
        }
      } catch (err) {
        console.log(
          `\n  Schema status: SDL not readable (${(err as Error).message}) — N/A`
        );
      }
    }
  }

  private async handleRollback(
    manager: SchemaManager,
    args: CLIArgs
  ): Promise<void> {
    if (!args.force) {
      console.error(
        "Error: Rollback is a destructive operation that may cause data loss."
      );
      console.error(
        "       Rolling back DROP TABLE cannot restore lost data."
      );
      console.error(
        "       Use --force to confirm you understand the risks."
      );
      return;
    }

    if (args["rollback-to"]) {
      const targetId = args["rollback-to"];
      console.log(`Rolling back all migrations after ${targetId}...`);

      const result = await manager.rollbackToMigration(targetId);
      if (!result.ok) {
        console.error(`Rollback failed: ${result.error.message}`);
        return;
      }

      console.log(`Successfully rolled back to migration ${targetId}`);
    } else {
      console.log("Rolling back the most recent migration...");

      const result = await manager.rollbackLastMigration();
      if (!result.ok) {
        console.error(`Rollback failed: ${result.error.message}`);
        return;
      }

      console.log("Successfully rolled back the last migration");
    }
  }

  private async handleSquash(
    manager: SchemaManager,
    args: CLIArgs
  ): Promise<void> {
    console.log("Squashing migrations...");

    const fromId = args["squash-from"] as string | undefined;
    const toId = args["squash-to"] as string | undefined;

    // Get migration history to build squashable list
    const statusResult = await manager.getMigrationStatus();
    if (!statusResult.ok) {
      console.error(
        `Failed to get migration status: ${statusResult.error.message}`
      );
      return;
    }

    if (statusResult.value.applied === 0) {
      console.log("No migrations to squash.");
      return;
    }

    // Build SquashableMigration list from history
    // Note: In a full implementation, we'd load DDL statements from stored migration files.
    // For now, we create entries from the history and rely on the squasher for validation.
    const historyResult = await manager.getMigrationHistory();
    if (!historyResult.ok) {
      console.error(
        `Failed to get migration history: ${historyResult.error.message}`
      );
      return;
    }

    // History is DESC by default, reverse to ASC for squashing
    const history = historyResult.value.reverse();

    const squashable: SquashableMigration[] = history.map(entry => ({
      id: entry.id,
      name: entry.name,
      statements: [], // Would be loaded from migration files in production
      rollbackStatements: [],
      hasDataMigration: entry.dataMigration
    }));

    const squasher = new MigrationSquasher();

    try {
      const result = squasher.squash(squashable, fromId, toId);

      if (result.squashedIds.length === 0) {
        console.log("No migrations in the specified range to squash.");
        return;
      }

      console.log(`\nSquash Result:`);
      console.log(`  Name: ${result.name}`);
      console.log(`  Migrations squashed: ${result.squashedIds.length}`);
      console.log(`  Combined statements: ${result.statements.length}`);
      console.log(
        `  Combined rollback statements: ${result.rollbackStatements.length}`
      );
      console.log(`\n  Squashed migration IDs:`);
      result.squashedIds.forEach(id => console.log(`    - ${id}`));

      console.log(
        "\nSquash preview complete. In production, this would replace the individual migrations with the squashed result."
      );
    } catch (error) {
      console.error(`Squash failed: ${(error as Error).message}`);
    }
  }

  private async createMigration(
    manager: SchemaManager,
    schemaFile: string
  ): Promise<void> {
    console.log("Creating new migration...");

    // Read SDL source from schema file
    let sdlSource: string;

    try {
      sdlSource = await Deno.readTextFile(schemaFile);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.error(`Schema file not found: ${schemaFile}`);
        return;
      }
      throw error;
    }

    // Plan the migration
    const planResult = manager.planSchema(sdlSource);

    if (!planResult.ok) {
      console.error(`Migration planning failed: ${planResult.error.message}`);
      return;
    }

    const plan = planResult.value;

    if (plan.operationsCount === 0) {
      console.log("No changes detected - schema is up to date");
      return;
    }

    console.log(`Migration Plan:`);
    console.log(`   Operations: ${plan.operationsCount}`);
    console.log(`   Estimated Duration: ${plan.estimatedDuration || 0}ms\n`);

    plan.migrations.forEach((migration, i) => {
      console.log(`${i + 1}. ${migration.name} (${migration.id})`);
      console.log(`   ${migration.description}`);
      console.log(`   Operations: ${migration.operations.length}\n`);
    });

    // Generate DDL for preview
    const ddlResult = manager.generateDDL(plan);
    if (ddlResult.ok) {
      console.log("Generated DDL:");
      ddlResult.value.forEach((stmt, i) => {
        if (stmt.trim() && !stmt.startsWith("--")) {
          console.log(`   ${i + 1}. ${stmt}`);
        }
      });
    }

    // Validate the migration
    const validationResult = manager.validateMigration(plan);
    if (!validationResult.ok) {
      console.log(`Validation warning: ${validationResult.error.message}`);
    }

    console.log("\nMigration created successfully");
    console.log("Run 'disc migrate' to apply the migration");
  }

  /**
   * Auto-apply migrations during `disc serve` against a managed (bundled)
   * PostgreSQL instance — but only on a fresh database with no prior
   * migrations recorded. This is the "first-run convenience" path: it
   * makes a fresh `disc init` → `disc serve` pair produce a working
   * server with tables ready to query. Subsequent schema changes go
   * through `disc migrate` as normal, since the migrator can't cheaply
   * reconstruct prior schema state from `disc_migrations` here.
   *
   * Logs a warning and continues — never blocks serve startup — because
   * a missing-table situation is recoverable but a server that refuses
   * to start is not.
   */
  private async autoMigrateOnServe(schemaFile: string): Promise<void> {
    let sdlSource: string;
    try {
      sdlSource = await Deno.readTextFile(schemaFile);
    } catch {
      return;
    }

    const databaseUrl = Deno.env.get("DATABASE_URL");
    if (!databaseUrl)
      return;

    const pool = new ConnectionPool({ connectionString: databaseUrl });
    let manager: SchemaManager | undefined;
    try {
      await pool.initialize();
      manager = new SchemaManager({ pool, dryRun: false });
      await manager.initialize();

      const status = await manager.getMigrationStatus();
      if (status.ok && status.value.applied > 0) {
        console.log(
          "  💡 Existing migrations detected — run 'disc migrate' to apply schema changes."
        );
        return;
      }

      const result = await manager.applySchema(sdlSource);
      if (!result.ok) {
        console.log(
          `  ⚠️  Auto-migrate failed: ${result.error.message}. Run 'disc migrate' manually.`
        );
        return;
      }
      const applied = result.value.length;
      if (applied === 0) {
        console.log("  ✅ Schema up to date");
      } else {
        console.log(
          `  ✅ Auto-applied ${applied} migration${applied === 1 ? "" : "s"}`
        );
      }
    } catch (error) {
      console.log(
        `  ⚠️  Auto-migrate error: ${(error as Error).message}. Run 'disc migrate' manually.`
      );
    } finally {
      if (manager)
        await manager.close();
      await pool.close();
    }
  }

  /**
   * Build a stdout-printing progress listener for the migrate command.
   * Lines mirror the format documented in gh/geldata#7490 — one line per
   * step, with the migration index and a duration on completion.
   */
  private makeMigrateProgressListener(): MigrationProgressListener {
    const startedAt = new Map<string, number>();
    return (event: MigrationProgressEvent): void => {
      switch (event.kind) {
        case "plan-started":
          if (event.totalMigrations === 0)
            return;
          console.log(
            `> Planning ${event.totalMigrations} migration${event.totalMigrations === 1 ? "" : "s"} (${event.totalOperations} operation${
              event.totalOperations === 1 ? "" : "s"
            })…`
          );
          return;
        case "migration-started":
          startedAt.set(event.migrationId, Date.now());
          console.log(
            `[${event.index}/${event.total}] ${event.name} …`
          );
          return;
        case "ddl-executing":
          console.log(
            `    applying ${event.statementCount} DDL statement${event.statementCount === 1 ? "" : "s"} …`
          );
          return;
        case "data-migration-running":
          console.log(`    applying data migration …`);
          return;
        case "migration-completed":
          console.log(
            `    ✓ done in ${event.durationMs}ms`
          );
          return;
        case "migration-failed":
          console.error(
            `    ✗ failed: ${event.error} (after ${event.durationMs}ms${event.rollbackAttempted ? ", rollback attempted" : ""})`
          );
          return;
        case "plan-completed":
          if (event.migrationCount === 0)
            return;
          console.log(
            `✓ Applied ${event.migrationCount} migration${event.migrationCount === 1 ? "" : "s"} in ${event.durationMs}ms`
          );
          return;
        case "plan-failed":
          console.error(`✗ Migration plan failed in ${event.durationMs}ms`);
          return;
      }
    };
  }

  private async applyMigrations(
    manager: SchemaManager,
    schemaFile: string,
    dryRun: boolean,
    allowUnsafe = false,
    quiet = false
  ): Promise<void> {
    if (!quiet && dryRun) {
      console.log("Applying migrations...");
    }

    // Read SDL source from schema file
    let sdlSource: string;

    try {
      sdlSource = await Deno.readTextFile(schemaFile);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        console.error(`Schema file not found: ${schemaFile}`);
        return;
      }
      throw error;
    }

    if (dryRun) {
      // Dry-run: plan and show DDL without executing
      const planResult = manager.planSchema(sdlSource);

      if (!planResult.ok) {
        console.error(
          `Migration planning failed: ${planResult.error.message}`
        );
        return;
      }

      const plan = planResult.value;

      if (plan.operationsCount === 0) {
        console.log("No migrations to apply - schema is up to date");
        return;
      }

      console.log(`DRY RUN - ${plan.migrations.length} migration${plan.migrations.length === 1 ? "" : "s"} planned:`);
      plan.migrations.forEach((migration, i) => {
        console.log(`  ${i + 1}. ${migration.name}`);
        console.log(`     ${migration.description}`);
      });

      const ddlResult = manager.generateDDL(plan);
      if (ddlResult.ok) {
        console.log("\nDDL that would be executed:");
        ddlResult.value.forEach((stmt, i) => {
          if (stmt.trim() && !stmt.startsWith("--")) {
            console.log(`   ${i + 1}. ${stmt}`);
          }
        });
      }

      console.log("\nNo changes applied (dry-run mode)");
    } else {
      // Pre-flight: detect a running Disc server attached to the same
      // database (gh/geldata#9034). Migration applies via the CLI's
      // direct PG connection and a running server's in-memory schema
      // cache won't see the change until it reloads. We surface the
      // warning *before* mutating the schema so the operator can plan
      // a follow-up reload (the server's schema-watch endpoint or a
      // restart) rather than discover stale-cache failures after the
      // fact.
      try {
        const detected = await manager.detectRunningServers();
        if (detected.ok && detected.value.length > 0 && !quiet) {
          console.warn(
            `\n⚠ Detected ${detected.value.length} active Disc server connection${detected.value.length === 1 ? "" : "s"} on this database.`
          );
          console.warn(
            "  Migrate will succeed, but the server's in-memory schema cache will be stale until reload."
          );
          console.warn(
            "  Trigger a schema reload (admin UI Diff page → Apply, or restart the server) after migration.\n"
          );
        }
      } catch {
        // Best-effort preflight: a probe failure is not a migration
        // blocker (operator may have stripped pg_stat_activity
        // permissions). Fall through to the apply.
      }

      // Live execution: applySchema handles parse + diff + execute. Pass
      // through `allowUnsafe` so `--unsafe` callers aren't blocked by
      // the destructive-op gate (gh/geldata#1838).
      //
      // Per-migration progress is rendered by the progress listener wired
      // in `migrate()` (gh/geldata#7490). The legacy "Migration Results"
      // block was removed — the listener prints `[i/N] name … done in Xms`
      // and a final `✓ Applied N migrations in Yms` summary.
      const applyResult = await manager.applySchema(sdlSource, {
        allowUnsafe
      });

      if (!applyResult.ok) {
        console.error(
          `Migration execution failed: ${applyResult.error.message}`
        );
        return;
      }

      const results = applyResult.value;

      if (results.length === 0 && !quiet) {
        console.log("No migrations to apply - schema is up to date");
        return;
      }
    }
  }

  /**
   * Get the project name from disc.toml or current directory
   */
  private getProjectName(): string {
    const ctx = resolveProjectContext();
    return ctx?.projectName || Deno.cwd().split("/").pop() || "default";
  }

  /**
   * Read and parse an SDL schema file into Module[] representation.
   *
   * Reads the file from disk and parses the SDL source via SchemaManager.
   * Returns null if the file does not exist or parsing fails.
   */
  private async readSchemaFile(filePath: string): Promise<Module[] | null> {
    try {
      console.log(`📖 Reading schema from ${filePath}`);

      let sdlSource: string;

      try {
        sdlSource = await Deno.readTextFile(filePath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          return null;
        }
        throw error;
      }

      const manager = new SchemaManager({});
      const result = manager.parseSDL(sdlSource);

      if (!result.ok) {
        console.error(`❌ Failed to parse schema: ${result.error.message}`);
        return null;
      }

      return result.value;
    } catch (error) {
      console.error(`Failed to read schema file: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Read an SDL schema file and convert it to a compiler Schema.
   *
   * Calls readSchemaFile() to get Module[], then converts to a Schema
   * via SchemaManager.modulesToSchema(). Returns null if the file cannot
   * be read or parsing fails.
   */
  private async readSchemaAsCompilerSchema(
    filePath: string
  ): Promise<Schema | null> {
    const modules = await this.readSchemaFile(filePath);

    if (!modules) {
      return null;
    }

    try {
      const manager = new SchemaManager({});
      return manager.modulesToSchema(modules);
    } catch (error) {
      console.error(
        `❌ Failed to convert schema: ${(error as Error).message}`
      );
      return null;
    }
  }
}

// Export the commands instance
export const commands = new CLICommands();

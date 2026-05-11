/**
 * Main Disc Database Server
 */

// Side-effect import: installs `BigInt.prototype.toJSON` so query responses
// carrying int64 columns can be JSON-serialized. Must run before any
// HTTP/SSE/WebSocket handler tries to stringify a row.
import "../lib/bigint-json.ts";
import { AuthRoutes } from "../auth/integration.ts";
import { AuthMiddleware } from "../auth/middleware.ts";
import { PgDatabaseAdapter } from "../auth/pg-database-adapter.ts";
import { AuthProvider } from "../auth/provider.ts";
import type { Schema } from "../compiler/context.ts";
import { mergeSchemaAdditions } from "../compiler/context.ts";
import { createExtensionContext } from "../extensions/context.ts";
import { ExtensionRegistry } from "../extensions/registry.ts";
import type { Extension } from "../extensions/types.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { configureLogging } from "../lib/logger.ts";
import { PostgresInstance } from "../postgres/instance.ts";
import { logger } from "../postgres/logger.ts";
import { BinaryProtocolServer } from "../protocol/binary-server.ts";
import { DatabaseRegistry } from "./database-registry.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import * as Types from "./types.ts";

/**
 * Options for constructing a DiscServer.
 * Extends the standard ServerConfig with an optional bundled PostgresInstance.
 */
export interface DiscServerOptions extends Partial<Types.ServerConfig> {
  /**
   * An optional PostgresInstance for bundled PG mode.
   * When provided, the server derives its databaseUrl from the instance's DSN
   * and passes it through to the protocol handler's connection pool.
   */
  postgresInstance?: PostgresInstance;

  /**
   * Which protocol handler to use.
   * - "simple" (default): SimpleEdgeQLProtocolHandler — simulated compilation
   * - "full": EdgeQLProtocolHandler — real EdgeQL compiler integration
   */
  protocol?: "simple" | "full";

  /**
   * An optional parsed Schema to pass to the protocol handler.
   * When provided, the handler uses this schema instead of the default test schema.
   */
  schema?: Schema;

  /**
   * Enable authentication system. Requires jwtSecret to be set.
   * When true (and jwtSecret is present), initializes AuthProvider,
   * registers /auth/* routes, and populates AuthContext from JWT tokens.
   */
  enableAuth?: boolean;

  /**
   * Enable access policy enforcement. When true, access policies from SDL
   * are registered with the compiler and auth context is bridged per-request.
   * Requires protocol: "full" for actual enforcement.
   */
  enableAccessPolicies?: boolean;

  /**
   * TTL in milliseconds for cached EXPLAIN plan results.
   * Only relevant when enableExplain is true. Default: 300_000 (5 minutes).
   */
  explainCacheTtlMs?: number;

  /**
   * Optional list of extensions to register with the server.
   * Each extension is initialized during server start and shut down during stop.
   */
  extensions?: Extension[];

  /**
   * Enable multi-database support via DatabaseRegistry.
   * When true, the server creates a DatabaseRegistry and routes requests
   * to the correct pool based on the X-Database header or ?database= param.
   */
  enableMultiDatabase?: boolean;

  /**
   * Pre-configured named databases mapped to DSNs.
   * Only used when enableMultiDatabase is true.
   */
  databases?: Record<string, string>;

  /**
   * Port for the Gel binary wire protocol server.
   * When set, DiscServer starts a BinaryProtocolServer alongside HTTP.
   * The binary protocol shares the same schema as the HTTP handler.
   * Default: undefined (binary protocol not started).
   */
  binaryPort?: number;

  /**
   * Password for binary protocol SCRAM-SHA-256 authentication.
   * Only used when binaryPort is set. If undefined, no auth is required.
   */
  binaryPassword?: string;

  /**
   * Cert + key files for the binary protocol's TLS layer. Required for
   * upstream Gel client compatibility — the Python and JS clients refuse
   * plain TCP and require ALPN "edgedb-binary".
   */
  binaryTls?: { certFile: string; keyFile: string; };

  /**
   * Path to the SDL schema file for the live-schema-diff admin endpoint
   * (Bundle K — Disc-original feature #3a). When provided, the HTTP
   * server mounts `/admin/schema-watch` (SSE diff stream) and
   * `/admin/schema-apply` (gated migration apply). When omitted, both
   * routes return 404.
   */
  schemaFilePath?: string;

  /**
   * SDL text the server believes is currently applied. Cached at boot
   * by the CLI from `schemaFilePath`; re-read internally after each
   * successful schema apply via `/admin/schema-apply`. Diff-vs-on-disk
   * is computed against this string.
   */
  appliedSdl?: string;
}

export class DiscServer {
  private config: Types.ServerConfig;
  private httpServer?: HttpServer;
  private postgresInstance?: PostgresInstance;
  private protocolHandler: Types.ProtocolHandler;
  private authProvider?: AuthProvider;
  private authMiddleware?: AuthMiddleware;
  private authRoutes?: AuthRoutes;
  private auth_db?: DatabaseConnection;
  private extensionRegistry: ExtensionRegistry;
  private databaseRegistry?: DatabaseRegistry;
  /**
   * Live data-subscription registry (Bundle L — Disc-original feature
   * #3c). Owns the change-log polling loop + per-subscriber debounce.
   * Initialized after the protocol handler's pool is ready, then
   * passed into HttpServer.
   */
  private dataWatchRegistry?: import("./admin/data-watch-registry.ts").DataWatchRegistry;
  private binaryServer?: BinaryProtocolServer;
  private binaryPassword?: string;
  private binaryTls?: { certFile: string; keyFile: string; };
  private stopping = false;
  private signal_handler?: () => void;
  private sighup_handler?: () => void;
  private last_log_level?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  private last_log_format?: "json" | "text";
  /**
   * Path + cached SDL text for the live-schema-diff admin endpoint.
   * Updated in-place after a successful `/admin/schema-apply`.
   */
  private schemaFilePath?: string;
  private appliedSdl?: string;

  constructor(config: DiscServerOptions = {}) {
    // If a PostgresInstance is provided, derive databaseUrl from its DSN
    // unless the caller explicitly set a databaseUrl.
    const databaseUrl = config.databaseUrl ||
      (config.postgresInstance ? config.postgresInstance.dsn() : "postgresql://localhost:5432/disc");

    this.config = {
      host: config.host || "localhost",
      port: config.port || 5656,
      databaseUrl,
      maxConnections: config.maxConnections || 100,
      requestTimeout: config.requestTimeout || 30000,
      enableCors: config.enableCors !== undefined ? config.enableCors : true,
      corsOrigins: config.corsOrigins,
      enableWebsockets: config.enableWebsockets !== undefined ? config.enableWebsockets : true,
      jwtSecret: config.jwtSecret,
      enableAuth: config.enableAuth,
      enableAccessPolicies: config.enableAccessPolicies,
      authConfig: config.authConfig,
      cacheMaxSize: config.cacheMaxSize,
      shutdownDrainTimeout: config.shutdownDrainTimeout,
      slowQueryThresholdMs: config.slowQueryThresholdMs,
      enableMetrics: config.enableMetrics,
      rateLimitRpm: config.rateLimitRpm,
      rateLimitBurst: config.rateLimitBurst,
      requireAuth: config.requireAuth,
      readOnly: config.readOnly,
      trustProxy: config.trustProxy,
      enableRest: config.enableRest,
      enableDataWatch: config.enableDataWatch,
      tls: config.tls,
      databases: config.databases,
      enableMultiDatabase: config.enableMultiDatabase,
      binaryPort: config.binaryPort
    };

    this.postgresInstance = config.postgresInstance;
    this.binaryPassword = config.binaryPassword;
    this.binaryTls = config.binaryTls;
    this.schemaFilePath = config.schemaFilePath;
    this.appliedSdl = config.appliedSdl;

    // Initialize extension registry and register extensions from options
    this.extensionRegistry = new ExtensionRegistry();
    if (config.extensions) {
      for (const ext of config.extensions) {
        this.extensionRegistry.register(ext);
      }
    }

    // Initialize the selected protocol handler
    const handlerOptions = {
      enableExplain: config.enableExplain || false,
      explainCacheTtlMs: config.explainCacheTtlMs,
      dryRun: config.dryRun || false,
      databaseUrl: this.config.databaseUrl,
      schema: config.schema,
      enableAccessPolicies: config.enableAccessPolicies,
      cacheMaxSize: config.cacheMaxSize,
      slowQueryThresholdMs: config.slowQueryThresholdMs,
      readOnly: config.readOnly ?? false
    };

    if (config.protocol === "full") {
      this.protocolHandler = new EdgeQLProtocolHandler(handlerOptions);
    } else {
      this.protocolHandler = new SimpleEdgeQLProtocolHandler(handlerOptions);
    }
  }

  /**
   * Set or replace the live-schema-diff source (Bundle K — Disc #3a).
   * Called by the CLI between `createServerFromEnv()` and `start()`
   * with the path to the project's `.disc` SDL file plus the SDL
   * text the server is booting from. After start, the server
   * exposes `/admin/schema-watch` (SSE diff stream) and
   * `/admin/schema-apply` (gated apply). The cached SDL is updated
   * automatically on each successful apply.
   */
  setSchemaWatchSource(schemaFilePath: string, appliedSdl: string): void {
    this.schemaFilePath = schemaFilePath;
    this.appliedSdl = appliedSdl;
  }

  async start(): Promise<void> {
    logger.info("Starting Disc Database Server");
    logger.info(`Configuration:
  Host: ${this.config.host}
  Port: ${this.config.port}
  Database: ${this.config.databaseUrl}
  Max Connections: ${this.config.maxConnections}
  CORS: ${this.config.enableCors}
  WebSockets: ${this.config.enableWebsockets}
  Request Timeout: ${this.config.requestTimeout}ms
  Bundled PostgreSQL: ${this.postgresInstance ? "yes" : "no"}`);

    try {
      // Initialize protocol handler (creates and warms up the connection pool)
      if (this.protocolHandler.initialize) {
        await this.protocolHandler.initialize();
        logger.info("Protocol handler initialized (connection pool ready)");
      }

      // Bootstrap live data-subscription infrastructure (Bundle L).
      // The pool is owned by the protocol handler; we reuse it so we
      // don't open yet another connection. Failures here are
      // non-fatal — the live-watch endpoint just stays unavailable.
      if (this.config.enableDataWatch !== false) {
        await this.initializeDataWatch();
      }

      // Initialize database registry for multi-database support
      if (this.config.enableMultiDatabase) {
        this.databaseRegistry = new DatabaseRegistry();
        await this.databaseRegistry.initialize(this.config.databaseUrl);
        logger.info("DatabaseRegistry initialized for multi-database support");
      }

      // Initialize auth if jwtSecret is set and enableAuth is not explicitly false
      if (this.config.jwtSecret && this.config.enableAuth !== false) {
        await this.initializeAuth();
      }

      // Initialize extensions
      if (this.extensionRegistry.size > 0) {
        const extCtx = createExtensionContext({
          schema: this.config.extensions ?
            (this.protocolHandler as any).schema ||
            { types: new Map(), functions: new Map() } :
            { types: new Map(), functions: new Map() },
          config: this.config
        });
        await this.extensionRegistry.initializeAll(extCtx);

        // Merge extension functions and types into the protocol handler schema
        const extFunctions = this.extensionRegistry.getAllFunctions();
        const extTypes = this.extensionRegistry.getAllTypes();
        if (
          (extFunctions.length > 0 || extTypes.length > 0) &&
          this.protocolHandler.updateSchema
        ) {
          const handlerSchema: {
            types: Map<string, any>;
            functions: Map<string, any>;
          } = (this.protocolHandler as any).schema ||
            { types: new Map(), functions: new Map() };
          const merged = mergeSchemaAdditions(
            handlerSchema,
            extFunctions,
            extTypes
          );
          this.protocolHandler.updateSchema(merged);
          logger.info(
            `Merged ${extFunctions.length} extension function${extFunctions.length === 1 ? "" : "s"} and ${extTypes.length} extension type${
              extTypes.length === 1 ? "" : "s"
            } into schema`
          );
        }
      }

      // Initialize binary protocol server if binaryPort is configured
      if (this.config.binaryPort !== undefined) {
        const handlerSchema = (this.protocolHandler as any).schema ||
          { types: new Map(), functions: new Map() };
        // Bind a stable executor that delegates to whatever protocol
        // handler is currently configured. Calling `.bind` here so the
        // closure captures the EdgeQL handler's `this`, since some
        // handlers (e.g. SimpleEdgeQLProtocolHandler) may not expose
        // executeBinaryQuery — see fallback below.
        const handler = this.protocolHandler as {
          executeBinaryQuery?: (
            commandText: string,
            args: Record<string, unknown>
          ) => Promise<{
            rows: Record<string, unknown>[];
            status: string;
          }>;
        };
        const executor = handler.executeBinaryQuery ? handler.executeBinaryQuery.bind(this.protocolHandler) : undefined;

        this.binaryServer = new BinaryProtocolServer({
          hostname: this.config.host === "localhost" ? "127.0.0.1" : this.config.host,
          port: this.config.binaryPort,
          schema: handlerSchema,
          password: this.binaryPassword,
          tls: this.binaryTls,
          executor
        });
        this.binaryServer.start();
        logger.info(
          `Binary protocol server listening on port ${this.binaryServer.port}`
        );
      }

      // Initialize HTTP server
      this.httpServer = new HttpServer({
        config: this.config,
        protocolHandler: this.protocolHandler,
        authProvider: this.authProvider,
        authMiddleware: this.authMiddleware,
        authRoutes: this.authRoutes,
        extensionRoutes: this.extensionRegistry.getAllRoutes(),
        extensionHealthGetter: this.extensionRegistry.size > 0 ? () => this.extensionRegistry.getHealthStatus() : undefined,
        databaseRegistry: this.databaseRegistry,
        // Live-schema-diff (Bundle K — Disc #3a). When the CLI passed a
        // schemaFilePath, HttpServer mounts `/admin/schema-watch` and
        // `/admin/schema-apply`; otherwise both 404.
        adminSchemaWatch: this.schemaFilePath ?
          {
            schemaFilePath: this.schemaFilePath,
            appliedSdlProvider: () => this.appliedSdl ?? "",
            onApplied: newSdl => {
              this.appliedSdl = newSdl;
            }
          } :
          undefined,
        dataWatchRegistry: this.dataWatchRegistry,
        schemaProvider: () => {
          // Access the handler's current schema (may be updated at runtime)
          const handler = this.protocolHandler as any;
          return handler.schema || { types: new Map(), functions: new Map() };
        },
        migrationsProvider: async () => {
          // Build a transient MigrationTracker against the protocol
          // handler's pool. Throws if no pool is available (e.g. dry-run).
          const handler = this.protocolHandler as any;
          const pool = handler.pool;
          if (!pool) {
            throw new Error("No connection pool available");
          }
          const { MigrationTracker } = await import(
            "../migration/tracker.ts"
          );
          const tracker = new MigrationTracker(pool);
          await tracker.initialize();
          const result = await tracker.getMigrationHistory();
          if (!result.ok) {
            throw new Error(result.error.message);
          }
          return result.value;
        }
      });

      // Register signal handlers for graceful shutdown
      this.signal_handler = () => {
        this.stop();
      };
      Deno.addSignalListener("SIGINT", this.signal_handler);
      Deno.addSignalListener("SIGTERM", this.signal_handler);

      // SIGHUP is POSIX-only — Deno's signal API throws on Windows for
      // unsupported signals. Skip registration there and log a hint.
      if (Deno.build.os !== "windows") {
        this.sighup_handler = () => {
          // Don't await — signal handlers must return quickly. The reload
          // runs as its own task; errors are caught + logged inside.
          // (gh/geldata#4278)
          void this.reloadConfig().catch(err => {
            logger.error(
              `SIGHUP config reload failed: ${err instanceof Error ? err.message : String(err)}`
            );
          });
        };
        Deno.addSignalListener("SIGHUP", this.sighup_handler);
        logger.info(
          "SIGHUP handler registered; send SIGHUP to reload safe-to-change config without restart"
        );
      } else {
        logger.info("SIGHUP config reload is not available on Windows; restart required for config changes");
      }

      // Capture the logging config that was active when the server
      // started — used by reloadConfig() to detect changes.
      const initialLogging = readLoggingEnv();
      this.last_log_level = initialLogging.level;
      this.last_log_format = initialLogging.format;

      // Start the server (blocks until server.finished)
      await this.httpServer.start();
    } catch (error) {
      logger.error(`Failed to start server: ${error}`);
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Make stop() idempotent -- safe to call multiple times
    if (this.stopping) {
      return;
    }
    this.stopping = true;

    logger.info("Stopping Disc Database Server");

    // Remove signal handlers
    if (this.signal_handler) {
      try {
        Deno.removeSignalListener("SIGINT", this.signal_handler);
        Deno.removeSignalListener("SIGTERM", this.signal_handler);
      } catch {
        // Ignore errors from removing listeners (e.g. in test environments)
      }
      this.signal_handler = undefined;
    }

    if (this.sighup_handler) {
      try {
        Deno.removeSignalListener("SIGHUP", this.sighup_handler);
      } catch {
        // Ignore errors from removing listeners (e.g. in test environments)
      }
      this.sighup_handler = undefined;
    }

    // Stop binary protocol server
    if (this.binaryServer) {
      await this.binaryServer.stop();
      logger.info("Binary protocol server stopped");
    }

    if (this.httpServer) {
      // Drain in-flight requests before shutting down
      const drainTimeout = this.config.shutdownDrainTimeout ?? 30000;
      logger.info(
        `Draining in-flight requests (timeout: ${drainTimeout}ms)`
      );
      await this.httpServer.drain(drainTimeout);

      await this.httpServer.stop();
    }

    // Stop data-watch registry (clears polling timer + subscribers).
    if (this.dataWatchRegistry) {
      this.dataWatchRegistry.stop();
      this.dataWatchRegistry = undefined;
      logger.info("Data-watch registry stopped");
    }

    // Shut down extensions
    if (this.extensionRegistry.size > 0) {
      await this.extensionRegistry.shutdownAll();
      logger.info("Extensions shut down");
    }

    // Close database registry pools
    if (this.databaseRegistry) {
      await this.databaseRegistry.close();
      logger.info("DatabaseRegistry closed (all pools drained)");
    }

    // Close database connections in protocol handler (drain pool)
    if (this.protocolHandler.close) {
      await this.protocolHandler.close();
      logger.info("Protocol handler closed (connection pool drained)");
    }

    // Close auth database connection
    if (this.auth_db) {
      await this.auth_db.close();
      logger.info("Auth database connection closed");
    }

    logger.info("Server stopped successfully");
  }

  /**
   * Bootstrap the live data-subscription infrastructure (Bundle L).
   *
   * Steps:
   *   1. Pull the connection pool from the protocol handler.
   *   2. Run `bootstrapDataWatch()` to ensure the change-log table,
   *      function, and triggers exist on every Disc-managed table.
   *   3. Construct + start a `DataWatchRegistry` against the pool.
   *
   * Failures are non-fatal. If bootstrap throws (e.g. permissions
   * issue, extension blocking), we log and skip the live-watch
   * registry — the endpoint just won't be mounted on HttpServer.
   */
  private async initializeDataWatch(): Promise<void> {
    const handler = this.protocolHandler as unknown as {
      pool?: import("../lib/connection-pool.ts").ConnectionPool;
    };
    if (!handler.pool) {
      logger.info(
        "data-watch: skipped — protocol handler has no connection pool"
      );
      return;
    }
    try {
      const { bootstrapDataWatch } = await import(
        "./admin/data-watch-ddl.ts"
      );
      const { DataWatchRegistry } = await import(
        "./admin/data-watch-registry.ts"
      );
      const result = await bootstrapDataWatch({ pool: handler.pool });
      this.dataWatchRegistry = new DataWatchRegistry({ pool: handler.pool });
      await this.dataWatchRegistry.start();
      logger.info(
        `data-watch: ready (${result.wiredTables.length} table${result.wiredTables.length === 1 ? "" : "s"} wired)`
      );
    } catch (err) {
      this.dataWatchRegistry = undefined;
      logger.warn(
        `data-watch: bootstrap failed; live data subscriptions disabled — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async initializeAuth(): Promise<void> {
    if (!this.config.jwtSecret)
      return;

    logger.info("Initializing authentication system");

    // Create a dedicated database connection for auth
    this.auth_db = new DatabaseConnection(this.config.databaseUrl);
    await this.auth_db.connect();

    // Wrap in PgDatabaseAdapter for ? -> $N placeholder conversion
    const adapter = new PgDatabaseAdapter(this.auth_db);

    // Build auth config
    const authConfig = {
      jwtSecret: this.config.jwtSecret,
      jwtIssuer: this.config.authConfig?.jwtIssuer,
      jwtAudience: this.config.authConfig?.jwtAudience,
      tokenExpiry: this.config.authConfig?.tokenExpiry,
      bcryptRounds: this.config.authConfig?.bcryptRounds,
      sessionTimeout: this.config.authConfig?.sessionTimeout,
      allowRegistration: this.config.authConfig?.allowRegistration,
      requireEmailVerification: this
        .config
        .authConfig
        ?.requireEmailVerification,
      passwordMinLength: this.config.authConfig?.passwordMinLength
    };

    // Initialize provider (creates tables + crypto key)
    this.authProvider = new AuthProvider(authConfig, adapter);
    await this.authProvider.initialize();

    // Create middleware and routes
    this.authMiddleware = new AuthMiddleware(this.authProvider);
    this.authRoutes = new AuthRoutes(this.authProvider, this.authMiddleware, {
      trustProxy: this.config.trustProxy
    });

    logger.info("Authentication system initialized");
  }

  /**
   * Re-read environment variables and apply hot-reloadable config
   * changes in place. Triggered by SIGHUP, but also callable directly
   * (for tests, admin endpoints, etc.). (gh/geldata#4278)
   *
   * Safe-to-reload fields are applied immediately and take effect on
   * the next request:
   *   - requestTimeout (DISC_REQUEST_TIMEOUT)
   *   - enableCors (DISC_ENABLE_CORS)
   *   - corsOrigins (DISC_CORS_ORIGINS)
   *   - slowQueryThresholdMs (DISC_SLOW_QUERY_MS)
   *   - explainCacheTtlMs (DISC_EXPLAIN_CACHE_TTL)
   *   - log level / format (DISC_LOG_LEVEL, DISC_LOG_FORMAT)
   *   - TLS cert/key (re-read from on-disk files via reloadTls())
   *
   * Unsafe fields (host, port, databaseUrl, jwtSecret, enableAuth,
   * enableAccessPolicies, enableWebsockets, enableMetrics,
   * maxConnections, cacheMaxSize) trigger a warn and are otherwise
   * ignored — restart required.
   */
  async reloadConfig(): Promise<void> {
    logger.info("SIGHUP received: reloading config from environment");

    const next = buildEnvOptions(
      this.postgresInstance,
      undefined,
      undefined
    );
    const cur = this.config;

    let applied = 0;
    let ignored = 0;

    const noteApplied = (field: string, oldVal: unknown, newVal: unknown): void => {
      logger.info(`config reload: ${field}: ${String(oldVal)} -> ${String(newVal)}`);
      applied++;
    };
    const noteIgnored = (field: string, oldVal: unknown, newVal: unknown): void => {
      logger.warn(
        `config reload: ${field} changed (${String(oldVal)} -> ${String(newVal)}) but cannot be hot-reloaded — restart required`
      );
      ignored++;
    };

    // ── Safe-to-reload fields ───────────────────────────────────────
    if (next.requestTimeout !== undefined && next.requestTimeout !== cur.requestTimeout) {
      noteApplied("requestTimeout", cur.requestTimeout, next.requestTimeout);
      cur.requestTimeout = next.requestTimeout;
      this.httpServer?.updateRequestTimeout(next.requestTimeout);
    }

    if (next.enableCors !== undefined && next.enableCors !== cur.enableCors) {
      noteApplied("enableCors", cur.enableCors, next.enableCors);
      cur.enableCors = next.enableCors;
      this.httpServer?.updateCorsEnabled(next.enableCors);
    }

    if (!arraysEqual(next.corsOrigins, cur.corsOrigins)) {
      noteApplied(
        "corsOrigins",
        cur.corsOrigins?.join(",") ?? "(none)",
        next.corsOrigins?.join(",") ?? "(none)"
      );
      cur.corsOrigins = next.corsOrigins;
      this.httpServer?.updateCorsAllowedOrigins(next.corsOrigins);
    }

    if (
      next.slowQueryThresholdMs !== undefined &&
      next.slowQueryThresholdMs !== cur.slowQueryThresholdMs
    ) {
      noteApplied(
        "slowQueryThresholdMs",
        cur.slowQueryThresholdMs,
        next.slowQueryThresholdMs
      );
      cur.slowQueryThresholdMs = next.slowQueryThresholdMs;
      this.httpServer?.updateSlowQueryThreshold(next.slowQueryThresholdMs);
    }

    const curExplain = (cur as Types.ServerConfig & { explainCacheTtlMs?: number; })
      .explainCacheTtlMs;
    if (
      next.explainCacheTtlMs !== undefined &&
      next.explainCacheTtlMs !== curExplain
    ) {
      noteApplied("explainCacheTtlMs", curExplain, next.explainCacheTtlMs);
      const ttl = next.explainCacheTtlMs;
      (cur as Types.ServerConfig & { explainCacheTtlMs?: number; }).explainCacheTtlMs = ttl;
      this.httpServer?.updateExplainCacheTtl(ttl);
    }

    // Logging — reconfigure the global logger if either knob changed.
    const nextLogging = readLoggingEnv();
    if (
      nextLogging.level !== this.last_log_level ||
      nextLogging.format !== this.last_log_format
    ) {
      noteApplied(
        "logLevel/format",
        `${this.last_log_level}/${this.last_log_format}`,
        `${nextLogging.level}/${nextLogging.format}`
      );
      configureLogging({ format: nextLogging.format, level: nextLogging.level });
      this.last_log_level = nextLogging.level;
      this.last_log_format = nextLogging.format;
    }

    // ── Unsafe-to-reload fields ─────────────────────────────────────
    if (next.host !== undefined && next.host !== cur.host) {
      noteIgnored("host", cur.host, next.host);
    }
    if (next.port !== undefined && next.port !== cur.port) {
      noteIgnored("port", cur.port, next.port);
    }
    if (next.databaseUrl !== undefined && next.databaseUrl !== cur.databaseUrl) {
      noteIgnored("databaseUrl", "(redacted)", "(redacted)");
    }
    if (next.jwtSecret !== undefined && next.jwtSecret !== cur.jwtSecret) {
      noteIgnored("jwtSecret", "(redacted)", "(redacted)");
    }
    if (next.enableAuth !== undefined && next.enableAuth !== cur.enableAuth) {
      noteIgnored("enableAuth", cur.enableAuth, next.enableAuth);
    }
    if (
      next.enableAccessPolicies !== undefined &&
      next.enableAccessPolicies !== cur.enableAccessPolicies
    ) {
      noteIgnored(
        "enableAccessPolicies",
        cur.enableAccessPolicies,
        next.enableAccessPolicies
      );
    }
    if (
      next.enableWebsockets !== undefined &&
      next.enableWebsockets !== cur.enableWebsockets
    ) {
      noteIgnored("enableWebsockets", cur.enableWebsockets, next.enableWebsockets);
    }
    if (next.enableMetrics !== undefined && next.enableMetrics !== cur.enableMetrics) {
      noteIgnored("enableMetrics", cur.enableMetrics, next.enableMetrics);
    }
    if (
      next.maxConnections !== undefined &&
      next.maxConnections !== cur.maxConnections
    ) {
      noteIgnored("maxConnections", cur.maxConnections, next.maxConnections);
    }
    // cacheMaxSize: the LRU caches live on the protocol handler and were
    // sized at construction time. Resizing in place would require pruning
    // entries to fit a smaller cap and re-keying the eviction list — not
    // trivial. TODO: expose a `resize(n)` on the cache and wire here.
    if (next.cacheMaxSize !== undefined && next.cacheMaxSize !== cur.cacheMaxSize) {
      noteIgnored("cacheMaxSize", cur.cacheMaxSize, next.cacheMaxSize);
    }

    // ── TLS cert/key on-disk reload ────────────────────────────────
    // Even when no config field changed, the cert files themselves may
    // have been rotated. reloadTls() re-reads from disk and swaps the
    // listener. Skip silently if TLS isn't configured or the HTTP
    // server isn't running yet.
    if (cur.tls && this.httpServer) {
      try {
        await this.httpServer.reloadTls();
        logger.info("config reload: TLS listener reloaded from on-disk cert/key");
      } catch (err) {
        logger.error(
          `config reload: TLS reload failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    logger.info(
      `SIGHUP reload complete: ${applied} applied, ${ignored} ignored (unsafe)`
    );
  }

  get_config(): Types.ServerConfig {
    return { ...this.config };
  }

  getHttpServer(): HttpServer | undefined {
    return this.httpServer;
  }

  get_postgres_instance(): PostgresInstance | undefined {
    return this.postgresInstance;
  }

  update_config(updates: Partial<Types.ServerConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  updateSchema(schema: Schema): void {
    this.protocolHandler.updateSchema?.(schema);
  }

  getProtocolHandler(): Types.ProtocolHandler {
    return this.protocolHandler;
  }

  getExtensionRegistry(): ExtensionRegistry {
    return this.extensionRegistry;
  }

  getDatabaseRegistry(): DatabaseRegistry | undefined {
    return this.databaseRegistry;
  }

  getBinaryServer(): BinaryProtocolServer | undefined {
    return this.binaryServer;
  }
}

/**
 * Order-sensitive equality for two optional string arrays. `undefined`
 * and `[]` are treated as equal — both mean "no allowlist set".
 */
function arraysEqual(a?: string[], b?: string[]): boolean {
  const la = a?.length ?? 0;
  const lb = b?.length ?? 0;
  if (la !== lb)
    return false;
  if (la === 0)
    return true;
  for (let i = 0; i < la; i++) {
    if (a![i] !== b![i])
      return false;
  }
  return true;
}

export function createDefaultConfig(): Types.ServerConfig {
  return {
    host: "localhost",
    port: 5656,
    databaseUrl: Deno.env.get("DATABASE_URL") ||
      "postgresql://localhost:5432/disc",
    maxConnections: 100,
    requestTimeout: 30000,
    enableCors: true,
    enableWebsockets: true
  };
}

/**
 * Build a `DiscServerOptions` snapshot from environment variables.
 *
 * Factored out of `createServerFromEnv` so SIGHUP-triggered reloads can
 * re-derive the same shape without re-running the side effects (logging
 * config, server construction). Pure function — does not mutate global
 * state. (gh/geldata#4278)
 */
export function buildEnvOptions(
  postgresInstance?: PostgresInstance,
  schema?: Schema,
  extensions?: Extension[]
): DiscServerOptions {
  const enableAuth = Deno.env.get("DISC_ENABLE_AUTH");
  const enableAccessPolicies = Deno.env.get("DISC_ENABLE_ACCESS_POLICIES");
  const config: DiscServerOptions = {
    host: Deno.env.get("DISC_HOST") || "localhost",
    port: parseInt(Deno.env.get("DISC_PORT") || "5656"),
    databaseUrl: Deno.env.get("DATABASE_URL") || undefined,
    maxConnections: parseInt(Deno.env.get("DISC_MAX_CONNECTIONS") || "100"),
    requestTimeout: parseInt(Deno.env.get("DISC_REQUEST_TIMEOUT") || "30000"),
    enableCors: Deno.env.get("DISC_ENABLE_CORS") !== "false",
    enableWebsockets: Deno.env.get("DISC_ENABLE_WEBSOCKETS") !== "false",
    jwtSecret: Deno.env.get("DISC_JWT_SECRET"),
    enableAuth: enableAuth !== undefined ? enableAuth !== "false" : undefined,
    enableAccessPolicies: enableAccessPolicies !== undefined ? enableAccessPolicies !== "false" : undefined,
    cacheMaxSize: parseInt(Deno.env.get("DISC_CACHE_MAX_SIZE") || "1000"),
    explainCacheTtlMs: parseInt(
      Deno.env.get("DISC_EXPLAIN_CACHE_TTL") || "300000"
    ),
    slowQueryThresholdMs: parseInt(
      Deno.env.get("DISC_SLOW_QUERY_MS") || "1000"
    ),
    enableMetrics: Deno.env.get("DISC_ENABLE_METRICS") === "true",
    rateLimitRpm: parseInt(Deno.env.get("DISC_RATE_LIMIT_RPM") || "0") ||
      undefined,
    rateLimitBurst: parseInt(Deno.env.get("DISC_RATE_LIMIT_BURST") || "0") ||
      undefined,
    postgresInstance,
    // Default to the full EdgeQL compiler. The "simple" path is a hand-rolled
    // stub that omits FROM/LIMIT/ORDER and bypasses the real compiler — kept
    // around for tests that assert against simulated SQL strings, but not
    // suitable for serving real queries. Set DISC_PROTOCOL=simple to opt in.
    protocol: Deno.env.get("DISC_PROTOCOL") === "simple" ? "simple" : "full",
    schema,
    extensions
  };

  // Parse CORS origins if provided
  const corsOriginsEnv = Deno.env.get("DISC_CORS_ORIGINS");
  if (corsOriginsEnv) {
    config.corsOrigins = corsOriginsEnv.split(",").map(origin => origin.trim());
  }

  // Shutdown drain timeout. Documented in `docs/production-deployment.md`
  // and `docs/server.md`; without this branch the env var was inert and
  // the only way to set the drain window was the programmatic surface
  // (`DiscServerOptions.shutdownDrainTimeout`). Closes Bundle G follow-up
  // (gh/geldata#5234, #7563).
  const drainTimeoutRaw = Deno.env.get("DISC_SHUTDOWN_DRAIN_TIMEOUT");
  if (drainTimeoutRaw !== undefined) {
    const parsed = parseInt(drainTimeoutRaw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      config.shutdownDrainTimeout = parsed;
    }
  }

  // Boolean knobs previously gated on disc.toml's `[server]` section.
  // Adding env-var equivalents completes the matrix documented in
  // `docs/server.md#disc-toml-keys-vs-env-vars-vs-cli-flags`.
  // (gh/geldata#5234, #7563).
  const requireAuth = parseBoolEnv("DISC_REQUIRE_AUTH");
  if (requireAuth !== undefined)
    config.requireAuth = requireAuth;

  const readOnly = parseBoolEnv("DISC_READ_ONLY");
  if (readOnly !== undefined)
    config.readOnly = readOnly;

  const trustProxy = parseBoolEnv("DISC_TRUST_PROXY");
  if (trustProxy !== undefined)
    config.trustProxy = trustProxy;

  // Schema-derived REST surface (Bundle J). Defaults to true; opt-out
  // via env or `disc.toml` `enable_rest = false` in the server section.
  const enableRest = parseBoolEnv("DISC_ENABLE_REST");
  if (enableRest !== undefined)
    config.enableRest = enableRest;

  // Live data subscriptions (Bundle L). Defaults to true; opt-out via
  // `DISC_ENABLE_DATA_WATCH=false` or `disc.toml` `enable_data_watch
  // = false`.
  const enableDataWatch = parseBoolEnv("DISC_ENABLE_DATA_WATCH");
  if (enableDataWatch !== undefined)
    config.enableDataWatch = enableDataWatch;

  // Parse TLS config if provided.
  // `DISC_TLS_CERT` / `DISC_TLS_KEY` accept on-disk paths.
  // `DISC_TLS_CERT_ENV` / `DISC_TLS_KEY_ENV` name *another* env var holding
  // the PEM-encoded contents — useful for platforms (Kubernetes secrets
  // mounted as env, Fly.io, Render, …) where dropping a file on disk is
  // awkward but injecting a string is easy. (gh/geldata#4547)
  const tlsCert = resolveTlsMaterial("DISC_TLS_CERT", "DISC_TLS_CERT_ENV");
  const tlsKey = resolveTlsMaterial("DISC_TLS_KEY", "DISC_TLS_KEY_ENV");
  if (tlsCert && tlsKey) {
    config.tls = {
      certFile: tlsCert,
      keyFile: tlsKey,
      redirect: Deno.env.get("DISC_TLS_REDIRECT") === "true",
      redirectPort: parseInt(Deno.env.get("DISC_TLS_REDIRECT_PORT") || "80")
    };
  }

  // Binary protocol TLS — required for upstream Gel client compatibility.
  const binaryTlsCert = resolveTlsMaterial(
    "DISC_BINARY_TLS_CERT",
    "DISC_BINARY_TLS_CERT_ENV"
  );
  const binaryTlsKey = resolveTlsMaterial(
    "DISC_BINARY_TLS_KEY",
    "DISC_BINARY_TLS_KEY_ENV"
  );
  if (binaryTlsCert && binaryTlsKey) {
    config.binaryTls = { certFile: binaryTlsCert, keyFile: binaryTlsKey };
  }

  // Binary protocol — port + SCRAM password.
  const binaryPortRaw = Deno.env.get("DISC_BINARY_PORT");
  if (binaryPortRaw !== undefined) {
    const parsed = parseInt(binaryPortRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      config.binaryPort = parsed;
    }
  }
  const binaryPassword = Deno.env.get("DISC_BINARY_PASSWORD");
  if (binaryPassword !== undefined) {
    config.binaryPassword = binaryPassword;
  }

  return config;
}

/**
 * Parse a `DISC_*` boolean env var. Accepts `1`/`true`/`yes`
 * (case-insensitive) as true and `0`/`false`/`no` as false. Anything
 * else returns `undefined` so the underlying disc.toml or default
 * value wins.
 */
function parseBoolEnv(key: string): boolean | undefined {
  const raw = Deno.env.get(key);
  if (raw === undefined || raw === "")
    return undefined;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return undefined;
}

/**
 * Resolve TLS material from one of two env-var forms:
 *   1. `<pathKey>` — env var pointing at an on-disk file path
 *   2. `<envKey>` — env var naming *another* env var that holds the
 *      PEM contents. The intermediate name lets operators rotate the
 *      secret-bearing variable without rebuilding the manifest.
 *
 * Returns the on-disk path when (1) is set; otherwise materializes the
 * PEM contents at (2) into a temp file and returns its path. Returns
 * `undefined` when neither is set.
 *
 * Temp files inherit OS permissions (mode 0600 on POSIX). Caller is
 * the long-running server, so leaking these on shutdown is acceptable —
 * the data was already in `process.env` and visible to anyone who can
 * read /proc/<pid>/environ. (gh/geldata#4547)
 */
function resolveTlsMaterial(pathKey: string, envKey: string): string | undefined {
  const direct = Deno.env.get(pathKey);
  if (direct)
    return direct;
  const indirectName = Deno.env.get(envKey);
  if (!indirectName)
    return undefined;
  const pem = Deno.env.get(indirectName);
  if (!pem)
    return undefined;
  const tempFile = Deno.makeTempFileSync({ prefix: "disc-tls-", suffix: ".pem" });
  Deno.writeTextFileSync(tempFile, pem);
  // Best-effort lock down the perms; failure is logged elsewhere.
  try {
    if (Deno.build.os !== "windows") {
      Deno.chmodSync(tempFile, 0o600);
    }
  } catch {
    // ignore
  }
  return tempFile;
}

/**
 * Read logging-related env vars. Returned separately because logging is
 * configured globally at process scope, not per-server.
 */
function readLoggingEnv(): { format: "json" | "text"; level: "DEBUG" | "INFO" | "WARN" | "ERROR"; } {
  const level = (Deno.env.get("DISC_LOG_LEVEL") || "INFO").toUpperCase() as
    | "DEBUG"
    | "INFO"
    | "WARN"
    | "ERROR";
  const format = (Deno.env.get("DISC_LOG_FORMAT") || "json") as "json" | "text";
  return { format, level };
}

/**
 * Create a DiscServer from environment variables.
 * Optionally accepts a PostgresInstance for bundled PG mode,
 * a parsed Schema, and a list of extensions to register.
 */
export function createServerFromEnv(
  postgresInstance?: PostgresInstance,
  schema?: Schema,
  extensions?: Extension[]
): DiscServer {
  // Configure structured logging from env vars
  const { format, level } = readLoggingEnv();
  configureLogging({ format, level });

  const config = buildEnvOptions(postgresInstance, schema, extensions);
  return new DiscServer(config);
}

// Export all types and classes for external use
export { BinaryProtocolServer } from "../protocol/binary-server.ts";
export { ConnectionManager, SessionManager, TransactionManager } from "./connection.ts";
export { DatabaseRegistry } from "./database-registry.ts";
export { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
export { HttpServer } from "./http.ts";
export { EdgeQLProtocolHandler as MockEdgeQLProtocolHandler, GraphQLProtocolHandler } from "./protocol.ts";
export { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
export * from "./types.ts";

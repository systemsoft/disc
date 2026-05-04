/**
 * Main Disc Database Server
 */

import * as Types from "./types.ts";
import { HttpServer } from "./http.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { configureLogging } from "../lib/logger.ts";
import { PostgresInstance } from "../postgres/instance.ts";
import { logger } from "../postgres/logger.ts";
import type { Schema } from "../compiler/context.ts";
import { mergeSchemaAdditions } from "../compiler/context.ts";
import { AuthProvider } from "../auth/provider.ts";
import { AuthMiddleware } from "../auth/middleware.ts";
import { AuthRoutes } from "../auth/integration.ts";
import { PgDatabaseAdapter } from "../auth/pg-database-adapter.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { ExtensionRegistry } from "../extensions/registry.ts";
import { createExtensionContext } from "../extensions/context.ts";
import type { Extension } from "../extensions/types.ts";
import { DatabaseRegistry } from "./database-registry.ts";
import { BinaryProtocolServer } from "../protocol/binary-server.ts";

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
  private binaryServer?: BinaryProtocolServer;
  private binaryPassword?: string;
  private stopping = false;
  private signal_handler?: () => void;

  constructor(config: DiscServerOptions = {}) {
    // If a PostgresInstance is provided, derive databaseUrl from its DSN
    // unless the caller explicitly set a databaseUrl.
    const databaseUrl = config.databaseUrl ||
      (config.postgresInstance
        ? config.postgresInstance.dsn()
        : "postgresql://localhost:5432/disc");

    this.config = {
      host: config.host || "localhost",
      port: config.port || 5656,
      databaseUrl,
      maxConnections: config.maxConnections || 100,
      requestTimeout: config.requestTimeout || 30000,
      enableCors: config.enableCors !== undefined ? config.enableCors : true,
      corsOrigins: config.corsOrigins,
      enableWebsockets: config.enableWebsockets !== undefined
        ? config.enableWebsockets
        : true,
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
      tls: config.tls,
      databases: config.databases,
      enableMultiDatabase: config.enableMultiDatabase,
      binaryPort: config.binaryPort,
    };

    this.postgresInstance = config.postgresInstance;
    this.binaryPassword = config.binaryPassword;

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
    };

    if (config.protocol === "full") {
      this.protocolHandler = new EdgeQLProtocolHandler(handlerOptions);
    } else {
      this.protocolHandler = new SimpleEdgeQLProtocolHandler(handlerOptions);
    }
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
          schema: this.config.extensions
            ? (this.protocolHandler as any).schema ||
              { types: new Map(), functions: new Map() }
            : { types: new Map(), functions: new Map() },
          config: this.config,
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
            extTypes,
          );
          this.protocolHandler.updateSchema(merged);
          logger.info(
            `Merged ${extFunctions.length} extension function(s) and ${extTypes.length} extension type(s) into schema`,
          );
        }
      }

      // Initialize binary protocol server if binaryPort is configured
      if (this.config.binaryPort !== undefined) {
        const handlerSchema = (this.protocolHandler as any).schema ||
          { types: new Map(), functions: new Map() };
        this.binaryServer = new BinaryProtocolServer({
          hostname: this.config.host === "localhost"
            ? "127.0.0.1"
            : this.config.host,
          port: this.config.binaryPort,
          schema: handlerSchema,
          password: this.binaryPassword,
        });
        this.binaryServer.start();
        logger.info(
          `Binary protocol server listening on port ${this.binaryServer.port}`,
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
        extensionHealthGetter: this.extensionRegistry.size > 0
          ? () => this.extensionRegistry.getHealthStatus()
          : undefined,
        databaseRegistry: this.databaseRegistry,
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
        },
      });

      // Register signal handlers for graceful shutdown
      this.signal_handler = () => {
        this.stop();
      };
      Deno.addSignalListener("SIGINT", this.signal_handler);
      Deno.addSignalListener("SIGTERM", this.signal_handler);

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

    // Stop binary protocol server
    if (this.binaryServer) {
      await this.binaryServer.stop();
      logger.info("Binary protocol server stopped");
    }

    if (this.httpServer) {
      // Drain in-flight requests before shutting down
      const drainTimeout = this.config.shutdownDrainTimeout ?? 30000;
      logger.info(
        `Draining in-flight requests (timeout: ${drainTimeout}ms)`,
      );
      await this.httpServer.drain(drainTimeout);

      await this.httpServer.stop();
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

  private async initializeAuth(): Promise<void> {
    if (!this.config.jwtSecret) return;

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
      requireEmailVerification: this.config.authConfig
        ?.requireEmailVerification,
      passwordMinLength: this.config.authConfig?.passwordMinLength,
    };

    // Initialize provider (creates tables + crypto key)
    this.authProvider = new AuthProvider(authConfig, adapter);
    await this.authProvider.initialize();

    // Create middleware and routes
    this.authMiddleware = new AuthMiddleware(this.authProvider);
    this.authRoutes = new AuthRoutes(this.authProvider, this.authMiddleware);

    logger.info("Authentication system initialized");
  }

  get_config(): Types.ServerConfig {
    return { ...this.config };
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

export function createDefaultConfig(): Types.ServerConfig {
  return {
    host: "localhost",
    port: 5656,
    databaseUrl: Deno.env.get("DATABASE_URL") ||
      "postgresql://localhost:5432/disc",
    maxConnections: 100,
    requestTimeout: 30000,
    enableCors: true,
    enableWebsockets: true,
  };
}

/**
 * Create a DiscServer from environment variables.
 * Optionally accepts a PostgresInstance for bundled PG mode,
 * a parsed Schema, and a list of extensions to register.
 */
export function createServerFromEnv(
  postgresInstance?: PostgresInstance,
  schema?: Schema,
  extensions?: Extension[],
): DiscServer {
  // Configure structured logging from env vars
  const logLevel = (Deno.env.get("DISC_LOG_LEVEL") || "INFO").toUpperCase();
  const logFormat = Deno.env.get("DISC_LOG_FORMAT") || "json";
  configureLogging({
    level: logLevel as "DEBUG" | "INFO" | "WARN" | "ERROR",
    format: logFormat as "json" | "text",
  });

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
    enableAccessPolicies: enableAccessPolicies !== undefined
      ? enableAccessPolicies !== "false"
      : undefined,
    cacheMaxSize: parseInt(Deno.env.get("DISC_CACHE_MAX_SIZE") || "1000"),
    explainCacheTtlMs: parseInt(
      Deno.env.get("DISC_EXPLAIN_CACHE_TTL") || "300000",
    ),
    slowQueryThresholdMs: parseInt(
      Deno.env.get("DISC_SLOW_QUERY_MS") || "1000",
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
    extensions,
  };

  // Parse CORS origins if provided
  const corsOriginsEnv = Deno.env.get("DISC_CORS_ORIGINS");
  if (corsOriginsEnv) {
    config.corsOrigins = corsOriginsEnv.split(",").map((origin) =>
      origin.trim()
    );
  }

  // Parse TLS config if provided
  const tlsCert = Deno.env.get("DISC_TLS_CERT");
  const tlsKey = Deno.env.get("DISC_TLS_KEY");
  if (tlsCert && tlsKey) {
    config.tls = {
      certFile: tlsCert,
      keyFile: tlsKey,
      redirect: Deno.env.get("DISC_TLS_REDIRECT") === "true",
      redirectPort: parseInt(Deno.env.get("DISC_TLS_REDIRECT_PORT") || "80"),
    };
  }

  return new DiscServer(config);
}

// Export all types and classes for external use
export * from "./types.ts";
export {
  ConnectionManager,
  SessionManager,
  TransactionManager,
} from "./connection.ts";
export { HttpServer } from "./http.ts";
export {
  EdgeQLProtocolHandler as MockEdgeQLProtocolHandler,
  GraphQLProtocolHandler,
} from "./protocol.ts";
export { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
export { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
export { DatabaseRegistry } from "./database-registry.ts";
export { BinaryProtocolServer } from "../protocol/binary-server.ts";

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
import { AuthProvider } from "../auth/provider.ts";
import { AuthMiddleware } from "../auth/middleware.ts";
import { AuthRoutes } from "../auth/integration.ts";
import { PgDatabaseAdapter } from "../auth/pg-database-adapter.ts";
import { DatabaseConnection } from "../lib/database.ts";

/**
 * Options for constructing a DiscServer.
 * Extends the standard ServerConfig with an optional bundled PostgresInstance.
 */
export interface DiscServerOptions extends Partial<Types.ServerConfig> {
  /**
   * An optional PostgresInstance for bundled PG mode.
   * When provided, the server derives its database_url from the instance's DSN
   * and passes it through to the protocol handler's connection pool.
   */
  postgres_instance?: PostgresInstance;

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
   * Enable authentication system. Requires jwt_secret to be set.
   * When true (and jwt_secret is present), initializes AuthProvider,
   * registers /auth/* routes, and populates AuthContext from JWT tokens.
   */
  enable_auth?: boolean;

  /**
   * Enable access policy enforcement. When true, access policies from SDL
   * are registered with the compiler and auth context is bridged per-request.
   * Requires protocol: "full" for actual enforcement.
   */
  enable_access_policies?: boolean;

  /**
   * TTL in milliseconds for cached EXPLAIN plan results.
   * Only relevant when enable_explain is true. Default: 300_000 (5 minutes).
   */
  explain_cache_ttl_ms?: number;
}

export class DiscServer {
  private config: Types.ServerConfig;
  private http_server?: HttpServer;
  private postgres_instance?: PostgresInstance;
  private protocol_handler: Types.ProtocolHandler;
  private auth_provider?: AuthProvider;
  private auth_middleware?: AuthMiddleware;
  private auth_routes?: AuthRoutes;
  private auth_db?: DatabaseConnection;
  private stopping = false;
  private signal_handler?: () => void;

  constructor(config: DiscServerOptions = {}) {
    // If a PostgresInstance is provided, derive database_url from its DSN
    // unless the caller explicitly set a database_url.
    const database_url = config.database_url ||
      (config.postgres_instance
        ? config.postgres_instance.dsn()
        : "postgresql://localhost:5432/disc");

    this.config = {
      host: config.host || "localhost",
      port: config.port || 5656,
      database_url,
      max_connections: config.max_connections || 100,
      request_timeout: config.request_timeout || 30000,
      enable_cors: config.enable_cors !== undefined ? config.enable_cors : true,
      cors_origins: config.cors_origins,
      enable_websockets: config.enable_websockets !== undefined
        ? config.enable_websockets
        : true,
      jwt_secret: config.jwt_secret,
      enable_auth: config.enable_auth,
      enable_access_policies: config.enable_access_policies,
      auth_config: config.auth_config,
      cache_max_size: config.cache_max_size,
      shutdown_drain_timeout: config.shutdown_drain_timeout,
      slow_query_threshold_ms: config.slow_query_threshold_ms,
      enable_metrics: config.enable_metrics,
      rate_limit_rpm: config.rate_limit_rpm,
      rate_limit_burst: config.rate_limit_burst,
      tls: config.tls,
    };

    this.postgres_instance = config.postgres_instance;

    // Initialize the selected protocol handler
    const handler_options = {
      enable_explain: config.enable_explain || false,
      explain_cache_ttl_ms: config.explain_cache_ttl_ms,
      dry_run: config.dry_run || false,
      database_url: this.config.database_url,
      schema: config.schema,
      enable_access_policies: config.enable_access_policies,
      cache_max_size: config.cache_max_size,
      slow_query_threshold_ms: config.slow_query_threshold_ms,
    };

    if (config.protocol === "full") {
      this.protocol_handler = new EdgeQLProtocolHandler(handler_options);
    } else {
      this.protocol_handler = new SimpleEdgeQLProtocolHandler(handler_options);
    }
  }

  async start(): Promise<void> {
    logger.info("Starting Disc Database Server");
    logger.info(`Configuration:
  Host: ${this.config.host}
  Port: ${this.config.port}
  Database: ${this.config.database_url}
  Max Connections: ${this.config.max_connections}
  CORS: ${this.config.enable_cors}
  WebSockets: ${this.config.enable_websockets}
  Request Timeout: ${this.config.request_timeout}ms
  Bundled PostgreSQL: ${this.postgres_instance ? "yes" : "no"}`);

    try {
      // Initialize protocol handler (creates and warms up the connection pool)
      if (this.protocol_handler.initialize) {
        await this.protocol_handler.initialize();
        logger.info("Protocol handler initialized (connection pool ready)");
      }

      // Initialize auth if jwt_secret is set and enable_auth is not explicitly false
      if (this.config.jwt_secret && this.config.enable_auth !== false) {
        await this.initializeAuth();
      }

      // Initialize HTTP server
      this.http_server = new HttpServer({
        config: this.config,
        protocol_handler: this.protocol_handler,
        auth_provider: this.auth_provider,
        auth_middleware: this.auth_middleware,
        auth_routes: this.auth_routes,
      });

      // Register signal handlers for graceful shutdown
      this.signal_handler = () => {
        this.stop();
      };
      Deno.addSignalListener("SIGINT", this.signal_handler);
      Deno.addSignalListener("SIGTERM", this.signal_handler);

      // Start the server (blocks until server.finished)
      await this.http_server.start();
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

    if (this.http_server) {
      // Drain in-flight requests before shutting down
      const drain_timeout = this.config.shutdown_drain_timeout ?? 30000;
      logger.info(
        `Draining in-flight requests (timeout: ${drain_timeout}ms)`,
      );
      await this.http_server.drain(drain_timeout);

      await this.http_server.stop();
    }

    // Close database connections in protocol handler (drain pool)
    if (this.protocol_handler.close) {
      await this.protocol_handler.close();
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
    if (!this.config.jwt_secret) return;

    logger.info("Initializing authentication system");

    // Create a dedicated database connection for auth
    this.auth_db = new DatabaseConnection(this.config.database_url);
    await this.auth_db.connect();

    // Wrap in PgDatabaseAdapter for ? -> $N placeholder conversion
    const adapter = new PgDatabaseAdapter(this.auth_db);

    // Build auth config
    const authConfig = {
      jwt_secret: this.config.jwt_secret,
      jwt_issuer: this.config.auth_config?.jwt_issuer,
      jwt_audience: this.config.auth_config?.jwt_audience,
      token_expiry: this.config.auth_config?.token_expiry,
      bcrypt_rounds: this.config.auth_config?.bcrypt_rounds,
      session_timeout: this.config.auth_config?.session_timeout,
      allow_registration: this.config.auth_config?.allow_registration,
      require_email_verification: this.config.auth_config
        ?.require_email_verification,
      password_min_length: this.config.auth_config?.password_min_length,
    };

    // Initialize provider (creates tables + crypto key)
    this.auth_provider = new AuthProvider(authConfig, adapter);
    await this.auth_provider.initialize();

    // Create middleware and routes
    this.auth_middleware = new AuthMiddleware(this.auth_provider);
    this.auth_routes = new AuthRoutes(this.auth_provider, this.auth_middleware);

    logger.info("Authentication system initialized");
  }

  get_config(): Types.ServerConfig {
    return { ...this.config };
  }

  get_postgres_instance(): PostgresInstance | undefined {
    return this.postgres_instance;
  }

  update_config(updates: Partial<Types.ServerConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  updateSchema(schema: Schema): void {
    this.protocol_handler.updateSchema?.(schema);
  }

  getProtocolHandler(): Types.ProtocolHandler {
    return this.protocol_handler;
  }
}

export function create_default_config(): Types.ServerConfig {
  return {
    host: "localhost",
    port: 5656,
    database_url: Deno.env.get("DATABASE_URL") ||
      "postgresql://localhost:5432/disc",
    max_connections: 100,
    request_timeout: 30000,
    enable_cors: true,
    enable_websockets: true,
  };
}

/**
 * Create a DiscServer from environment variables.
 * Optionally accepts a PostgresInstance for bundled PG mode.
 */
export function create_server_from_env(
  postgres_instance?: PostgresInstance,
  schema?: Schema,
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
    database_url: Deno.env.get("DATABASE_URL") || undefined,
    max_connections: parseInt(Deno.env.get("DISC_MAX_CONNECTIONS") || "100"),
    request_timeout: parseInt(Deno.env.get("DISC_REQUEST_TIMEOUT") || "30000"),
    enable_cors: Deno.env.get("DISC_ENABLE_CORS") !== "false",
    enable_websockets: Deno.env.get("DISC_ENABLE_WEBSOCKETS") !== "false",
    jwt_secret: Deno.env.get("DISC_JWT_SECRET"),
    enable_auth: enableAuth !== undefined ? enableAuth !== "false" : undefined,
    enable_access_policies: enableAccessPolicies !== undefined
      ? enableAccessPolicies !== "false"
      : undefined,
    cache_max_size: parseInt(Deno.env.get("DISC_CACHE_MAX_SIZE") || "1000"),
    explain_cache_ttl_ms: parseInt(
      Deno.env.get("DISC_EXPLAIN_CACHE_TTL") || "300000",
    ),
    slow_query_threshold_ms: parseInt(
      Deno.env.get("DISC_SLOW_QUERY_MS") || "1000",
    ),
    enable_metrics: Deno.env.get("DISC_ENABLE_METRICS") === "true",
    rate_limit_rpm: parseInt(Deno.env.get("DISC_RATE_LIMIT_RPM") || "0") ||
      undefined,
    rate_limit_burst: parseInt(Deno.env.get("DISC_RATE_LIMIT_BURST") || "0") ||
      undefined,
    postgres_instance,
    protocol: Deno.env.get("DISC_PROTOCOL") === "full" ? "full" : "simple",
    schema,
  };

  // Parse CORS origins if provided
  const cors_origins_env = Deno.env.get("DISC_CORS_ORIGINS");
  if (cors_origins_env) {
    config.cors_origins = cors_origins_env.split(",").map((origin) =>
      origin.trim()
    );
  }

  // Parse TLS config if provided
  const tls_cert = Deno.env.get("DISC_TLS_CERT");
  const tls_key = Deno.env.get("DISC_TLS_KEY");
  if (tls_cert && tls_key) {
    config.tls = {
      cert_file: tls_cert,
      key_file: tls_key,
      redirect: Deno.env.get("DISC_TLS_REDIRECT") === "true",
      redirect_port: parseInt(Deno.env.get("DISC_TLS_REDIRECT_PORT") || "80"),
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

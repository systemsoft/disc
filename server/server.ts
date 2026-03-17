/**
 * Main Disc Database Server
 */

import * as Types from "./types.ts";
import { HttpServer } from "./http.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { PostgresInstance } from "../postgres/instance.ts";
import { logger } from "../postgres/logger.ts";
import type { Schema } from "../compiler/context.ts";

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
}

export class DiscServer {
  private config: Types.ServerConfig;
  private http_server?: HttpServer;
  private postgres_instance?: PostgresInstance;
  private protocol_handler: Types.ProtocolHandler;

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
      tls: config.tls,
    };

    this.postgres_instance = config.postgres_instance;

    // Initialize the selected protocol handler
    const handler_options = {
      enable_explain: config.enable_explain || false,
      dry_run: config.dry_run || false,
      database_url: this.config.database_url,
      schema: config.schema,
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

      // Initialize HTTP server
      this.http_server = new HttpServer({
        config: this.config,
        protocol_handler: this.protocol_handler,
      });

      // Start the server
      await this.http_server.start();
    } catch (error) {
      logger.error(`Failed to start server: ${error}`);
      throw error;
    }
  }

  async stop(): Promise<void> {
    logger.info("Stopping Disc Database Server");

    if (this.http_server) {
      await this.http_server.stop();
    }

    // Close database connections in protocol handler (drain pool)
    if (this.protocol_handler.close) {
      await this.protocol_handler.close();
      logger.info("Protocol handler closed (connection pool drained)");
    }

    logger.info("Server stopped successfully");
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
  const config: DiscServerOptions = {
    host: Deno.env.get("DISC_HOST") || "localhost",
    port: parseInt(Deno.env.get("DISC_PORT") || "5656"),
    database_url: Deno.env.get("DATABASE_URL") || undefined,
    max_connections: parseInt(Deno.env.get("DISC_MAX_CONNECTIONS") || "100"),
    request_timeout: parseInt(Deno.env.get("DISC_REQUEST_TIMEOUT") || "30000"),
    enable_cors: Deno.env.get("DISC_ENABLE_CORS") !== "false",
    enable_websockets: Deno.env.get("DISC_ENABLE_WEBSOCKETS") !== "false",
    jwt_secret: Deno.env.get("DISC_JWT_SECRET"),
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

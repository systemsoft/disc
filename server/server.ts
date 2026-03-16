/**
 * Main Disc Database Server
 */

import * as Types from "./types.ts";
import { HttpServer } from "./http.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";

export class DiscServer {
  private config: Types.ServerConfig;
  private http_server?: HttpServer;
  private protocol_handler: Types.ProtocolHandler;

  constructor(config: Partial<Types.ServerConfig> = {}) {
    this.config = {
      host: config.host || "localhost",
      port: config.port || 5656,
      database_url: config.database_url || "postgresql://localhost:5432/disc",
      max_connections: config.max_connections || 100,
      request_timeout: config.request_timeout || 30000,
      enable_cors: config.enable_cors !== undefined ? config.enable_cors : true,
      cors_origins: config.cors_origins,
      enable_websockets: config.enable_websockets !== undefined ? config.enable_websockets : true,
      jwt_secret: config.jwt_secret,
      tls: config.tls,
    };

    // Initialize protocol handler with simplified EdgeQL integration
    this.protocol_handler = new SimpleEdgeQLProtocolHandler({
      enable_explain: config.enable_explain || false,
      dry_run: config.dry_run || false,
      database_url: config.database_url,
    });
  }

  async start(): Promise<void> {
    console.log("🚀 Starting Disc Database Server");
    console.log(`📋 Configuration:
  • Host: ${this.config.host}
  • Port: ${this.config.port}
  • Database: ${this.config.database_url}
  • Max Connections: ${this.config.max_connections}
  • CORS: ${this.config.enable_cors}
  • WebSockets: ${this.config.enable_websockets}
  • Request Timeout: ${this.config.request_timeout}ms`);

    try {
      // Initialize HTTP server
      this.http_server = new HttpServer({
        config: this.config,
        protocol_handler: this.protocol_handler,
      });

      // Start the server
      await this.http_server.start();

    } catch (error) {
      console.error("❌ Failed to start server:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    console.log("🛑 Stopping Disc Database Server");

    if (this.http_server) {
      await this.http_server.stop();
    }

    // Close database connections in protocol handler
    if (this.protocol_handler && 'close' in this.protocol_handler) {
      await (this.protocol_handler as any).close();
    }

    console.log("✅ Server stopped successfully");
  }

  get_config(): Types.ServerConfig {
    return { ...this.config };
  }

  update_config(updates: Partial<Types.ServerConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}

export function create_default_config(): Types.ServerConfig {
  return {
    host: "localhost",
    port: 5656,
    database_url: Deno.env.get("DATABASE_URL") || "postgresql://localhost:5432/disc",
    max_connections: 100,
    request_timeout: 30000,
    enable_cors: true,
    enable_websockets: true,
  };
}

export function create_server_from_env(): DiscServer {
  const config: Partial<Types.ServerConfig> = {
    host: Deno.env.get("DISC_HOST") || "localhost",
    port: parseInt(Deno.env.get("DISC_PORT") || "5656"),
    database_url: Deno.env.get("DATABASE_URL") || "postgresql://localhost:5432/disc",
    max_connections: parseInt(Deno.env.get("DISC_MAX_CONNECTIONS") || "100"),
    request_timeout: parseInt(Deno.env.get("DISC_REQUEST_TIMEOUT") || "30000"),
    enable_cors: Deno.env.get("DISC_ENABLE_CORS") !== "false",
    enable_websockets: Deno.env.get("DISC_ENABLE_WEBSOCKETS") !== "false",
    jwt_secret: Deno.env.get("DISC_JWT_SECRET"),
  };

  // Parse CORS origins if provided
  const cors_origins_env = Deno.env.get("DISC_CORS_ORIGINS");
  if (cors_origins_env) {
    config.cors_origins = cors_origins_env.split(",").map(origin => origin.trim());
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
export { ConnectionManager, SessionManager, TransactionManager } from "./connection.ts";
export { HttpServer } from "./http.ts";
export { EdgeQLProtocolHandler as MockEdgeQLProtocolHandler, GraphQLProtocolHandler } from "./protocol.ts";
export { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";

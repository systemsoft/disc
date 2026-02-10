/**
 * HTTP Server implementation for Disc Database
 */

import * as Types from "./types.ts";
import { ConnectionManager, SessionManager, TransactionManager } from "./connection.ts";
import { SubscriptionHandler } from "./subscription-handler.ts";

export interface HttpServerOptions {
  config: Types.ServerConfig;
  protocol_handler: Types.ProtocolHandler;
}

export class HttpServer {
  private config: Types.ServerConfig;
  private protocol_handler: Types.ProtocolHandler;
  private connection_manager: ConnectionManager;
  private session_manager: SessionManager;
  private transaction_manager: TransactionManager;
  private subscription_handler: SubscriptionHandler;
  private server?: Deno.HttpServer<Deno.NetAddr>;
  private start_time: Date;
  private stats = {
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    total_duration_ms: 0,
  };

  constructor(options: HttpServerOptions) {
    this.config = options.config;
    this.protocol_handler = options.protocol_handler;
    this.connection_manager = new ConnectionManager();
    this.session_manager = new SessionManager();
    this.transaction_manager = new TransactionManager();
    this.subscription_handler = new SubscriptionHandler();
    this.start_time = new Date();
  }

  async start(): Promise<void> {
    console.log(`🚀 Starting Disc HTTP server on ${this.config.host}:${this.config.port}`);
    
    const handler = (request: Request, info: Deno.ServeHandlerInfo): Response | Promise<Response> => {
      return this.handle_request(request, info);
    };

    this.server = Deno.serve({
      hostname: this.config.host,
      port: this.config.port,
      handler,
    });

    // Start cleanup intervals
    this.start_cleanup_intervals();

    console.log(`✅ Disc server is running on http://${this.config.host}:${this.config.port}`);
    console.log(`📊 CORS enabled: ${this.config.enable_cors}`);
    console.log(`🔌 WebSockets enabled: ${this.config.enable_websockets}`);

    await this.server.finished;
  }

  async stop(): Promise<void> {
    if (this.server) {
      console.log("🛑 Stopping Disc server...");
      await this.server.shutdown();
      console.log("✅ Server stopped");
    }
  }

  private async handle_request(request: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
    const start_time = Date.now();
    const request_id = this.generate_request_id();
    
    try {
      this.stats.total_requests++;

      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return this.handle_preflight(request);
      }

      // Handle WebSocket upgrade
      if (this.config.enable_websockets && request.headers.get("upgrade") === "websocket") {
        return this.handle_websocket_upgrade(request, info);
      }

      // Handle regular HTTP requests
      const url = new URL(request.url);
      
      // Route handling
      switch (url.pathname) {
        case "/":
          return this.handle_root();
        case "/query":
          return await this.handle_query(request, info, request_id);
        case "/health":
          return this.handle_health();
        case "/stats":
          return this.handle_stats();
        default:
          return this.create_error_response("Not Found", 404);
      }

    } catch (error) {
      this.stats.failed_requests++;
      console.error(`Request ${request_id} failed:`, error);
      return this.create_error_response("Internal Server Error", 500);
    } finally {
      const duration = Date.now() - start_time;
      this.stats.total_duration_ms += duration;
    }
  }

  private handle_root(): Response {
    const info = {
      name: "Disc Database",
      version: "0.1.0",
      protocol: "HTTP/JSON",
      endpoints: {
        query: "/query",
        health: "/health",
        stats: "/stats",
        websocket: this.config.enable_websockets ? "ws://upgrade" : null,
      },
    };

    return new Response(JSON.stringify(info, null, 2), {
      headers: this.get_default_headers("application/json"),
    });
  }

  private async handle_query(
    request: Request, 
    info: Deno.ServeHandlerInfo, 
    request_id: string
  ): Promise<Response> {
    if (request.method !== "POST") {
      return this.create_error_response("Method Not Allowed", 405);
    }

    try {
      // Parse request body
      const body = await request.text();
      let query_request: Types.QueryRequest;

      try {
        query_request = JSON.parse(body);
      } catch {
        return this.create_error_response("Invalid JSON", 400);
      }

      // Validate request
      const validation_errors = this.protocol_handler.validate_request(query_request);
      if (validation_errors.length > 0) {
        return new Response(JSON.stringify({
          errors: validation_errors,
        }), {
          status: 400,
          headers: this.get_default_headers("application/json"),
        });
      }

      // Create connection and session
      const remote_addr = "hostname" in info.remoteAddr ? info.remoteAddr.hostname : "unknown";
      const connection = this.connection_manager.create_connection(
        "http",
        remote_addr,
        undefined,
        request.headers.get("user-agent") || undefined
      );

      // Create query context
      const context: Types.QueryContext = {
        session: connection.session,
        auth: { roles: [], permissions: [] }, // TODO: Implement real auth
        request_id,
        started_at: new Date(),
        client_info: this.parse_client_info(request),
      };

      // Execute query
      const response = await this.protocol_handler.handle_request(query_request, context);
      
      // Update session activity
      this.session_manager.update_activity(connection.session.session_id);
      
      this.stats.successful_requests++;

      return new Response(JSON.stringify(response), {
        headers: this.get_default_headers("application/json"),
      });

    } catch (error) {
      console.error(`Query execution failed for request ${request_id}:`, error);
      
      const error_response: Types.QueryResponse = {
        errors: [{
          message: "Internal server error",
          extensions: { code: "INTERNAL_ERROR" },
        }],
      };

      return new Response(JSON.stringify(error_response), {
        status: 500,
        headers: this.get_default_headers("application/json"),
      });
    }
  }

  private handle_health(): Response {
    const health = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime_ms: Date.now() - this.start_time.getTime(),
      connections: this.connection_manager.get_stats(),
      memory: this.get_memory_stats(),
    };

    return new Response(JSON.stringify(health, null, 2), {
      headers: this.get_default_headers("application/json"),
    });
  }

  private handle_stats(): Response {
    const subscription_stats = this.subscription_handler.get_subscription_stats();
    
    const stats: Types.ServerStats & { subscriptions: typeof subscription_stats } = {
      connections: this.connection_manager.get_stats(),
      queries: {
        total: this.stats.total_requests,
        successful: this.stats.successful_requests,
        failed: this.stats.failed_requests,
        avg_duration_ms: this.stats.total_requests > 0 
          ? this.stats.total_duration_ms / this.stats.total_requests 
          : 0,
      },
      transactions: {
        active: this.transaction_manager.get_active_transactions().length,
        committed: 0, // TODO: Track from real implementation
        rolled_back: 0, // TODO: Track from real implementation
      },
      memory_usage: this.get_memory_stats(),
      uptime_ms: Date.now() - this.start_time.getTime(),
      subscriptions: subscription_stats,
    };

    return new Response(JSON.stringify(stats, null, 2), {
      headers: this.get_default_headers("application/json"),
    });
  }

  private handle_preflight(request: Request): Response {
    if (!this.config.enable_cors) {
      return this.create_error_response("CORS not enabled", 405);
    }

    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", this.get_cors_origin(request));
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");

    return new Response(null, { status: 204, headers });
  }

  private handle_websocket_upgrade(request: Request, info: Deno.ServeHandlerInfo): Response {
    const { socket, response } = Deno.upgradeWebSocket(request);
    
    const remote_addr = "hostname" in info.remoteAddr ? info.remoteAddr.hostname : "unknown";
    const connection = this.connection_manager.create_connection(
      "websocket",
      remote_addr,
      undefined,
      request.headers.get("user-agent") || undefined
    );

    socket.onopen = () => {
      console.log(`WebSocket connection opened: ${connection.id}`);
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await this.handle_websocket_message(socket, connection, message);
      } catch (error) {
        console.error("WebSocket message error:", error);
        socket.send(JSON.stringify({
          type: "error",
          payload: { message: "Invalid message format" },
        }));
      }
    };

    socket.onclose = () => {
      console.log(`WebSocket connection closed: ${connection.id}`);
      this.subscription_handler.cleanup_connection(connection.session.session_id);
      this.connection_manager.close_connection(connection.id);
    };

    socket.onerror = (error) => {
      console.error(`WebSocket error for ${connection.id}:`, error);
    };

    return response;
  }

  private async handle_websocket_message(
    socket: WebSocket, 
    connection: Types.Connection, 
    message: any
  ): Promise<void> {
    const { type, payload } = message;

    switch (type) {
      case "query": {
        const context: Types.QueryContext = {
          session: connection.session,
          auth: { roles: [], permissions: [] },
          request_id: this.generate_request_id(),
          started_at: new Date(),
        };

        try {
          const response = await this.protocol_handler.handle_request(payload, context);
          socket.send(JSON.stringify({
            type: "query_result",
            payload: response,
          }));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: errorMessage },
          }));
        }
        break;
      }

      case "subscribe": {
        const context: Types.QueryContext = {
          session: connection.session,
          auth: { roles: [], permissions: [] },
          request_id: this.generate_request_id(),
          started_at: new Date(),
        };

        try {
          await this.subscription_handler.handle_subscription(payload, context, socket);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown subscription error";
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: errorMessage },
          }));
        }
        break;
      }

      case "unsubscribe": {
        const { subscription_id } = payload;
        if (subscription_id) {
          this.subscription_handler.stop_subscription(subscription_id);
          socket.send(JSON.stringify({
            type: "subscription_stopped",
            payload: { subscription_id },
          }));
        } else {
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: "subscription_id is required for unsubscribe" },
          }));
        }
        break;
      }

      default:
        socket.send(JSON.stringify({
          type: "error",
          payload: { message: `Unknown message type: ${type}` },
        }));
    }
  }

  private get_default_headers(content_type: string): Headers {
    const headers = new Headers();
    headers.set("Content-Type", content_type);
    
    if (this.config.enable_cors) {
      headers.set("Access-Control-Allow-Origin", "*"); // TODO: Use config origins
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    return headers;
  }

  private get_cors_origin(request: Request): string {
    const origin = request.headers.get("origin");
    if (!origin) return "*";

    if (this.config.cors_origins && this.config.cors_origins.includes(origin)) {
      return origin;
    }

    return "*";
  }

  private create_error_response(message: string, status: number): Response {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: this.get_default_headers("application/json"),
    });
  }

  private parse_client_info(request: Request): Types.QueryContext["client_info"] {
    const user_agent = request.headers.get("user-agent");
    if (!user_agent) return undefined;

    // Parse common client patterns
    if (user_agent.includes("disc-client")) {
      return {
        name: "disc-client",
        version: "unknown",
        library: "disc-ts",
      };
    }

    return {
      name: "unknown",
      version: "unknown", 
      library: "http",
    };
  }

  private get_memory_stats(): Types.ServerStats["memory_usage"] {
    const memoryUsage = Deno.memoryUsage();
    return {
      heap_used: memoryUsage.heapUsed,
      heap_total: memoryUsage.heapTotal,
      external: memoryUsage.external,
    };
  }

  private start_cleanup_intervals(): void {
    // Cleanup idle connections every 5 minutes
    setInterval(() => {
      const cleaned = this.connection_manager.cleanup_idle_connections();
      if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} idle connections`);
      }
    }, 5 * 60 * 1000);

    // Cleanup expired sessions every 10 minutes
    setInterval(() => {
      const cleaned = this.session_manager.cleanup_expired_sessions();
      if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} expired sessions`);
      }
    }, 10 * 60 * 1000);

    // Cleanup abandoned transactions every 2 minutes
    setInterval(() => {
      const cleaned = this.transaction_manager.cleanup_abandoned_transactions();
      if (cleaned > 0) {
        console.log(`🧹 Cleaned up ${cleaned} abandoned transactions`);
      }
    }, 2 * 60 * 1000);
  }

  private generate_request_id(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
  }
}
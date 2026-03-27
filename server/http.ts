/**
 * HTTP Server implementation for Disc Database
 */

import { getLogger } from "../lib/logger.ts";
import * as Types from "./types.ts";
import { renderMetrics } from "./metrics.ts";
import type { MetricsSource } from "./metrics.ts";

const log = getLogger("http");
import {
  ConnectionManager,
  SessionManager,
  TransactionManager,
} from "./connection.ts";
import { RateLimiter } from "./rate-limiter.ts";
import { SubscriptionHandler } from "./subscription-handler.ts";
import type { AuthProvider } from "../auth/provider.ts";
import type { AuthMiddleware } from "../auth/middleware.ts";
import type { AuthRoutes } from "../auth/integration.ts";
import type { ExtensionRoute } from "../extensions/types.ts";
import type { DatabaseRegistry } from "./database-registry.ts";
import type { SchemaProvider } from "./schema-endpoint.ts";
import {
  handleGetSchema,
  handleGetSchemaType,
  handleGetSchemaTypes,
} from "./schema-endpoint.ts";

export interface HttpServerOptions {
  config: Types.ServerConfig;
  protocolHandler: Types.ProtocolHandler;
  authProvider?: AuthProvider;
  authMiddleware?: AuthMiddleware;
  authRoutes?: AuthRoutes;
  extensionRoutes?: Map<string, ExtensionRoute[]>;
  extensionHealthGetter?: () => Promise<
    Map<string, { healthy: boolean; details?: string }>
  >;
  databaseRegistry?: DatabaseRegistry;
  schemaProvider?: SchemaProvider;
}

export class HttpServer {
  private config: Types.ServerConfig;
  private protocolHandler: Types.ProtocolHandler;
  private connection_manager: ConnectionManager;
  private session_manager: SessionManager;
  private transaction_manager: TransactionManager;
  private subscription_handler: SubscriptionHandler;
  private authMiddleware?: AuthMiddleware;
  private authRoutes?: AuthRoutes;
  private extensionRoutes: Map<string, ExtensionRoute[]>;
  private extensionHealthGetter?: () => Promise<
    Map<string, { healthy: boolean; details?: string }>
  >;
  private databaseRegistry?: DatabaseRegistry;
  private schemaProvider?: SchemaProvider;
  private rate_limiter?: RateLimiter;
  private server?: Deno.HttpServer<Deno.NetAddr>;
  private redirect_server?: Deno.HttpServer<Deno.NetAddr>;
  private cleanup_interval_ids: number[] = [];
  private startTime: Date;
  private in_flight_requests = 0;
  private shutting_down = false;
  private stats = {
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    total_duration_ms: 0,
  };

  constructor(options: HttpServerOptions) {
    this.config = options.config;
    this.protocolHandler = options.protocolHandler;
    this.authMiddleware = options.authMiddleware;
    this.authRoutes = options.authRoutes;
    this.extensionRoutes = options.extensionRoutes || new Map();
    this.extensionHealthGetter = options.extensionHealthGetter;
    this.databaseRegistry = options.databaseRegistry;
    this.schemaProvider = options.schemaProvider;
    this.connection_manager = new ConnectionManager();
    this.session_manager = new SessionManager();
    this.transaction_manager = new TransactionManager();
    this.subscription_handler = new SubscriptionHandler();
    this.startTime = new Date();

    if (
      options.config.rateLimitRpm && options.config.rateLimitRpm > 0
    ) {
      this.rate_limiter = new RateLimiter({
        requestsPerMinute: options.config.rateLimitRpm,
        burstSize: options.config.rateLimitBurst ||
          options.config.rateLimitRpm,
      });
    }
  }

  async start(): Promise<void> {
    log.info("Starting Disc HTTP server", {
      host: this.config.host,
      port: this.config.port,
    });

    const handler = (
      request: Request,
      info: Deno.ServeHandlerInfo,
    ): Response | Promise<Response> => {
      return this.handleRequest(request, info);
    };

    if (this.config.tls) {
      const cert = await Deno.readTextFile(this.config.tls.certFile);
      const key = await Deno.readTextFile(this.config.tls.keyFile);
      this.server = Deno.serve({
        hostname: this.config.host,
        port: this.config.port,
        cert,
        key,
      }, handler);
    } else {
      this.server = Deno.serve({
        hostname: this.config.host,
        port: this.config.port,
      }, handler);
    }

    // Start redirect server if TLS redirect is enabled
    if (this.config.tls?.redirect) {
      const redirectPort = this.config.tls.redirectPort || 80;
      const httpsPort = this.config.port;
      const host = this.config.host;

      this.redirect_server = Deno.serve({
        hostname: host,
        port: redirectPort,
        handler: (request: Request) => {
          const url = new URL(request.url);
          url.protocol = "https:";
          url.port = String(httpsPort);
          return new Response(null, {
            status: 301,
            headers: { "Location": url.toString() },
          });
        },
      });
    }

    // Start cleanup intervals
    this.start_cleanup_intervals();

    const protocol = this.config.tls ? "https" : "http";
    log.info("Disc server is running", {
      url: `${protocol}://${this.config.host}:${this.config.port}`,
    });
    log.info("Server configuration", {
      cors: this.config.enableCors,
      websockets: this.config.enableWebsockets,
    });

    await Promise.all([
      this.server.finished,
      ...(this.redirect_server ? [this.redirect_server.finished] : []),
    ]);
  }

  async stop(): Promise<void> {
    // Dispose rate limiter cleanup interval
    this.rate_limiter?.dispose();

    // Clear all cleanup intervals
    for (const id of this.cleanup_interval_ids) {
      clearInterval(id);
    }
    this.cleanup_interval_ids = [];

    // Dispose subscription handler timers
    this.subscription_handler.dispose();

    if (this.redirect_server) {
      await this.redirect_server.shutdown();
    }

    if (this.server) {
      log.info("Stopping Disc server");
      await this.server.shutdown();
      log.info("Server stopped");
    }
  }

  /**
   * Drain in-flight requests by setting the shutting_down flag and polling
   * until all requests complete or the timeout expires.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.shutting_down = true;

    const deadline = Date.now() + timeoutMs;
    while (this.in_flight_requests > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Returns the current number of in-flight requests being processed.
   */
  getInFlightCount(): number {
    return this.in_flight_requests;
  }

  private async handleRequest(
    request: Request,
    info: Deno.ServeHandlerInfo,
  ): Promise<Response> {
    // Reject new requests during shutdown
    if (this.shutting_down) {
      return new Response(
        JSON.stringify({ error: "Server is shutting down" }),
        {
          status: 503,
          headers: this.get_default_headers("application/json"),
        },
      );
    }

    // Enforce rate limit before touching in-flight counter or stats
    if (this.rate_limiter) {
      const clientIp = "hostname" in info.remoteAddr
        ? info.remoteAddr.hostname
        : "unknown";
      if (!this.rate_limiter.allow(clientIp)) {
        const headers = this.get_default_headers("application/json");
        headers.set("Retry-After", "60");
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded" }),
          { status: 429, headers },
        );
      }
    }

    this.in_flight_requests++;
    const startTime = Date.now();
    const requestId = this.generate_request_id();

    try {
      this.stats.total_requests++;

      // Handle CORS preflight
      if (request.method === "OPTIONS") {
        return this.handle_preflight(request);
      }

      // Handle WebSocket upgrade
      if (
        this.config.enableWebsockets &&
        request.headers.get("upgrade") === "websocket"
      ) {
        return this.handle_websocket_upgrade(request, info);
      }

      // Handle regular HTTP requests
      const url = new URL(request.url);

      // Extension route handling
      if (url.pathname.startsWith("/ext/")) {
        return await this.handleExtensionRoute(request, url);
      }

      // Auth route handling
      if (url.pathname.startsWith("/auth/")) {
        return await this.handle_auth_route(request, url);
      }

      // Schema introspection route handling
      if (url.pathname === "/schema" || url.pathname.startsWith("/schema/")) {
        return this.handle_schema_route(url);
      }

      // Route handling
      switch (url.pathname) {
        case "/":
          return this.handle_root();
        case "/query":
          return await this.handle_query(request, info, requestId);
        case "/health":
          return await this.handle_health();
        case "/health/live":
          return this.handle_health_live();
        case "/health/ready":
          return await this.handle_health_ready();
        case "/stats":
          return this.handle_stats();
        case "/metrics":
          return this.handle_metrics();
        default:
          return this.create_error_response("Not Found", 404);
      }
    } catch (error) {
      this.stats.failed_requests++;
      log.error("Request failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.create_error_response("Internal Server Error", 500);
    } finally {
      const duration = Date.now() - startTime;
      this.stats.total_duration_ms += duration;
      this.in_flight_requests--;
    }
  }

  private handle_root(): Response {
    const endpoints: Record<string, any> = {
      query: "/query",
      health: "/health",
      healthLive: "/health/live",
      healthReady: "/health/ready",
      stats: "/stats",
      websocket: this.config.enableWebsockets ? "ws://upgrade" : null,
    };

    if (this.config.enableMetrics) {
      endpoints.metrics = "/metrics";
    }

    if (this.authRoutes) {
      endpoints.auth = {
        register: "/auth/register",
        login: "/auth/login",
        logout: "/auth/logout",
        refresh: "/auth/refresh",
        profile: "/auth/profile",
        password: "/auth/password",
        reset: "/auth/reset",
        reset_confirm: "/auth/reset/confirm",
        verify: "/auth/verify",
      };
    }

    if (this.schemaProvider) {
      endpoints.schema = {
        describe: "/schema",
        types: "/schema/types",
        type: "/schema/types/:name",
      };
    }

    if (this.extensionRoutes.size > 0) {
      const extEndpoints: Record<string, string[]> = {};
      for (const [name, routes] of this.extensionRoutes) {
        extEndpoints[name] = routes.map((r) =>
          `${r.method} /ext/${name}${r.path}`
        );
      }
      endpoints.extensions = extEndpoints;
    }

    const info = {
      name: "Disc Database",
      version: "0.1.0",
      protocol: "HTTP/JSON",
      endpoints,
    };

    return new Response(JSON.stringify(info, null, 2), {
      headers: this.get_default_headers("application/json"),
    });
  }

  private async handle_query(
    request: Request,
    info: Deno.ServeHandlerInfo,
    requestId: string,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return this.create_error_response("Method Not Allowed", 405);
    }

    try {
      // Parse request body
      const body = await request.text();
      let queryRequest: Types.QueryRequest;

      try {
        queryRequest = JSON.parse(body);
      } catch {
        return this.create_error_response("Invalid JSON", 400);
      }

      // Validate request
      const validationErrors = this.protocolHandler.validateRequest(
        queryRequest,
      );
      if (validationErrors.length > 0) {
        return new Response(
          JSON.stringify({
            errors: validationErrors,
          }),
          {
            status: 400,
            headers: this.get_default_headers("application/json"),
          },
        );
      }

      // Resolve target database from request headers/params
      const queryUrl = new URL(request.url);
      const databaseName = this.resolveDatabaseName(request, queryUrl);

      // Validate the database exists in the registry (if registry is available)
      if (
        this.databaseRegistry &&
        !this.databaseRegistry.getDatabase(databaseName)
      ) {
        return this.create_error_response(
          `Unknown database: "${databaseName}"`,
          400,
        );
      }

      // Create connection and session
      const remoteAddr = "hostname" in info.remoteAddr
        ? info.remoteAddr.hostname
        : "unknown";
      const connection = this.connection_manager.createConnection(
        "http",
        remoteAddr,
        undefined,
        request.headers.get("user-agent") || undefined,
      );

      // Set the resolved database name on the session
      connection.session.database = databaseName;

      // Build auth context from JWT if auth middleware is configured
      const authContext: Types.AuthContext = { roles: [], permissions: [] };
      if (this.authMiddleware) {
        const authResult = await this.authMiddleware.authenticate(request);
        if (authResult) {
          authContext.userId = authResult.userId;
          authContext.jwtClaims = {
            sub: authResult.sub,
            email: authResult.email,
            username: authResult.username,
            iss: authResult.iss,
            aud: authResult.aud,
          };
        }
      }

      // Create query context
      const context: Types.QueryContext = {
        session: connection.session,
        auth: authContext,
        requestId,
        startedAt: new Date(),
        clientInfo: this.parse_client_info(request),
      };

      // Execute query with optional HTTP-level timeout safety net
      let response: Types.QueryResponse;
      const timeoutMs = this.config.requestTimeout;

      if (timeoutMs && timeoutMs > 0) {
        let timerId: number | undefined;

        const timeoutPromise = new Promise<Types.QueryResponse>(
          (_resolve, reject) => {
            timerId = setTimeout(() => {
              reject(new Error("__HTTP_TIMEOUT__"));
            }, timeoutMs);
          },
        );

        try {
          response = await Promise.race([
            this.protocolHandler.handleRequest(queryRequest, context),
            timeoutPromise,
          ]);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "__HTTP_TIMEOUT__"
          ) {
            this.stats.failed_requests++;
            return new Response(
              JSON.stringify({
                errors: [{
                  message: `Request timed out after ${timeoutMs}ms`,
                  extensions: { code: "TIMEOUT" },
                }],
              }),
              {
                status: 408,
                headers: this.get_default_headers("application/json"),
              },
            );
          }
          throw error;
        } finally {
          if (timerId !== undefined) {
            clearTimeout(timerId);
          }
        }
      } else {
        response = await this.protocolHandler.handleRequest(
          queryRequest,
          context,
        );
      }

      // Update session activity
      this.session_manager.updateActivity(connection.session.sessionId);

      // Determine HTTP status based on response content
      // Errors with code "WARNING" are not real errors (e.g. dry-run mode)
      const hasRealErrors = response.errors?.some(
        (e) => e.extensions?.code !== "WARNING",
      );

      if (hasRealErrors && !response.data) {
        this.stats.failed_requests++;
        return new Response(JSON.stringify(response), {
          status: 400,
          headers: this.get_default_headers("application/json"),
        });
      }

      this.stats.successful_requests++;

      return new Response(JSON.stringify(response), {
        headers: this.get_default_headers("application/json"),
      });
    } catch (error) {
      log.error("Query execution failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });

      const errorResponse: Types.QueryResponse = {
        errors: [{
          message: "Internal server error",
          extensions: { code: "INTERNAL_ERROR" },
        }],
      };

      return new Response(JSON.stringify(errorResponse), {
        status: 500,
        headers: this.get_default_headers("application/json"),
      });
    }
  }

  private handle_health_live(): Response {
    return new Response(
      JSON.stringify({ status: "alive" }),
      {
        status: 200,
        headers: this.get_default_headers("application/json"),
      },
    );
  }

  private async handle_health_ready(): Promise<Response> {
    if (this.protocolHandler.checkHealth) {
      const health = await this.protocolHandler.checkHealth();
      const httpStatus = health.status === "unhealthy" ? 503 : 200;

      return new Response(
        JSON.stringify({ status: health.status }),
        {
          status: httpStatus,
          headers: this.get_default_headers("application/json"),
        },
      );
    }

    // No checkHealth on handler — assume healthy
    return new Response(
      JSON.stringify({ status: "healthy" }),
      {
        status: 200,
        headers: this.get_default_headers("application/json"),
      },
    );
  }

  private async handle_health(): Promise<Response> {
    // Gather extension health if available
    let extensionHealth:
      | Record<string, { healthy: boolean; details?: string }>
      | undefined;
    if (this.extensionHealthGetter) {
      const extMap = await this.extensionHealthGetter();
      if (extMap.size > 0) {
        extensionHealth = Object.fromEntries(extMap);
      }
    }

    if (this.protocolHandler.checkHealth) {
      const health = await this.protocolHandler.checkHealth();
      const httpStatus = health.status === "unhealthy" ? 503 : 200;

      const body: Record<string, unknown> = {
        ...health,
        timestamp: new Date().toISOString(),
        uptimeMs: Date.now() - this.startTime.getTime(),
      };

      if (extensionHealth !== undefined) {
        body.extensions = extensionHealth;
      }

      return new Response(JSON.stringify(body, null, 2), {
        status: httpStatus,
        headers: this.get_default_headers("application/json"),
      });
    }

    // Fallback when handler does not support checkHealth
    const body: Record<string, unknown> = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptimeMs: Date.now() - this.startTime.getTime(),
      connections: this.connection_manager.get_stats(),
      memory: this.get_memory_stats(),
    };

    if (extensionHealth !== undefined) {
      body.extensions = extensionHealth;
    }

    return new Response(JSON.stringify(body, null, 2), {
      headers: this.get_default_headers("application/json"),
    });
  }

  private handle_stats(): Response {
    const subscriptionStats = this.subscription_handler
      .get_subscription_stats();

    // Gather handler-level cache/metrics stats if available
    const handlerStats = this.protocolHandler.getStats?.();

    const stats: Types.ServerStats & {
      subscriptions: typeof subscriptionStats;
    } = {
      connections: this.connection_manager.get_stats(),
      queries: {
        total: this.stats.total_requests,
        successful: this.stats.successful_requests,
        failed: this.stats.failed_requests,
        avgDurationMs: this.stats.total_requests > 0
          ? this.stats.total_duration_ms / this.stats.total_requests
          : 0,
      },
      transactions: this.transaction_manager.get_stats(),
      memoryUsage: this.get_memory_stats(),
      uptimeMs: Date.now() - this.startTime.getTime(),
      subscriptions: subscriptionStats,
      cache: handlerStats?.cache,
      queryMetrics: handlerStats?.queryMetrics,
      rateLimit: this.rate_limiter?.stats(),
    };

    return new Response(JSON.stringify(stats, null, 2), {
      headers: this.get_default_headers("application/json"),
    });
  }

  private handle_metrics(): Response {
    if (!this.config.enableMetrics) {
      return this.create_error_response("Not Found", 404);
    }

    const handlerStats = this.protocolHandler.getStats?.();
    const poolStats = this.protocolHandler.getPoolStats?.() ?? null;

    const source: MetricsSource = {
      http: {
        total_requests: this.stats.total_requests,
        successful_requests: this.stats.successful_requests,
        failed_requests: this.stats.failed_requests,
        total_duration_ms: this.stats.total_duration_ms,
      },
      cache: handlerStats?.cache,
      queryMetrics: handlerStats?.queryMetrics,
      pool: poolStats,
      rateLimit: this.rate_limiter?.stats(),
      uptimeMs: Date.now() - this.startTime.getTime(),
      memory: this.get_memory_stats(),
    };

    const body = renderMetrics(source);
    return new Response(body, {
      headers: new Headers({
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      }),
    });
  }

  private handle_preflight(request: Request): Response {
    if (!this.config.enableCors) {
      return this.create_error_response("CORS not enabled", 405);
    }

    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", this.get_cors_origin(request));
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");

    return new Response(null, { status: 204, headers });
  }

  private handle_websocket_upgrade(
    request: Request,
    info: Deno.ServeHandlerInfo,
  ): Response {
    const { socket, response } = Deno.upgradeWebSocket(request);

    const remoteAddr = "hostname" in info.remoteAddr
      ? info.remoteAddr.hostname
      : "unknown";
    const connection = this.connection_manager.createConnection(
      "websocket",
      remoteAddr,
      undefined,
      request.headers.get("user-agent") || undefined,
    );

    socket.onopen = () => {
      log.info("WebSocket connection opened", { connectionId: connection.id });
    };

    socket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await this.handle_websocket_message(socket, connection, message);
      } catch (error) {
        log.error("WebSocket message error", {
          error: error instanceof Error ? error.message : String(error),
        });
        socket.send(JSON.stringify({
          type: "error",
          payload: { message: "Invalid message format" },
        }));
      }
    };

    socket.onclose = () => {
      log.info("WebSocket connection closed", { connectionId: connection.id });
      this.subscription_handler.cleanup_connection(
        connection.session.sessionId,
      );
      this.connection_manager.closeConnection(connection.id);
    };

    socket.onerror = (_error) => {
      log.error("WebSocket error", { connectionId: connection.id });
    };

    return response;
  }

  private async handle_websocket_message(
    socket: WebSocket,
    connection: Types.Connection,
    message: any,
  ): Promise<void> {
    const { type, payload } = message;

    switch (type) {
      case "query": {
        const context: Types.QueryContext = {
          session: connection.session,
          auth: {
            roles: [],
            permissions: [],
            ...connection.session.variables?._auth_context,
          },
          requestId: this.generate_request_id(),
          startedAt: new Date(),
        };

        try {
          const response = await this.protocolHandler.handleRequest(
            payload,
            context,
          );
          socket.send(JSON.stringify({
            type: "query_result",
            payload: response,
          }));
        } catch (error) {
          const errorMessage = error instanceof Error
            ? error.message
            : "Unknown error";
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
          requestId: this.generate_request_id(),
          startedAt: new Date(),
        };

        try {
          await this.subscription_handler.handleSubscription(
            payload,
            context,
            socket,
          );
        } catch (error) {
          const errorMessage = error instanceof Error
            ? error.message
            : "Unknown subscription error";
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: errorMessage },
          }));
        }
        break;
      }

      case "unsubscribe": {
        const { subscriptionId } = payload;
        if (subscriptionId) {
          this.subscription_handler.stop_subscription(subscriptionId);
          socket.send(JSON.stringify({
            type: "subscription_stopped",
            payload: { subscriptionId },
          }));
        } else {
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: "subscriptionId is required for unsubscribe" },
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

  private async handleExtensionRoute(
    request: Request,
    url: URL,
  ): Promise<Response> {
    // Parse /ext/<name>/<path>
    const parts = url.pathname.slice(5).split("/"); // strip "/ext/"
    const extName = parts[0];
    const extPath = "/" + parts.slice(1).join("/");

    const routes = this.extensionRoutes.get(extName);
    if (!routes) {
      return this.create_error_response(
        `Extension "${extName}" not found`,
        404,
      );
    }

    const route = routes.find(
      (r) => r.path === extPath && r.method === request.method,
    );
    if (!route) {
      return this.create_error_response("Extension route not found", 404);
    }

    try {
      return await route.handler(request);
    } catch (error) {
      log.error("Extension route error", {
        extension: extName,
        path: extPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.create_error_response("Extension error", 500);
    }
  }

  private handle_schema_route(url: URL): Response {
    if (!this.schemaProvider) {
      return this.create_error_response(
        "Schema introspection not configured",
        404,
      );
    }

    const routeCtx = {
      schemaProvider: this.schemaProvider,
      defaultHeaders: () => this.get_default_headers("application/json"),
    };

    // Exact match: /schema
    if (url.pathname === "/schema") {
      return handleGetSchema(routeCtx);
    }

    // Exact match: /schema/types
    if (url.pathname === "/schema/types") {
      return handleGetSchemaTypes(routeCtx, url);
    }

    // Pattern match: /schema/types/:name
    if (url.pathname.startsWith("/schema/types/")) {
      const typeName = decodeURIComponent(
        url.pathname.slice("/schema/types/".length),
      );
      if (typeName) {
        return handleGetSchemaType(routeCtx, typeName);
      }
    }

    return this.create_error_response("Not Found", 404);
  }

  private async handle_auth_route(
    request: Request,
    url: URL,
  ): Promise<Response> {
    if (!this.authRoutes) {
      return this.create_error_response("Authentication not configured", 404);
    }

    // Strip /auth/ prefix to get the route
    const route = url.pathname.slice(6); // "/auth/".length === 6

    switch (route) {
      case "register":
        return await this.authRoutes.register()(request);
      case "login":
        return await this.authRoutes.login()(request);
      case "logout":
        return await this.authRoutes.logout()(request);
      case "refresh":
        return await this.authRoutes.refresh()(request);
      case "profile":
        return await this.authRoutes.profile()(request);
      case "password":
        return await this.authRoutes.updatePassword()(request);
      case "reset":
        return await this.authRoutes.resetPasswordRequest()(request);
      case "reset/confirm":
        return await this.authRoutes.resetPassword()(request);
      case "verify":
        return await this.authRoutes.verifyEmail()(request);
      default:
        return this.create_error_response("Unknown auth endpoint", 404);
    }
  }

  private get_default_headers(contentType: string): Headers {
    const headers = new Headers();
    headers.set("Content-Type", contentType);

    if (this.config.enableCors) {
      headers.set("Access-Control-Allow-Origin", "*"); // TODO: Use config origins
      headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );
    }

    return headers;
  }

  private get_cors_origin(request: Request): string {
    const origin = request.headers.get("origin");
    if (!origin) return "*";

    if (this.config.corsOrigins && this.config.corsOrigins.includes(origin)) {
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

  /**
   * Resolve the target database name from the request.
   * Precedence: X-Database header > ?database= query param > "disc" (default).
   */
  private resolveDatabaseName(request: Request, url: URL): string {
    const headerValue = request.headers.get("X-Database");
    if (headerValue) {
      return headerValue;
    }

    const paramValue = url.searchParams.get("database");
    if (paramValue) {
      return paramValue;
    }

    return "disc";
  }

  private parse_client_info(
    request: Request,
  ): Types.QueryContext["clientInfo"] {
    const userAgent = request.headers.get("user-agent");
    if (!userAgent) return undefined;

    // Parse common client patterns
    if (userAgent.includes("disc-client")) {
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

  private get_memory_stats(): Types.ServerStats["memoryUsage"] {
    const memoryUsage = Deno.memoryUsage();
    return {
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      external: memoryUsage.external,
    };
  }

  private start_cleanup_intervals(): void {
    // Cleanup idle connections every 5 minutes
    this.cleanup_interval_ids.push(setInterval(() => {
      const cleaned = this.connection_manager.cleanupIdleConnections();
      if (cleaned > 0) {
        log.debug("Cleaned up idle connections", { count: cleaned });
      }
    }, 5 * 60 * 1000));

    // Cleanup expired sessions every 10 minutes
    this.cleanup_interval_ids.push(setInterval(() => {
      const cleaned = this.session_manager.cleanupExpiredSessions();
      if (cleaned > 0) {
        log.debug("Cleaned up expired sessions", { count: cleaned });
      }
    }, 10 * 60 * 1000));

    // Cleanup abandoned transactions every 2 minutes
    this.cleanup_interval_ids.push(setInterval(() => {
      const cleaned = this.transaction_manager.cleanupAbandonedTransactions();
      if (cleaned > 0) {
        log.debug("Cleaned up abandoned transactions", { count: cleaned });
      }
    }, 2 * 60 * 1000));
  }

  private generate_request_id(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
}

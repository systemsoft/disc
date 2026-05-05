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
import {
  handleGetMigrations,
  type MigrationsProvider,
} from "./migrations-endpoint.ts";

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
  migrationsProvider?: MigrationsProvider;
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
  private migrationsProvider?: MigrationsProvider;
  private rate_limiter?: RateLimiter;
  private server?: Deno.HttpServer<Deno.NetAddr>;
  private redirect_server?: Deno.HttpServer<Deno.NetAddr>;
  private tls_watcher?: import("./tls-reload.ts").TlsCertWatcher;
  private request_handler?: (
    request: Request,
    info: Deno.ServeHandlerInfo,
  ) => Response | Promise<Response>;
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
    this.migrationsProvider = options.migrationsProvider;
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
    this.request_handler = handler;

    if (this.config.tls) {
      const cert = await Deno.readTextFile(this.config.tls.certFile);
      const key = await Deno.readTextFile(this.config.tls.keyFile);
      this.server = Deno.serve({
        hostname: this.config.host,
        port: this.config.port,
        cert,
        key,
      }, handler);

      // Start file-watch-driven TLS hot-reload when opted in.
      // (gh/geldata#4277, ports geldata/gel#4297)
      if (this.config.tls.reload) {
        const { TlsCertWatcher } = await import("./tls-reload.ts");
        this.tls_watcher = new TlsCertWatcher({
          certFile: this.config.tls.certFile,
          keyFile: this.config.tls.keyFile,
          debounceMs: this.config.tls.reloadDebounceMs,
          onReload: (newCert, newKey) =>
            this.swapTlsListener(newCert, newKey),
        });
        this.tls_watcher.start();
      }
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

    // Dispose auth-route rate limiter (see auth/integration.ts — each
    // AuthRoutes owns its own per-IP limiter for login/register/reset).
    this.authRoutes?.dispose();

    // Stop the TLS file watcher before tearing down the listener.
    if (this.tls_watcher) {
      await this.tls_watcher.stop();
      this.tls_watcher = undefined;
    }

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
   * Hot-reload TLS by swapping the active listener for a new one
   * configured with the given cert + key. The old listener is shut
   * down (drains in-flight requests) and a new one is started on the
   * same host:port. Brief blip in connection accepts is expected; the
   * trade-off avoids needing a custom TLS-handshake layer to swap
   * `SSL_CTX` in place.
   *
   * If construction of the new listener throws (malformed cert, bad
   * key/cert pair, port collision), we log critical and **keep the old
   * listener running** — losing TLS reload is bad but losing the
   * server entirely is worse. (gh/geldata#4277, ports geldata/gel#4297)
   *
   * Public so operators can also trigger a reload programmatically
   * (for tests, admin endpoints, etc.).
   */
  async reloadTls(): Promise<void> {
    if (!this.config.tls) {
      throw new Error("reloadTls called but TLS is not configured");
    }
    const cert = await Deno.readTextFile(this.config.tls.certFile);
    const key = await Deno.readTextFile(this.config.tls.keyFile);
    await this.swapTlsListener(cert, key);
  }

  private async swapTlsListener(cert: string, key: string): Promise<void> {
    if (!this.config.tls || !this.request_handler) {
      log.warn("swapTlsListener invoked before server start; ignoring");
      return;
    }

    const oldServer = this.server;
    let newServer: Deno.HttpServer<Deno.NetAddr> | undefined;

    try {
      // Drain old listener first — Deno can't bind two TLS listeners
      // to the same port simultaneously without SO_REUSEPORT.
      log.info("TLS hot-reload: draining old listener");
      if (oldServer) {
        await oldServer.shutdown();
      }

      newServer = Deno.serve({
        hostname: this.config.host,
        port: this.config.port,
        cert,
        key,
      }, this.request_handler);

      this.server = newServer;
      log.info("TLS hot-reload: new listener up", {
        host: this.config.host,
        port: this.config.port,
      });
    } catch (err) {
      log.error(
        "TLS hot-reload failed; old listener has already been drained",
        { error: err instanceof Error ? err.message : String(err) },
      );
      // Best-effort recovery: try to restart with the *previous* cert
      // we know was valid.
      try {
        const fallbackCert = await Deno.readTextFile(this.config.tls.certFile);
        const fallbackKey = await Deno.readTextFile(this.config.tls.keyFile);
        this.server = Deno.serve({
          hostname: this.config.host,
          port: this.config.port,
          cert: fallbackCert,
          key: fallbackKey,
        }, this.request_handler);
        log.warn("TLS hot-reload: recovered listener with on-disk cert/key");
      } catch (recoveryErr) {
        log.error("TLS hot-reload: recovery failed; server is now down", {
          error: recoveryErr instanceof Error
            ? recoveryErr.message
            : String(recoveryErr),
        });
        throw recoveryErr;
      }
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

      // Auth gate. When `config.requireAuth` is enabled, protected
      // routes need a valid `Authorization: Bearer <JWT>` header before
      // the route handler runs. Returns a 401/503 response on failure
      // or `null` when the request may proceed. (gh/geldata#6345)
      const authResult = await this.gateAuth(request, url);
      if (authResult instanceof Response) {
        return authResult;
      }
      const authedContext = authResult; // AuthContext | null

      // Extension route handling
      if (url.pathname.startsWith("/ext/")) {
        return await this.handleExtensionRoute(request, url, authedContext);
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
          return this.handle_root(request);
        case "/query":
          return await this.handle_query(request, info, requestId);
        case "/health":
          return await this.handle_health(request);
        case "/health/live":
          return this.handle_health_live(request);
        case "/health/ready":
          return await this.handle_health_ready(request);
        case "/stats":
          return this.handle_stats(request);
        case "/metrics":
          return this.handle_metrics(request);
        case "/migrations":
          return await this.handle_migrations(request);
        default:
          return this.create_error_response("Not Found", 404, request);
      }
    } catch (error) {
      this.stats.failed_requests++;
      log.error("Request failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.create_error_response("Internal Server Error", 500, request);
    } finally {
      const duration = Date.now() - startTime;
      this.stats.total_duration_ms += duration;
      this.in_flight_requests--;
    }
  }

  /**
   * Public-route allowlist. These paths are reachable without a JWT
   * even when `config.requireAuth` is enabled — they're either part of
   * the auth flow itself (you can't log in with a token you don't have
   * yet) or unauthenticated by design (health probes for orchestrators).
   * (gh/geldata#6345, ports geldata/gel#6352)
   */
  private isPublicRoute(pathname: string): boolean {
    if (pathname === "/") return true;
    if (pathname.startsWith("/auth/")) return true;
    if (pathname === "/health" || pathname.startsWith("/health/")) return true;
    return false;
  }

  /**
   * Authenticate the request when `config.requireAuth` is on. Returns
   * `null` to indicate "proceed without an attached context" (public
   * route or auth disabled), an `AuthContext` when the JWT verified,
   * or a 401/503 `Response` to short-circuit the dispatcher.
   *
   * 503 (not 401) when `requireAuth=true` but no `authMiddleware` is
   * wired — that's a misconfig that would otherwise let traffic
   * through. Fail loud.
   */
  private async gateAuth(
    request: Request,
    url: URL,
  ): Promise<import("../auth/middleware.ts").AuthContext | null | Response> {
    if (!this.config.requireAuth) {
      // Permissive mode — populate context if we can, but don't reject.
      if (!this.authMiddleware) return null;
      return await this.authMiddleware.authenticate(request);
    }

    if (this.isPublicRoute(url.pathname)) return null;

    if (!this.authMiddleware) {
      log.error(
        "requireAuth=true but no authMiddleware configured — rejecting request",
        { path: url.pathname },
      );
      return new Response(
        JSON.stringify({
          error: "Authentication required but auth provider not configured",
        }),
        {
          status: 503,
          headers: this.get_default_headers("application/json"),
        },
      );
    }

    const ctx = await this.authMiddleware.authenticate(request);
    if (!ctx) {
      const headers = this.get_default_headers("application/json");
      // RFC 6750 §3 — return a WWW-Authenticate challenge so clients
      // know which scheme to retry with.
      headers.set("WWW-Authenticate", 'Bearer realm="disc"');
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers },
      );
    }
    return ctx;
  }

  private handle_root(request?: Request): Response {
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
        anonymous: "/auth/anonymous",
        upgrade: "/auth/upgrade",
        mfa_totp_enroll: "/auth/mfa/totp/enroll",
        mfa_totp_confirm: "/auth/mfa/totp/confirm",
        mfa_totp_disable: "/auth/mfa/totp/disable",
        mfa_totp_login: "/auth/mfa/totp/login",
        magic_link_request: "/auth/magic-link/request",
        magic_link_consume: "/auth/magic-link/consume",
        recovery_codes_generate: "/auth/mfa/recovery-codes/generate",
        recovery_codes_login: "/auth/mfa/recovery-codes/login",
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
      headers: this.get_default_headers("application/json", request),
    });
  }

  private async handle_query(
    request: Request,
    info: Deno.ServeHandlerInfo,
    requestId: string,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return this.create_error_response("Method Not Allowed", 405, request);
    }

    // P1-12: cap request body size BEFORE reading it into memory. Without
    // this a malicious client can stream multi-gigabyte payloads and OOM
    // the server.
    const MAX_QUERY_BODY_BYTES = this.config.maxRequestBodyBytes ??
      4 * 1024 * 1024; // 4 MiB default
    const contentLengthHeader = request.headers.get("content-length");
    if (contentLengthHeader !== null) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > MAX_QUERY_BODY_BYTES) {
        return this.create_error_response(
          `Request body exceeds maximum of ${MAX_QUERY_BODY_BYTES} bytes`,
          413,
          request,
        );
      }
    }

    try {
      // Parse request body
      const body = await request.text();
      if (body.length > MAX_QUERY_BODY_BYTES) {
        return this.create_error_response(
          `Request body exceeds maximum of ${MAX_QUERY_BODY_BYTES} bytes`,
          413,
          request,
        );
      }
      let queryRequest: Types.QueryRequest;

      try {
        queryRequest = JSON.parse(body);
      } catch {
        return this.create_error_response("Invalid JSON", 400, request);
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
          // RBAC: roles come from the JWT claim populated by
          // `AuthProvider.generateJWT` at login. (gh/geldata#8177)
          if (authResult.roles && authResult.roles.length > 0) {
            authContext.roles = authResult.roles;
          }
          authContext.jwtClaims = {
            sub: authResult.sub,
            email: authResult.email,
            username: authResult.username,
            iss: authResult.iss,
            aud: authResult.aud,
            roles: authResult.roles,
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

  private handle_health_live(request?: Request): Response {
    return new Response(
      JSON.stringify({ status: "alive" }),
      {
        status: 200,
        headers: this.get_default_headers("application/json", request),
      },
    );
  }

  private async handle_health_ready(request?: Request): Promise<Response> {
    if (this.protocolHandler.checkHealth) {
      const health = await this.protocolHandler.checkHealth();
      const httpStatus = health.status === "unhealthy" ? 503 : 200;

      return new Response(
        JSON.stringify({ status: health.status }),
        {
          status: httpStatus,
          headers: this.get_default_headers("application/json", request),
        },
      );
    }

    // No checkHealth on handler — assume healthy
    return new Response(
      JSON.stringify({ status: "healthy" }),
      {
        status: 200,
        headers: this.get_default_headers("application/json", request),
      },
    );
  }

  private async handle_health(request?: Request): Promise<Response> {
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
        headers: this.get_default_headers("application/json", request),
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
      headers: this.get_default_headers("application/json", request),
    });
  }

  private handle_stats(request?: Request): Response {
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
      headers: this.get_default_headers("application/json", request),
    });
  }

  private handle_metrics(request?: Request): Response {
    if (!this.config.enableMetrics) {
      return this.create_error_response("Not Found", 404, request);
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
    const headers = new Headers({
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
    if (this.config.enableCors) {
      const origin = this.resolve_allowed_origin(request);
      if (origin !== null) {
        headers.set("Access-Control-Allow-Origin", origin);
      }
    }
    return new Response(body, { headers });
  }

  private handle_preflight(request: Request): Response {
    if (!this.config.enableCors) {
      return this.create_error_response("CORS not enabled", 405);
    }

    const allowedOrigin = this.get_cors_origin(request);
    if (allowedOrigin === null) {
      // Origin not in allowlist — reject preflight instead of falsely allowing
      return new Response(null, { status: 403 });
    }

    const headers = new Headers();
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
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
    authContext?: import("../auth/middleware.ts").AuthContext | null,
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
      // gh/geldata#6345 — forward auth context so extensions (graphql,
      // custom-functions, …) can enforce per-route authorization.
      return await route.handler(request, authContext ?? undefined);
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

  private async handle_migrations(_request: Request): Promise<Response> {
    if (!this.migrationsProvider) {
      return this.create_error_response(
        "Migration history not configured",
        404,
      );
    }

    return await handleGetMigrations({
      migrationsProvider: this.migrationsProvider,
      defaultHeaders: () => this.get_default_headers("application/json"),
    });
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
      case "anonymous":
        return await this.authRoutes.loginAnonymous()(request);
      case "upgrade":
        return await this.authRoutes.upgradeAnonymous()(request);
      case "mfa/totp/enroll":
        return await this.authRoutes.enrollTOTP()(request);
      case "mfa/totp/confirm":
        return await this.authRoutes.confirmTOTP()(request);
      case "mfa/totp/disable":
        return await this.authRoutes.disableTOTP()(request);
      case "mfa/totp/login":
        return await this.authRoutes.loginWithTOTP()(request);
      case "magic-link/request":
        return await this.authRoutes.requestMagicLink()(request);
      case "magic-link/consume":
        return await this.authRoutes.consumeMagicLink()(request);
      case "mfa/recovery-codes/generate":
        return await this.authRoutes.generateRecoveryCodes()(request);
      case "mfa/recovery-codes/login":
        return await this.authRoutes.loginWithRecoveryCode()(request);
      default:
        return this.create_error_response("Unknown auth endpoint", 404);
    }
  }

  private get_default_headers(contentType: string, request?: Request): Headers {
    const headers = new Headers();
    headers.set("Content-Type", contentType);

    if (this.config.enableCors) {
      const origin = this.resolve_allowed_origin(request);
      // When corsOrigins is configured (restrictive mode) and the request's
      // Origin isn't in the allowlist, don't emit CORS headers — the browser
      // will block the response, which is the correct behavior.
      if (origin !== null) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization",
        );
      }
    }

    return headers;
  }

  /**
   * Resolve the `Access-Control-Allow-Origin` header value.
   *
   * - If `corsOrigins` is configured: echo the request Origin only when it
   *   appears in the allowlist; otherwise return `null` (no CORS header).
   * - If `corsOrigins` is not configured: permissive `"*"` for local dev.
   *
   * Returns `null` when no CORS header should be emitted.
   */
  private resolve_allowed_origin(request?: Request): string | null {
    const allowlist = this.config.corsOrigins;

    // Restrictive mode: origin must be in the allowlist
    if (allowlist && allowlist.length > 0) {
      const origin = request?.headers.get("origin");
      if (origin && allowlist.includes(origin)) {
        return origin;
      }
      return null;
    }

    // Permissive mode (dev default): wildcard
    return "*";
  }

  private get_cors_origin(request: Request): string | null {
    return this.resolve_allowed_origin(request);
  }

  private create_error_response(
    message: string,
    status: number,
    request?: Request,
  ): Response {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: this.get_default_headers("application/json", request),
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

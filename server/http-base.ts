/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * HTTP server base layer — options, instance state, lifecycle
 * (start/stop, TLS hot-reload, drain), hot-reload config setters, and
 * low-level header/CORS/response helpers. Extended by
 * `HttpRouteHandlers` (route handlers, `server/http-handlers.ts`) and
 * `HttpServer` (dispatch, `server/http.ts`).
 */

import { parseConnectionString } from "../lib/database.ts";
import { getLogger } from "../lib/logger.ts";
import { computeCertExpiry } from "./tls-cert-info.ts";
import * as Types from "./types.ts";

const log = getLogger("http");
import type { AuthRoutes } from "../auth/integration.ts";
import type { AuthMiddleware } from "../auth/middleware.ts";
import type { AuthProvider } from "../auth/provider.ts";
import type { ExtensionRoute } from "../extensions/types.ts";
import type { DataWatchRegistry } from "./admin/data-watch-registry.ts";
import {
  ConnectionManager,
  SessionManager,
  TransactionManager
} from "./connection.ts";
import { matchCorsOrigin } from "./cors-matcher.ts";
import type { DatabaseRegistry } from "./database-registry.ts";
import type { MigrationsProvider } from "./migrations-endpoint.ts";
import { RateLimiter } from "./rate-limiter.ts";
import type { SchemaProvider } from "./schema-endpoint.ts";
import { SubscriptionHandler } from "./subscription-handler.ts";
import { createUiAssetHandler, type UiAssetHandler } from "./ui-assets.ts";

export const DEFAULT_CORS_METHODS = ["GET", "POST", "OPTIONS"];
export const DEFAULT_CORS_HEADERS = ["Content-Type", "Authorization"];
export const DEFAULT_CORS_MAX_AGE = 86400;

export interface HttpServerOptions {
  config: Types.ServerConfig;
  protocolHandler: Types.ProtocolHandler;
  authProvider?: AuthProvider;
  authMiddleware?: AuthMiddleware;
  authRoutes?: AuthRoutes;
  extensionRoutes?: Map<string, ExtensionRoute[]>;
  extensionHealthGetter?: () => Promise<
    Map<string, { healthy: boolean; details?: string; }>
  >;
  databaseRegistry?: DatabaseRegistry;
  schemaProvider?: SchemaProvider;
  migrationsProvider?: MigrationsProvider;
  /**
   * File-storage manager backing the `/files/*` endpoints. Optional:
   * apps that don't need uploads omit it and the routes return 404.
   * (gh/geldata#3567)
   */
  fileManager?: import("../lib/file-storage/manager.ts").FileManager;
  /**
   * Live-schema-diff admin wiring (Bundle K — Disc-original feature
   * #3a). When set, the HTTP server mounts:
   *   GET  /admin/schema-watch  — SSE stream of diff snapshots
   *   POST /admin/schema-apply  — apply the on-disk schema
   * Both routes are gated by the standard auth gate. Omitted → 404.
   */
  adminSchemaWatch?: {
    source: import("./admin/schema-watch.ts").SchemaWatchSource;
    appliedSdlProvider: () => string;
    onApplied?: (newSdl: string) => void;
  };
  /**
   * Live data-subscription registry (Bundle L — Disc-original feature
   * #3c). When set, the HTTP server mounts:
   *   GET /admin/data-watch?tables=…  — SSE invalidation stream
   * Disabled when `config.enableDataWatch === false`. Omitted → 404.
   */
  dataWatchRegistry?: DataWatchRegistry;
}

export abstract class HttpServerBase {
  protected config: Types.ServerConfig;
  protected protocolHandler: Types.ProtocolHandler;
  protected connection_manager: ConnectionManager;
  protected session_manager: SessionManager;
  protected transaction_manager: TransactionManager;
  protected subscription_handler: SubscriptionHandler;
  protected authMiddleware?: AuthMiddleware;
  protected authRoutes?: AuthRoutes;
  protected fileManager?: import("../lib/file-storage/manager.ts").FileManager;
  protected extensionRoutes: Map<string, ExtensionRoute[]>;
  protected extensionHealthGetter?: () => Promise<
    Map<string, { healthy: boolean; details?: string; }>
  >;
  protected databaseRegistry?: DatabaseRegistry;
  protected schemaProvider?: SchemaProvider;
  protected migrationsProvider?: MigrationsProvider;
  protected adminSchemaWatch?: HttpServerOptions["adminSchemaWatch"];
  protected dataWatchRegistry?: DataWatchRegistry;
  protected rate_limiter?: RateLimiter;
  protected uiAssetHandler: UiAssetHandler;
  private server?: Deno.HttpServer<Deno.NetAddr>;
  private redirect_server?: Deno.HttpServer<Deno.NetAddr>;
  private tls_watcher?: import("./tls-reload.ts").TlsCertWatcher;
  /**
   * Cached leaf-certificate `notAfter` timestamp (unix epoch seconds).
   * Refreshed on initial TLS bind and on every successful hot-reload so
   * the Prometheus exporter can publish an up-to-date expiry gauge.
   * (Ports geldata/gel#6205.)
   */
  protected tls_not_after_unix?: number;
  private request_handler?: (
    request: Request,
    info: Deno.ServeHandlerInfo
  ) => Response | Promise<Response>;
  private cleanup_interval_ids: ReturnType<typeof setInterval>[] = [];
  protected startTime: Date;
  protected in_flight_requests = 0;
  protected shutting_down = false;
  protected stats = {
    total_requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    total_duration_ms: 0
  };

  constructor(options: HttpServerOptions) {
    this.config = options.config;
    this.protocolHandler = options.protocolHandler;
    this.authMiddleware = options.authMiddleware;
    this.authRoutes = options.authRoutes;
    this.fileManager = options.fileManager;
    this.extensionRoutes = options.extensionRoutes || new Map();
    this.extensionHealthGetter = options.extensionHealthGetter;
    this.databaseRegistry = options.databaseRegistry;
    this.schemaProvider = options.schemaProvider;
    this.migrationsProvider = options.migrationsProvider;
    this.adminSchemaWatch = options.adminSchemaWatch;
    this.dataWatchRegistry = options.dataWatchRegistry;
    this.connection_manager = new ConnectionManager();
    this.session_manager = new SessionManager();
    this.transaction_manager = new TransactionManager();
    this.subscription_handler = new SubscriptionHandler();
    this.uiAssetHandler = createUiAssetHandler();
    this.startTime = new Date();

    if (
      options.config.rateLimitRpm && options.config.rateLimitRpm > 0
    ) {
      this.rate_limiter = new RateLimiter({
        requestsPerMinute: options.config.rateLimitRpm,
        burstSize: options.config.rateLimitBurst ||
          options.config.rateLimitRpm
      });
    }
  }

  /**
   * The port the listener actually bound to. When the server is started
   * with `port: 0` the OS assigns a free ephemeral port; read this after
   * `start()` to learn it. Tests should bind on 0 and use this instead of
   * guessing a port, which avoids `AddrInUse` flakes from port collisions.
   * Throws if read before the listener is bound.
   */
  get boundPort(): number {
    const addr = this.server?.addr;
    if (!addr) {
      throw new Error("boundPort read before the server bound a listener");
    }
    return addr.port;
  }

  async start(): Promise<void> {
    log.debug("Starting Disc HTTP server", {
      host: this.config.host,
      port: this.config.port
    });

    const handler = (request: Request, info: Deno.ServeHandlerInfo): Response | Promise<Response> => {
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
        key
      }, handler);

      this.refreshTlsCertExpiry(cert);

      // Start file-watch-driven TLS hot-reload when opted in.
      // (gh/geldata#4277, ports geldata/gel#4297)
      if (this.config.tls.reload) {
        const { TlsCertWatcher } = await import("./tls-reload.ts");
        this.tls_watcher = new TlsCertWatcher({
          certFile: this.config.tls.certFile,
          keyFile: this.config.tls.keyFile,
          debounceMs: this.config.tls.reloadDebounceMs,
          onReload: (newCert, newKey) => this.swapTlsListener(newCert, newKey)
        });
        this.tls_watcher.start();
      }
    } else {
      this.server = Deno.serve({
        hostname: this.config.host,
        onListen() {
          /*** We already expose the path/port, we don’t need it again ***/
        },
        port: this.config.port
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
            headers: { Location: url.toString() }
          });
        }
      });
    }

    // Start cleanup intervals
    this.start_cleanup_intervals();

    const protocol = this.config.tls ? "https" : "http";

    log.info("Disc server is running", {
      url: `${protocol}://${this.config.host}:${this.config.port}`
    });

    log.info("Server configuration", {
      cors: this.config.enableCors,
      websockets: this.config.enableWebsockets
    });

    await Promise.all([
      this.server.finished,
      ...(this.redirect_server ? [this.redirect_server.finished] : [])
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
      // deno-lint-ignore no-console
      console.log("");
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
        key
      }, this.request_handler);

      this.server = newServer;
      this.refreshTlsCertExpiry(cert);
      log.info("TLS hot-reload: new listener up", {
        host: this.config.host,
        port: this.config.port
      });
    } catch (err) {
      log.error(
        "TLS hot-reload failed; old listener has already been drained",
        { error: err instanceof Error ? err.message : String(err) }
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
          key: fallbackKey
        }, this.request_handler);
        log.warn("TLS hot-reload: recovered listener with on-disk cert/key");
      } catch (recoveryErr) {
        log.error("TLS hot-reload: recovery failed; server is now down", {
          error: recoveryErr instanceof Error ?
            recoveryErr.message :
            String(recoveryErr)
        });
        throw recoveryErr;
      }
    }
  }

  /**
   * Decode the active leaf cert and cache its `notAfter` for the
   * Prometheus exporter. Failures here are non-fatal: a parse error
   * just means the expiry gauge stays unset for this scrape, never
   * that the server fails to start. Ports geldata/gel#6205.
   */
  private refreshTlsCertExpiry(cert: string): void {
    try {
      const expiry = computeCertExpiry(cert);
      this.tls_not_after_unix = expiry.notAfterUnix;
      log.info("TLS certificate expiry refreshed", {
        notAfter: expiry.notAfter.toISOString(),
        secondsUntilExpiry: expiry.secondsUntilExpiry
      });
    } catch (err) {
      this.tls_not_after_unix = undefined;
      log.warn("Failed to decode TLS leaf certificate notAfter", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  /**
   * Hot-reload setters for config knobs that are safe to mutate while the
   * server is running. Each request reads the current `this.config` value,
   * so a plain field-mutation here takes effect on the very next request.
   * Used by `DiscServer.reloadConfig()` (gh/geldata#4278).
   */
  updateRequestTimeout(ms: number): void {
    this.config.requestTimeout = ms;
    log.info("config reload: requestTimeout updated", { value: ms });
  }

  updateCorsEnabled(enabled: boolean): void {
    this.config.enableCors = enabled;
    log.info("config reload: enableCors updated", { value: enabled });
  }

  updateCorsAllowedOrigins(origins: string[] | undefined): void {
    this.config.corsOrigins = origins;
    log.info("config reload: corsOrigins updated", {
      value: origins ?? null
    });
  }

  updateSlowQueryThreshold(ms: number): void {
    this.config.slowQueryThresholdMs = ms;
    log.info("config reload: slowQueryThresholdMs updated", { value: ms });
  }

  updateExplainCacheTtl(ms: number): void {
    // The actual EXPLAIN cache lives on the protocol handler. The HTTP
    // server doesn't read this value directly, but we mirror it on
    // `this.config` so /stats and similar surfaces see the new value.
    // The protocol handler is updated separately by the caller.
    (this.config as Types.ServerConfig & { explainCacheTtlMs?: number; })
      .explainCacheTtlMs = ms;
    log.info("config reload: explainCacheTtlMs updated", { value: ms });
  }

  /**
   * Drain in-flight requests by setting the shutting_down flag and polling
   * until all requests complete or the timeout expires.
   */
  async drain(timeoutMs: number): Promise<void> {
    this.shutting_down = true;

    const deadline = Date.now() + timeoutMs;
    while (this.in_flight_requests > 0 && Date.now() < deadline) {
      await new Promise<void>(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Returns the current number of in-flight requests being processed.
   */
  getInFlightCount(): number {
    return this.in_flight_requests;
  }

  /**
   * Request dispatcher — implemented by `HttpServer` in
   * `server/http.ts`. Declared abstract here so `start()` can install
   * it as the `Deno.serve` handler.
   */
  protected abstract handleRequest(
    request: Request,
    info: Deno.ServeHandlerInfo
  ): Promise<Response>;

  protected get_default_headers(contentType: string, request?: Request): Headers {
    const headers = new Headers();
    headers.set("Content-Type", contentType);

    if (this.config.enableCors) {
      const origin = this.resolve_allowed_origin(request);
      // When corsOrigins is configured (restrictive mode) and the request's
      // Origin isn't in the allowlist, don't emit CORS headers — the browser
      // will block the response, which is the correct behavior.
      if (origin !== null) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set(
          "Access-Control-Allow-Methods",
          (this.config.corsAllowedMethods ?? DEFAULT_CORS_METHODS).join(", ")
        );
        headers.set(
          "Access-Control-Allow-Headers",
          (this.config.corsAllowedHeaders ?? DEFAULT_CORS_HEADERS).join(", ")
        );
        if (this.config.corsExposeHeaders?.length) {
          headers.set(
            "Access-Control-Expose-Headers",
            this.config.corsExposeHeaders.join(", ")
          );
        }
        // `Access-Control-Allow-Credentials: true` is forbidden with the
        // wildcard origin per the CORS spec — only emit when an explicit
        // allowlist resolved the request.
        if (this.config.corsAllowCredentials && origin !== "*") {
          headers.set("Access-Control-Allow-Credentials", "true");
        }
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
  protected resolve_allowed_origin(request?: Request): string | null {
    const allowlist = this.config.corsOrigins;

    // Restrictive mode: origin must match the allowlist (exact or wildcard)
    if (allowlist && allowlist.length > 0) {
      const origin = request?.headers.get("origin");
      if (origin && matchCorsOrigin(origin, allowlist)) {
        return origin;
      }
      return null;
    }

    // Permissive mode (dev default): wildcard
    return "*";
  }

  protected get_cors_origin(request: Request): string | null {
    return this.resolve_allowed_origin(request);
  }

  protected create_error_response(
    message: string,
    status: number,
    request?: Request
  ): Response {
    return new Response(JSON.stringify({ error: message }), {
      status,
      headers: this.get_default_headers("application/json", request)
    });
  }

  /**
   * Resolve the target database name from the request.
   * Precedence: X-Database header > ?database= query param > "disc" (default).
   */
  protected resolveDatabaseName(
    request: Request,
    url: URL,
    fallback = "disc"
  ): string {
    const headerValue = request.headers.get("X-Database");
    if (headerValue) {
      return headerValue;
    }

    const paramValue = url.searchParams.get("database");
    if (paramValue) {
      return paramValue;
    }

    return fallback;
  }

  /**
   * The database the server is configured to connect to, derived from the
   * DSN. For the bundled instance this is the project's instance name (the
   * DSN path segment), which the dashboard surfaces next to "Database
   * Overview" so users see their instance rather than the bare registry
   * default. Falls back to "disc" when the DSN can't be parsed.
   */
  protected configuredDatabaseName(): string {
    try {
      return parseConnectionString(this.config.databaseUrl).database || "disc";
    } catch {
      return "disc";
    }
  }

  protected parse_client_info(
    request: Request
  ): Types.QueryContext["clientInfo"] {
    const userAgent = request.headers.get("user-agent");
    if (!userAgent) {
      return undefined;
    }

    // Parse common client patterns
    if (userAgent.includes("disc-client")) {
      return {
        name: "disc-client",
        version: "unknown",
        library: "disc-ts"
      };
    }

    return {
      name: "unknown",
      version: "unknown",
      library: "http"
    };
  }

  protected get_memory_stats(): Types.ServerStats["memoryUsage"] {
    const memoryUsage = Deno.memoryUsage();
    return {
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      external: memoryUsage.external
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

  protected generate_request_id(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }
}

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * HTTP server route-handler layer — the endpoint implementations
 * (`/`, `/query`, health, stats, metrics, WebSocket, extensions,
 * files, admin, REST, schema, migrations) dispatched by
 * `HttpServer.handleRequest()` in `server/http.ts`. State, lifecycle,
 * and low-level helpers live on `HttpServerBase`
 * (`server/http-base.ts`).
 */

import { getLogger } from "../lib/logger.ts";
import { DISC_VERSION } from "../lib/version.ts";
import { renderMetrics } from "./metrics.ts";
import type { MetricsSource } from "./metrics.ts";
import * as Types from "./types.ts";

const log = getLogger("http");
import { handleSchemaApply } from "./admin/schema-apply.ts";
import { handleSchemaWatch } from "./admin/schema-watch.ts";
import {
  DEFAULT_CORS_HEADERS,
  DEFAULT_CORS_MAX_AGE,
  DEFAULT_CORS_METHODS,
  HttpServerBase
} from "./http-base.ts";
import { handleGetMigrations } from "./migrations-endpoint.ts";
import { renderOpenApiSpec } from "./rest/openapi.ts";
import { dispatchRest } from "./rest/router.ts";
import {
  handleGetSchema,
  handleGetSchemaType,
  handleGetSchemaTypes
} from "./schema-endpoint.ts";

export abstract class HttpRouteHandlers extends HttpServerBase {
  protected handle_root(request?: Request): Response {
    const endpoints: Record<string, any> = {
      query: "/query",
      health: "/health",
      healthLive: "/health/live",
      healthReady: "/health/ready",
      stats: "/stats",
      websocket: this.config.enableWebsockets ? "ws://upgrade" : null
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
        magic_code_request: "/auth/magic-code/request",
        magic_code_verify: "/auth/magic-code/verify",
        recovery_codes_generate: "/auth/mfa/recovery-codes/generate",
        recovery_codes_login: "/auth/mfa/recovery-codes/login",
        webauthn_register_begin: "/auth/webauthn/register/begin",
        webauthn_register_finish: "/auth/webauthn/register/finish",
        webauthn_login_begin: "/auth/webauthn/login/begin",
        webauthn_login_finish: "/auth/webauthn/login/finish",
        webauthn_credentials: "/auth/webauthn/credentials",
        webauthn_credentials_delete: "/auth/webauthn/credentials/delete"
      };
    }

    if (this.fileManager) {
      endpoints.files = {
        upload: "POST /files",
        list: "GET /files",
        get: "GET /files/:id",
        meta: "GET /files/:id/meta",
        delete: "DELETE /files/:id"
      };
    }

    if (this.schemaProvider) {
      endpoints.schema = {
        describe: "/schema",
        types: "/schema/types",
        type: "/schema/types/:name"
      };
    }

    endpoints.config = "/config";

    if (this.extensionRoutes.size > 0) {
      const extEndpoints: Record<string, string[]> = {};
      for (const [name, routes] of this.extensionRoutes) {
        extEndpoints[name] = routes.map(r => `${r.method} /ext/${name}${r.path}`);
      }
      endpoints.extensions = extEndpoints;
    }

    const info = {
      name: "Disc Database",
      version: DISC_VERSION,
      protocol: "HTTP/JSON",
      endpoints
    };

    return new Response(JSON.stringify(info, null, 2), {
      headers: this.get_default_headers("application/json", request)
    });
  }

  protected async handle_query(
    request: Request,
    info: Deno.ServeHandlerInfo,
    requestId: string
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
          request
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
          request
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
        queryRequest
      );
      if (validationErrors.length > 0) {
        return new Response(
          JSON.stringify({
            errors: validationErrors
          }),
          {
            status: 400,
            headers: this.get_default_headers("application/json")
          }
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
          400
        );
      }

      // Create connection and session
      const remoteAddr = "hostname" in info.remoteAddr ?
        info.remoteAddr.hostname :
        "unknown";
      const connection = this.connection_manager.createConnection(
        "http",
        remoteAddr,
        undefined,
        request.headers.get("user-agent") || undefined
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
            roles: authResult.roles
          };
        }
      }

      // Per-request access-policy override (gh/geldata#6358). The
      // header opts out of policy injection for the upcoming query,
      // mirroring `apply_access_policies := false` in EdgeQL. Only
      // admins may exercise it; for any other role the flag is dropped
      // so a regular user setting the header can't escalate.
      const bypassHeader = request
        .headers
        .get("X-Disc-Apply-Access-Policies");
      const bypassRequested = bypassHeader !== null &&
        /^(false|0|no)$/i.test(bypassHeader.trim());
      const callerIsAdmin = authContext.roles.includes("admin");
      const bypassAccessPolicies = bypassRequested && callerIsAdmin;

      // Per-policy disable (gh/geldata#6432 slice 3). The header lists
      // qualified policy names (`<TypeName>.<policy_name>`) the caller
      // wants the evaluator to skip — surgical disable for testing,
      // versus the all-or-nothing `bypassAccessPolicies` above. Same
      // admin-gate so a non-admin can't disable a policy that protects
      // them.
      const disableHeader = request
        .headers
        .get("X-Disc-Disable-Policies");
      let disabledPolicies: Set<string> | undefined;
      if (disableHeader && callerIsAdmin) {
        const names = disableHeader
          .split(",")
          .map(s => s.trim())
          .filter(s => s.length > 0);
        if (names.length > 0) {
          disabledPolicies = new Set(names);
        }
      }

      // Create query context
      const context: Types.QueryContext = {
        session: connection.session,
        auth: authContext,
        requestId,
        startedAt: new Date(),
        clientInfo: this.parse_client_info(request),
        bypassAccessPolicies,
        disabledPolicies
      };

      // Execute query with optional HTTP-level timeout safety net
      let response: Types.QueryResponse;
      const timeoutMs = this.config.requestTimeout;

      if (timeoutMs && timeoutMs > 0) {
        let timerId: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<Types.QueryResponse>(
          (_resolve, reject) => {
            timerId = setTimeout(() => {
              reject(new Error("__HTTP_TIMEOUT__"));
            }, timeoutMs);
          }
        );

        try {
          response = await Promise.race([
            this.protocolHandler.handleRequest(queryRequest, context),
            timeoutPromise
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
                  extensions: { code: "TIMEOUT" }
                }]
              }),
              {
                status: 408,
                headers: this.get_default_headers("application/json")
              }
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
          context
        );
      }

      // Update session activity
      this.session_manager.updateActivity(connection.session.sessionId);

      // Determine HTTP status based on response content
      // Errors with code "WARNING" are not real errors (e.g. dry-run mode)
      const hasRealErrors = response.errors?.some(
        e => e.extensions?.code !== "WARNING"
      );

      if (hasRealErrors && !response.data) {
        this.stats.failed_requests++;
        return new Response(JSON.stringify(response), {
          status: 400,
          headers: this.get_default_headers("application/json")
        });
      }

      this.stats.successful_requests++;

      return new Response(JSON.stringify(response), {
        headers: this.get_default_headers("application/json")
      });
    } catch (error) {
      log.error("Query execution failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });

      const errorResponse: Types.QueryResponse = {
        errors: [{
          message: "Internal server error",
          extensions: { code: "INTERNAL_ERROR" }
        }]
      };

      return new Response(JSON.stringify(errorResponse), {
        status: 500,
        headers: this.get_default_headers("application/json")
      });
    }
  }

  protected handle_health_live(request?: Request): Response {
    return new Response(
      JSON.stringify({ status: "alive" }),
      {
        status: 200,
        headers: this.get_default_headers("application/json", request)
      }
    );
  }

  protected async handle_health_ready(request?: Request): Promise<Response> {
    if (this.protocolHandler.checkHealth) {
      const health = await this.protocolHandler.checkHealth();
      const httpStatus = health.status === "unhealthy" ? 503 : 200;

      return new Response(
        JSON.stringify({ status: health.status }),
        {
          status: httpStatus,
          headers: this.get_default_headers("application/json", request)
        }
      );
    }

    // No checkHealth on handler — assume healthy
    return new Response(
      JSON.stringify({ status: "healthy" }),
      {
        status: 200,
        headers: this.get_default_headers("application/json", request)
      }
    );
  }

  protected async handle_health(request?: Request): Promise<Response> {
    // Gather extension health if available
    let extensionHealth:
      | Record<string, { healthy: boolean; details?: string; }>
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
        uptimeMs: Date.now() - this.startTime.getTime()
      };

      if (extensionHealth !== undefined) {
        body.extensions = extensionHealth;
      }

      return new Response(JSON.stringify(body, null, 2), {
        status: httpStatus,
        headers: this.get_default_headers("application/json", request)
      });
    }

    // Fallback when handler does not support checkHealth
    const body: Record<string, unknown> = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptimeMs: Date.now() - this.startTime.getTime(),
      connections: this.connection_manager.get_stats(),
      memory: this.get_memory_stats()
    };

    if (extensionHealth !== undefined) {
      body.extensions = extensionHealth;
    }

    return new Response(JSON.stringify(body, null, 2), {
      headers: this.get_default_headers("application/json", request)
    });
  }

  protected handle_stats(request?: Request): Response {
    const subscriptionStats = this
      .subscription_handler
      .get_subscription_stats();

    // Gather handler-level cache/metrics stats if available
    const handlerStats = this.protocolHandler.getStats?.();

    // Resolve database name for display. An explicit X-Database / ?database=
    // selection wins; otherwise fall back to the server's configured database
    // (the project instance name from the DSN) rather than the bare registry
    // default, so the UI shows the user's instance next to "Database Overview".
    const database = request ?
      this.resolveDatabaseName(request, new URL(request.url), this.configuredDatabaseName()) :
      this.configuredDatabaseName();
    const databases = this.databaseRegistry?.listDatabases() ?? [database];

    const stats: Types.ServerStats & {
      subscriptions: typeof subscriptionStats;
    } = {
      version: DISC_VERSION,
      database,
      databases,
      connections: this.connection_manager.get_stats(),
      queries: {
        total: this.stats.total_requests,
        successful: this.stats.successful_requests,
        failed: this.stats.failed_requests,
        avgDurationMs: this.stats.total_requests > 0 ?
          this.stats.total_duration_ms / this.stats.total_requests :
          0
      },
      transactions: this.transaction_manager.get_stats(),
      memoryUsage: this.get_memory_stats(),
      uptimeMs: Date.now() - this.startTime.getTime(),
      subscriptions: subscriptionStats,
      cache: handlerStats?.cache,
      queryMetrics: handlerStats?.queryMetrics,
      rateLimit: this.rate_limiter?.stats()
    };

    return new Response(JSON.stringify(stats, null, 2), {
      headers: this.get_default_headers("application/json", request)
    });
  }

  protected handle_metrics(request?: Request): Response {
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
        total_duration_ms: this.stats.total_duration_ms
      },
      cache: handlerStats?.cache,
      queryMetrics: handlerStats?.queryMetrics,
      pool: poolStats,
      rateLimit: this.rate_limiter?.stats(),
      uptimeMs: Date.now() - this.startTime.getTime(),
      memory: this.get_memory_stats(),
      tls: this.tls_not_after_unix !== undefined ?
        {
          notAfterUnix: this.tls_not_after_unix,
          secondsUntilExpiry: this.tls_not_after_unix -
            Math.floor(Date.now() / 1000)
        } :
        undefined
    };

    const body = renderMetrics(source);
    const headers = new Headers({
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8"
    });
    if (this.config.enableCors) {
      const origin = this.resolve_allowed_origin(request);
      if (origin !== null) {
        headers.set("Access-Control-Allow-Origin", origin);
      }
    }
    return new Response(body, { headers });
  }

  protected handle_preflight(request: Request): Response {
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
    if (this.config.corsAllowCredentials && allowedOrigin !== "*") {
      headers.set("Access-Control-Allow-Credentials", "true");
    }
    headers.set(
      "Access-Control-Max-Age",
      String(this.config.corsMaxAge ?? DEFAULT_CORS_MAX_AGE)
    );

    return new Response(null, { status: 204, headers });
  }

  protected handle_websocket_upgrade(
    request: Request,
    info: Deno.ServeHandlerInfo
  ): Response {
    // Read everything we need off the request/info BEFORE upgrading. As of
    // Deno 2.8.3, `Deno.upgradeWebSocket()` consumes the request — any
    // subsequent access to `request.headers` or `info.remoteAddr` throws
    // `TypeError: Request closed`, which would bubble up as a failed upgrade
    // ("Upgrade response was not returned from callback") and hang every WS
    // client. (2.8.2 and earlier tolerated post-upgrade access.)
    const remoteAddr = "hostname" in info.remoteAddr ?
      info.remoteAddr.hostname :
      "unknown";
    const userAgent = request.headers.get("user-agent") || undefined;

    const { socket, response } = Deno.upgradeWebSocket(request);

    const connection = this.connection_manager.createConnection(
      "websocket",
      remoteAddr,
      undefined,
      userAgent
    );

    socket.onopen = () => {
      log.info("WebSocket connection opened", { connectionId: connection.id });
    };

    socket.onmessage = async event => {
      try {
        const message = JSON.parse(event.data);
        await this.handle_websocket_message(socket, connection, message);
      } catch (error) {
        log.error("WebSocket message error", {
          error: error instanceof Error ? error.message : String(error)
        });
        socket.send(JSON.stringify({
          type: "error",
          payload: { message: "Invalid message format" }
        }));
      }
    };

    socket.onclose = () => {
      log.info("WebSocket connection closed", { connectionId: connection.id });
      this.subscription_handler.cleanup_connection(
        connection.session.sessionId
      );
      this.connection_manager.closeConnection(connection.id);
    };

    socket.onerror = _error => {
      log.error("WebSocket error", { connectionId: connection.id });
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
          auth: {
            roles: [],
            permissions: [],
            ...connection.session.variables?._auth_context
          },
          requestId: this.generate_request_id(),
          startedAt: new Date()
        };

        try {
          const response = await this.protocolHandler.handleRequest(
            payload,
            context
          );
          socket.send(JSON.stringify({
            type: "query_result",
            payload: response
          }));
        } catch (error) {
          const errorMessage = error instanceof Error ?
            error.message :
            "Unknown error";
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: errorMessage }
          }));
        }
        break;
      }

      case "subscribe": {
        const context: Types.QueryContext = {
          session: connection.session,
          auth: { roles: [], permissions: [] },
          requestId: this.generate_request_id(),
          startedAt: new Date()
        };

        try {
          await this.subscription_handler.handleSubscription(
            payload,
            context,
            socket
          );
        } catch (error) {
          const errorMessage = error instanceof Error ?
            error.message :
            "Unknown subscription error";
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: errorMessage }
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
            payload: { subscriptionId }
          }));
        } else {
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: "subscriptionId is required for unsubscribe" }
          }));
        }
        break;
      }

      default:
        socket.send(JSON.stringify({
          type: "error",
          payload: { message: `Unknown message type: ${type}` }
        }));
    }
  }

  protected async handleExtensionRoute(
    request: Request,
    url: URL,
    authContext?: import("../auth/middleware.ts").AuthContext | null
  ): Promise<Response> {
    // Parse /ext/<name>/<path>
    const parts = url.pathname.slice(5).split("/"); // strip "/ext/"
    const extName = parts[0];
    const extPath = "/" + parts.slice(1).join("/");

    const routes = this.extensionRoutes.get(extName);
    if (!routes) {
      return this.create_error_response(
        `Extension "${extName}" not found`,
        404
      );
    }

    const route = routes.find(
      r => r.path === extPath && r.method === request.method
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
        error: error instanceof Error ? error.message : String(error)
      });
      return this.create_error_response("Extension error", 500);
    }
  }

  /**
   * File-storage HTTP layer (gh/geldata#3567).
   *
   * Routes:
   *   POST   /files                  upload (raw octet-stream body)
   *   GET    /files                  list owner's files (JSON)
   *   GET    /files/:id              download (binary)
   *   GET    /files/:id/meta         metadata only (JSON)
   *   DELETE /files/:id              delete (owner-only)
   *
   * All routes require auth — owner is `context.userId`. Apps that want
   * unauthenticated reads should layer that on top with a custom route.
   */
  protected async handle_files_route(
    request: Request,
    url: URL,
    context: import("../auth/middleware.ts").AuthContext | null
  ): Promise<Response> {
    if (!this.fileManager) {
      return this.create_error_response("File storage not configured", 404);
    }
    if (!context?.userId) {
      // gateAuth already enforces requireAuth when configured; this is
      // the in-permissive-mode path. Files are sensitive enough that we
      // refuse without a user even when the rest of the server is open.
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    const userId = context.userId;
    const segments = url.pathname.split("/").filter(Boolean); // ["files", ...]
    try {
      if (segments.length === 1) {
        // /files
        if (request.method === "POST") {
          const body = new Uint8Array(await request.arrayBuffer());
          const meta = await this.fileManager.upload({
            ownerUserId: userId,
            name: request.headers.get("x-file-name") ?? undefined,
            contentType: request.headers.get("content-type") ?? undefined,
            body
          });
          return new Response(JSON.stringify(meta), {
            status: 201,
            headers: { "Content-Type": "application/json" }
          });
        }
        if (request.method === "GET") {
          const list = await this.fileManager.list(userId);
          return new Response(JSON.stringify({ files: list }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        return this.create_error_response("Method not allowed", 405);
      }

      if (segments.length === 2) {
        // /files/:id
        const id = segments[1];
        if (request.method === "GET") {
          const { metadata, body } = await this.fileManager.read(id, userId);
          return new Response(body as BodyInit, {
            status: 200,
            headers: {
              "Content-Type": metadata.contentType,
              "Content-Length": String(metadata.size),
              ...(metadata.name ?
                {
                  "Content-Disposition": `inline; filename="${metadata.name.replace(/"/g, "")}"`
                } :
                {})
            }
          });
        }
        if (request.method === "DELETE") {
          await this.fileManager.delete(id, userId);
          return new Response(null, { status: 204 });
        }
        return this.create_error_response("Method not allowed", 405);
      }

      if (segments.length === 3 && segments[2] === "meta") {
        // /files/:id/meta
        if (request.method !== "GET") {
          return this.create_error_response("Method not allowed", 405);
        }
        const meta = await this.fileManager.readMetadata(segments[1], userId);
        return new Response(JSON.stringify(meta), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      return this.create_error_response("Unknown files route", 404);
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "FileNotFoundError") {
        return this.create_error_response("File not found", 404);
      }
      if (name === "FileAccessDeniedError") {
        return this.create_error_response("Access denied", 403);
      }
      if (name === "FileTooLargeError") {
        return this.create_error_response(
          err instanceof Error ? err.message : "File too large",
          413
        );
      }
      log.error("Files route error", {
        path: url.pathname,
        error: err instanceof Error ? err.message : String(err)
      });
      return this.create_error_response("Internal error", 500);
    }
  }

  /**
   * Live-schema-diff admin endpoints (Bundle K — Disc-original
   * feature #3a). Dispatches `/admin/schema-watch` and
   * `/admin/schema-apply` to the dedicated handlers in
   * `server/admin/`.
   *
   * Auth: when `requireAuth` is on, the global gate already enforced
   * a JWT and we're handed an `AuthContext`. When `requireAuth` is
   * off (dev default), these routes still respond — operators who
   * deploy the admin UI in production should pair it with
   * `requireAuth=true`.
   */
  protected async handleAdminSchemaRoute(
    request: Request,
    url: URL,
    _authContext: import("../auth/middleware.ts").AuthContext | null
  ): Promise<Response> {
    if (!this.adminSchemaWatch) {
      return this.create_error_response("Admin endpoints not configured", 404);
    }

    if (url.pathname === "/admin/schema-watch") {
      if (request.method !== "GET") {
        return this.create_error_response("Method Not Allowed", 405);
      }
      return handleSchemaWatch({
        source: this.adminSchemaWatch.source,
        appliedSdlProvider: this.adminSchemaWatch.appliedSdlProvider
      });
    }

    if (url.pathname === "/admin/schema-apply") {
      if (request.method !== "POST") {
        return this.create_error_response("Method Not Allowed", 405);
      }
      return await handleSchemaApply({
        request,
        url,
        source: this.adminSchemaWatch.source,
        databaseUrl: this.config.databaseUrl,
        appliedSdl: this.adminSchemaWatch.appliedSdlProvider(),
        onApplied: this.adminSchemaWatch.onApplied
      });
    }

    return this.create_error_response("Not Found", 404);
  }

  /**
   * Schema-derived REST surface (Bundle J — Disc-original feature #2).
   *
   * Builds a `QueryContext` shaped like `/query` would, so access
   * policies and the read-only-mode gate fire identically. Returns
   * `null` when the path isn't a recognized REST route — the dispatcher
   * then falls through to its existing 404 handling.
   */
  protected async handleRestRoute(
    request: Request,
    requestId: string,
    authContext: import("../auth/middleware.ts").AuthContext | null
  ): Promise<Response | null> {
    if (!this.schemaProvider) {
      return this.create_error_response(
        "REST surface not available — no schema provider configured",
        503
      );
    }
    const schema = this.schemaProvider();
    const sessionAuth: Types.AuthContext = {
      roles: authContext?.roles ?? [],
      permissions: [],
      userId: authContext?.userId,
      jwtClaims: authContext ?
        {
          sub: authContext.sub,
          email: authContext.email,
          username: authContext.username,
          iss: authContext.iss,
          aud: authContext.aud,
          roles: authContext.roles
        } :
        undefined
    };
    const session: Types.SessionContext = {
      sessionId: requestId,
      database: "disc",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    };
    const context: Types.QueryContext = {
      session,
      auth: sessionAuth,
      requestId,
      startedAt: new Date()
    };
    return await dispatchRest({
      request,
      schema,
      protocolHandler: this.protocolHandler,
      context
    });
  }

  protected handleOpenApi(_request: Request): Response {
    if (this.config.enableRest === false) {
      return this.create_error_response("REST surface disabled", 404);
    }
    if (!this.schemaProvider) {
      return this.create_error_response(
        "REST surface not available — no schema provider configured",
        503
      );
    }
    const schema = this.schemaProvider();
    const spec = renderOpenApiSpec(schema, {
      requireAuth: this.config.requireAuth === true
    });
    return new Response(JSON.stringify(spec, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  protected handle_schema_route(url: URL): Response {
    if (!this.schemaProvider) {
      return this.create_error_response(
        "Schema introspection not configured",
        404
      );
    }

    const routeCtx = {
      schemaProvider: this.schemaProvider,
      defaultHeaders: () => this.get_default_headers("application/json")
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
        url.pathname.slice("/schema/types/".length)
      );
      if (typeName) {
        return handleGetSchemaType(routeCtx, typeName);
      }
    }

    return this.create_error_response("Not Found", 404);
  }

  protected async handle_migrations(_request: Request): Promise<Response> {
    if (!this.migrationsProvider) {
      return this.create_error_response(
        "Migration history not configured",
        404
      );
    }

    return await handleGetMigrations({
      migrationsProvider: this.migrationsProvider,
      defaultHeaders: () => this.get_default_headers("application/json")
    });
  }
}

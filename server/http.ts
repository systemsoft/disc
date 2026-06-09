/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * HTTP Server implementation for Disc Database
 *
 * Top layer of the HTTP server stack: request dispatch and the auth
 * gate. Instance state, lifecycle, and low-level helpers live in
 * `server/http-base.ts`; the endpoint implementations live in
 * `server/http-handlers.ts`.
 */

import { classifyAuthRoute } from "../auth/integration.ts";
import { getLogger } from "../lib/logger.ts";
import { handleDataWatch } from "./admin/data-watch.ts";
import { handleGetConfig, handleSetConfig } from "./config-endpoint.ts";
import { HttpRouteHandlers } from "./http-handlers.ts";

const log = getLogger("http");

export type { HttpServerOptions } from "./http-base.ts";

export class HttpServer extends HttpRouteHandlers {
  protected async handleRequest(
    request: Request,
    info: Deno.ServeHandlerInfo
  ): Promise<Response> {
    // Reject new requests during shutdown
    if (this.shutting_down) {
      return new Response(
        JSON.stringify({ error: "Server is shutting down" }),
        {
          status: 503,
          headers: this.get_default_headers("application/json")
        }
      );
    }

    // Enforce rate limit before touching in-flight counter or stats
    if (this.rate_limiter) {
      const clientIp = "hostname" in info.remoteAddr ?
        info.remoteAddr.hostname :
        "unknown";
      if (!this.rate_limiter.allow(clientIp)) {
        const headers = this.get_default_headers("application/json");
        headers.set("Retry-After", "60");
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded" }),
          { status: 429, headers }
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

      // Strip the UI's `/api` namespace for non-REST endpoints. The admin
      // UI prefixes every backend call with `/api` so SvelteKit's own
      // page routes (`/schema`, `/query`, ...) don't collide with the
      // backend ones. In dev, the vite proxy strips the prefix; in
      // production (single-binary, UI mounted at `/ui`), the server has
      // to do it instead. Only paths that match a known non-REST
      // endpoint are rewritten — `/api/<TypeName>` keeps falling
      // through to the REST data API (Bundle J).
      if (
        url.pathname.startsWith("/api/") &&
        this.shouldStripApiPrefix(url.pathname)
      ) {
        url.pathname = url.pathname.slice(4);
      }

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

      // File-storage routes
      if (url.pathname === "/files" || url.pathname.startsWith("/files/")) {
        return await this.handle_files_route(request, url, authedContext);
      }

      // Admin UI assets (Bundle I — single-binary distribution).
      // Embedded via `deno compile --include ui/build` and served from
      // the static manifest. Falls back to `index.html` for SPA routes.
      if (url.pathname === "/ui" || url.pathname.startsWith("/ui/")) {
        const uiResponse = await this.uiAssetHandler(request);
        if (uiResponse) {
          return uiResponse;
        }
      }

      // Live-schema-diff admin endpoints (Bundle K — Disc-original
      // feature #3a). Mounted only when DiscServer was given a
      // `schemaFilePath`. The auth gate above has already approved
      // the request; these routes are sensitive (write path), so
      // operators should also enable `requireAuth` in production.
      if (
        this.adminSchemaWatch &&
        (url.pathname === "/admin/schema-watch" ||
          url.pathname === "/admin/schema-apply")
      ) {
        return await this.handleAdminSchemaRoute(
          request,
          url,
          authedContext
        );
      }

      // Live data-subscription endpoint (Bundle L — Disc-original
      // feature #3c). Read-only SSE stream of `invalidate` events;
      // mounted only when a registry was wired (DiscServer
      // bootstraps it after PG is ready).
      if (
        this.config.enableDataWatch !== false &&
        this.dataWatchRegistry &&
        url.pathname === "/admin/data-watch"
      ) {
        if (request.method !== "GET") {
          return this.create_error_response("Method Not Allowed", 405);
        }
        return handleDataWatch({
          registry: this.dataWatchRegistry,
          url
        });
      }

      // Schema-derived REST surface (Bundle J — Disc-original feature #2).
      // `/api/<Type>/...` routes lower to EdgeQL and run through the
      // standard protocol pipeline so access policies, read-only mode,
      // and the auth gate compose for free. Disabled when
      // `config.enableRest === false`.
      if (
        this.config.enableRest !== false &&
        (url.pathname === "/api" || url.pathname.startsWith("/api/"))
      ) {
        if (url.pathname === "/api/openapi.json") {
          return this.handleOpenApi(request);
        }
        const restResponse = await this.handleRestRoute(
          request,
          requestId,
          authedContext
        );
        if (restResponse) {
          return restResponse;
        }
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
        case "/config":
          if (request.method === "POST") {
            return await this.handle_config_write(request);
          }
          return await handleGetConfig({
            defaultHeaders: () => this.get_default_headers("application/json"),
            fetchCurrentValues: this.protocolHandler.getConfigValues ?
              names => this.protocolHandler.getConfigValues!(names) :
              undefined
          });
        default:
          return this.create_error_response("Not Found", 404, request);
      }
    } catch (error) {
      this.stats.failed_requests++;
      log.error("Request failed", {
        requestId,
        error: error instanceof Error ? error.message : String(error)
      });
      return this.create_error_response("Internal Server Error", 500, request);
    } finally {
      const duration = Date.now() - startTime;
      this.stats.total_duration_ms += duration;
      this.in_flight_requests--;
    }
  }

  /**
   * Decide whether `/api/<rest>` should be rewritten to `/<rest>` before
   * dispatch. The admin UI prefixes every backend call with `/api`; the
   * REST data API (Bundle J) also lives under `/api/<TypeName>`. We
   * strip the prefix only when the next segment matches a known non-REST
   * endpoint, so `/api/Merchant` keeps reaching the REST router.
   *
   * Update this list when a new top-level non-REST route is added to
   * `handleRequest()` — otherwise the production-served UI will 404 on
   * it even though the dev (vite-proxied) UI works.
   */
  private shouldStripApiPrefix(pathname: string): boolean {
    // pathname has the leading `/api/` (5 chars) so we slice past it.
    const firstSegment = pathname.slice(5).split("/")[0];
    const knownEndpoints = new Set([
      "schema",
      "query",
      "migrations",
      "stats",
      "health",
      "metrics",
      "config",
      "auth",
      "admin",
      "ext",
      "files"
    ]);
    return knownEndpoints.has(firstSegment);
  }

  /**
   * Public-route allowlist. These paths are reachable without a JWT
   * even when `config.requireAuth` is enabled — they're either part of
   * the auth flow itself (you can't log in with a token you don't have
   * yet) or unauthenticated by design (health probes for orchestrators).
   * (gh/geldata#6345, ports geldata/gel#6352)
   */
  private isPublicRoute(pathname: string): boolean {
    if (pathname === "/") {
      return true;
    }
    if (pathname.startsWith("/auth/")) {
      return true;
    }
    if (pathname === "/health" || pathname.startsWith("/health/")) {
      return true;
    }
    // Admin UI assets are public; users sign in *through* the UI, so
    // the bundle has to load before authentication. The UI's own
    // network calls (e.g. /query, /schema) still go through gateAuth
    // when `requireAuth` is on.
    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      return true;
    }
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
    url: URL
  ): Promise<import("../auth/middleware.ts").AuthContext | null | Response> {
    if (!this.config.requireAuth) {
      // Permissive mode — populate context if we can, but don't reject.
      if (!this.authMiddleware) {
        return null;
      }
      return await this.authMiddleware.authenticate(request);
    }

    if (this.isPublicRoute(url.pathname)) {
      return null;
    }

    if (!this.authMiddleware) {
      log.error(
        "requireAuth=true but no authMiddleware configured — rejecting request",
        { path: url.pathname }
      );
      return new Response(
        JSON.stringify({
          error: "Authentication required but auth provider not configured"
        }),
        {
          status: 503,
          headers: this.get_default_headers("application/json")
        }
      );
    }

    const ctx = await this.authMiddleware.authenticate(request);
    if (!ctx) {
      const headers = this.get_default_headers("application/json");
      // RFC 6750 §3 — return a WWW-Authenticate challenge so clients
      // know which scheme to retry with.
      headers.set("WWW-Authenticate", "Bearer realm=\"disc\"");
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers }
      );
    }
    return ctx;
  }

  /**
   * Handle `POST /config` — persist a single setting via `ALTER SYSTEM`.
   * Refused in read-only mode (mirrors the query path's write gate) and
   * when the protocol handler exposes no writer (dry-run / no pool).
   */
  private async handle_config_write(request: Request): Promise<Response> {
    if (this.config.readOnly) {
      return this.create_error_response(
        "the server is currently in read-only mode; configuration cannot be changed",
        403,
        request
      );
    }
    if (!this.protocolHandler.setConfigValue) {
      return this.create_error_response(
        "Configuration editing is not available",
        503,
        request
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return this.create_error_response("Invalid JSON", 400, request);
    }

    return await handleSetConfig(body, {
      defaultHeaders: () => this.get_default_headers("application/json"),
      setValue: (pgName, value) => this.protocolHandler.setConfigValue!(pgName, value)
    });
  }

  private async handle_auth_route(
    request: Request,
    url: URL
  ): Promise<Response> {
    if (!this.authRoutes) {
      return this.create_error_response("Authentication not configured", 404);
    }

    // Strip /auth/ prefix to get the route
    const route = url.pathname.slice(6); // "/auth/".length === 6

    // Router-level lockdown (gh/geldata#7525). Every dispatched route
    // must be classified explicitly as public or authenticated; an
    // unknown classification means a developer added a handler to the
    // switch without an explicit policy decision — fail closed rather
    // than ship a quietly-public endpoint. For authenticated routes
    // the JWT is enforced here regardless of `config.requireAuth`,
    // independent of the global gate so logout/profile/password etc.
    // are protected even in permissive mode.
    const classification = classifyAuthRoute(route);
    if (classification === "unknown") {
      return this.create_error_response("Unknown auth endpoint", 404);
    }
    if (classification === "authenticated") {
      if (!this.authMiddleware) {
        return new Response(
          JSON.stringify({
            error: "Authentication required but auth provider not configured"
          }),
          {
            status: 503,
            headers: this.get_default_headers("application/json")
          }
        );
      }
      const ctx = await this.authMiddleware.authenticate(request);
      if (!ctx) {
        const headers = this.get_default_headers("application/json");
        headers.set("WWW-Authenticate", "Bearer realm=\"disc\"");
        return new Response(
          JSON.stringify({ error: "Authentication required" }),
          { status: 401, headers }
        );
      }
    }

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
      case "magic-code/request":
        return await this.authRoutes.requestMagicCode()(request);
      case "magic-code/verify":
        return await this.authRoutes.verifyMagicCode()(request);
      case "mfa/recovery-codes/generate":
        return await this.authRoutes.generateRecoveryCodes()(request);
      case "mfa/recovery-codes/login":
        return await this.authRoutes.loginWithRecoveryCode()(request);
      case "webauthn/register/begin":
        return await this.authRoutes.beginWebAuthnRegistration()(request);
      case "webauthn/register/finish":
        return await this.authRoutes.finishWebAuthnRegistration()(request);
      case "webauthn/login/begin":
        return await this.authRoutes.beginWebAuthnLogin()(request);
      case "webauthn/login/finish":
        return await this.authRoutes.finishWebAuthnLogin()(request);
      case "webauthn/credentials":
        return await this.authRoutes.listWebAuthnCredentials()(request);
      case "webauthn/credentials/delete":
        return await this.authRoutes.deleteWebAuthnCredential()(request);
      default:
        return this.create_error_response("Unknown auth endpoint", 404);
    }
  }
}

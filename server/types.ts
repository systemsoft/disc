/**
 * Server types and interfaces for Disc database
 */

import type { Schema } from "../compiler/context.ts";
import type { Extension } from "../extensions/types.ts";

export interface AuthServerConfig {
  jwtIssuer?: string;
  jwtAudience?: string;
  tokenExpiry?: number;
  bcryptRounds?: number;
  sessionTimeout?: number;
  allowRegistration?: boolean;
  requireEmailVerification?: boolean;
  passwordMinLength?: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  databaseUrl: string;
  maxConnections: number;
  requestTimeout: number;
  /**
   * Max `POST /query` request body size in bytes. Requests larger than
   * this are rejected with 413 before the body is read into memory. (P1-12)
   * Defaults to 4 MiB when unset.
   */
  maxRequestBodyBytes?: number;
  enableCors: boolean;
  /**
   * Allowed origins. Entries may be exact origins (`https://app.example.com`)
   * or single-label wildcard subdomains (`https://*.example.com`). When
   * empty/unset and `enableCors` is true, the server runs in permissive mode
   * (`Access-Control-Allow-Origin: *`) for local-dev backward compat.
   * (gh/geldata#6655)
   */
  corsOrigins?: string[];
  /**
   * HTTP methods listed in `Access-Control-Allow-Methods` for preflight.
   * Defaults to `["GET", "POST", "OPTIONS"]`. (gh/geldata#6655)
   */
  corsAllowedMethods?: string[];
  /**
   * Request headers listed in `Access-Control-Allow-Headers` for preflight.
   * Defaults to `["Content-Type", "Authorization"]`. (gh/geldata#6655)
   */
  corsAllowedHeaders?: string[];
  /**
   * Response headers exposed to the browser via
   * `Access-Control-Expose-Headers`. Empty by default. (gh/geldata#6655)
   */
  corsExposeHeaders?: string[];
  /**
   * When true, emit `Access-Control-Allow-Credentials: true`. Forbidden
   * with permissive `*` origin per the CORS spec — when this is on,
   * `corsOrigins` MUST be a non-empty allowlist. (gh/geldata#6655)
   */
  corsAllowCredentials?: boolean;
  /**
   * Preflight cache duration emitted as `Access-Control-Max-Age`.
   * Defaults to 86400 (24h). (gh/geldata#6655)
   */
  corsMaxAge?: number;
  /**
   * When true, trust `X-Forwarded-For`, `X-Real-IP`, and
   * `X-Forwarded-Proto` headers — set this only when Disc sits behind
   * a reverse proxy that strips and resets these headers from clients.
   * Trusting them unconditionally lets a directly-reachable attacker
   * spoof their IP (rate-limit evasion) and downgrade scheme checks.
   * Defaults to `false`. (gh/geldata#5030)
   */
  trustProxy?: boolean;
  enableWebsockets: boolean;
  jwtSecret?: string;
  enableAuth?: boolean;
  enableAccessPolicies?: boolean;
  authConfig?: AuthServerConfig;
  /**
   * When true, all data-plane HTTP routes (`/query`, `/schema*`,
   * `/migrations`, `/stats`, `/metrics`, `/ext/*`) require a valid
   * `Authorization: Bearer <JWT>` header. Auth-flow routes (`/auth/*`)
   * and health/liveness probes (`/health*`) remain public regardless.
   * Defaults to `false` for backwards compatibility — existing callers
   * keep their permissive behavior unless they opt in. When enabled
   * without an `authMiddleware`, requests are rejected with 503 to
   * fail loud rather than silently bypass. (gh/geldata#6345, ports
   * geldata/gel#6352)
   */
  requireAuth?: boolean;
  /**
   * When true, the server runs in read-only mode: queries that would
   * write to the database (INSERT/UPDATE/DELETE/CONFIGURE
   * DATABASE|INSTANCE|SYSTEM) are rejected with a `READ_ONLY_MODE`
   * error. Schema migrations are also blocked. Useful for maintenance
   * windows, staged failovers, and scaling read replicas without code
   * changes. Defaults to `false`. (gh/geldata#5524, ports
   * geldata/gel#5543)
   */
  readOnly?: boolean;
  enableExplain?: boolean;
  dryRun?: boolean;
  /**
   * When true, expose the schema-derived REST surface (Bundle J).
   * Routes are mounted under `/api/<TypeName>` and pass through the
   * standard EdgeQL → SQL → PG pipeline so access policies, read-only
   * mode, and the auth gate compose without extra work. Defaults to
   * `true`. Disable via `disc.toml` `enable_rest = false` or the
   * `DISC_ENABLE_REST=false` environment variable.
   * (Bundle J — Disc-original feature #2)
   */
  enableRest?: boolean;
  /**
   * When true, expose the live data-subscription endpoint
   * `GET /admin/data-watch?tables=…` and bootstrap the change-log
   * triggers. Powers the admin UI's live data viewer. Defaults to
   * `true`. Disable via `disc.toml` `enable_data_watch = false` or
   * the `DISC_ENABLE_DATA_WATCH=false` environment variable.
   * (Bundle L — Disc-original feature #3c)
   */
  enableDataWatch?: boolean;
  cacheMaxSize?: number;
  shutdownDrainTimeout?: number;
  slowQueryThresholdMs?: number;
  enableMetrics?: boolean;
  rateLimitRpm?: number;
  rateLimitBurst?: number;
  tls?: {
    certFile: string;
    keyFile: string;
    redirect?: boolean;
    redirectPort?: number;
    /**
     * When true, watch `certFile` and `keyFile` and reload them in
     * place when they change on disk — typically after a certbot /
     * cert-manager renewal. The reload sequence drains in-flight
     * requests, shuts the old listener, and starts a new one on the
     * same port; expect a sub-second blip in connection accepts but
     * no full restart. Defaults to `false`. (gh/geldata#4277,
     * ports geldata/gel#4297)
     */
    reload?: boolean;
    /**
     * Debounce window (ms) for collapsing burst filesystem events
     * during cert rotation. Renewal tools commonly write key+cert
     * back-to-back; a short window keeps the reload to one swap.
     * Defaults to 500ms.
     */
    reloadDebounceMs?: number;
  };
  extensions?: Extension[];
  databases?: Record<string, string>;
  enableMultiDatabase?: boolean;
  /**
   * Port for the Gel binary wire protocol server.
   * When set, DiscServer starts a BinaryProtocolServer alongside the HTTP server.
   * Default: undefined (binary protocol not started).
   */
  binaryPort?: number;
}

export interface QueryRequest {
  query: string;
  variables?: Record<string, any>;
  operationName?: string;
}

export interface QueryResponse {
  data?: any;
  errors?: QueryError[];
  extensions?: Record<string, any>;
}

export interface QueryError {
  message: string;
  locations?: Array<{
    line: number;
    column: number;
  }>;
  path?: Array<string | number>;
  extensions?: Record<string, any>;
}

export interface SessionContext {
  sessionId: string;
  userId?: string;
  database: string;
  transactionId?: string;
  createdAt: Date;
  lastActivity: Date;
  variables: Record<string, any>;
}

export interface Connection {
  id: string;
  type: "http" | "websocket";
  session: SessionContext;
  createdAt: Date;
  remoteAddr: string;
  userAgent?: string;
}

export interface Transaction {
  id: string;
  sessionId: string;
  isolationLevel: "read_committed" | "repeatable_read" | "serializable";
  readOnly: boolean;
  startedAt: Date;
  statements: string[];
}

export interface SubscriptionRequest {
  id: string;
  query: string;
  variables?: Record<string, any>;
  operationName?: string;
}

export interface SubscriptionMessage {
  id: string;
  type: "data" | "error" | "complete";
  payload?: any;
}

export interface ServerStats {
  connections: {
    active: number;
    total: number;
    http: number;
    websocket: number;
  };
  queries: {
    total: number;
    successful: number;
    failed: number;
    avgDurationMs: number;
  };
  transactions: {
    active: number;
    committed: number;
    rolledBack: number;
  };
  memoryUsage: {
    heapUsed: number;
    heapTotal: number;
    external: number;
  };
  uptimeMs: number;
  cache?: {
    compilation: {
      evictions: number;
      hitRate: number;
      hits: number;
      misses: number;
      size: number;
    };
    parse: {
      evictions: number;
      hitRate: number;
      hits: number;
      misses: number;
      size: number;
    };
  };
  queryMetrics?: {
    avgCompileMs: number;
    avgExecuteMs: number;
    avgParseMs: number;
    cacheHitRate: number;
    totalQueries: number;
  };
  rateLimit?: {
    rejectedCount: number;
    activeClients: number;
  };
}

export interface AuthContext {
  userId?: string;
  roles: string[];
  permissions: string[];
  jwtClaims?: Record<string, any>;
}

export interface QueryContext {
  session: SessionContext;
  auth: AuthContext;
  requestId: string;
  startedAt: Date;
  clientInfo?: {
    name: string;
    version: string;
    library: string;
  };
}

export interface ExecutionResult {
  success: boolean;
  data?: any;
  errors?: QueryError[];
  durationMs: number;
  rowsAffected?: number;
  queryHash?: string;
}

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  database?: {
    connected: boolean;
    latencyMs?: number;
  };
  pool?: {
    total: number;
    idle: number;
    active: number;
    waiters: number;
  };
}

export interface ProtocolHandler {
  handleRequest(
    request: QueryRequest,
    context: QueryContext,
  ): Promise<QueryResponse>;
  handleSubscription?(
    request: SubscriptionRequest,
    context: QueryContext,
  ): AsyncIterableIterator<SubscriptionMessage>;
  validateRequest(request: QueryRequest): QueryError[];
  /** Initialize the handler (e.g. connect to database, warm up pool). */
  initialize?(): Promise<void>;
  /** Gracefully close the handler (e.g. drain connection pool). */
  close?(): Promise<void>;
  /** Update the handler's schema at runtime (e.g. after a migration). */
  updateSchema?(schema: Schema): void;
  /** Return cache and query metrics stats if available. */
  getStats?(): {
    cache?: ServerStats["cache"];
    queryMetrics?: ServerStats["queryMetrics"];
  };
  /** Check database and pool health, returning overall status. */
  checkHealth?(): Promise<HealthStatus>;
  /** Return connection pool statistics, or null if no pool configured. */
  getPoolStats?(): {
    total: number;
    idle: number;
    active: number;
    waiters: number;
  } | null;
}

export interface ConnectionManager {
  createConnection(type: Connection["type"], remoteAddr: string): Connection;
  getConnection(id: string): Connection | null;
  closeConnection(id: string): void;
  getActiveConnections(): Connection[];
  cleanupIdleConnections(): number;
}

export interface SessionManager {
  createSession(database: string): SessionContext;
  getSession(id: string): SessionContext | null;
  updateActivity(id: string): void;
  closeSession(id: string): void;
  cleanupExpiredSessions(): number;
}

export interface TransactionManager {
  beginTransaction(
    sessionId: string,
    options?: Partial<Transaction>,
  ): Transaction;
  getTransaction(id: string): Transaction | null;
  commitTransaction(id: string): Promise<void>;
  rollbackTransaction(id: string): Promise<void>;
  cleanupAbandonedTransactions(): number;
}

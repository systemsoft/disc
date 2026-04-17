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
  corsOrigins?: string[];
  enableWebsockets: boolean;
  jwtSecret?: string;
  enableAuth?: boolean;
  enableAccessPolicies?: boolean;
  authConfig?: AuthServerConfig;
  enableExplain?: boolean;
  dryRun?: boolean;
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

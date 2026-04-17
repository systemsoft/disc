/**
 * SDK Types — Client-side types mirroring server types
 */

// --- Client Configuration ---

export interface DiscClientConfig {
  /** Base URL of the Disc server (default: "http://localhost:5656") */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Custom headers to include with every request */
  headers?: Record<string, string>;
  /** Number of retries on network errors (default: 0) */
  retries?: number;
  /** Base delay between retries in milliseconds (default: 1000) */
  retryDelay?: number;
  /**
   * Optional logger for debugging. Called at `warn` on retry attempts
   * and `error` on final failures — lets apps surface flaky networks
   * without subclassing the client. (P2-20)
   */
  logger?: {
    warn?(message: string, details?: Record<string, unknown>): void;
    error?(message: string, details?: Record<string, unknown>): void;
  };
}

// --- Query Types ---

export interface QueryRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface QueryResponse<T = unknown> {
  data?: T;
  errors?: QueryError[];
  extensions?: QueryExtensions;
}

export interface QueryError {
  message: string;
  locations?: Array<{ line: number; column: number }>;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

export interface QueryExtensions {
  parseMs?: number;
  compileMs?: number;
  executeMs?: number;
  cacheHit?: boolean;
  [key: string]: unknown;
}

// --- Health & Stats ---

export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp?: string;
  uptimeMs?: number;
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
    compilation: CacheStats;
    parse: CacheStats;
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

export interface CacheStats {
  evictions: number;
  hitRate: number;
  hits: number;
  misses: number;
  size: number;
}

// --- Auth Types ---

export interface AuthTokens {
  token: string;
  refreshToken?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  username?: string;
  createdAt: string;
  updatedAt: string;
  emailVerified: boolean;
  active: boolean;
  metadata?: Record<string, unknown>;
}

export interface AuthResponse {
  user: AuthUser;
  session: {
    id: string;
    userId: string;
    token: string;
    refreshToken?: string;
    createdAt: string;
    expiresAt: string;
  };
  token: string;
  refreshToken?: string;
}

export interface LoginCredentials {
  email?: string;
  username?: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  username?: string;
  metadata?: Record<string, unknown>;
}

export interface AuthManagerOptions {
  /** Enable automatic token refresh (default: true) */
  autoRefresh?: boolean;
  /** Seconds before expiry to trigger refresh (default: 60) */
  refreshBuffer?: number;
}

// --- Transaction Types ---

export type IsolationLevel =
  | "read_committed"
  | "repeatable_read"
  | "serializable";

export type TransactionState = "active" | "committed" | "rolled_back";

// --- Subscription Types ---

export interface SubscriptionClientConfig {
  /** Auto-reconnect on disconnect (default: true) */
  autoReconnect?: boolean;
  /** Max reconnection attempts (default: 5) */
  maxReconnectAttempts?: number;
  /** Base delay between reconnect attempts in ms (default: 1000) */
  reconnectDelay?: number;
}

export interface SubscriptionRequest {
  id: string;
  query: string;
  variables?: Record<string, unknown>;
}

export interface SubscriptionMessage<T = unknown> {
  id: string;
  type: "data" | "error" | "complete";
  payload?: T;
}

export interface SubscriptionCallbacks<T = unknown> {
  onData: (data: T) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

export interface SubscriptionHandle {
  id: string;
  unsubscribe: () => void;
}

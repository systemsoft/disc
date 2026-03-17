/**
 * Server types and interfaces for Disc database
 */

export interface ServerConfig {
  host: string;
  port: number;
  database_url: string;
  max_connections: number;
  request_timeout: number;
  enable_cors: boolean;
  cors_origins?: string[];
  enable_websockets: boolean;
  jwt_secret?: string;
  enable_explain?: boolean;
  dry_run?: boolean;
  tls?: {
    cert_file: string;
    key_file: string;
  };
}

export interface QueryRequest {
  query: string;
  variables?: Record<string, any>;
  operation_name?: string;
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
  session_id: string;
  user_id?: string;
  database: string;
  transaction_id?: string;
  created_at: Date;
  last_activity: Date;
  variables: Record<string, any>;
}

export interface Connection {
  id: string;
  type: "http" | "websocket";
  session: SessionContext;
  created_at: Date;
  remote_addr: string;
  user_agent?: string;
}

export interface Transaction {
  id: string;
  session_id: string;
  isolation_level: "read_committed" | "repeatable_read" | "serializable";
  read_only: boolean;
  started_at: Date;
  statements: string[];
}

export interface SubscriptionRequest {
  id: string;
  query: string;
  variables?: Record<string, any>;
  operation_name?: string;
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
    avg_duration_ms: number;
  };
  transactions: {
    active: number;
    committed: number;
    rolled_back: number;
  };
  memory_usage: {
    heap_used: number;
    heap_total: number;
    external: number;
  };
  uptime_ms: number;
}

export interface AuthContext {
  user_id?: string;
  roles: string[];
  permissions: string[];
  jwt_claims?: Record<string, any>;
}

export interface QueryContext {
  session: SessionContext;
  auth: AuthContext;
  request_id: string;
  started_at: Date;
  client_info?: {
    name: string;
    version: string;
    library: string;
  };
}

export interface ExecutionResult {
  success: boolean;
  data?: any;
  errors?: QueryError[];
  duration_ms: number;
  rows_affected?: number;
  query_hash?: string;
}

export interface ProtocolHandler {
  handle_request(
    request: QueryRequest,
    context: QueryContext,
  ): Promise<QueryResponse>;
  handle_subscription?(
    request: SubscriptionRequest,
    context: QueryContext,
  ): AsyncIterableIterator<SubscriptionMessage>;
  validate_request(request: QueryRequest): QueryError[];
  /** Initialize the handler (e.g. connect to database, warm up pool). */
  initialize?(): Promise<void>;
  /** Gracefully close the handler (e.g. drain connection pool). */
  close?(): Promise<void>;
}

export interface ConnectionManager {
  create_connection(type: Connection["type"], remote_addr: string): Connection;
  get_connection(id: string): Connection | null;
  close_connection(id: string): void;
  get_active_connections(): Connection[];
  cleanup_idle_connections(): number;
}

export interface SessionManager {
  create_session(database: string): SessionContext;
  get_session(id: string): SessionContext | null;
  update_activity(id: string): void;
  close_session(id: string): void;
  cleanup_expired_sessions(): number;
}

export interface TransactionManager {
  begin_transaction(
    session_id: string,
    options?: Partial<Transaction>,
  ): Transaction;
  get_transaction(id: string): Transaction | null;
  commit_transaction(id: string): Promise<void>;
  rollback_transaction(id: string): Promise<void>;
  cleanup_abandoned_transactions(): number;
}

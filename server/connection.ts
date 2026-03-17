/**
 * Connection and Session Management for Disc Server
 */

import * as Types from "./types.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { logger } from "../postgres/logger.ts";

export class SessionManager implements Types.SessionManager {
  private sessions = new Map<string, Types.SessionContext>();
  private session_timeout_ms: number;

  constructor(session_timeout_ms = 30 * 60 * 1000) { // 30 minutes default
    this.session_timeout_ms = session_timeout_ms;
  }

  create_session(database: string): Types.SessionContext {
    const session_id = this.generate_session_id();
    const now = new Date();

    const session: Types.SessionContext = {
      session_id,
      database,
      created_at: now,
      last_activity: now,
      variables: {},
    };

    this.sessions.set(session_id, session);
    return session;
  }

  get_session(id: string): Types.SessionContext | null {
    return this.sessions.get(id) || null;
  }

  update_activity(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.last_activity = new Date();
    }
  }

  close_session(id: string): void {
    this.sessions.delete(id);
  }

  cleanup_expired_sessions(): number {
    const now = new Date();
    const expired_sessions: string[] = [];

    for (const [id, session] of this.sessions) {
      const idle_time = now.getTime() - session.last_activity.getTime();
      if (idle_time > this.session_timeout_ms) {
        expired_sessions.push(id);
      }
    }

    for (const id of expired_sessions) {
      this.sessions.delete(id);
    }

    return expired_sessions.length;
  }

  get_active_sessions(): Types.SessionContext[] {
    return Array.from(this.sessions.values());
  }

  private generate_session_id(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export class ConnectionManager implements Types.ConnectionManager {
  private connections = new Map<string, Types.Connection>();
  private connection_timeout_ms: number;

  constructor(connection_timeout_ms = 5 * 60 * 1000) { // 5 minutes default
    this.connection_timeout_ms = connection_timeout_ms;
  }

  create_connection(
    type: Types.Connection["type"],
    remote_addr: string,
    session?: Types.SessionContext,
    user_agent?: string
  ): Types.Connection {
    const connection_id = this.generate_connection_id();

    // Create a default session if none provided
    const conn_session = session || {
      session_id: this.generate_connection_id(),
      database: "default",
      created_at: new Date(),
      last_activity: new Date(),
      variables: {},
    };

    const connection: Types.Connection = {
      id: connection_id,
      type,
      session: conn_session,
      created_at: new Date(),
      remote_addr,
      user_agent,
    };

    this.connections.set(connection_id, connection);
    return connection;
  }

  get_connection(id: string): Types.Connection | null {
    return this.connections.get(id) || null;
  }

  close_connection(id: string): void {
    this.connections.delete(id);
  }

  get_active_connections(): Types.Connection[] {
    return Array.from(this.connections.values());
  }

  cleanup_idle_connections(): number {
    const now = new Date();
    const idle_connections: string[] = [];

    for (const [id, connection] of this.connections) {
      const idle_time = now.getTime() - connection.session.last_activity.getTime();
      if (idle_time > this.connection_timeout_ms) {
        idle_connections.push(id);
      }
    }

    for (const id of idle_connections) {
      this.connections.delete(id);
    }

    return idle_connections.length;
  }

  get_stats(): Types.ServerStats["connections"] {
    const connections = Array.from(this.connections.values());
    return {
      active: connections.length,
      total: connections.length,
      http: connections.filter(c => c.type === "http").length,
      websocket: connections.filter(c => c.type === "websocket").length,
    };
  }

  private generate_connection_id(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export class TransactionManager implements Types.TransactionManager {
  private transactions = new Map<string, Types.Transaction>();
  private transaction_timeout_ms: number;
  private pool?: ConnectionPool;
  private transaction_connections = new Map<string, DatabaseConnection>();
  private pending_begins = new Map<string, Promise<void>>();
  private stats = {
    committed: 0,
    rolled_back: 0,
  };

  constructor(transaction_timeout_ms = 10 * 60 * 1000) { // 10 minutes default
    this.transaction_timeout_ms = transaction_timeout_ms;
  }

  /**
   * Set the connection pool for real PostgreSQL transaction management.
   * When a pool is available, BEGIN/COMMIT/ROLLBACK execute against the database.
   * When no pool is set, the manager falls back to mock/no-op behavior.
   */
  setPool(pool: ConnectionPool): void {
    this.pool = pool;
    logger.info("TransactionManager: connection pool attached");
  }

  /**
   * Get the connection pool, if one has been set.
   */
  getPool(): ConnectionPool | undefined {
    return this.pool;
  }

  begin_transaction(
    session_id: string,
    options: Partial<Types.Transaction> = {}
  ): Types.Transaction {
    const transaction_id = this.generate_transaction_id();

    const transaction: Types.Transaction = {
      id: transaction_id,
      session_id,
      isolation_level: options.isolation_level || "read_committed",
      read_only: options.read_only || false,
      started_at: new Date(),
      statements: [],
    };

    this.transactions.set(transaction_id, transaction);

    // If a pool is available, acquire a connection and execute BEGIN asynchronously.
    // The promise is stored so commit/rollback can await it before proceeding.
    if (this.pool) {
      const beginPromise = this.execute_begin(transaction_id, transaction);
      this.pending_begins.set(transaction_id, beginPromise);
    }

    return transaction;
  }

  get_transaction(id: string): Types.Transaction | null {
    return this.transactions.get(id) || null;
  }

  /**
   * Get the database connection held by an active transaction.
   * Useful for executing queries within an explicit transaction context.
   * Returns null if no pool is attached or the transaction has no held connection.
   */
  get_transaction_connection(id: string): DatabaseConnection | undefined {
    return this.transaction_connections.get(id);
  }

  async commit_transaction(id: string): Promise<void> {
    const transaction = this.transactions.get(id);
    if (!transaction) {
      throw new Error(`Transaction ${id} not found`);
    }

    // Await pending BEGIN if pool is available
    const pendingBegin = this.pending_begins.get(id);
    if (pendingBegin) {
      await pendingBegin;
      this.pending_begins.delete(id);
    }

    // Execute COMMIT on the held connection if available
    const conn = this.transaction_connections.get(id);
    if (conn && this.pool) {
      try {
        await conn.execute("COMMIT");
        logger.info(`Transaction ${id}: COMMIT executed on PostgreSQL`);
      } catch (error) {
        logger.error(`Transaction ${id}: COMMIT failed: ${error}`);
        throw error;
      } finally {
        this.pool.release(conn);
        this.transaction_connections.delete(id);
      }
    }

    this.transactions.delete(id);
    this.stats.committed++;
  }

  async rollback_transaction(id: string): Promise<void> {
    const transaction = this.transactions.get(id);
    if (!transaction) {
      throw new Error(`Transaction ${id} not found`);
    }

    // Await pending BEGIN if pool is available
    const pendingBegin = this.pending_begins.get(id);
    if (pendingBegin) {
      await pendingBegin;
      this.pending_begins.delete(id);
    }

    // Execute ROLLBACK on the held connection if available
    const conn = this.transaction_connections.get(id);
    if (conn && this.pool) {
      try {
        await conn.execute("ROLLBACK");
        logger.info(`Transaction ${id}: ROLLBACK executed on PostgreSQL`);
      } catch (error) {
        logger.error(`Transaction ${id}: ROLLBACK failed: ${error}`);
        throw error;
      } finally {
        this.pool.release(conn);
        this.transaction_connections.delete(id);
      }
    }

    this.transactions.delete(id);
    this.stats.rolled_back++;
  }

  cleanup_abandoned_transactions(): number {
    const now = new Date();
    const abandoned_transactions: string[] = [];

    for (const [id, transaction] of this.transactions) {
      const age = now.getTime() - transaction.started_at.getTime();
      if (age > this.transaction_timeout_ms) {
        abandoned_transactions.push(id);
      }
    }

    for (const id of abandoned_transactions) {
      // Release any held connections for abandoned transactions
      const conn = this.transaction_connections.get(id);
      if (conn && this.pool) {
        try {
          // Best-effort ROLLBACK on abandoned transactions
          conn.execute("ROLLBACK").then(() => {
            this.pool!.release(conn);
          }).catch((error) => {
            logger.error(`Failed to rollback abandoned transaction ${id}: ${error}`);
            this.pool!.release(conn);
          });
        } catch (_) {
          // Swallowing here is intentional: cleanup must not throw
          this.pool.release(conn);
        }
        this.transaction_connections.delete(id);
      }
      this.pending_begins.delete(id);
      this.transactions.delete(id);
    }

    return abandoned_transactions.length;
  }

  get_active_transactions(): Types.Transaction[] {
    return Array.from(this.transactions.values());
  }

  get_stats() {
    return {
      active: this.transactions.size,
      committed: this.stats.committed,
      rolled_back: this.stats.rolled_back,
    };
  }

  private async execute_begin(
    transaction_id: string,
    transaction: Types.Transaction
  ): Promise<void> {
    if (!this.pool) return;

    try {
      const conn = await this.pool.acquire();
      this.transaction_connections.set(transaction_id, conn);

      // Build BEGIN statement with isolation level and read-only options
      let beginSQL = "BEGIN";
      if (transaction.isolation_level === "serializable") {
        beginSQL += " ISOLATION LEVEL SERIALIZABLE";
      } else if (transaction.isolation_level === "repeatable_read") {
        beginSQL += " ISOLATION LEVEL REPEATABLE READ";
      } else {
        beginSQL += " ISOLATION LEVEL READ COMMITTED";
      }

      if (transaction.read_only) {
        beginSQL += " READ ONLY";
      }

      await conn.execute(beginSQL);
      logger.info(`Transaction ${transaction_id}: ${beginSQL} executed on PostgreSQL`);
    } catch (error) {
      logger.error(`Transaction ${transaction_id}: BEGIN failed: ${error}`);
      // Clean up on failure
      const conn = this.transaction_connections.get(transaction_id);
      if (conn && this.pool) {
        this.pool.release(conn);
        this.transaction_connections.delete(transaction_id);
      }
      throw error;
    }
  }

  private generate_transaction_id(): string {
    return `txn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

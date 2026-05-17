/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Connection and Session Management for Disc Server
 */

import { ConnectionPool } from "../lib/connection-pool.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { logger } from "../postgres/logger.ts";
import * as Types from "./types.ts";

export class SessionManager implements Types.SessionManager {
  private sessions = new Map<string, Types.SessionContext>();
  private sessionTimeoutMs: number;

  constructor(sessionTimeoutMs = 30 * 60 * 1000) { // 30 minutes default
    this.sessionTimeoutMs = sessionTimeoutMs;
  }

  createSession(database: string): Types.SessionContext {
    const sessionId = this.generate_session_id();
    const now = new Date();

    const session: Types.SessionContext = {
      sessionId,
      database,
      createdAt: now,
      lastActivity: now,
      variables: {}
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(id: string): Types.SessionContext | null {
    return this.sessions.get(id) || null;
  }

  updateActivity(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastActivity = new Date();
    }
  }

  closeSession(id: string): void {
    this.sessions.delete(id);
  }

  cleanupExpiredSessions(): number {
    const now = new Date();
    const expiredSessions: string[] = [];

    for (const [id, session] of this.sessions) {
      const idleTime = now.getTime() - session.lastActivity.getTime();
      if (idleTime > this.sessionTimeoutMs) {
        expiredSessions.push(id);
      }
    }

    for (const id of expiredSessions) {
      this.sessions.delete(id);
    }

    return expiredSessions.length;
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
  private connectionTimeoutMs: number;

  constructor(connectionTimeoutMs = 5 * 60 * 1000) { // 5 minutes default
    this.connectionTimeoutMs = connectionTimeoutMs;
  }

  createConnection(
    type: Types.Connection["type"],
    remoteAddr: string,
    session?: Types.SessionContext,
    userAgent?: string
  ): Types.Connection {
    const connectionId = this.generate_connection_id();

    // Create a default session if none provided
    const connSession = session || {
      sessionId: this.generate_connection_id(),
      database: "default",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    };

    const connection: Types.Connection = {
      id: connectionId,
      type,
      session: connSession,
      createdAt: new Date(),
      remoteAddr,
      userAgent
    };

    this.connections.set(connectionId, connection);
    return connection;
  }

  getConnection(id: string): Types.Connection | null {
    return this.connections.get(id) || null;
  }

  closeConnection(id: string): void {
    this.connections.delete(id);
  }

  getActiveConnections(): Types.Connection[] {
    return Array.from(this.connections.values());
  }

  cleanupIdleConnections(): number {
    const now = new Date();
    const idleConnections: string[] = [];

    for (const [id, connection] of this.connections) {
      const idleTime = now.getTime() -
        connection.session.lastActivity.getTime();
      if (idleTime > this.connectionTimeoutMs) {
        idleConnections.push(id);
      }
    }

    for (const id of idleConnections) {
      this.connections.delete(id);
    }

    return idleConnections.length;
  }

  get_stats(): Types.ServerStats["connections"] {
    const connections = Array.from(this.connections.values());
    return {
      active: connections.length,
      total: connections.length,
      http: connections.filter(c => c.type === "http").length,
      websocket: connections.filter(c => c.type === "websocket").length
    };
  }

  private generate_connection_id(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export class TransactionManager implements Types.TransactionManager {
  private transactions = new Map<string, Types.Transaction>();
  private transactionTimeoutMs: number;
  private pool?: ConnectionPool;
  private transaction_connections = new Map<string, DatabaseConnection>();
  private pending_begins = new Map<string, Promise<void>>();
  private stats = {
    committed: 0,
    rolledBack: 0
  };

  constructor(transactionTimeoutMs = 10 * 60 * 1000) { // 10 minutes default
    this.transactionTimeoutMs = transactionTimeoutMs;
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

  beginTransaction(
    sessionId: string,
    options: Partial<Types.Transaction> = {}
  ): Types.Transaction {
    const transactionId = this.generate_transaction_id();

    const transaction: Types.Transaction = {
      id: transactionId,
      sessionId,
      isolationLevel: options.isolationLevel || "read_committed",
      readOnly: options.readOnly || false,
      startedAt: new Date(),
      statements: []
    };

    this.transactions.set(transactionId, transaction);

    // If a pool is available, acquire a connection and execute BEGIN asynchronously.
    // The promise is stored so commit/rollback can await it before proceeding.
    if (this.pool) {
      const beginPromise = this.execute_begin(transactionId, transaction);
      this.pending_begins.set(transactionId, beginPromise);
    }

    return transaction;
  }

  getTransaction(id: string): Types.Transaction | null {
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

  async commitTransaction(id: string): Promise<void> {
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

  async rollbackTransaction(id: string): Promise<void> {
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
    this.stats.rolledBack++;
  }

  cleanupAbandonedTransactions(): number {
    const now = new Date();
    const abandonedTransactions: string[] = [];

    for (const [id, transaction] of this.transactions) {
      const age = now.getTime() - transaction.startedAt.getTime();
      if (age > this.transactionTimeoutMs) {
        abandonedTransactions.push(id);
      }
    }

    for (const id of abandonedTransactions) {
      // Release any held connections for abandoned transactions
      const conn = this.transaction_connections.get(id);
      if (conn && this.pool) {
        try {
          // Best-effort ROLLBACK on abandoned transactions
          conn
            .execute("ROLLBACK")
            .then(() => {
              this.pool!.release(conn);
            })
            .catch(error => {
              logger.error(
                `Failed to rollback abandoned transaction ${id}: ${error}`
              );
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

    return abandonedTransactions.length;
  }

  get_active_transactions(): Types.Transaction[] {
    return Array.from(this.transactions.values());
  }

  get_stats() {
    return {
      active: this.transactions.size,
      committed: this.stats.committed,
      rolledBack: this.stats.rolledBack
    };
  }

  private async execute_begin(
    transactionId: string,
    transaction: Types.Transaction
  ): Promise<void> {
    if (!this.pool) {
      return;
    }

    try {
      const conn = await this.pool.acquire();
      this.transaction_connections.set(transactionId, conn);

      // Build BEGIN statement with isolation level and read-only options
      let beginSQL = "BEGIN";
      if (transaction.isolationLevel === "serializable") {
        beginSQL += " ISOLATION LEVEL SERIALIZABLE";
      } else if (transaction.isolationLevel === "repeatable_read") {
        beginSQL += " ISOLATION LEVEL REPEATABLE READ";
      } else {
        beginSQL += " ISOLATION LEVEL READ COMMITTED";
      }

      if (transaction.readOnly) {
        beginSQL += " READ ONLY";
      }

      await conn.execute(beginSQL);
      logger.info(
        `Transaction ${transactionId}: ${beginSQL} executed on PostgreSQL`
      );
    } catch (error) {
      logger.error(`Transaction ${transactionId}: BEGIN failed: ${error}`);
      // Clean up on failure
      const conn = this.transaction_connections.get(transactionId);
      if (conn && this.pool) {
        this.pool.release(conn);
        this.transaction_connections.delete(transactionId);
      }
      throw error;
    }
  }

  private generate_transaction_id(): string {
    return `txn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

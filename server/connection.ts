/**
 * Connection and Session Management for Disc Server
 */

import * as Types from "./types.ts";

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
    return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

export class TransactionManager implements Types.TransactionManager {
  private transactions = new Map<string, Types.Transaction>();
  private transaction_timeout_ms: number;

  constructor(transaction_timeout_ms = 10 * 60 * 1000) { // 10 minutes default
    this.transaction_timeout_ms = transaction_timeout_ms;
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
    return transaction;
  }

  get_transaction(id: string): Types.Transaction | null {
    return this.transactions.get(id) || null;
  }

  async commit_transaction(id: string): Promise<void> {
    const transaction = this.transactions.get(id);
    if (!transaction) {
      throw new Error(`Transaction ${id} not found`);
    }

    // In a real implementation, this would execute COMMIT on PostgreSQL
    // For now, we'll simulate successful commit
    this.transactions.delete(id);
  }

  async rollback_transaction(id: string): Promise<void> {
    const transaction = this.transactions.get(id);
    if (!transaction) {
      throw new Error(`Transaction ${id} not found`);
    }

    // In a real implementation, this would execute ROLLBACK on PostgreSQL
    // For now, we'll simulate successful rollback
    this.transactions.delete(id);
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
      this.transactions.delete(id);
    }

    return abandoned_transactions.length;
  }

  get_active_transactions(): Types.Transaction[] {
    return Array.from(this.transactions.values());
  }

  private generate_transaction_id(): string {
    return `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
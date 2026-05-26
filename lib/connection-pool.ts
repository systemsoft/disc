/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Database Connection Pool for Disc
 *
 * Provides efficient connection pooling with:
 * - Minimum and maximum connection limits
 * - Connection validation
 * - Idle connection cleanup
 * - Request queuing when pool is full
 * - Statistics tracking
 */

import { logger } from "../postgres/logger.ts";
import { DatabaseConfig, DatabaseConnection, QueryResult } from "./database.ts";
import { QueryTimeoutError } from "./errors.ts";

export interface PoolConfig extends DatabaseConfig {
  minConnections?: number;
  maxConnections?: number;
  connectionTimeout?: number;
  idleTimeout?: number;
  validateOnAcquire?: boolean;
  maxWaitQueueSize?: number;
  cleanupInterval?: number;
  leakWarningTimeout?: number;
}

interface PooledConnection {
  connection: DatabaseConnection;
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  inUse: boolean;
  acquiredAt?: Date;
  acquireStackTrace?: string;
}

interface WaitQueueEntry {
  resolve: (conn: DatabaseConnection) => void;
  reject: (error: Error) => void;
  timeoutId: number;
  /** Marked true when the entry times out; consumers skip it. (P2-28) */
  cancelled: boolean;
}

interface PoolStatistics {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitQueueSize: number;
  totalAcquired: number;
  totalReleased: number;
  totalCreated: number;
  totalDestroyed: number;
  totalErrors: number;
}

export class ConnectionPool {
  private config: PoolConfig;
  private connections: Map<string, PooledConnection> = new Map();
  private connectionToPooled: Map<DatabaseConnection, PooledConnection> = new Map();
  private idleConnections: PooledConnection[] = [];
  private waitQueue: WaitQueueEntry[] = [];
  private cleanupIntervalId?: number;
  private closed = false;
  private activeCount = 0;
  private leakTimers: Map<string, number> = new Map();
  private stats: PoolStatistics = {
    totalConnections: 0,
    activeConnections: 0,
    idleConnections: 0,
    waitQueueSize: 0,
    totalAcquired: 0,
    totalReleased: 0,
    totalCreated: 0,
    totalDestroyed: 0,
    totalErrors: 0
  };

  constructor(config: PoolConfig) {
    this.config = {
      ...config,
      minConnections: config.minConnections ?? 2,
      maxConnections: config.maxConnections ?? 10,
      connectionTimeout: config.connectionTimeout ?? 30000,
      idleTimeout: config.idleTimeout ?? 600000, // 10 minutes
      validateOnAcquire: config.validateOnAcquire ?? true,
      maxWaitQueueSize: config.maxWaitQueueSize ?? 50,
      cleanupInterval: config.cleanupInterval ?? 60000, // 1 minute
      leakWarningTimeout: config.leakWarningTimeout ?? 30000 // 30 seconds
    };
  }

  async initialize(): Promise<void> {
    // Idempotent: re-initializing an already-started pool would leak a second
    // cleanup interval (only the latest id is tracked in close()) and
    // duplicate the initial connections — causing disc migrate to hang on exit.
    if (this.cleanupIntervalId !== undefined || this.connections.size > 0) {
      return;
    }

    logger.debug(
      `Initializing connection pool with min=${this.config.minConnections}, max=${this.config.maxConnections}`
    );

    // Create minimum connections
    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.config.minConnections!; i++) {
      promises.push(
        this.createConnection().then(conn => {
          if (conn) {
            this.idleConnections.push(conn);
          }
        })
      );
    }

    await Promise.all(promises);

    // Start cleanup interval
    if (this.config.cleanupInterval! > 0) {
      this.cleanupIntervalId = setInterval(
        () => this.cleanupIdleConnections(),
        this.config.cleanupInterval!
      );
    }

    logger.debug(
      `Connection pool initialized with ${this.connections.size} connections`
    );
  }

  async acquire(): Promise<DatabaseConnection> {
    const acquireStack = new Error().stack;

    // Check if we have idle connections
    while (this.idleConnections.length > 0) {
      const pooled = this.idleConnections.shift()!;
      pooled.inUse = true;
      pooled.lastUsedAt = new Date();

      // Validate connection if required
      if (this.config.validateOnAcquire) {
        const isValid = await this.validateConnection(pooled.connection);
        if (!isValid) {
          await this.destroyConnection(pooled);
          continue;
        }
      }

      pooled.acquiredAt = new Date();
      pooled.acquireStackTrace = acquireStack;
      this.startLeakTimer(pooled);
      this.stats.totalAcquired++;
      this.activeCount++;
      this.updateStats();
      return pooled.connection;
    }

    // Check if we can create a new connection
    if (this.connections.size < this.config.maxConnections!) {
      const pooled = await this.createConnection();
      if (pooled) {
        pooled.inUse = true;
        pooled.acquiredAt = new Date();
        pooled.acquireStackTrace = acquireStack;
        this.startLeakTimer(pooled);
        this.stats.totalAcquired++;
        this.activeCount++;
        this.updateStats();
        return pooled.connection;
      }
    }

    // Check if wait queue is full
    if (this.waitQueue.length >= this.config.maxWaitQueueSize!) {
      throw new Error("Connection pool wait queue is full");
    }

    // Add to wait queue. Timeout cancellation is O(1) via a shared
    // `cancelled` flag on the entry — consumers (release / close) skip
    // cancelled entries instead of splicing on every timeout. (P2-28)
    return new Promise((resolve, reject) => {
      const entry: WaitQueueEntry = {
        resolve,
        reject,
        timeoutId: 0,
        cancelled: false
      };
      entry.timeoutId = setTimeout(() => {
        if (!entry.cancelled) {
          entry.cancelled = true;
          this.updateStats();
          reject(new Error("Connection pool timeout"));
        }
      }, this.config.connectionTimeout!);

      this.waitQueue.push(entry);
      this.updateStats();
    });
  }

  release(connection: DatabaseConnection): void {
    // O(1) reverse lookup instead of linear scan through all connections
    const pooled = this.connectionToPooled.get(connection);

    if (!pooled) {
      logger.debug("Attempted to release unknown connection");
      return;
    }

    this.clearLeakTimer(pooled);
    pooled.inUse = false;
    pooled.acquiredAt = undefined;
    pooled.acquireStackTrace = undefined;
    pooled.lastUsedAt = new Date();
    this.stats.totalReleased++;
    this.activeCount--;

    // Hand the connection to the oldest non-cancelled waiter.
    // Cancelled entries (timed out) are skipped in FIFO order. (P2-28)
    let entry: WaitQueueEntry | undefined;
    while (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()!;
      if (!next.cancelled) {
        entry = next;
        break;
      }
    }
    if (entry) {
      clearTimeout(entry.timeoutId);
      pooled.inUse = true;
      pooled.acquiredAt = new Date();
      pooled.lastUsedAt = new Date();
      this.startLeakTimer(pooled);
      this.stats.totalAcquired++;
      this.activeCount++;
      this.updateStats();
      entry.resolve(connection);
      return;
    }

    // Add to idle pool
    this.idleConnections.push(pooled);
    this.updateStats();
  }

  async query(sql: string, params?: any[]): Promise<QueryResult> {
    const connection = await this.acquire();
    try {
      return await connection.query(sql, params);
    } finally {
      this.release(connection);
    }
  }

  async queryWithTimeout(
    sql: string,
    params: unknown[],
    timeoutMs: number
  ): Promise<QueryResult> {
    if (timeoutMs <= 0) {
      return this.query(sql, params as any[]);
    }

    let timerId: number | undefined;

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timerId = setTimeout(() => {
        reject(new QueryTimeoutError(sql, timeoutMs));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        this.query(sql, params as any[]),
        timeoutPromise
      ]);
      return result;
    } finally {
      if (timerId !== undefined) {
        clearTimeout(timerId);
      }
    }
  }

  async execute(sql: string, params?: any[]): Promise<void> {
    const connection = await this.acquire();
    try {
      await connection.execute(sql, params);
    } finally {
      this.release(connection);
    }
  }

  async transaction<T>(
    fn: (conn: DatabaseConnection) => Promise<T>
  ): Promise<T> {
    const connection = await this.acquire();
    try {
      return await connection.transaction(fn);
    } finally {
      this.release(connection);
    }
  }

  async close(): Promise<void> {
    logger.debug("Closing connection pool");

    this.closed = true;

    // Clear cleanup interval
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }

    // Clear all leak timers
    for (const timerId of this.leakTimers.values()) {
      clearTimeout(timerId);
    }
    this.leakTimers.clear();

    // Reject all waiting requests. Cancelled entries already rejected
    // themselves via the timeout — skip them. (P2-28)
    for (const entry of this.waitQueue) {
      clearTimeout(entry.timeoutId);
      if (!entry.cancelled) {
        entry.reject(new Error("Connection pool is closing"));
      }
    }
    this.waitQueue = [];

    // Close all connections
    const promises: Promise<void>[] = [];
    for (const pooled of this.connections.values()) {
      promises.push(pooled.connection.close());
    }

    await Promise.all(promises);
    this.connections.clear();
    this.connectionToPooled.clear();
    this.idleConnections = [];
    this.activeCount = 0;

    logger.debug("Connection pool closed");
  }

  async cleanupIdleConnections(): Promise<void> {
    const now = new Date();
    const toDestroy: PooledConnection[] = [];

    this.idleConnections = this.idleConnections.filter(pooled => {
      const idleTime = now.getTime() - pooled.lastUsedAt.getTime();

      // Keep minimum connections
      if (this.connections.size <= this.config.minConnections!) {
        return true;
      }

      // Remove if idle too long
      if (idleTime > this.config.idleTimeout!) {
        toDestroy.push(pooled);
        return false;
      }

      return true;
    });

    // Destroy idle connections
    for (const pooled of toDestroy) {
      await this.destroyConnection(pooled);
    }

    if (toDestroy.length > 0) {
      logger.debug(`Cleaned up ${toDestroy.length} idle connections`);
    }
  }

  getPoolSize(): number {
    return this.connections.size;
  }

  getActiveConnections(): number {
    return this.stats.activeConnections;
  }

  getIdleConnections(): number {
    return this.idleConnections.length;
  }

  getMaxConnections(): number {
    return this.config.maxConnections!;
  }

  getMinConnections(): number {
    return this.config.minConnections!;
  }

  getWaitQueueSize(): number {
    return this.waitQueue.length;
  }

  getStatistics(): PoolStatistics {
    return { ...this.stats };
  }

  private async createConnection(): Promise<PooledConnection | null> {
    const maxRetries = this.config.maxRetries ?? 3;
    const baseDelay = this.config.retryDelay ?? 1000;
    const maxDelay = 30000; // Cap at 30 seconds

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const connection = new DatabaseConnection(this.config);
        await connection.connect();

        const pooled: PooledConnection = {
          connection,
          id: this.generateConnectionId(),
          createdAt: new Date(),
          lastUsedAt: new Date(),
          inUse: false
        };

        this.connections.set(pooled.id, pooled);
        this.connectionToPooled.set(connection, pooled);
        this.stats.totalCreated++;
        this.updateStats();

        logger.debug(`Created connection ${pooled.id} (${this.connections.size}/${this.config.maxConnections})`);
        return pooled;
      } catch (error) {
        this.stats.totalErrors++;
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        logger.debug(`Failed to create connection (attempt ${attempt}/${maxRetries}, next retry in ${delay}ms): ${error}`);

        if (attempt < maxRetries)
          await new Promise(resolve => setTimeout(resolve, delay));
        else
          throw new Error(`Failed to create connection after ${maxRetries} attempts: ${error}`);
      }
    }

    return null;
  }

  private async destroyConnection(pooled: PooledConnection): Promise<void> {
    try {
      await pooled.connection.close();
    } catch (error) {
      logger.debug(`Error closing connection ${pooled.id}: ${error}`);
    }

    this.connections.delete(pooled.id);
    this.connectionToPooled.delete(pooled.connection);
    this.stats.totalDestroyed++;
    this.updateStats();

    logger.debug(`Destroyed connection ${pooled.id} (${this.connections.size}/${this.config.maxConnections})`);
  }

  private async validateConnection(
    connection: DatabaseConnection
  ): Promise<boolean> {
    try {
      const result = await connection.query("SELECT 1");
      return result.rowCount === 1;
    } catch (error) {
      logger.debug(`Connection validation failed: ${error}`);
      return false;
    }
  }

  private updateStats(): void {
    this.stats.totalConnections = this.connections.size;
    this.stats.activeConnections = this.activeCount;
    this.stats.idleConnections = this.idleConnections.length;
    this.stats.waitQueueSize = this.waitQueue.length;
  }

  isHealthy(): boolean {
    // Not healthy if pool is closed
    if (this.closed) {
      return false;
    }

    // Not healthy if all connections in use and wait queue has waiters
    const allInUse = this.connections.size >= this.config.maxConnections! &&
      this.idleConnections.length === 0;
    if (allInUse && this.waitQueue.length > 0) {
      return false;
    }

    // Healthy if we have idle connections or can create new ones
    return true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private startLeakTimer(pooled: PooledConnection): void {
    const timeout = this.config.leakWarningTimeout!;
    if (timeout <= 0) {
      return;
    }

    const timerId = setTimeout(() => {
      const heldMs = pooled.acquiredAt ?
        Date.now() - pooled.acquiredAt.getTime() :
        timeout;
      logger.debug(
        `Potential connection leak detected: connection ${pooled.id} has been held for ${heldMs}ms without being released.\nAcquire stack trace:\n${
          pooled.acquireStackTrace || "unavailable"
        }`
      );
      this.leakTimers.delete(pooled.id);
    }, timeout);

    this.leakTimers.set(pooled.id, timerId);
  }

  private clearLeakTimer(pooled: PooledConnection): void {
    const timerId = this.leakTimers.get(pooled.id);
    if (timerId !== undefined) {
      clearTimeout(timerId);
      this.leakTimers.delete(pooled.id);
    }
  }

  private generateConnectionId(): string {
    return `pool_conn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

/**
 * Create a connection pool from environment variables
 */
export function createPoolFromEnv(): ConnectionPool {
  const connectionString = Deno.env.get("DATABASE_URL");
  const config: PoolConfig = connectionString ? { connectionString } : {
    host: Deno.env.get("DB_HOST") || "localhost",
    port: parseInt(Deno.env.get("DB_PORT") || "5432"),
    database: Deno.env.get("DB_NAME") || "disc",
    user: Deno.env.get("DB_USER") || "disc",
    password: Deno.env.get("DB_PASSWORD") || ""
  };

  // Add pool-specific configuration from environment
  config.minConnections = parseInt(Deno.env.get("DB_POOL_MIN") || "2");
  config.maxConnections = parseInt(Deno.env.get("DB_POOL_MAX") || "10");
  config.idleTimeout = parseInt(
    Deno.env.get("DB_POOL_IDLE_TIMEOUT") || "600000"
  );
  config.connectionTimeout = parseInt(
    Deno.env.get("DB_POOL_CONNECTION_TIMEOUT") || "30000"
  );

  return new ConnectionPool(config);
}

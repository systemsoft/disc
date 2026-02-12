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

import { DatabaseConfig, DatabaseConnection, QueryResult } from "./database.ts";
import { logger } from "../postgres/logger.ts";

export interface PoolConfig extends DatabaseConfig {
  minConnections?: number;
  maxConnections?: number;
  connectionTimeout?: number;
  idleTimeout?: number;
  validateOnAcquire?: boolean;
  maxWaitQueueSize?: number;
  cleanupInterval?: number;
}

interface PooledConnection {
  connection: DatabaseConnection;
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  inUse: boolean;
}

interface WaitQueueEntry {
  resolve: (conn: DatabaseConnection) => void;
  reject: (error: Error) => void;
  timeoutId: number;
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
  private idleConnections: PooledConnection[] = [];
  private waitQueue: WaitQueueEntry[] = [];
  private cleanupIntervalId?: number;
  private stats: PoolStatistics = {
    totalConnections: 0,
    activeConnections: 0,
    idleConnections: 0,
    waitQueueSize: 0,
    totalAcquired: 0,
    totalReleased: 0,
    totalCreated: 0,
    totalDestroyed: 0,
    totalErrors: 0,
  };

  constructor(config: PoolConfig) {
    this.config = {
      ...config,
      minConnections: config.minConnections ?? 0,
      maxConnections: config.maxConnections ?? 10,
      connectionTimeout: config.connectionTimeout ?? 30000,
      idleTimeout: config.idleTimeout ?? 600000, // 10 minutes
      validateOnAcquire: config.validateOnAcquire ?? false,
      maxWaitQueueSize: config.maxWaitQueueSize ?? 50,
      cleanupInterval: config.cleanupInterval ?? 60000, // 1 minute
    };
  }

  async initialize(): Promise<void> {
    logger.info(
      `Initializing connection pool with min=${this.config.minConnections}, max=${this.config.maxConnections}`,
    );

    // Create minimum connections
    const promises: Promise<void>[] = [];
    for (let i = 0; i < this.config.minConnections!; i++) {
      promises.push(
        this.createConnection().then((conn) => {
          if (conn) {
            this.idleConnections.push(conn);
          }
        }),
      );
    }

    await Promise.all(promises);

    // Start cleanup interval
    if (this.config.cleanupInterval! > 0) {
      this.cleanupIntervalId = setInterval(
        () => this.cleanupIdleConnections(),
        this.config.cleanupInterval!,
      );
    }

    logger.info(
      `Connection pool initialized with ${this.connections.size} connections`,
    );
  }

  async acquire(): Promise<DatabaseConnection> {
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

      this.stats.totalAcquired++;
      this.updateStats();
      return pooled.connection;
    }

    // Check if we can create a new connection
    if (this.connections.size < this.config.maxConnections!) {
      const pooled = await this.createConnection();
      if (pooled) {
        pooled.inUse = true;
        this.stats.totalAcquired++;
        this.updateStats();
        return pooled.connection;
      }
    }

    // Check if wait queue is full
    if (this.waitQueue.length >= this.config.maxWaitQueueSize!) {
      throw new Error("Connection pool wait queue is full");
    }

    // Add to wait queue
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.waitQueue.findIndex((entry) =>
          entry.timeoutId === timeoutId
        );
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
          this.updateStats();
          reject(new Error("Connection pool timeout"));
        }
      }, this.config.connectionTimeout!);

      this.waitQueue.push({ resolve, reject, timeoutId });
      this.updateStats();
    });
  }

  release(connection: DatabaseConnection): void {
    // Find the pooled connection
    let pooled: PooledConnection | undefined;
    for (const [_id, pc] of this.connections) {
      if (pc.connection === connection) {
        pooled = pc;
        break;
      }
    }

    if (!pooled) {
      logger.warn("Attempted to release unknown connection");
      return;
    }

    pooled.inUse = false;
    pooled.lastUsedAt = new Date();
    this.stats.totalReleased++;

    // Check if there are waiting requests
    if (this.waitQueue.length > 0) {
      const entry = this.waitQueue.shift()!;
      clearTimeout(entry.timeoutId);
      pooled.inUse = true;
      pooled.lastUsedAt = new Date();
      this.stats.totalAcquired++;
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

  async execute(sql: string, params?: any[]): Promise<void> {
    const connection = await this.acquire();
    try {
      await connection.execute(sql, params);
    } finally {
      this.release(connection);
    }
  }

  async transaction<T>(
    fn: (conn: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.acquire();
    try {
      return await connection.transaction(fn);
    } finally {
      this.release(connection);
    }
  }

  async close(): Promise<void> {
    logger.info("Closing connection pool");

    // Clear cleanup interval
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }

    // Reject all waiting requests
    for (const entry of this.waitQueue) {
      clearTimeout(entry.timeoutId);
      entry.reject(new Error("Connection pool is closing"));
    }
    this.waitQueue = [];

    // Close all connections
    const promises: Promise<void>[] = [];
    for (const pooled of this.connections.values()) {
      promises.push(pooled.connection.close());
    }

    await Promise.all(promises);
    this.connections.clear();
    this.idleConnections = [];

    logger.info("Connection pool closed");
  }

  async cleanupIdleConnections(): Promise<void> {
    const now = new Date();
    const toDestroy: PooledConnection[] = [];

    this.idleConnections = this.idleConnections.filter((pooled) => {
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
      logger.info(`Cleaned up ${toDestroy.length} idle connections`);
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
    const retryDelay = this.config.retryDelay ?? 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const connection = new DatabaseConnection(this.config);
        await connection.connect();

        const pooled: PooledConnection = {
          connection,
          id: this.generateConnectionId(),
          createdAt: new Date(),
          lastUsedAt: new Date(),
          inUse: false,
        };

        this.connections.set(pooled.id, pooled);
        this.stats.totalCreated++;
        this.updateStats();

        logger.info(
          `Created connection ${pooled.id} (${this.connections.size}/${this.config.maxConnections})`,
        );
        return pooled;
      } catch (error) {
        this.stats.totalErrors++;
        logger.warn(
          `Failed to create connection (attempt ${attempt}/${maxRetries}): ${error}`,
        );

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        } else {
          throw new Error(
            `Failed to create connection after ${maxRetries} attempts: ${error}`,
          );
        }
      }
    }

    return null;
  }

  private async destroyConnection(pooled: PooledConnection): Promise<void> {
    try {
      await pooled.connection.close();
    } catch (error) {
      logger.error(`Error closing connection ${pooled.id}: ${error}`);
    }

    this.connections.delete(pooled.id);
    this.stats.totalDestroyed++;
    this.updateStats();

    logger.info(
      `Destroyed connection ${pooled.id} (${this.connections.size}/${this.config.maxConnections})`,
    );
  }

  private async validateConnection(
    connection: DatabaseConnection,
  ): Promise<boolean> {
    try {
      const result = await connection.query("SELECT 1");
      return result.rowCount === 1;
    } catch (error) {
      logger.warn(`Connection validation failed: ${error}`);
      return false;
    }
  }

  private updateStats(): void {
    this.stats.totalConnections = this.connections.size;
    this.stats.activeConnections = Array.from(this.connections.values())
      .filter((pc) => pc.inUse).length;
    this.stats.idleConnections = this.idleConnections.length;
    this.stats.waitQueueSize = this.waitQueue.length;
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
    password: Deno.env.get("DB_PASSWORD") || "",
  };

  // Add pool-specific configuration from environment
  config.minConnections = parseInt(Deno.env.get("DB_POOL_MIN") || "2");
  config.maxConnections = parseInt(Deno.env.get("DB_POOL_MAX") || "10");
  config.idleTimeout = parseInt(
    Deno.env.get("DB_POOL_IDLE_TIMEOUT") || "600000",
  );
  config.connectionTimeout = parseInt(
    Deno.env.get("DB_POOL_CONNECTION_TIMEOUT") || "30000",
  );

  return new ConnectionPool(config);
}

/**
 * Database connection utilities for Disc
 */

import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { logger } from "../postgres/logger.ts";

export interface QueryResult {
  rows: Record<string, any>[];
  rowCount: number;
}

export interface DatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  maxRetries?: number;
  retryDelay?: number;
}

export class DatabaseConnection {
  private client: Client;
  private config: DatabaseConfig;
  private connected = false;

  constructor(config: DatabaseConfig | string) {
    if (typeof config === "string") {
      this.config = { connectionString: config };
    } else {
      this.config = config;
    }

    this.client = new Client(this.getClientConfig());
  }

  private getClientConfig() {
    if (this.config.connectionString) {
      // Parse connection string
      const url = new URL(this.config.connectionString);
      return {
        hostname: url.hostname,
        port: url.port ? parseInt(url.port) : 5432,
        user: url.username || "postgres",
        password: url.password || "",
        database: url.pathname.slice(1) || "postgres",
      };
    }

    return {
      hostname: this.config.host || "localhost",
      port: this.config.port || 5432,
      user: this.config.user || "postgres",
      password: this.config.password || "",
      database: this.config.database || "postgres",
    };
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const maxRetries = this.config.maxRetries || 3;
    const retryDelay = this.config.retryDelay || 1000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.client.connect();
        this.connected = true;
        logger.info(`Connected to PostgreSQL database`);
        return;
      } catch (error) {
        logger.warn(
          `Connection attempt ${attempt}/${maxRetries} failed: ${error}`,
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        } else {
          throw new Error(
            `Failed to connect to database after ${maxRetries} attempts: ${error}`,
          );
        }
      }
    }
  }

  async query(sql: string, params?: any[]): Promise<QueryResult> {
    if (!this.connected) {
      await this.connect();
    }

    try {
      const result = await this.client.queryObject(sql, params);
      return {
        rows: result.rows as Record<string, any>[],
        rowCount: result.rowCount || 0,
      };
    } catch (error) {
      logger.error(`Query failed: ${error}`);
      throw error;
    }
  }

  async execute(sql: string, params?: any[]): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }

    try {
      await this.client.queryArray(sql, params);
    } catch (error) {
      logger.error(`Execute failed: ${error}`);
      throw error;
    }
  }

  async transaction<T>(
    fn: (conn: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    if (!this.connected) {
      await this.connect();
    }

    await this.execute("BEGIN");
    try {
      const result = await fn(this);
      await this.execute("COMMIT");
      return result;
    } catch (error) {
      await this.execute("ROLLBACK");
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.end();
      this.connected = false;
      logger.info("Database connection closed");
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Create database if it doesn't exist
   */
  async createDatabaseIfNotExists(dbName: string): Promise<void> {
    // Connect to postgres database to create new database
    const adminClient = new Client({
      ...this.getClientConfig(),
      database: "postgres",
    });

    try {
      await adminClient.connect();

      // Check if database exists
      const result = await adminClient.queryObject(
        `SELECT 1 FROM pg_database WHERE datname = $1`,
        [dbName],
      );

      if (result.rowCount === 0) {
        // Create database
        await adminClient.queryArray(`CREATE DATABASE "${dbName}"`);
        logger.info(`Created database: ${dbName}`);
      } else {
        logger.info(`Database already exists: ${dbName}`);
      }
    } finally {
      await adminClient.end();
    }
  }

  /**
   * Check if a table exists
   */
  async tableExists(tableName: string): Promise<boolean> {
    const result = await this.query(
      `SELECT 1 FROM information_schema.tables 
       WHERE table_schema = 'public' 
       AND tableName = $1`,
      [tableName],
    );
    return result.rowCount > 0;
  }

  /**
   * Execute multiple SQL statements
   */
  async executeMany(statements: string[]): Promise<void> {
    for (const statement of statements) {
      if (statement.trim()) {
        await this.execute(statement);
      }
    }
  }
}

/**
 * Create a database connection from environment variables
 */
export function createConnectionFromEnv(): DatabaseConnection {
  const connectionString = Deno.env.get("DATABASE_URL");
  if (connectionString) {
    return new DatabaseConnection(connectionString);
  }

  return new DatabaseConnection({
    host: Deno.env.get("DB_HOST") || "localhost",
    port: parseInt(Deno.env.get("DB_PORT") || "5432"),
    database: Deno.env.get("DB_NAME") || "disc",
    user: Deno.env.get("DB_USER") || "disc",
    password: Deno.env.get("DB_PASSWORD") || "",
  });
}

/**
 * Create a connection to a Disc-managed PostgreSQL instance
 */
export function createDiscConnection(
  instanceName: string,
  socketDir?: string,
): DatabaseConnection {
  if (socketDir) {
    // Unix socket connection
    return new DatabaseConnection({
      connectionString: `postgresql://disc@/${instanceName}?host=${socketDir}`,
    });
  }

  // TCP connection
  return new DatabaseConnection({
    host: "localhost",
    port: 5432,
    database: instanceName,
    user: "disc",
  });
}

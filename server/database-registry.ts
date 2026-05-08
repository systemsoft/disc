/**
 * Database Registry — maps named databases to connection pools,
 * schemas, and migration trackers.
 *
 * Each named database corresponds to a separate PostgreSQL database
 * within the same cluster, prefixed with `disc_` to avoid collisions
 * with system databases.
 */

import type { Schema } from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { createDatabase, dropDatabase, replaceDsnDatabase } from "../lib/database.ts";
import { DatabaseRegistryError } from "../lib/errors.ts";
import { MigrationTracker } from "../migration/tracker.ts";
import { logger } from "../postgres/logger.ts";

/**
 * A single database entry managed by the registry.
 */
export interface DatabaseEntry {
  name: string;
  pool: ConnectionPool;
  schema: Schema | null;
  migrationTracker: MigrationTracker | null;
  databaseUrl: string;
}

/** Regex for valid database names: lowercase alphanumeric and underscores. */
const VALID_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Default database name used for backward compatibility. */
const DEFAULT_DATABASE_NAME = "disc";

/** Prefix applied to all Disc-managed PG database names. */
const DATABASE_PREFIX = "disc_";

export class DatabaseRegistry {
  private databases: Map<string, DatabaseEntry> = new Map();
  private defaultDatabaseUrl = "";
  private initialized = false;

  /**
   * Initialize the registry with a default database entry.
   * The default entry uses the DSN as-is (no disc_ prefix) for backward compat.
   */
  async initialize(defaultDatabaseUrl: string): Promise<void> {
    if (this.initialized) {
      throw new DatabaseRegistryError(
        "DatabaseRegistry is already initialized"
      );
    }

    this.defaultDatabaseUrl = defaultDatabaseUrl;

    // Create the default pool — connects to the existing database in the DSN
    const pool = new ConnectionPool({
      connectionString: defaultDatabaseUrl,
      minConnections: 2,
      maxConnections: 10
    });

    await pool.initialize();

    const entry: DatabaseEntry = {
      name: DEFAULT_DATABASE_NAME,
      pool,
      schema: null,
      migrationTracker: null,
      databaseUrl: defaultDatabaseUrl
    };

    this.databases.set(DEFAULT_DATABASE_NAME, entry);
    this.initialized = true;

    logger.info(
      `DatabaseRegistry initialized with default database "${DEFAULT_DATABASE_NAME}"`
    );
  }

  /**
   * Create a new named database.
   * Runs `CREATE DATABASE disc_<name>` via an admin connection,
   * then creates a ConnectionPool targeting the new database.
   */
  async createDatabase(name: string): Promise<DatabaseEntry> {
    this.ensureInitialized();

    if (!VALID_NAME_RE.test(name)) {
      throw new DatabaseRegistryError(
        `Invalid database name "${name}": must start with a lowercase letter and contain only lowercase letters, digits, and underscores`
      );
    }

    if (this.databases.has(name)) {
      throw new DatabaseRegistryError(
        `Database "${name}" already exists in the registry`
      );
    }

    const pgDatabaseName = `${DATABASE_PREFIX}${name}`;
    const databaseUrl = replaceDsnDatabase(
      this.defaultDatabaseUrl,
      pgDatabaseName
    );

    // Create the PostgreSQL database via the admin (postgres) database
    await createDatabase(this.defaultDatabaseUrl, pgDatabaseName);

    // Create a pool for the new database
    const pool = new ConnectionPool({
      connectionString: databaseUrl,
      minConnections: 2,
      maxConnections: 10
    });

    const entry: DatabaseEntry = {
      name,
      pool,
      schema: null,
      migrationTracker: null,
      databaseUrl
    };

    this.databases.set(name, entry);

    logger.info(
      `Created database "${name}" (PG: ${pgDatabaseName})`
    );

    return entry;
  }

  /**
   * Drop a named database.
   * Closes the pool, removes the registry entry, then runs
   * `DROP DATABASE disc_<name>`.
   *
   * The default database cannot be dropped.
   */
  async dropDatabase(name: string): Promise<void> {
    this.ensureInitialized();

    if (name === DEFAULT_DATABASE_NAME) {
      throw new DatabaseRegistryError(
        "Cannot drop the default database"
      );
    }

    const entry = this.databases.get(name);
    if (!entry) {
      throw new DatabaseRegistryError(
        `Database "${name}" not found in the registry`
      );
    }

    // Close the pool first so all connections are released
    await entry.pool.close();

    // Remove from registry before dropping so a retry won't find stale state
    this.databases.delete(name);

    const pgDatabaseName = `${DATABASE_PREFIX}${name}`;
    await dropDatabase(this.defaultDatabaseUrl, pgDatabaseName);

    logger.info(
      `Dropped database "${name}" (PG: ${pgDatabaseName})`
    );
  }

  /**
   * Get a database entry by name, or undefined if not found.
   */
  getDatabase(name: string): DatabaseEntry | undefined {
    return this.databases.get(name);
  }

  /**
   * Get the default database entry.
   */
  getDefaultDatabase(): DatabaseEntry {
    this.ensureInitialized();
    return this.databases.get(DEFAULT_DATABASE_NAME)!;
  }

  /**
   * List all registered database names.
   */
  listDatabases(): string[] {
    return Array.from(this.databases.keys());
  }

  /**
   * Close all connection pools and clear the registry.
   */
  async close(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    for (const entry of this.databases.values()) {
      closePromises.push(entry.pool.close());
    }

    await Promise.all(closePromises);
    this.databases.clear();
    this.initialized = false;

    logger.info("DatabaseRegistry closed — all pools drained");
  }

  /**
   * Throw if the registry has not been initialized.
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new DatabaseRegistryError(
        "DatabaseRegistry has not been initialized — call initialize() first"
      );
    }
  }
}

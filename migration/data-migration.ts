/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Data Migration System
 *
 * Provides a framework for running custom TypeScript data migrations
 * alongside schema (DDL) migrations. Data migration files are named
 * `m<timestamp>_<name>.data.ts` and live in `dbschema/migrations/`.
 */

import { ConnectionPool } from "../lib/connection-pool.ts";
import { MigrationError } from "../lib/errors.ts";
import { logger } from "../postgres/logger.ts";

/**
 * Context passed to data migration up/down functions.
 * Provides helpers for executing SQL and EdgeQL queries
 * within the migration transaction.
 */
export interface DataMigrationContext {
  sql(query: string, params?: unknown[]): Promise<unknown[]>;
  edgeql(query: string, params?: unknown[]): Promise<unknown>;
  pool: ConnectionPool;
  log(message: string): void;
}

/**
 * Shape of a data migration module.
 * Each `.data.ts` file must export a default object matching this interface.
 */
export interface DataMigration {
  name: string;
  timestamp: string;
  up(context: DataMigrationContext): Promise<void>;
  down?(context: DataMigrationContext): Promise<void>;
}

/**
 * Internal representation of a discovered data migration file.
 */
interface DiscoveredDataMigration {
  filePath: string;
  timestamp: string;
  migration: DataMigration;
}

/**
 * Discovers and executes data migration files.
 */
export class DataMigrationRunner {
  /**
   * Scan a directory for `*.data.ts` files and dynamically import them.
   * Returns migrations sorted by timestamp (ascending).
   */
  async discoverMigrations(dir: string): Promise<DataMigration[]> {
    const discovered: DiscoveredDataMigration[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile) {
          continue;
        }
        if (!entry.name.endsWith(".data.ts")) {
          continue;
        }

        // Extract timestamp from filename: m<timestamp>_<name>.data.ts
        const match = entry.name.match(/^m(\d{8,}T?\d*)_/);
        if (!match) {
          logger.warn(
            `Skipping data migration file with invalid name format: ${entry.name}`
          );
          continue;
        }

        const timestamp = match[1];
        const filePath = `${dir}/${entry.name}`;

        try {
          const fileUrl = new URL(`file://${Deno.realPathSync(filePath)}`);
          const mod = await import(fileUrl.href);
          const migration: DataMigration = mod.default;

          if (!migration || typeof migration.up !== "function") {
            logger.warn(
              `Skipping ${entry.name}: missing default export or up() function`
            );
            continue;
          }

          discovered.push({
            filePath,
            timestamp,
            migration: {
              ...migration,
              timestamp: migration.timestamp || timestamp
            }
          });
        } catch (error) {
          logger.warn(
            `Failed to import data migration ${entry.name}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // Directory doesn't exist — no data migrations to discover
        return [];
      }
      throw error;
    }

    // Sort by timestamp ascending
    discovered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    return discovered.map(d => d.migration);
  }

  /**
   * Run a single data migration's up() function within a transaction.
   */
  async runMigration(
    migration: DataMigration,
    pool: ConnectionPool
  ): Promise<void> {
    const context = this.createContext(pool);

    logger.info(`Running data migration: ${migration.name}`);

    try {
      await pool.transaction(async conn => {
        // Override context.sql to use the transactional connection
        const txContext: DataMigrationContext = {
          ...context,
          sql: async (
            query: string,
            params?: unknown[]
          ): Promise<unknown[]> => {
            const result = await conn.query(query, params);
            return result.rows;
          }
        };

        await migration.up(txContext);
      });

      logger.info(`Data migration ${migration.name} completed successfully`);
    } catch (error) {
      throw new MigrationError(
        `Data migration "${migration.name}" failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Rollback a single data migration by calling its down() function.
   * Throws if down() is not defined on the migration.
   */
  async rollbackMigration(
    migration: DataMigration,
    pool: ConnectionPool
  ): Promise<void> {
    if (!migration.down) {
      throw new MigrationError(
        `Data migration "${migration.name}" does not define a down() function and cannot be rolled back`
      );
    }

    const context = this.createContext(pool);

    logger.info(`Rolling back data migration: ${migration.name}`);

    try {
      await pool.transaction(async conn => {
        const txContext: DataMigrationContext = {
          ...context,
          sql: async (
            query: string,
            params?: unknown[]
          ): Promise<unknown[]> => {
            const result = await conn.query(query, params);
            return result.rows;
          }
        };

        await migration.down!(txContext);
      });

      logger.info(
        `Data migration ${migration.name} rolled back successfully`
      );
    } catch (error) {
      throw new MigrationError(
        `Data migration "${migration.name}" rollback failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Find a data migration whose timestamp matches the given schema migration timestamp.
   */
  findMatchingDataMigration(
    dataMigrations: DataMigration[],
    schemaTimestamp: string
  ): DataMigration | undefined {
    return dataMigrations.find(dm => dm.timestamp === schemaTimestamp);
  }

  /**
   * Create a DataMigrationContext for the given pool.
   */
  private createContext(pool: ConnectionPool): DataMigrationContext {
    return {
      sql: async (query: string, params?: unknown[]): Promise<unknown[]> => {
        const result = await pool.query(query, params);
        return result.rows;
      },
      edgeql: (
        _query: string,
        _params?: unknown[]
      ): Promise<unknown> => {
        // EdgeQL execution is a placeholder — requires EdgeQL compiler integration
        return Promise.reject(
          new MigrationError(
            "EdgeQL execution in data migrations is not yet supported. Use sql() instead."
          )
        );
      },
      pool,
      log: (message: string): void => {
        logger.info(`[data-migration] ${message}`);
      }
    };
  }
}

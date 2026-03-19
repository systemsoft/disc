// deno-lint-ignore-file no-console
/**
 * CLI DbCommand Implementation - Database management functionality
 *
 * Provides create, list, and drop operations for Disc-managed databases.
 * Each database is created as a PostgreSQL database with a `disc_` prefix
 * to avoid collisions with system databases.
 */

import {
  createDatabase,
  DatabaseConnection,
  dropDatabase,
} from "../lib/database.ts";

export interface DbCreateOptions {
  name: string;
  databaseUrl: string;
}

export interface DbListOptions {
  databaseUrl: string;
}

export interface DbDropOptions {
  name: string;
  databaseUrl: string;
  force: boolean;
}

/** Regex for valid database names: starts with letter, lowercase alphanumeric + underscore. */
const VALID_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Prefix applied to all Disc-managed PG database names. */
const DATABASE_PREFIX = "disc_";

/** The default database name that cannot be dropped. */
const DEFAULT_DATABASE_NAME = "disc";

export class DbCommand {
  /**
   * Validate a database name against the naming rules.
   * Returns an error message string if invalid, or null if valid.
   */
  validateName(name: string): string | null {
    if (!VALID_NAME_RE.test(name)) {
      return `Invalid database name "${name}": must start with a lowercase letter and contain only lowercase letters, digits, and underscores`;
    }
    return null;
  }

  /**
   * Create a new Disc-managed database.
   *
   * Validates the name format, then creates a PostgreSQL database
   * named `disc_<name>` via an admin connection.
   */
  async create(options: DbCreateOptions): Promise<void> {
    const { name, databaseUrl } = options;

    // Validate name
    const validationError = this.validateName(name);
    if (validationError) {
      throw new Error(validationError);
    }

    const pgDatabaseName = `${DATABASE_PREFIX}${name}`;

    console.log(`Creating database "${name}" (PG: ${pgDatabaseName})...`);

    await createDatabase(databaseUrl, pgDatabaseName);

    console.log(`Database "${name}" created successfully.`);
  }

  /**
   * List all Disc-managed databases.
   *
   * Queries `pg_database` for databases with the `disc_` prefix
   * and displays them with the prefix stripped.
   */
  async list(options: DbListOptions): Promise<void> {
    const { databaseUrl } = options;

    // Connect to the postgres maintenance database to query pg_database
    const conn = new DatabaseConnection(databaseUrl);

    try {
      await conn.connect();

      const result = await conn.query(
        `SELECT datname FROM pg_database WHERE datname LIKE 'disc\\_%' ORDER BY datname`,
      );

      if (result.rows.length === 0) {
        console.log("No Disc-managed databases found.");
        return;
      }

      console.log("Disc-managed databases:\n");
      console.log("  NAME");
      console.log("  " + "-".repeat(30));

      for (const row of result.rows) {
        const pgName = row.datname as string;
        const displayName = pgName.replace(/^disc_/, "");
        console.log(`  ${displayName}`);
      }

      console.log(`\n  ${result.rows.length} database(s) total.`);
    } finally {
      await conn.close();
    }
  }

  /**
   * Drop a Disc-managed database.
   *
   * Requires the `--force` flag. Prevents dropping the default "disc"
   * database. Drops the PostgreSQL database named `disc_<name>`.
   */
  async drop(options: DbDropOptions): Promise<void> {
    const { name, databaseUrl, force } = options;

    if (!force) {
      throw new Error(
        "Dropping a database requires the --force flag. This action is irreversible.",
      );
    }

    if (name === DEFAULT_DATABASE_NAME) {
      throw new Error(
        'Cannot drop the default "disc" database.',
      );
    }

    const pgDatabaseName = `${DATABASE_PREFIX}${name}`;

    console.log(`Dropping database "${name}" (PG: ${pgDatabaseName})...`);

    await dropDatabase(databaseUrl, pgDatabaseName);

    console.log(`Database "${name}" dropped successfully.`);
  }
}

export const dbCommand = new DbCommand();

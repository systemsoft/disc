/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PostgreSQL Database Adapter for Auth Module
 *
 * Bridges the auth module's DatabaseInterface (which uses `?` placeholders)
 * to real PostgreSQL connections (which use `$1, $2, ...` placeholders).
 */

/*** UTILITY ------------------------------------------ ***/

import { DatabaseConnection } from "../lib/database.ts";
import { DatabaseInterface, QueryResult } from "./database-interface.ts";

/*** EXPORT ------------------------------------------- ***/

/**
 * Convert `?` placeholders to PostgreSQL-style `$1, $2, ...` placeholders.
 * Skips `?` characters inside single-quoted strings.
 */
export function convertPlaceholders(sql: string): string {
  let inString = false;
  let paramIndex = 0;
  let result = "";

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];

    if (char === "'" && !inString) {
      inString = true;
      result += char;
    } else if (char === "'" && inString) {
      /*** Handle escaped single quotes ('') ***/
      if (i + 1 < sql.length && sql[i + 1] === "'") {
        result += "''";
        i++;
      } else {
        inString = false;
        result += char;
      }
    } else if (char === "?" && !inString) {
      paramIndex++;
      result += `$${paramIndex}`;
    } else {
      result += char;
    }
  }

  return result;
}

export class PgDatabaseAdapter implements DatabaseInterface {
  private connection: DatabaseConnection;

  constructor(connection: DatabaseConnection) {
    this.connection = connection;
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  async connect(): Promise<void> {
    await this.connection.connect();
  }

  async execute(sql: string, params?: any[]): Promise<void> {
    const convertedSql = convertPlaceholders(sql);
    await this.connection.execute(convertedSql, params);
  }

  isConnected(): boolean {
    return this.connection.isConnected();
  }

  async query(sql: string, params?: any[]): Promise<QueryResult> {
    const convertedSql = convertPlaceholders(sql);
    const result = await this.connection.query(convertedSql, params);

    return {
      rowCount: result.rowCount,
      rows: result.rows
    };
  }

  async transaction<T>(fn: (db: DatabaseInterface) => Promise<T>): Promise<T> {
    /*** Use the underlying connection’s transaction but pass this adapter to the callback so
         SQL continues to get placeholder conversion. ***/
    return await this.connection.transaction(async () => {
      return await fn(this);
    });
  }
}

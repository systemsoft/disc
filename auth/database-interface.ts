/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Database Interface for Auth Module
 */

/*** EXPORT ------------------------------------------- ***/

export interface QueryResult {
  rowCount: number;
  rows: any[];
}

export interface DatabaseInterface {
  connect(): Promise<void>;
  close(): Promise<void>;
  execute(sql: string, params?: any[]): Promise<void>;
  isConnected(): boolean;
  query(sql: string, params?: any[]): Promise<QueryResult>;
  transaction<T>(fn: (db: DatabaseInterface) => Promise<T>): Promise<T>;
}

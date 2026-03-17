/**
 * Database Interface for Auth Module
 */

export interface QueryResult {
  rows: any[];
  rowCount: number;
}

export interface DatabaseInterface {
  connect(): Promise<void>;
  close(): Promise<void>;
  isConnected(): boolean;
  execute(sql: string, params?: any[]): Promise<void>;
  query(sql: string, params?: any[]): Promise<QueryResult>;
  transaction<T>(fn: (db: DatabaseInterface) => Promise<T>): Promise<T>;
}

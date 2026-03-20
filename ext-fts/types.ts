/**
 * Full-text search extension types for Disc database
 */

export type FtsWeight = "A" | "B" | "C" | "D";

export interface FtsIndexConfig {
  /** Fully qualified type name, e.g. "default::BlogPost" */
  typeName: string;
  /** Table name in PostgreSQL */
  tableName: string;
  /** Column names to include in the FTS index */
  columns: string[];
  /** Column-to-weight mapping (A is highest, D is lowest) */
  weights?: Record<string, FtsWeight>;
  /** PostgreSQL text search configuration, e.g. "english" (default) */
  language?: string;
  /** Custom index name; auto-generated if omitted */
  indexName?: string;
}

export interface FtsSearchOptions {
  /** PostgreSQL text search configuration, e.g. "english" */
  language?: string;
  /** Maximum number of results to return */
  limit?: number;
  /** Column weight multipliers for ranking */
  weights?: Record<string, number>;
}

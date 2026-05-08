/**
 * Full-text search index DDL generation
 *
 * Generates PostgreSQL DDL for tsvector columns and GIN indexes used by the
 * FTS extension. The generated column is always named `fts_vector` and is a
 * GENERATED ALWAYS STORED column that concatenates weighted tsvectors for each
 * configured source column.
 */

import type { FtsIndexConfig, FtsWeight } from "./types.ts";

/** The fixed column name used for the generated tsvector column. */
export const FTS_VECTOR_COLUMN = "fts_vector";

/** Default PostgreSQL text search configuration. */
export const DEFAULT_LANGUAGE = "english";

/**
 * Validate an FtsIndexConfig, throwing on invalid inputs.
 */
export function validateFtsConfig(config: FtsIndexConfig): void {
  if (!config.tableName || config.tableName.trim() === "") {
    throw new Error("FtsIndexConfig requires a non-empty tableName");
  }
  if (!config.columns || config.columns.length === 0) {
    throw new Error("FtsIndexConfig requires at least one column");
  }
  if (config.weights) {
    const validWeights = new Set(["A", "B", "C", "D"]);
    for (const [col, weight] of Object.entries(config.weights)) {
      if (!validWeights.has(weight)) {
        throw new Error(
          `Invalid weight "${weight}" for column "${col}". Must be A, B, C, or D.`
        );
      }
    }
  }
}

/**
 * Generate an ALTER TABLE statement that adds a `fts_vector` tsvector column
 * as a GENERATED ALWAYS STORED expression.
 *
 * Each source column is converted via `to_tsvector` and optionally weighted
 * with `setweight`. Multiple columns are concatenated with `||`.
 */
export function generateFtsColumn(config: FtsIndexConfig): string {
  const language = config.language ?? DEFAULT_LANGUAGE;

  const parts = config.columns.map(col => {
    const weight: FtsWeight | undefined = config.weights?.[col];
    const tsvector = `to_tsvector('${language}', coalesce(${col}, ''))`;
    if (weight) {
      return `setweight(${tsvector}, '${weight}')`;
    }
    return tsvector;
  });

  const expression = parts.join(" || ");

  return `ALTER TABLE ${config.tableName} ADD COLUMN ${FTS_VECTOR_COLUMN} tsvector GENERATED ALWAYS AS (${expression}) STORED;`;
}

/**
 * Generate a CREATE INDEX statement for a GIN index on the `fts_vector` column.
 */
export function generateFtsIndex(config: FtsIndexConfig): string {
  const indexName = config.indexName ??
    `${config.tableName}_fts_idx`;

  return `CREATE INDEX ${indexName} ON ${config.tableName} USING GIN (${FTS_VECTOR_COLUMN});`;
}

/**
 * Generate DROP statements to remove the FTS GIN index and the `fts_vector`
 * column from a table.
 */
export function generateDropFtsIndex(config: FtsIndexConfig): string {
  const indexName = config.indexName ??
    `${config.tableName}_fts_idx`;

  return `DROP INDEX IF EXISTS ${indexName}; ALTER TABLE ${config.tableName} DROP COLUMN IF EXISTS ${FTS_VECTOR_COLUMN};`;
}

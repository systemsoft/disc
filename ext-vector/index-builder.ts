/**
 * Vector index DDL generation
 */

import type { VectorIndexDef } from "./types.ts";

export function generateVectorIndex(def: VectorIndexDef): string {
  const indexName = `idx_${def.tableName}_${def.columnName}_vector`;

  if (def.indexType === "ivfflat") {
    const lists = def.lists ?? 100;
    return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${def.tableName} USING ivfflat (${def.columnName} vector_cosine_ops) WITH (lists = ${lists});`;
  }

  // HNSW (default)
  const m = def.m ?? 16;
  const efConstruction = def.efConstruction ?? 64;
  return `CREATE INDEX IF NOT EXISTS ${indexName} ON ${def.tableName} USING hnsw (${def.columnName} vector_cosine_ops) WITH (m = ${m}, ef_construction = ${efConstruction});`;
}

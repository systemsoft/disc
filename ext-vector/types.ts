/**
 * Vector search extension types for Disc database
 */

export type VectorIndexType = "ivfflat" | "hnsw";

export interface VectorConfig {
  defaultDimensions?: number; // default: 1536
  indexType?: VectorIndexType; // default: "hnsw"
}

export interface VectorIndexDef {
  tableName: string;
  columnName: string;
  dimensions: number;
  indexType: VectorIndexType;
  lists?: number; // IVFFlat parameter
  m?: number; // HNSW parameter
  efConstruction?: number; // HNSW parameter
}

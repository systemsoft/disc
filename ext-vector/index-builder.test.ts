/**
 * Tests for vector index DDL generation
 */

import { assertEquals } from "@std/assert";
import { generateVectorIndex } from "./index-builder.ts";

// ── IVFFlat index generation ───────────────────────────────────────────

Deno.test("generateVectorIndex - generates IVFFlat DDL with default lists", () => {
  const sql = generateVectorIndex({
    tableName: "documents",
    columnName: "embedding",
    dimensions: 1536,
    indexType: "ivfflat"
  });
  assertEquals(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_documents_embedding_vector ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);"
  );
});

Deno.test("generateVectorIndex - generates IVFFlat DDL with custom lists param", () => {
  const sql = generateVectorIndex({
    tableName: "items",
    columnName: "vec",
    dimensions: 512,
    indexType: "ivfflat",
    lists: 200
  });
  assertEquals(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_items_vec_vector ON items USING ivfflat (vec vector_cosine_ops) WITH (lists = 200);"
  );
});

// ── HNSW index generation ──────────────────────────────────────────────

Deno.test("generateVectorIndex - generates HNSW DDL with default params", () => {
  const sql = generateVectorIndex({
    tableName: "products",
    columnName: "feature_vec",
    dimensions: 768,
    indexType: "hnsw"
  });
  assertEquals(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_products_feature_vec_vector ON products USING hnsw (feature_vec vector_cosine_ops) WITH (m = 16, ef_construction = 64);"
  );
});

Deno.test("generateVectorIndex - generates HNSW DDL with custom m and ef_construction", () => {
  const sql = generateVectorIndex({
    tableName: "embeddings",
    columnName: "vector",
    dimensions: 1536,
    indexType: "hnsw",
    m: 32,
    efConstruction: 128
  });
  assertEquals(
    sql,
    "CREATE INDEX IF NOT EXISTS idx_embeddings_vector_vector ON embeddings USING hnsw (vector vector_cosine_ops) WITH (m = 32, ef_construction = 128);"
  );
});

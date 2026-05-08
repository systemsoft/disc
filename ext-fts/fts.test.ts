/**
 * Unit tests for the FTS extension
 *
 * Tests cover:
 * - Extension metadata and lifecycle
 * - DDL generation (columns, indexes, drop statements)
 * - Compiler hook transforms
 * - Configuration validation
 */

import { assertEquals, assertThrows } from "@std/assert";
import type { ExtensionContext } from "../extensions/types.ts";
import { FtsExtension } from "./extension.ts";
import { DEFAULT_LANGUAGE, FTS_VECTOR_COLUMN, generateDropFtsIndex, generateFtsColumn, generateFtsIndex, validateFtsConfig } from "./index-builder.ts";
import type { FtsIndexConfig } from "./types.ts";

// ── Test helpers ───────────────────────────────────────────────────────

function makeContext(): ExtensionContext {
  return {
    schema: { types: new Map(), functions: new Map() },
    config: {
      host: "localhost",
      port: 5656,
      databaseUrl: "postgres://localhost/disc_test",
      maxConnections: 5,
      requestTimeout: 5000,
      enableCors: false,
      enableWebsockets: false
    },
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: function() {
        return this;
      },
      withRequest: function() {
        return this;
      }
    } as unknown as ExtensionContext["logger"]
  };
}

function makeConfig(overrides?: Partial<FtsIndexConfig>): FtsIndexConfig {
  return {
    typeName: "default::BlogPost",
    tableName: "blog_posts",
    columns: ["title", "body"],
    ...overrides
  };
}

// ── 1. Extension creates successfully ──────────────────────────────────

Deno.test("FtsExtension - creates successfully with default config", () => {
  const ext = new FtsExtension();
  assertEquals(ext.state, "uninitialized");
});

// ── 2. Extension has correct name/version ──────────────────────────────

Deno.test("FtsExtension - metadata has correct name", () => {
  const ext = new FtsExtension();
  assertEquals(ext.metadata.name, "fts");
});

Deno.test("FtsExtension - metadata has correct version", () => {
  const ext = new FtsExtension();
  assertEquals(ext.metadata.version, "1.0.0");
});

Deno.test("FtsExtension - metadata has correct description", () => {
  const ext = new FtsExtension();
  assertEquals(
    ext.metadata.description,
    "Full-text search using PostgreSQL tsvector/tsquery"
  );
});

// ── 3. generateFtsColumn with single column ────────────────────────────

Deno.test("generateFtsColumn - single column without weight", () => {
  const sql = generateFtsColumn(makeConfig({ columns: ["title"] }));
  assertEquals(
    sql,
    `ALTER TABLE blog_posts ADD COLUMN ${FTS_VECTOR_COLUMN} tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, ''))) STORED;`
  );
});

// ── 4. generateFtsColumn with multiple columns ─────────────────────────

Deno.test("generateFtsColumn - multiple columns without weights", () => {
  const sql = generateFtsColumn(makeConfig());
  assertEquals(
    sql,
    `ALTER TABLE blog_posts ADD COLUMN ${FTS_VECTOR_COLUMN} tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '')) || to_tsvector('english', coalesce(body, ''))) STORED;`
  );
});

// ── 5. generateFtsColumn with custom weights ───────────────────────────

Deno.test("generateFtsColumn - columns with custom weights (A, B, C, D)", () => {
  const sql = generateFtsColumn(
    makeConfig({
      columns: ["title", "body", "summary", "tags"],
      weights: { title: "A", body: "D", summary: "B", tags: "C" }
    })
  );
  assertEquals(
    sql,
    `ALTER TABLE blog_posts ADD COLUMN ${FTS_VECTOR_COLUMN} tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'D') || setweight(to_tsvector('english', coalesce(summary, '')), 'B') || setweight(to_tsvector('english', coalesce(tags, '')), 'C')) STORED;`
  );
});

// ── 6. generateFtsColumn with custom language ──────────────────────────

Deno.test("generateFtsColumn - custom language", () => {
  const sql = generateFtsColumn(
    makeConfig({ columns: ["title"], language: "spanish" })
  );
  assertEquals(
    sql,
    `ALTER TABLE blog_posts ADD COLUMN ${FTS_VECTOR_COLUMN} tsvector GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(title, ''))) STORED;`
  );
});

// ── 7. generateFtsIndex generates GIN index DDL ────────────────────────

Deno.test("generateFtsIndex - generates GIN index DDL with default name", () => {
  const sql = generateFtsIndex(makeConfig());
  assertEquals(
    sql,
    `CREATE INDEX blog_posts_fts_idx ON blog_posts USING GIN (${FTS_VECTOR_COLUMN});`
  );
});

// ── 8. generateDropFtsIndex generates DROP statements ──────────────────

Deno.test("generateDropFtsIndex - generates DROP statements", () => {
  const sql = generateDropFtsIndex(makeConfig());
  assertEquals(
    sql,
    `DROP INDEX IF EXISTS blog_posts_fts_idx; ALTER TABLE blog_posts DROP COLUMN IF EXISTS ${FTS_VECTOR_COLUMN};`
  );
});

// ── 9. fts::search compilation via compiler hook ───────────────────────

Deno.test("FtsExtension - compiler hook transforms fts::search correctly", () => {
  const ext = new FtsExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.(
    "fts::search",
    ["'search query'"]
  );
  assertEquals(
    result,
    `${FTS_VECTOR_COLUMN} @@ plainto_tsquery('english', 'search query')`
  );
});

// ── 10. fts::rank compilation via compiler hook ────────────────────────

Deno.test("FtsExtension - compiler hook transforms fts::rank correctly", () => {
  const ext = new FtsExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.(
    "fts::rank",
    ["'search query'"]
  );
  assertEquals(
    result,
    `ts_rank(${FTS_VECTOR_COLUMN}, plainto_tsquery('english', 'search query'))`
  );
});

// ── 11. FtsIndexConfig validation ──────────────────────────────────────

Deno.test("validateFtsConfig - throws on empty tableName", () => {
  assertThrows(
    () => validateFtsConfig({ ...makeConfig(), tableName: "" }),
    Error,
    "non-empty tableName"
  );
});

Deno.test("validateFtsConfig - throws on empty columns array", () => {
  assertThrows(
    () => validateFtsConfig({ ...makeConfig(), columns: [] }),
    Error,
    "at least one column"
  );
});

Deno.test("validateFtsConfig - throws on invalid weight value", () => {
  assertThrows(
    () =>
      validateFtsConfig({
        ...makeConfig(),
        weights: { title: "X" as "A" }
      }),
    Error,
    "Invalid weight \"X\""
  );
});

Deno.test("validateFtsConfig - passes for valid config", () => {
  // Should not throw
  validateFtsConfig(makeConfig({ weights: { title: "A", body: "B" } }));
});

// ── 12. Default language is "english" ──────────────────────────────────

Deno.test("DEFAULT_LANGUAGE is english", () => {
  assertEquals(DEFAULT_LANGUAGE, "english");
});

// ── 13. Custom index name in generated DDL ─────────────────────────────

Deno.test("generateFtsIndex - custom index name", () => {
  const sql = generateFtsIndex(
    makeConfig({ indexName: "my_custom_fts_idx" })
  );
  assertEquals(
    sql,
    `CREATE INDEX my_custom_fts_idx ON blog_posts USING GIN (${FTS_VECTOR_COLUMN});`
  );
});

Deno.test("generateDropFtsIndex - custom index name in DROP", () => {
  const sql = generateDropFtsIndex(
    makeConfig({ indexName: "my_custom_fts_idx" })
  );
  assertEquals(
    sql,
    `DROP INDEX IF EXISTS my_custom_fts_idx; ALTER TABLE blog_posts DROP COLUMN IF EXISTS ${FTS_VECTOR_COLUMN};`
  );
});

// ── 14. Extension compiler hooks registered correctly ──────────────────

Deno.test("FtsExtension - getCompilerHooks returns exactly one hook", () => {
  const ext = new FtsExtension();
  const hooks = ext.getCompilerHooks();
  assertEquals(hooks.length, 1);
  assertEquals(hooks[0].name, "fts-functions");
});

Deno.test("FtsExtension - compiler hook returns undefined for unknown function", () => {
  const ext = new FtsExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.("unknown_fn", ["x"]);
  assertEquals(result, undefined);
});

// ── 15. Extension routes registered ────────────────────────────────────

Deno.test("FtsExtension - getRoutes returns empty array", () => {
  const ext = new FtsExtension();
  assertEquals(ext.getRoutes().length, 0);
});

// ── Additional lifecycle tests ─────────────────────────────────────────

Deno.test("FtsExtension - healthCheck reports unhealthy before initialize", async () => {
  const ext = new FtsExtension();
  const health = await ext.healthCheck();
  assertEquals(health.healthy, false);
  assertEquals(health.details, undefined);
});

Deno.test("FtsExtension - healthCheck reports healthy after initialize", async () => {
  const ext = new FtsExtension();
  await ext.initialize(makeContext());
  const health = await ext.healthCheck();
  assertEquals(health.healthy, true);
  assertEquals(health.details, "FTS enabled (language: english)");
});

Deno.test("FtsExtension - custom language applied to compiler hooks", () => {
  const ext = new FtsExtension("spanish");
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.(
    "fts::search",
    ["'buscar'"]
  );
  assertEquals(
    result,
    `${FTS_VECTOR_COLUMN} @@ plainto_tsquery('spanish', 'buscar')`
  );
});

Deno.test("FtsExtension - custom language shown in healthCheck", async () => {
  const ext = new FtsExtension("german");
  await ext.initialize(makeContext());
  const health = await ext.healthCheck();
  assertEquals(health.details, "FTS enabled (language: german)");
});

Deno.test("FtsExtension - getDatabaseSetup returns empty setupSql (tsvector is built-in)", () => {
  const ext = new FtsExtension();
  const setup = ext.getDatabaseSetup();
  assertEquals(setup.setupSql.length, 0);
});

Deno.test("FtsExtension - getFunctions returns 2 functions", () => {
  const ext = new FtsExtension();
  const fns = ext.getFunctions();
  assertEquals(fns.length, 2);
});

Deno.test("FtsExtension - getFunctions includes fts::search and fts::rank", () => {
  const ext = new FtsExtension();
  const names = ext.getFunctions().map(f => f.name);
  assertEquals(names.includes("fts::search"), true);
  assertEquals(names.includes("fts::rank"), true);
});

Deno.test("FtsExtension - fts::search function definition has correct shape", () => {
  const ext = new FtsExtension();
  const fn = ext.getFunctions().find(f => f.name === "fts::search");
  assertEquals(fn !== undefined, true);
  assertEquals(fn!.args.length, 1);
  assertEquals(fn!.args[0].name, "query");
  assertEquals(fn!.args[0].type, "str");
  assertEquals(fn!.returnType, "bool");
});

Deno.test("FtsExtension - fts::rank function definition has correct shape", () => {
  const ext = new FtsExtension();
  const fn = ext.getFunctions().find(f => f.name === "fts::rank");
  assertEquals(fn !== undefined, true);
  assertEquals(fn!.args.length, 1);
  assertEquals(fn!.args[0].name, "query");
  assertEquals(fn!.args[0].type, "str");
  assertEquals(fn!.returnType, "float64");
});

// ── Compiler hook also matches underscore-joined names ─────────────────

Deno.test("FtsExtension - compiler hook handles fts__search variant", () => {
  const ext = new FtsExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.(
    "fts__search",
    ["'hello'"]
  );
  assertEquals(
    result,
    `${FTS_VECTOR_COLUMN} @@ plainto_tsquery('english', 'hello')`
  );
});

Deno.test("FtsExtension - compiler hook handles fts__rank variant", () => {
  const ext = new FtsExtension();
  const hook = ext.getCompilerHooks()[0];
  const result = hook.transformFunctionCall?.(
    "fts__rank",
    ["'hello'"]
  );
  assertEquals(
    result,
    `ts_rank(${FTS_VECTOR_COLUMN}, plainto_tsquery('english', 'hello'))`
  );
});

// ── FTS_VECTOR_COLUMN constant ─────────────────────────────────────────

Deno.test("FTS_VECTOR_COLUMN is fts_vector", () => {
  assertEquals(FTS_VECTOR_COLUMN, "fts_vector");
});

// ── Partial weight assignment ──────────────────────────────────────────

Deno.test("generateFtsColumn - partial weight assignment (only some columns weighted)", () => {
  const sql = generateFtsColumn(
    makeConfig({ weights: { title: "A" } })
  );
  // title gets weight A, body has no weight
  assertEquals(
    sql,
    `ALTER TABLE blog_posts ADD COLUMN ${FTS_VECTOR_COLUMN} tsvector GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || to_tsvector('english', coalesce(body, ''))) STORED;`
  );
});

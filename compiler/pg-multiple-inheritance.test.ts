/**
 * PostgreSQL End-to-End Tests — Multiple Inheritance
 *
 * Tests the full SDL -> migrate -> compile EdgeQL -> execute pipeline
 * against real PostgreSQL for multiple inheritance scenarios:
 *   - Multi-parent property inheritance (INSERT + SELECT)
 *   - Diamond inheritance (no duplicate columns)
 *   - Multi-parent type filter (polymorphic query)
 *   - Multiple children extending the same multiple parents
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import {
  canRunPgTests,
  getTestDsn,
  resetTestDatabase,
} from "../tests/pg-test-harness.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import type { Schema } from "./context.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a ConnectionPool configured for testing. */
function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0,
  });
}

/**
 * Apply an SDL schema via SchemaManager and return the schema for the compiler.
 * Caller must handle cleanup via manager.close().
 */
async function applySDL(
  pool: ConnectionPool,
  sdl: string,
): Promise<{ manager: SchemaManager; schema: Schema }> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  const result = await manager.applySchema(sdl);
  assertEquals(
    result.ok,
    true,
    `applySchema should succeed: ${result.ok ? "" : JSON.stringify(result)}`,
  );

  const schema = manager.getSchema();
  assertExists(schema, "Schema should exist after applySchema");

  return { manager, schema: schema! };
}

/**
 * Compile an EdgeQL query string to SQL using the full pipeline:
 * EdgeQLParser -> EdgeQLCompiler -> SQLCodeGenerator.
 */
function compileEdgeQL(edgeql: string, schema: Schema): string {
  const parser = new EdgeQLParser(edgeql);
  const ast = parser.parse();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const result = compiler.compile(ast);

  if (!result.ok) {
    throw new Error(`Compilation failed: ${result.error.message}`);
  }

  const codegen = new SQLCodeGenerator();
  return codegen.generate(result.value);
}

/** Drop all user tables and disc migration tracking tables. */
async function cleanup(pool: ConnectionPool): Promise<void> {
  await resetTestDatabase(pool);
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

// =========================================================================
// Test 1: Multi-parent property inheritance — INSERT and SELECT
// =========================================================================

const MULTI_PARENT_SDL = `
  abstract type Timestamped {
    property created_at: datetime {
      default := datetime_current();
    };
  };
  abstract type Authored {
    required property author_name: str;
  };
  type BlogPost extending Timestamped, Authored {
    required property title: str;
    required property body: str;
  };
`;

Deno.test({
  name:
    "PG Multiple Inheritance: Multi-parent property inheritance — INSERT and SELECT",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applySDL(pool, MULTI_PARENT_SDL);

      // INSERT a BlogPost with author_name, title, body
      // created_at should get a default value from datetime_current()
      const insertSql = compileEdgeQL(
        'INSERT BlogPost { author_name := "Jane Doe", title := "Hello World", body := "First post content" }',
        schema,
      );
      await pool.query(insertSql);

      // SELECT BlogPost with shape {title, author_name, created_at}
      const selectSql = compileEdgeQL(
        "SELECT BlogPost { title, author_name, created_at }",
        schema,
      );
      const result = await pool.query(selectSql);

      // Verify at least one row returned
      assertEquals(
        result.rowCount >= 1,
        true,
        "Should return at least one BlogPost row",
      );

      // Extract data from JSON result
      const firstRow = result.rows[0];
      const data = (firstRow as Record<string, unknown>).jsonb_build_object ??
        firstRow;
      const rowData = data as Record<string, unknown>;

      // Verify all properties are present (including inherited ones)
      assertEquals(
        rowData.title,
        "Hello World",
        "title should be 'Hello World'",
      );
      assertEquals(
        rowData.author_name,
        "Jane Doe",
        "author_name (inherited from Authored) should be 'Jane Doe'",
      );
      assertExists(
        rowData.created_at,
        "created_at (inherited from Timestamped) should be present",
      );

      await manager.close();
    } finally {
      await cleanup(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Test 2: Diamond inheritance — no duplicate columns
// =========================================================================

const DIAMOND_SDL = `
  abstract type Named {
    required property name: str;
  };
  abstract type Categorized extending Named {
    required property category: str;
  };
  abstract type Tagged extending Named {
    required property tag: str;
  };
  type Item extending Categorized, Tagged {
    required property price: int64;
  };
`;

Deno.test({
  name:
    "PG Multiple Inheritance: Diamond inheritance — no duplicate columns for shared ancestor",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applySDL(pool, DIAMOND_SDL);

      // INSERT an Item with all properties
      const insertSql = compileEdgeQL(
        'INSERT Item { name := "Widget", category := "Hardware", tag := "sale", price := 999 }',
        schema,
      );
      await pool.query(insertSql);

      // SELECT Item with all 4 properties
      const selectSql = compileEdgeQL(
        "SELECT Item { name, category, tag, price }",
        schema,
      );
      const result = await pool.query(selectSql);

      assertEquals(
        result.rowCount,
        1,
        "Should return exactly 1 Item row",
      );

      // Extract data
      const firstRow = result.rows[0];
      const data = (firstRow as Record<string, unknown>).jsonb_build_object ??
        firstRow;
      const rowData = data as Record<string, unknown>;

      // Verify all 4 properties are returned
      assertEquals(rowData.name, "Widget", "name should be 'Widget'");
      assertEquals(
        rowData.category,
        "Hardware",
        "category should be 'Hardware'",
      );
      assertEquals(rowData.tag, "sale", "tag should be 'sale'");
      assertEquals(Number(rowData.price), 999, "price should be 999");

      // Verify `name` column appears only once in the PG table.
      // Query information_schema to count columns named 'name' in the item table.
      const colCountResult = await pool.query(`
        SELECT COUNT(*)::int AS cnt
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'item'
          AND column_name = 'name'
      `);
      assertEquals(
        Number(colCountResult.rows[0].cnt),
        1,
        "The 'name' column should appear exactly once in the item table (no duplicates from diamond)",
      );

      await manager.close();
    } finally {
      await cleanup(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Test 3: Multi-parent type filter (polymorphic query)
// =========================================================================

Deno.test({
  name:
    "PG Multiple Inheritance: Multi-parent type filter — SELECT abstract parent returns child rows",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applySDL(pool, MULTI_PARENT_SDL);

      // INSERT a BlogPost row
      const insertSql = compileEdgeQL(
        'INSERT BlogPost { author_name := "Alice", title := "Test Post", body := "Some body text" }',
        schema,
      );
      await pool.query(insertSql);

      // SELECT Timestamped — should return BlogPost rows since BlogPost extends Timestamped
      const tsSelectSql = compileEdgeQL(
        "SELECT Timestamped { created_at }",
        schema,
      );
      const tsResult = await pool.query(tsSelectSql);

      assertEquals(
        tsResult.rowCount >= 1,
        true,
        "SELECT Timestamped should return BlogPost rows (polymorphic query)",
      );

      // SELECT Authored — should also return BlogPost rows
      const authSelectSql = compileEdgeQL(
        "SELECT Authored { author_name }",
        schema,
      );
      const authResult = await pool.query(authSelectSql);

      assertEquals(
        authResult.rowCount >= 1,
        true,
        "SELECT Authored should return BlogPost rows (polymorphic query)",
      );

      // Verify inherited property value via Authored query
      const authFirstRow = authResult.rows[0];
      const authData =
        (authFirstRow as Record<string, unknown>).jsonb_build_object ??
          authFirstRow;
      assertEquals(
        (authData as Record<string, unknown>).author_name,
        "Alice",
        "author_name should be 'Alice' when queried through Authored",
      );

      // Verify the __type__ discriminator is 'BlogPost' in the underlying table
      const typeResult = await pool.query(
        "SELECT __type__ FROM blog_post LIMIT 1",
      );
      if (typeResult.rowCount > 0) {
        assertEquals(
          (typeResult.rows[0] as Record<string, unknown>).__type__,
          "BlogPost",
          "__type__ column should be 'BlogPost'",
        );
      }

      await manager.close();
    } finally {
      await cleanup(pool);
      await pool.close();
    }
  },
});

// =========================================================================
// Test 4: Multiple children extending same multiple parents
// =========================================================================

const MULTI_CHILDREN_SDL = `
  abstract type Timestamped {
    property created_at: datetime {
      default := datetime_current();
    };
  };
  abstract type Authored {
    required property author_name: str;
  };
  type Article extending Timestamped, Authored {
    required property headline: str;
  };
  type Review extending Timestamped, Authored {
    required property rating: int64;
    required property comment: str;
  };
`;

Deno.test({
  name:
    "PG Multiple Inheritance: Multiple children extending same multiple parents",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const { manager, schema } = await applySDL(pool, MULTI_CHILDREN_SDL);

      // INSERT an Article
      const insertArticleSql = compileEdgeQL(
        'INSERT Article { author_name := "Bob", headline := "Breaking News" }',
        schema,
      );
      await pool.query(insertArticleSql);

      // INSERT a Review
      const insertReviewSql = compileEdgeQL(
        'INSERT Review { author_name := "Carol", rating := 5, comment := "Excellent!" }',
        schema,
      );
      await pool.query(insertReviewSql);

      // Query Article — verify it has inherited + own properties
      const articleSql = compileEdgeQL(
        "SELECT Article { headline, author_name, created_at }",
        schema,
      );
      const articleResult = await pool.query(articleSql);

      assertEquals(
        articleResult.rowCount,
        1,
        "Should return exactly 1 Article",
      );

      const articleRow = articleResult.rows[0];
      const articleData =
        (articleRow as Record<string, unknown>).jsonb_build_object ?? articleRow;
      const article = articleData as Record<string, unknown>;

      assertEquals(
        article.headline,
        "Breaking News",
        "Article headline should be 'Breaking News'",
      );
      assertEquals(
        article.author_name,
        "Bob",
        "Article author_name (inherited) should be 'Bob'",
      );
      assertExists(
        article.created_at,
        "Article created_at (inherited from Timestamped) should be present",
      );

      // Query Review — verify it has inherited + own properties
      const reviewSql = compileEdgeQL(
        "SELECT Review { rating, comment, author_name, created_at }",
        schema,
      );
      const reviewResult = await pool.query(reviewSql);

      assertEquals(
        reviewResult.rowCount,
        1,
        "Should return exactly 1 Review",
      );

      const reviewRow = reviewResult.rows[0];
      const reviewData =
        (reviewRow as Record<string, unknown>).jsonb_build_object ?? reviewRow;
      const review = reviewData as Record<string, unknown>;

      assertEquals(
        Number(review.rating),
        5,
        "Review rating should be 5",
      );
      assertEquals(
        review.comment,
        "Excellent!",
        "Review comment should be 'Excellent!'",
      );
      assertEquals(
        review.author_name,
        "Carol",
        "Review author_name (inherited) should be 'Carol'",
      );
      assertExists(
        review.created_at,
        "Review created_at (inherited from Timestamped) should be present",
      );

      // Verify that Article and Review are independent —
      // querying one does not return the other
      const articleCount = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM article",
      );
      assertEquals(
        Number(articleCount.rows[0].cnt),
        1,
        "article table should have exactly 1 row",
      );

      const reviewCount = await pool.query(
        "SELECT COUNT(*)::int AS cnt FROM review",
      );
      assertEquals(
        Number(reviewCount.rows[0].cnt),
        1,
        "review table should have exactly 1 row",
      );

      await manager.close();
    } finally {
      await cleanup(pool);
      await pool.close();
    }
  },
});

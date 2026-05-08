/**
 * Stage 40: Schema Evolution Tests
 *
 * End-to-end tests that verify incremental schema changes (adding triggers,
 * changing constraints, removing rewrites, adding properties, adding annotations)
 * are correctly applied to a real PostgreSQL instance through the migration engine.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals, assertExists } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDsn(
  dsn: string
): { hostname: string; port: number; user: string; database: string; } {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test"
  };
}

async function tableExists(dsn: string, tableName: string): Promise<boolean> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<{ exists: boolean; }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists`,
      [tableName]
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

async function getColumns(
  dsn: string,
  tableName: string
): Promise<{ column_name: string; data_type: string; }[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<
      { column_name: string; data_type: string; }
    >(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1
       ORDER BY ordinal_position`,
      [tableName]
    );
    return result.rows;
  } finally {
    await client.end();
  }
}

async function getTriggers(
  dsn: string,
  tableName: string
): Promise<string[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = await client.queryObject<{ trigger_name: string; }>(
      `SELECT DISTINCT trigger_name
       FROM information_schema.triggers
       WHERE trigger_schema = 'public' AND event_object_table = $1
       ORDER BY trigger_name`,
      [tableName]
    );
    return result.rows.map(r => r.trigger_name);
  } finally {
    await client.end();
  }
}

async function execSQL(
  dsn: string,
  sql: string,
  params?: unknown[]
): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    if (params) {
      await client.queryArray(sql, params);
    } else {
      await client.queryArray(sql);
    }
  } finally {
    await client.end();
  }
}

async function queryRows<T>(
  dsn: string,
  sql: string,
  params?: unknown[]
): Promise<T[]> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    const result = params ? await client.queryObject<T>(sql, params) : await client.queryObject<T>(sql);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function dropTables(dsn: string, ...tableNames: string[]): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    for (const name of tableNames) {
      await client.queryArray(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }
    // Drop lingering trigger functions
    await client.queryArray(`
      DO $$ DECLARE fn RECORD;
      BEGIN
        FOR fn IN
          SELECT proname FROM pg_proc
          WHERE pronamespace = 'public'::regnamespace
            AND (proname LIKE '%__rewrite_fn' OR proname LIKE '%_fn' OR proname LIKE 'disc_source_delete_%')
        LOOP
          EXECUTE 'DROP FUNCTION IF EXISTS ' || fn.proname || '() CASCADE';
        END LOOP;
      END $$;
    `);
  } finally {
    await client.end();
  }
}

function makePool(dsn: string): ConnectionPool {
  return new ConnectionPool({
    connectionString: dsn,
    minConnections: 1,
    maxConnections: 3,
    cleanupInterval: 0
  });
}

// ---------------------------------------------------------------------------
// Test 1: Add rewrite rule to existing type
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Evolution: add rewrite rule to existing type creates trigger, data intact",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      // Step 1: Type without rewrite
      const sdlV1 = `
        type EvoArticle {
          required title: str;
          created_at: datetime;
        };
      `;

      const resultV1 = await manager.applySchema(sdlV1);
      assertEquals(resultV1.ok, true, "Initial applySchema should succeed");

      // Insert data manually (no rewrite yet)
      await execSQL(
        dsn,
        `INSERT INTO evo_article (id, title) VALUES (gen_random_uuid(), $1)`,
        ["Existing Article"]
      );

      // Verify no rewrite trigger
      const triggersV1 = await getTriggers(dsn, "evo_article");
      const hasRewriteV1 = triggersV1.some(t => t.includes("rewrite"));
      assertEquals(
        hasRewriteV1,
        false,
        "Should NOT have rewrite trigger initially"
      );

      // Step 2: Add rewrite rule
      const sdlV2 = `
        type EvoArticle {
          required title: str;
          created_at: datetime {
            rewrite insert using (datetime_of_statement());
          };
        };
      `;

      const resultV2 = await manager.applySchema(sdlV2);
      assertEquals(
        resultV2.ok,
        true,
        "applySchema with rewrite should succeed"
      );

      // Verify rewrite trigger now exists
      const triggersV2 = await getTriggers(dsn, "evo_article");
      const hasRewriteV2 = triggersV2.some(t => t.includes("rewrite"));
      assertEquals(
        hasRewriteV2,
        true,
        "Should have rewrite trigger after evolution"
      );

      // Verify existing data is intact
      const rows = await queryRows<{ title: string; }>(
        dsn,
        `SELECT title FROM evo_article`
      );
      assertEquals(rows.length, 1, "Existing row should still be there");
      assertEquals(rows[0].title, "Existing Article");

      // Verify new inserts get created_at auto-set
      await execSQL(
        dsn,
        `INSERT INTO evo_article (id, title) VALUES (gen_random_uuid(), $1)`,
        ["New Article"]
      );

      const newRows = await queryRows<
        { title: string; created_at: string | null; }
      >(
        dsn,
        `SELECT title, created_at FROM evo_article WHERE title = $1`,
        ["New Article"]
      );
      assertEquals(newRows.length, 1);
      assertEquals(
        newRows[0].created_at !== null,
        true,
        "New article should have created_at auto-set by rewrite"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "evo_article",
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 2: Add property to existing type — existing data preserved
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Evolution: add property to existing type preserves data",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      // Step 1: Type with name only
      const sdlV1 = `
        type EvoProduct {
          required name: str;
          required price: float64;
        };
      `;

      const resultV1 = await manager.applySchema(sdlV1);
      assertEquals(resultV1.ok, true, "Initial applySchema should succeed");

      // Insert data
      await execSQL(
        dsn,
        `INSERT INTO evo_product (id, name, price) VALUES (gen_random_uuid(), $1, $2)`,
        ["Widget", 19.99]
      );

      // Verify initial columns
      let columns = await getColumns(dsn, "evo_product");
      let colNames = columns.map(c => c.column_name);
      assertEquals(colNames.includes("name"), true, "Should have name column");
      assertEquals(
        colNames.includes("description"),
        false,
        "Should NOT have description yet"
      );

      // Step 2: Add description property
      const sdlV2 = `
        type EvoProduct {
          required name: str;
          required price: float64;
          description: str;
          in_stock: bool;
        };
      `;

      const resultV2 = await manager.applySchema(sdlV2);
      assertEquals(resultV2.ok, true, "Evolved applySchema should succeed");

      // Verify new columns added
      columns = await getColumns(dsn, "evo_product");
      colNames = columns.map(c => c.column_name);
      assertEquals(
        colNames.includes("description"),
        true,
        "Should now have description column"
      );
      assertEquals(
        colNames.includes("in_stock"),
        true,
        "Should now have in_stock column"
      );

      // Verify existing data preserved
      const rows = await queryRows<{
        name: string;
        price: number;
        description: string | null;
      }>(dsn, `SELECT name, price, description FROM evo_product`);
      assertEquals(rows.length, 1, "Existing row should be preserved");
      assertEquals(rows[0].name, "Widget");
      assertEquals(
        rows[0].description,
        null,
        "New column should be NULL for existing rows"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "evo_product",
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 3: Remove rewrite rule — trigger should be dropped
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Evolution: remove rewrite rule drops trigger from PG",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      // Step 1: Type WITH rewrite
      const sdlV1 = `
        type EvoLog {
          required message: str;
          logged_at: datetime {
            rewrite insert using (datetime_of_statement());
          };
        };
      `;

      const resultV1 = await manager.applySchema(sdlV1);
      assertEquals(resultV1.ok, true, "Initial applySchema should succeed");

      // Verify rewrite trigger exists
      const triggersV1 = await getTriggers(dsn, "evo_log");
      const hasRewriteV1 = triggersV1.some(t => t.includes("rewrite"));
      assertEquals(hasRewriteV1, true, "Should have rewrite trigger initially");

      // Step 2: Remove rewrite rule
      const sdlV2 = `
        type EvoLog {
          required message: str;
          logged_at: datetime;
        };
      `;

      const resultV2 = await manager.applySchema(sdlV2);
      assertEquals(
        resultV2.ok,
        true,
        "applySchema without rewrite should succeed"
      );

      // Verify rewrite trigger was dropped
      const triggersV2 = await getTriggers(dsn, "evo_log");
      const hasRewriteV2 = triggersV2.some(t => t.includes("rewrite"));
      assertEquals(
        hasRewriteV2,
        false,
        "Rewrite trigger should be dropped after removal"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "evo_log",
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 4: Add annotation to existing type — verify in schema introspection
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Evolution: add annotation to existing type appears in schema introspection",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      // Step 1: Type without annotation
      const sdlV1 = `
        type EvoCategory {
          required name: str;
        };
      `;

      const resultV1 = await manager.applySchema(sdlV1);
      assertEquals(resultV1.ok, true, "Initial applySchema should succeed");

      // Verify no annotations initially
      const schemaV1 = manager.getSchema();
      const catV1 = schemaV1?.types.get("EvoCategory");
      assertExists(catV1, "EvoCategory should exist in schema");
      assertEquals(
        catV1!.annotations === undefined ||
          Object.keys(catV1!.annotations).length === 0,
        true,
        "Should have no annotations initially"
      );

      // Step 2: Add @description annotation
      const sdlV2 = `
        type EvoCategory {
          annotation description := 'Product categories for the store';
          required name: str;
        };
      `;

      const resultV2 = await manager.applySchema(sdlV2);
      assertEquals(
        resultV2.ok,
        true,
        "applySchema with annotation should succeed"
      );

      // Verify annotation in schema introspection
      const schemaV2 = manager.getSchema();
      const catV2 = schemaV2?.types.get("EvoCategory");
      assertExists(catV2, "EvoCategory should still exist in schema");
      assertExists(catV2!.annotations, "EvoCategory should have annotations");
      assertEquals(
        catV2!.annotations!["description"] !== undefined,
        true,
        "Should have @description annotation"
      );

      // Table should still be intact
      assertEquals(
        await tableExists(dsn, "evo_category"),
        true,
        "Table should still exist"
      );

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "evo_category",
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Test 5: Multiple inheritance evolution — add new parent
// ---------------------------------------------------------------------------

Deno.test({
  name: "Stage 40 Evolution: type extending abstract types gets inherited properties",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      // Schema with multiple inheritance
      const sdl = `
        abstract type Auditable {
          audit_note: str;
        };

        abstract type Versioned {
          version: int64;
        };

        type EvoDocument extending Auditable, Versioned {
          required title: str;
          content: str;
        };
      `;

      const result = await manager.applySchema(sdl);
      assertEquals(
        result.ok,
        true,
        `applySchema should succeed: ${result.ok ? "" : (result as any).error}`
      );

      // Verify the table has inherited columns
      const columns = await getColumns(dsn, "evo_document");
      const colNames = columns.map(c => c.column_name);

      assertEquals(
        colNames.includes("title"),
        true,
        "Should have title column"
      );
      assertEquals(
        colNames.includes("content"),
        true,
        "Should have content column"
      );
      assertEquals(
        colNames.includes("audit_note"),
        true,
        "Should have inherited audit_note from Auditable"
      );
      assertEquals(
        colNames.includes("version"),
        true,
        "Should have inherited version from Versioned"
      );

      // Verify in schema introspection
      const schema = manager.getSchema();
      const docType = schema?.types.get("EvoDocument");
      assertExists(docType, "EvoDocument should exist in schema");
      assertEquals(
        docType!.parentTypes?.includes("Auditable"),
        true,
        "EvoDocument should extend Auditable"
      );
      assertEquals(
        docType!.parentTypes?.includes("Versioned"),
        true,
        "EvoDocument should extend Versioned"
      );

      // Verify inherited properties exist in the TypeDef
      const auditProp = docType!.properties.get("audit_note");
      assertExists(auditProp, "Should have inherited audit_note property");

      const versionProp = docType!.properties.get("version");
      assertExists(versionProp, "Should have inherited version property");

      // Insert data using inherited columns
      await execSQL(
        dsn,
        `INSERT INTO evo_document (id, title, content, audit_note, version) VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        ["My Doc", "Some content", "Initial creation", 1]
      );

      const rows = await queryRows<
        { title: string; audit_note: string; version: number; }
      >(
        dsn,
        `SELECT title, audit_note, version FROM evo_document`
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0].title, "My Doc");
      assertEquals(rows[0].audit_note, "Initial creation");
      // version is `int64` → PG `bigint` → deno-postgres returns BigInt.
      assertEquals(Number(rows[0].version), 1);

      await manager.close();
    } finally {
      await dropTables(
        dsn,
        "evo_document",
        "disc_migrations",
        "disc_migration_checkpoints"
      );
      await pool.close();
    }
  }
});

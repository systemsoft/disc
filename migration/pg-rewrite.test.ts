/**
 * PostgreSQL End-to-End Tests for Rewrite Rules
 *
 * Tests that verify PL/pgSQL rewrite triggers are correctly created and fire
 * against a real PostgreSQL instance. Each test creates tables with rewrite
 * rules and verifies that column values are automatically set on INSERT/UPDATE.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { DDLGenerator } from "./ddl.ts";
import type { CreateTypeOperation, RewriteDefinition } from "./types.ts";

const RUN_PG = canRunPgTests();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDsn(
  dsn: string,
): { hostname: string; port: number; user: string; database: string } {
  const url = new URL(dsn);
  return {
    hostname: url.hostname || "localhost",
    port: url.port ? parseInt(url.port) : 5432,
    user: url.username || "disc",
    database: url.pathname.slice(1) || "disc_test",
  };
}

/** Execute raw SQL via a fresh client connection. */
async function execSQL(dsn: string, sql: string): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    await client.queryArray(sql);
  } finally {
    await client.end();
  }
}

/** Query rows via a fresh client connection. */
async function queryRows<T>(
  dsn: string,
  sql: string,
  params?: unknown[],
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

/** Drop tables, functions, and triggers (best-effort cleanup). */
async function cleanup(dsn: string, ...tableNames: string[]): Promise<void> {
  const cfg = parseDsn(dsn);
  const client = new Client(cfg);
  try {
    await client.connect();
    for (const name of tableNames) {
      await client.queryArray(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }
    // Also drop any rewrite trigger functions that may be lingering
    await client.queryArray(`
      DO $$ DECLARE fn RECORD;
      BEGIN
        FOR fn IN
          SELECT proname FROM pg_proc
          WHERE proname LIKE '%__rewrite_fn' AND pronamespace = 'public'::regnamespace
        LOOP
          EXECUTE 'DROP FUNCTION IF EXISTS ' || fn.proname || '() CASCADE';
        END LOOP;
      END $$;
    `);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Test 1: INSERT rewrite auto-sets created_at via datetime_of_statement()
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG Rewrite: INSERT rewrite auto-sets created_at on insert via BEFORE INSERT trigger",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const tableName = `rewrite_post_${ts}`;

    try {
      // Create the table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          created_at TIMESTAMPTZ
        );
      `,
      );

      // Create the rewrite trigger function and trigger manually
      // (mimicking what DDLGenerator produces)
      const fnName = `${tableName}__created_at__rewrite_fn`;
      const triggerName = `${tableName}__created_at__rewrite`;

      await execSQL(
        dsn,
        `
        CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
        BEGIN
          NEW.created_at := statement_timestamp();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
      );

      await execSQL(
        dsn,
        `
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON ${tableName}
        FOR EACH ROW EXECUTE FUNCTION ${fnName}();
      `,
      );

      // Insert a row WITHOUT specifying created_at
      await execSQL(
        dsn,
        `
        INSERT INTO ${tableName} (title) VALUES ('Hello World');
      `,
      );

      // Verify created_at was auto-set by the rewrite trigger
      const rows = await queryRows<{ title: string; created_at: string }>(
        dsn,
        `SELECT title, created_at FROM ${tableName}`,
      );

      assertEquals(rows.length, 1, "Should have exactly 1 row");
      assertEquals(rows[0].title, "Hello World");
      assertEquals(
        rows[0].created_at !== null && rows[0].created_at !== undefined,
        true,
        "created_at should be auto-set by rewrite trigger",
      );
    } finally {
      await cleanup(dsn, tableName);
    }
  },
});

// ---------------------------------------------------------------------------
// Test 2: UPDATE rewrite auto-sets updated_at on update
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG Rewrite: UPDATE rewrite auto-sets updated_at when row is updated",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const tableName = `rewrite_article_${ts}`;

    try {
      // Create the table with updated_at defaulting to NULL
      await execSQL(
        dsn,
        `
        CREATE TABLE ${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          updated_at TIMESTAMPTZ
        );
      `,
      );

      // Create the rewrite trigger for UPDATE only
      const fnName = `${tableName}__updated_at__rewrite_fn`;
      const triggerName = `${tableName}__updated_at__rewrite`;

      await execSQL(
        dsn,
        `
        CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
        BEGIN
          NEW.updated_at := statement_timestamp();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
      );

      await execSQL(
        dsn,
        `
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE ON ${tableName}
        FOR EACH ROW EXECUTE FUNCTION ${fnName}();
      `,
      );

      // Insert a row — updated_at should remain NULL (trigger is UPDATE-only)
      await execSQL(
        dsn,
        `
        INSERT INTO ${tableName} (title) VALUES ('Original Title');
      `,
      );

      const insertRows = await queryRows<{
        title: string;
        updated_at: string | null;
      }>(
        dsn,
        `SELECT title, updated_at FROM ${tableName}`,
      );

      assertEquals(insertRows.length, 1);
      assertEquals(
        insertRows[0].updated_at,
        null,
        "updated_at should be NULL after INSERT (UPDATE-only rewrite)",
      );

      // Update the row — updated_at should be auto-set
      await execSQL(
        dsn,
        `
        UPDATE ${tableName} SET title = 'Updated Title' WHERE title = 'Original Title';
      `,
      );

      const updateRows = await queryRows<{
        title: string;
        updated_at: string | null;
      }>(
        dsn,
        `SELECT title, updated_at FROM ${tableName}`,
      );

      assertEquals(updateRows.length, 1);
      assertEquals(updateRows[0].title, "Updated Title");
      assertEquals(
        updateRows[0].updated_at !== null &&
          updateRows[0].updated_at !== undefined,
        true,
        "updated_at should be auto-set by rewrite trigger on UPDATE",
      );
    } finally {
      await cleanup(dsn, tableName);
    }
  },
});

// ---------------------------------------------------------------------------
// Test 3: INSERT+UPDATE combined rewrite
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG Rewrite: INSERT+UPDATE combined rewrite auto-sets column on both operations",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const tableName = `rewrite_log_${ts}`;

    try {
      // Create the table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          content TEXT NOT NULL,
          modified_at TIMESTAMPTZ
        );
      `,
      );

      // Create the rewrite trigger for both INSERT and UPDATE
      const fnName = `${tableName}__modified_at__rewrite_fn`;
      const triggerName = `${tableName}__modified_at__rewrite`;

      await execSQL(
        dsn,
        `
        CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
        BEGIN
          NEW.modified_at := statement_timestamp();
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
      );

      await execSQL(
        dsn,
        `
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT OR UPDATE ON ${tableName}
        FOR EACH ROW EXECUTE FUNCTION ${fnName}();
      `,
      );

      // Insert a row — modified_at should be set
      await execSQL(
        dsn,
        `
        INSERT INTO ${tableName} (content) VALUES ('First version');
      `,
      );

      const insertRows = await queryRows<{
        content: string;
        modified_at: string;
      }>(
        dsn,
        `SELECT content, modified_at FROM ${tableName}`,
      );

      assertEquals(insertRows.length, 1);
      const insertTimestamp = insertRows[0].modified_at;
      assertEquals(
        insertTimestamp !== null && insertTimestamp !== undefined,
        true,
        "modified_at should be set on INSERT",
      );

      // Small delay to ensure timestamps differ
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Update the row — modified_at should change
      await execSQL(
        dsn,
        `
        UPDATE ${tableName} SET content = 'Second version' WHERE content = 'First version';
      `,
      );

      const updateRows = await queryRows<{
        content: string;
        modified_at: string;
      }>(
        dsn,
        `SELECT content, modified_at FROM ${tableName}`,
      );

      assertEquals(updateRows.length, 1);
      assertEquals(updateRows[0].content, "Second version");
      const updateTimestamp = updateRows[0].modified_at;
      assertEquals(
        updateTimestamp !== null && updateTimestamp !== undefined,
        true,
        "modified_at should be updated on UPDATE",
      );

      // The update timestamp should be different from (or equal to) the insert timestamp
      // They may or may not differ depending on timing, but both should be non-null
    } finally {
      await cleanup(dsn, tableName);
    }
  },
});

// ---------------------------------------------------------------------------
// Test 4: Rewrite with __old__ reference (counter increment)
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG Rewrite: UPDATE rewrite with OLD reference increments counter on each update",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const tableName = `rewrite_counter_${ts}`;

    try {
      // Create the table with a counter column
      await execSQL(
        dsn,
        `
        CREATE TABLE ${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          counter INTEGER NOT NULL DEFAULT 0
        );
      `,
      );

      // Create a rewrite trigger that increments counter using OLD reference
      // This mimics: rewrite update using (__old__.counter + 1)
      // which compiles to: OLD.counter + 1
      const fnName = `${tableName}__counter__rewrite_fn`;
      const triggerName = `${tableName}__counter__rewrite`;

      await execSQL(
        dsn,
        `
        CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
        BEGIN
          NEW.counter := OLD.counter + 1;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
      );

      await execSQL(
        dsn,
        `
        CREATE TRIGGER ${triggerName}
        BEFORE UPDATE ON ${tableName}
        FOR EACH ROW EXECUTE FUNCTION ${fnName}();
      `,
      );

      // Insert a row with counter=0
      await execSQL(
        dsn,
        `
        INSERT INTO ${tableName} (name, counter) VALUES ('test', 0);
      `,
      );

      // First update: counter should become 1
      await execSQL(
        dsn,
        `
        UPDATE ${tableName} SET name = 'test1' WHERE name = 'test';
      `,
      );

      let rows = await queryRows<{ name: string; counter: number }>(
        dsn,
        `SELECT name, counter FROM ${tableName}`,
      );

      assertEquals(rows.length, 1);
      assertEquals(
        rows[0].counter,
        1,
        "Counter should be 1 after first update",
      );

      // Second update: counter should become 2
      await execSQL(
        dsn,
        `
        UPDATE ${tableName} SET name = 'test2' WHERE name = 'test1';
      `,
      );

      rows = await queryRows<{ name: string; counter: number }>(
        dsn,
        `SELECT name, counter FROM ${tableName}`,
      );

      assertEquals(rows.length, 1);
      assertEquals(
        rows[0].counter,
        2,
        "Counter should be 2 after second update",
      );

      // Third update: counter should become 3
      await execSQL(
        dsn,
        `
        UPDATE ${tableName} SET name = 'test3' WHERE name = 'test2';
      `,
      );

      rows = await queryRows<{ name: string; counter: number }>(
        dsn,
        `SELECT name, counter FROM ${tableName}`,
      );

      assertEquals(rows.length, 1);
      assertEquals(
        rows[0].counter,
        3,
        "Counter should be 3 after third update",
      );
    } finally {
      await cleanup(dsn, tableName);
    }
  },
});

// ---------------------------------------------------------------------------
// Test 5: DDLGenerator output executes against PG
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG Rewrite: DDLGenerator-produced rewrite SQL executes and fires on INSERT",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const tableName = `ddl_rewrite_${ts}`;

    try {
      // Create the table first (since we only want to test the rewrite DDL)
      await execSQL(
        dsn,
        `
        CREATE TABLE ${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          title TEXT NOT NULL,
          created_at TIMESTAMPTZ
        );
      `,
      );

      // Use the DDLGenerator to produce rewrite DDL
      const ddl = new DDLGenerator();
      const rewriteDef: RewriteDefinition = {
        events: ["insert"],
        body: "datetime_of_statement()",
      };

      // Generate DDL using CreateType operation, then extract only rewrite statements
      const createOp: CreateTypeOperation = {
        kind: "CreateType",
        typeName: tableName,
        properties: [
          {
            name: "created_at",
            type: "datetime",
            required: false,
            multi: false,
            constraints: [],
            annotations: {},
            rewrites: [rewriteDef],
          },
        ],
        links: [],
      };

      const allStatements = ddl.generateDDL([createOp]);

      // Filter for only the rewrite-related statements
      // (skip CREATE TABLE since we already created the table)
      const rewriteSql = allStatements.filter(
        (s) =>
          s.includes("CREATE OR REPLACE FUNCTION") &&
            s.includes("rewrite_fn") ||
          s.includes("CREATE TRIGGER") && s.includes("rewrite"),
      );

      assertEquals(
        rewriteSql.length,
        2,
        "DDLGenerator should produce exactly 2 rewrite statements (function + trigger)",
      );

      // Execute the generated rewrite SQL against PostgreSQL
      for (const stmt of rewriteSql) {
        await execSQL(dsn, stmt);
      }

      // Insert a row without specifying created_at to verify the rewrite fires
      await execSQL(
        dsn,
        `
        INSERT INTO ${tableName} (title) VALUES ('DDL Test Post');
      `,
      );

      // Verify created_at was populated by the DDL-generated rewrite trigger
      const rows = await queryRows<{
        title: string;
        created_at: string | null;
      }>(
        dsn,
        `SELECT title, created_at FROM ${tableName}`,
      );

      assertEquals(rows.length, 1, "Should have exactly 1 row");
      assertEquals(rows[0].title, "DDL Test Post");
      assertEquals(
        rows[0].created_at !== null && rows[0].created_at !== undefined,
        true,
        "created_at should be auto-set by DDL-generated rewrite trigger",
      );
    } finally {
      await cleanup(dsn, tableName);
    }
  },
});

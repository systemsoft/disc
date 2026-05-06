/**
 * PostgreSQL End-to-End Tests for Trigger Feature
 *
 * Tests that verify PL/pgSQL triggers are correctly created and fire
 * against a real PostgreSQL instance. Each test creates tables with
 * triggers and verifies the side-effect rows produced by those triggers.
 *
 * These tests require a running PostgreSQL instance.
 * Set DISC_PG_TEST_URL or DISC_PG_AUTO=1 to enable them.
 */

import { assertEquals } from "@std/assert";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { canRunPgTests, getTestDsn } from "../tests/pg-test-harness.ts";
import { DDLGenerator } from "./ddl.ts";
import type { CreateTypeOperation, TriggerDefinition } from "./types.ts";

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
    const result = params
      ? await client.queryObject<T>(sql, params)
      : await client.queryObject<T>(sql);
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
    // Also drop any trigger functions that may be lingering
    await client.queryArray(`
      DO $$ DECLARE fn RECORD;
      BEGIN
        FOR fn IN
          SELECT proname FROM pg_proc
          WHERE proname LIKE '%__audit_%' AND pronamespace = 'public'::regnamespace
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
// Test 1: Trigger fires on INSERT (AFTER INSERT)
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG Trigger: AFTER INSERT trigger fires and inserts audit_log row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const auditTable = `audit_log_${ts}`;
    const userTable = `trigger_user_${ts}`;

    try {
      // Create the audit_log table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${auditTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          action TEXT NOT NULL,
          target_name TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `,
      );

      // Create the user table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${userTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL
        );
      `,
      );

      // Construct the trigger SQL directly using the same naming patterns
      // as DDLGenerator (tableName__triggerName_fn and tableName__triggerName).
      const fnName = `${userTable}__audit_insert_fn`;
      const triggerName = `${userTable}__audit_insert`;

      await execSQL(
        dsn,
        `
        CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
        BEGIN
          INSERT INTO ${auditTable}(action, target_name) VALUES (TG_OP, NEW.name);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
      );

      await execSQL(
        dsn,
        `
        CREATE TRIGGER ${triggerName}
        AFTER INSERT ON ${userTable}
        FOR EACH ROW EXECUTE FUNCTION ${fnName}();
      `,
      );

      // Insert a user row
      await execSQL(
        dsn,
        `
        INSERT INTO ${userTable} (name) VALUES ('Ada');
      `,
      );

      // Verify audit_log has a row from the trigger
      const rows = await queryRows<{ action: string; target_name: string }>(
        dsn,
        `SELECT action, target_name FROM ${auditTable}`,
      );

      assertEquals(rows.length, 1, "Should have exactly 1 audit_log entry");
      assertEquals(rows[0].action, "INSERT", "Action should be INSERT");
      assertEquals(rows[0].target_name, "Ada", "Target name should be Ada");
    } finally {
      await cleanup(dsn, auditTable, userTable);
    }
  },
});

// ---------------------------------------------------------------------------
// Test 2: Trigger fires on UPDATE (AFTER UPDATE)
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG Trigger: AFTER UPDATE trigger fires and inserts audit_log row",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const auditTable = `audit_log_${ts}`;
    const userTable = `trigger_user_${ts}`;

    try {
      // Create the audit_log table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${auditTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          action TEXT NOT NULL,
          target_name TEXT NOT NULL
        );
      `,
      );

      // Create the user table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${userTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL
        );
      `,
      );

      // Create trigger function and trigger for AFTER UPDATE
      const fnName = `${userTable}__audit_update_fn`;
      const triggerName = `${userTable}__audit_update`;

      await execSQL(
        dsn,
        `
        CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
        BEGIN
          INSERT INTO ${auditTable}(action, target_name) VALUES (TG_OP, NEW.name);
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `,
      );

      await execSQL(
        dsn,
        `
        CREATE TRIGGER ${triggerName}
        AFTER UPDATE ON ${userTable}
        FOR EACH ROW EXECUTE FUNCTION ${fnName}();
      `,
      );

      // Insert a row (should NOT fire the UPDATE trigger)
      await execSQL(
        dsn,
        `
        INSERT INTO ${userTable} (name) VALUES ('Billie');
      `,
      );

      // Verify audit_log is empty after INSERT (trigger is UPDATE-only)
      const emptyRows = await queryRows<{ action: string }>(
        dsn,
        `SELECT action FROM ${auditTable}`,
      );
      assertEquals(
        emptyRows.length,
        0,
        "Audit log should be empty after INSERT (UPDATE trigger only)",
      );

      // Update the row
      await execSQL(
        dsn,
        `
        UPDATE ${userTable} SET name = 'Billieby' WHERE name = 'Billie';
      `,
      );

      // Verify audit_log has one entry from the UPDATE trigger
      const rows = await queryRows<{ action: string; target_name: string }>(
        dsn,
        `SELECT action, target_name FROM ${auditTable}`,
      );

      assertEquals(rows.length, 1, "Should have exactly 1 audit_log entry");
      assertEquals(rows[0].action, "UPDATE", "Action should be UPDATE");
      assertEquals(
        rows[0].target_name,
        "Billieby",
        "Target name should be the updated value",
      );
    } finally {
      await cleanup(dsn, auditTable, userTable);
    }
  },
});

// ---------------------------------------------------------------------------
// Test 3: Trigger fires on DELETE (BEFORE timing)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "PG Trigger: BEFORE DELETE trigger fires and logs to audit_log before deletion",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const auditTable = `audit_log_${ts}`;
    const userTable = `trigger_user_${ts}`;

    try {
      // Create the audit_log table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${auditTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          action TEXT NOT NULL,
          target_name TEXT NOT NULL
        );
      `,
      );

      // Create the user table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${userTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL
        );
      `,
      );

      // Create trigger function and trigger for BEFORE DELETE.
      // Note: For DELETE triggers, NEW is NULL so we use OLD to access the
      // row being deleted. We RETURN OLD to allow the deletion to proceed.
      // (The DDLGenerator currently always returns NEW, which would cancel
      // a BEFORE DELETE. This test constructs the SQL directly to verify
      // that BEFORE DELETE timing works correctly in PostgreSQL.)
      const fnName = `${userTable}__audit_delete_fn`;
      const triggerName = `${userTable}__audit_delete`;

      await execSQL(
        dsn,
        `
        CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
        BEGIN
          INSERT INTO ${auditTable}(action, target_name) VALUES (TG_OP, OLD.name);
          RETURN OLD;
        END;
        $$ LANGUAGE plpgsql;
      `,
      );

      await execSQL(
        dsn,
        `
        CREATE TRIGGER ${triggerName}
        BEFORE DELETE ON ${userTable}
        FOR EACH ROW EXECUTE FUNCTION ${fnName}();
      `,
      );

      // Insert a row
      await execSQL(
        dsn,
        `
        INSERT INTO ${userTable} (name) VALUES ('Cher');
      `,
      );

      // Delete the row (should fire BEFORE DELETE trigger)
      await execSQL(
        dsn,
        `
        DELETE FROM ${userTable} WHERE name = 'Cher';
      `,
      );

      // Verify audit_log has an entry logged BEFORE the delete
      const auditRows = await queryRows<
        { action: string; target_name: string }
      >(
        dsn,
        `SELECT action, target_name FROM ${auditTable}`,
      );

      assertEquals(
        auditRows.length,
        1,
        "Should have exactly 1 audit_log entry",
      );
      assertEquals(auditRows[0].action, "DELETE", "Action should be DELETE");
      assertEquals(
        auditRows[0].target_name,
        "Cher",
        "Target name should be the deleted row's name",
      );

      // Verify the row was actually deleted from the user table
      const userRows = await queryRows<{ name: string }>(
        dsn,
        `SELECT name FROM ${userTable}`,
      );
      assertEquals(
        userRows.length,
        0,
        "User table should be empty after deletion",
      );
    } finally {
      await cleanup(dsn, auditTable, userTable);
    }
  },
});

// ---------------------------------------------------------------------------
// Test 4: Trigger with multiple events (INSERT OR UPDATE OR DELETE)
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "PG Trigger: Multi-event trigger (INSERT OR UPDATE OR DELETE) fires for all operations",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const auditTable = `audit_log_${ts}`;
    const itemTable = `trigger_item_${ts}`;

    try {
      // Create the audit_log table. Use BIGSERIAL so `ORDER BY id`
      // returns rows in insertion order — random UUIDs would make the
      // multi-event ordering assertion flaky.
      await execSQL(
        dsn,
        `
        CREATE TABLE ${auditTable} (
          id BIGSERIAL PRIMARY KEY,
          action TEXT NOT NULL,
          target_name TEXT
        );
      `,
      );

      // Create the item table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${itemTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL
        );
      `,
      );

      // Create a single trigger function that handles all three events.
      // Uses COALESCE(NEW.name, OLD.name) to handle DELETE where NEW is NULL.
      const fnName = `${itemTable}__audit_all_fn`;
      const triggerName = `${itemTable}__audit_all`;

      await execSQL(
        dsn,
        `
        CREATE OR REPLACE FUNCTION ${fnName}() RETURNS TRIGGER AS $$
        BEGIN
          IF TG_OP = 'DELETE' THEN
            INSERT INTO ${auditTable}(action, target_name) VALUES (TG_OP, OLD.name);
            RETURN OLD;
          ELSE
            INSERT INTO ${auditTable}(action, target_name) VALUES (TG_OP, NEW.name);
            RETURN NEW;
          END IF;
        END;
        $$ LANGUAGE plpgsql;
      `,
      );

      await execSQL(
        dsn,
        `
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT OR UPDATE OR DELETE ON ${itemTable}
        FOR EACH ROW EXECUTE FUNCTION ${fnName}();
      `,
      );

      // Perform all three operations
      await execSQL(
        dsn,
        `
        INSERT INTO ${itemTable} (name) VALUES ('Widget');
      `,
      );
      await execSQL(
        dsn,
        `
        UPDATE ${itemTable} SET name = 'Gadget' WHERE name = 'Widget';
      `,
      );
      await execSQL(
        dsn,
        `
        DELETE FROM ${itemTable} WHERE name = 'Gadget';
      `,
      );

      // Verify 3 audit_log entries, one per operation
      const rows = await queryRows<{ action: string; target_name: string }>(
        dsn,
        `SELECT action, target_name FROM ${auditTable} ORDER BY id`,
      );

      assertEquals(rows.length, 3, "Should have exactly 3 audit_log entries");

      assertEquals(rows[0].action, "INSERT", "First action should be INSERT");
      assertEquals(rows[0].target_name, "Widget", "INSERT should log 'Widget'");

      assertEquals(rows[1].action, "UPDATE", "Second action should be UPDATE");
      assertEquals(
        rows[1].target_name,
        "Gadget",
        "UPDATE should log the new name 'Gadget'",
      );

      assertEquals(rows[2].action, "DELETE", "Third action should be DELETE");
      assertEquals(
        rows[2].target_name,
        "Gadget",
        "DELETE should log the old name 'Gadget'",
      );
    } finally {
      await cleanup(dsn, auditTable, itemTable);
    }
  },
});

// ---------------------------------------------------------------------------
// Test 5: DDLGenerator produces valid trigger SQL that PG can execute
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "PG Trigger: DDLGenerator-produced trigger SQL executes and fires on INSERT",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const ts = Date.now();
    const auditTable = `audit_log_${ts}`;
    const tableName = `ddl_user_${ts}`;

    try {
      // Create the audit_log table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${auditTable} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          action TEXT NOT NULL,
          target_name TEXT NOT NULL
        );
      `,
      );

      // Create the user table
      await execSQL(
        dsn,
        `
        CREATE TABLE ${tableName} (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL
        );
      `,
      );

      // Use the DDLGenerator to produce trigger DDL from a TriggerDefinition
      const ddl = new DDLGenerator();
      const triggerDef: TriggerDefinition = {
        name: "audit_insert",
        timing: "after",
        events: ["insert"],
        scope: "each",
        body:
          `INSERT INTO ${auditTable}(action, target_name) VALUES (__action__, __new__.name)`,
      };

      // Generate DDL using the same path as the migration engine:
      // wrap the trigger in a CreateType operation and extract the trigger DDL.
      const createOp: CreateTypeOperation = {
        kind: "CreateType",
        typeName: tableName,
        properties: [],
        links: [],
        triggers: [triggerDef],
      };
      const triggerStatements = ddl.generateDDL([createOp]);

      // The DDL will include a CREATE TABLE (which we skip since we already
      // created the table) and the trigger function + trigger statements.
      // Filter for only the trigger-related statements.
      const triggerSql = triggerStatements.filter(
        (s) =>
          s.includes("CREATE OR REPLACE FUNCTION") ||
          s.includes("CREATE TRIGGER"),
      );

      assertEquals(
        triggerSql.length,
        2,
        "DDLGenerator should produce exactly 2 trigger statements (function + trigger)",
      );

      // Execute the generated trigger SQL against PostgreSQL
      for (const stmt of triggerSql) {
        await execSQL(dsn, stmt);
      }

      // Insert a user row to fire the trigger
      await execSQL(
        dsn,
        `
        INSERT INTO ${tableName} (name) VALUES ('Diana');
      `,
      );

      // Verify audit_log was populated by the DDL-generated trigger
      const rows = await queryRows<{ action: string; target_name: string }>(
        dsn,
        `SELECT action, target_name FROM ${auditTable}`,
      );

      assertEquals(rows.length, 1, "Should have exactly 1 audit_log entry");
      assertEquals(rows[0].action, "INSERT", "Action should be INSERT");
      assertEquals(
        rows[0].target_name,
        "Diana",
        "Target name should be Diana",
      );
    } finally {
      await cleanup(dsn, auditTable, tableName);
    }
  },
});

/**
 * Unit tests for the data-watch DDL helpers (Bundle L — #3c).
 *
 * Tests that don't require PG live in here. PG-backed roundtrip
 * (bootstrap + trigger fires + change-log row appears) lives in
 * `data-watch-pg.test.ts`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  CHANGE_LOG_FN,
  CHANGE_LOG_TABLE,
  createChangeLogFunctionSql,
  createChangeLogTableSql,
  createTriggerSql,
  DEFAULT_EXCLUDED_TABLES,
} from "./data-watch-ddl.ts";

Deno.test("createChangeLogTableSql — emits idempotent CREATE TABLE IF NOT EXISTS", () => {
  const sql = createChangeLogTableSql();
  assertStringIncludes(sql, `CREATE TABLE IF NOT EXISTS ${CHANGE_LOG_TABLE}`);
  assertStringIncludes(sql, "id BIGSERIAL PRIMARY KEY");
  assertStringIncludes(sql, "table_name TEXT NOT NULL");
  assertStringIncludes(sql, "op TEXT NOT NULL");
  assertStringIncludes(sql, "CREATE INDEX IF NOT EXISTS");
});

Deno.test("createChangeLogFunctionSql — emits CREATE OR REPLACE plpgsql function", () => {
  const sql = createChangeLogFunctionSql();
  assertStringIncludes(sql, `CREATE OR REPLACE FUNCTION ${CHANGE_LOG_FN}()`);
  // Statement-level so a bulk UPDATE only emits one log row.
  assertStringIncludes(sql, "RETURN NULL");
  assertStringIncludes(sql, "TG_TABLE_NAME");
  assertStringIncludes(sql, "TG_OP");
  assertStringIncludes(sql, "LANGUAGE plpgsql");
});

Deno.test("createTriggerSql — drops then re-creates AFTER trigger for INSERT/UPDATE/DELETE", () => {
  const sql = createTriggerSql("users");
  // Idempotent: drop first.
  assertStringIncludes(sql, `DROP TRIGGER IF EXISTS "disc_data_watch_users"`);
  // Re-create AFTER mutating ops.
  assertStringIncludes(sql, `CREATE TRIGGER "disc_data_watch_users"`);
  assertStringIncludes(sql, "AFTER INSERT OR UPDATE OR DELETE ON \"users\"");
  assertStringIncludes(sql, "FOR EACH STATEMENT");
  assertStringIncludes(sql, `EXECUTE FUNCTION ${CHANGE_LOG_FN}()`);
});

Deno.test("createTriggerSql — quotes the table name (avoids injection)", () => {
  // Even with a "weird but valid" identifier the SQL stays well-formed.
  const sql = createTriggerSql("my_table_42");
  assertStringIncludes(sql, `ON "my_table_42"`);
  assertStringIncludes(sql, `"disc_data_watch_my_table_42"`);
});

Deno.test("DEFAULT_EXCLUDED_TABLES — excludes the change-log itself + migrations + auth churn", () => {
  // The change-log MUST be excluded — otherwise INSERT into the log
  // would trigger another INSERT into the log → infinite loop.
  assertEquals(DEFAULT_EXCLUDED_TABLES.has(CHANGE_LOG_TABLE), true);
  assertEquals(DEFAULT_EXCLUDED_TABLES.has("disc_migrations"), true);
  // Auth-internal high-churn tables.
  assertEquals(DEFAULT_EXCLUDED_TABLES.has("auth_sessions"), true);
  assertEquals(DEFAULT_EXCLUDED_TABLES.has("magic_link_tokens"), true);
  // Regular user tables are NOT excluded.
  assertEquals(DEFAULT_EXCLUDED_TABLES.has("users"), false);
  assertEquals(DEFAULT_EXCLUDED_TABLES.has("posts"), false);
});

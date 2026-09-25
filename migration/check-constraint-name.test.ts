/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A property's CHECK constraint is named after its column,
 * `chk_<table>_<column>_<constraint>`, on every path: CREATE TABLE, adding
 * the constraint to an existing property, dropping it, and both rollbacks.
 * The add/drop paths used to use the raw property name, so for a camelCase
 * property (`maxRetries` → column `max_retries`) a later drop missed the
 * CHECK CREATE TABLE made. Dropping also removes that legacy name so
 * databases migrated before the fix heal.
 *
 * The PG tests require PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaManager } from "./schema-manager.ts";
import type * as Types from "./types.ts";

const CHECK_NAME = "chk_job_max_retries_min_value_0_";
const LEGACY_CHECK_NAME = "chk_job_maxRetries_min_value_0_";

const WITH_CHECK = `
  module default {
    type Job {
      required maxRetries: int64 {
        constraint min_value(0);
      };
    };
  };
`;

const WITHOUT_CHECK = `
  module default {
    type Job {
      required maxRetries: int64;
    };
  };
`;

function maxRetriesProperty(constraints: string[]): Types.PropertyDefinition {
  return { annotations: {}, constraints, multi: false, name: "maxRetries", required: true, type: "int64" };
}

function alterOperation(change: Types.PropertyChange): Types.AlterTypeOperation[] {
  const alterProperty: Types.AlterPropertyOperation = { changes: [change], kind: "AlterProperty", propertyName: "maxRetries" };

  return [{ kind: "AlterType", operations: [alterProperty], typeName: "Job" }];
}

Deno.test("CREATE TABLE names a camelCase property's CHECK after its column", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    links: [],
    properties: [maxRetriesProperty(["min_value(0)"])],
    typeName: "Job"
  };
  const ddl = new DDLGenerator().generateDDL([operation]).join("\n");

  assertEquals(ddl.includes(CHECK_NAME), true, ddl);
});

Deno.test("adding a CHECK to a camelCase property uses the CREATE TABLE name", () => {
  const ddl = new DDLGenerator().generateDDL(alterOperation({ kind: "AddConstraint", newValue: "min_value(0)" }));

  assertEquals(ddl, [`ALTER TABLE job ADD CONSTRAINT ${CHECK_NAME} CHECK (max_retries >= 0);`]);
});

Deno.test("dropping a camelCase property's CHECK removes the current and legacy names", () => {
  const ddl = new DDLGenerator().generateDDL(alterOperation({ kind: "DropConstraint", oldValue: "min_value(0)" }));

  assertEquals(ddl, [
    `ALTER TABLE job DROP CONSTRAINT IF EXISTS ${CHECK_NAME};`,
    `ALTER TABLE job DROP CONSTRAINT IF EXISTS "${LEGACY_CHECK_NAME}";`
  ]);
});

Deno.test("rolling back an added CHECK drops it by the column-based name", () => {
  const ddl = new DDLGenerator().generateRollbackDDL(alterOperation({ kind: "AddConstraint", newValue: "min_value(0)" }));

  assertEquals(ddl, [`ALTER TABLE job DROP CONSTRAINT IF EXISTS ${CHECK_NAME};`]);
});

Deno.test("rolling back a dropped CHECK re-adds it against the column", () => {
  const ddl = new DDLGenerator().generateRollbackDDL(alterOperation({ kind: "DropConstraint", oldValue: "min_value(0)" }));

  assertEquals(ddl, [`ALTER TABLE job ADD CONSTRAINT ${CHECK_NAME} CHECK (max_retries >= 0);`]);
});

Deno.test("rolling back a camelCase property change alters the snake_case column", () => {
  const ddl = new DDLGenerator().generateRollbackDDL(alterOperation({ kind: "ChangeRequired", newValue: true, oldValue: false }));

  assertEquals(ddl, ["ALTER TABLE job ALTER COLUMN max_retries DROP NOT NULL;"]);
});

// ---------------------------------------------------------------------------
// Real PostgreSQL
// ---------------------------------------------------------------------------

async function checksOnJob(pool: ConnectionPool): Promise<string[]> {
  const result = await pool.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'job'::regclass AND contype = 'c' ORDER BY conname`
  );

  return result.rows.map(row => row.conname as string);
}

async function applySdl(pool: ConnectionPool, sdl: string): Promise<void> {
  const manager = new SchemaManager({ pool });

  try {
    await manager.initialize();
    const result = await manager.applySchema(sdl, { allowUnsafe: true });
    assertEquals(result.ok, true, result.ok ? "" : result.error.message);
  } finally {
    await manager.close();
  }
}

Deno.test({
  name: "PG: migrating a camelCase property's CHECK away lets violating values in",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await applySdl(pool, WITH_CHECK);
      assertEquals(await checksOnJob(pool), [CHECK_NAME]);

      await applySdl(pool, WITHOUT_CHECK);

      assertEquals(await checksOnJob(pool), []);
      await pool.query(`INSERT INTO job (max_retries) VALUES (-1)`);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: re-adding a camelCase property's CHECK uses the CREATE TABLE name",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await applySdl(pool, WITHOUT_CHECK);
      await applySdl(pool, WITH_CHECK);

      assertEquals(await checksOnJob(pool), [CHECK_NAME]);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

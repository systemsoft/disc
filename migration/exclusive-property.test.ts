/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Property-level `constraint exclusive` owns exactly one unique index,
 * `uk_<table>_<column>`, on every path: CREATE TABLE, adding the constraint
 * to an existing property, and dropping it again. Dropping also removes the
 * names older Disc versions created (`<table>_<column>_key` from an inline
 * `UNIQUE`, `idx_<table>_<column>_unique` from the add path) so databases
 * migrated before the fix heal on their next migrate.
 *
 * The PG tests require PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaManager } from "./schema-manager.ts";
import type * as Types from "./types.ts";

const WITH_EXCLUSIVE = `
  module default {
    type GitObject {
      required object_id: str {
        constraint exclusive;
      };
    };
  };
`;

const WITHOUT_EXCLUSIVE = `
  module default {
    type GitObject {
      required object_id: str;
    };
  };
`;

function objectIdProperty(constraints: string[]): Types.PropertyDefinition {
  return { annotations: {}, constraints, multi: false, name: "object_id", required: true, type: "str" };
}

function alterConstraint(change: Types.PropertyChange): string[] {
  const alterProperty: Types.AlterPropertyOperation = { changes: [change], kind: "AlterProperty", propertyName: "object_id" };
  const operation: Types.AlterTypeOperation = { kind: "AlterType", operations: [alterProperty], typeName: "GitObject" };

  return new DDLGenerator().generateDDL([operation]);
}

Deno.test("CREATE TABLE gives an exclusive property exactly one unique index", () => {
  const operation: Types.CreateTypeOperation = {
    kind: "CreateType",
    links: [],
    properties: [objectIdProperty(["exclusive"])],
    typeName: "GitObject"
  };

  const ddl = new DDLGenerator().generateDDL([operation]);
  const createTable = ddl.find(s => s.startsWith("CREATE TABLE"))!;

  assertEquals(createTable.includes("UNIQUE"), false, createTable);
  assertEquals(ddl.filter(s => s.includes("UNIQUE")), ["CREATE UNIQUE INDEX uk_git_object_object_id ON git_object (object_id);"]);
});

Deno.test("adding exclusive to an existing property creates the same uk_ index CREATE TABLE does", () => {
  const ddl = alterConstraint({ kind: "AddConstraint", newValue: "exclusive" });

  assertEquals(ddl.filter(s => s.includes("UNIQUE")), ["CREATE UNIQUE INDEX uk_git_object_object_id ON git_object (object_id);"]);
});

Deno.test("a new exclusive property on an existing type gets the uk_ index", () => {
  const addProperty: Types.AddPropertyOperation = { kind: "AddProperty", property: objectIdProperty(["exclusive"]) };
  const operation: Types.AlterTypeOperation = { kind: "AlterType", operations: [addProperty], typeName: "GitObject" };
  const ddl = new DDLGenerator().generateDDL([operation]);

  assertEquals(ddl.filter(s => s.includes("UNIQUE")), ["CREATE UNIQUE INDEX uk_git_object_object_id ON git_object (object_id);"]);
});

Deno.test("dropping exclusive removes the uk_ index and the legacy names", () => {
  const ddl = alterConstraint({ kind: "DropConstraint", oldValue: "exclusive" });

  for (
    const expected of [
      "DROP INDEX IF EXISTS uk_git_object_object_id;",
      "DROP INDEX IF EXISTS idx_git_object_object_id_unique;",
      "ALTER TABLE git_object DROP CONSTRAINT IF EXISTS git_object_object_id_key;"
    ]
  ) {
    assertEquals(ddl.includes(expected), true, `missing ${expected} in:\n${ddl.join("\n")}`);
  }
});

// ---------------------------------------------------------------------------
// Real PostgreSQL
// ---------------------------------------------------------------------------

/** Names of unique indexes and unique constraints on `git_object`, primary key excluded. */
async function uniquesOnGitObject(pool: ConnectionPool): Promise<{ constraints: string[]; indexes: string[]; }> {
  const indexes = await pool.query(
    `SELECT indexname FROM pg_indexes
      WHERE tablename = 'git_object' AND indexdef LIKE 'CREATE UNIQUE INDEX%' AND indexname <> 'git_object_pkey'
      ORDER BY indexname`
  );
  const constraints = await pool.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'git_object'::regclass AND contype = 'u' ORDER BY conname`
  );

  return {
    constraints: constraints.rows.map(row => row.conname as string),
    indexes: indexes.rows.map(row => row.indexname as string)
  };
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

async function insertTwice(pool: ConnectionPool): Promise<number> {
  await pool.query(`INSERT INTO git_object (object_id) VALUES ('same'), ('same')`);
  const count = await pool.query(`SELECT count(*)::int AS n FROM git_object WHERE object_id = 'same'`);

  return count.rows[0].n as number;
}

Deno.test({
  name: "PG: a fresh exclusive property is backed by exactly one unique index",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await applySdl(pool, WITH_EXCLUSIVE);

      assertEquals(await uniquesOnGitObject(pool), { constraints: [], indexes: ["uk_git_object_object_id"] });
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: migrating a property's exclusive away lets duplicate values in",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await applySdl(pool, WITH_EXCLUSIVE);
      await applySdl(pool, WITHOUT_EXCLUSIVE);

      assertEquals(await uniquesOnGitObject(pool), { constraints: [], indexes: [] });
      assertEquals(await insertTwice(pool), 2);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: dropping exclusive heals a database that has the legacy unique names",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await applySdl(pool, WITH_EXCLUSIVE);
      /*** What older Disc versions left behind: an inline UNIQUE constraint from CREATE TABLE and the
           add-constraint path's index, next to uk_. ***/
      await pool.query(`ALTER TABLE git_object ADD CONSTRAINT git_object_object_id_key UNIQUE (object_id)`);
      await pool.query(`CREATE UNIQUE INDEX idx_git_object_object_id_unique ON git_object (object_id)`);

      await applySdl(pool, WITHOUT_EXCLUSIVE);

      assertEquals(await uniquesOnGitObject(pool), { constraints: [], indexes: [] });
      assertEquals(await insertTwice(pool), 2);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: re-adding exclusive after dropping it enforces uniqueness again",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);
      await applySdl(pool, WITHOUT_EXCLUSIVE);
      await applySdl(pool, WITH_EXCLUSIVE);

      assertEquals(await uniquesOnGitObject(pool), { constraints: [], indexes: ["uk_git_object_object_id"] });
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

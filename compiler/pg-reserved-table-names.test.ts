/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A type whose table name is a PostgreSQL reserved word (`User` → `user`,
 * `Order` → `order`) must round-trip through the compiler.
 *
 * Regression guard for `syntax error at or near "user"`: DDL quoted the
 * relation on CREATE (`CREATE TABLE "user"`) but `compiler/codegen.ts`
 * carried its own 35-word keyword list that omitted `user`, so every
 * compiled statement emitted a bare `INSERT INTO user` / `FROM user`.
 * Both sides now share `RESERVED_PG_KEYWORDS` in `lib/identifiers.ts`.
 *
 * The unit test runs everywhere; the round-trip needs PostgreSQL —
 * set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  canRunPgTests,
  getTestDsn,
  makePool
} from "../tests/pg-test-harness.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type User {
    required email -> str;
    required name -> str;
  }
  type Order {
    required label -> str;
    required user -> User;
  }
}`;

const TABLES = ["order", "user"];

async function dropAll(pool: { query: (sql: string) => Promise<unknown>; }) {
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

// Compiled `select X { ... }` returns one jsonb column per row.
function unwrap(row: Record<string, unknown>): Record<string, unknown> {
  return (row.jsonb_build_object ?? row) as Record<string, unknown>;
}

Deno.test("reserved table names are quoted in compiled SQL", () => {
  const schema = {
    functions: new Map(),
    types: new Map([[
      "User",
      {
        kind: "object" as const,
        links: new Map(),
        name: "User",
        properties: new Map([
          ["id", { columnName: "id", multi: false, name: "id", required: true, type: "uuid" }],
          ["email", { columnName: "email", multi: false, name: "email", required: true, type: "str" }]
        ]),
        tableName: "user"
      }
    ]])
  };

  assertStringIncludes(
    compileEdgeQL("select User { email }", schema),
    "\"user\""
  );
  assertStringIncludes(
    compileEdgeQL("insert User { email := \"a@b.c\" }", schema),
    "INSERT INTO \"user\""
  );
  assertStringIncludes(
    compileEdgeQL("update User filter .email = \"a@b.c\" set { email := \"d@e.f\" }", schema),
    "UPDATE \"user\""
  );
  assertStringIncludes(
    compileEdgeQL("delete User filter .email = \"a@b.c\"", schema),
    "DELETE FROM \"user\""
  );
});

Deno.test({
  name: "PG reserved table names: insert/select/update/delete round-trip on User",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();

    try {
      await dropAll(pool);
      const manager = new SchemaManager({ pool });
      await manager.initialize();

      const applied = await manager.applySchema(SDL);
      assertEquals(
        applied.ok,
        true,
        `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`
      );
      const schema = manager.getSchema();
      assert(schema, "schema unavailable after applySchema");

      const insertSql = compileEdgeQL(
        "insert User { email := \"ada@example.com\", name := \"Ada\" }",
        schema
      );
      await pool.query(insertSql);

      const selectRows = await pool.query(
        compileEdgeQL(
          "select User { email, name } filter .email = \"ada@example.com\"",
          schema
        )
      );
      assertEquals(selectRows.rows.length, 1);
      assertEquals(unwrap(selectRows.rows[0]).name, "Ada");

      await pool.query(
        compileEdgeQL(
          "update User filter .email = \"ada@example.com\" set { name := \"Ada L\" }",
          schema
        )
      );
      const afterUpdate = await pool.query(
        compileEdgeQL(
          "select User { name } filter .email = \"ada@example.com\"",
          schema
        )
      );
      assertEquals(unwrap(afterUpdate.rows[0]).name, "Ada L");

      await pool.query(
        compileEdgeQL("delete User filter .email = \"ada@example.com\"", schema)
      );
      const afterDelete = await pool.query(
        compileEdgeQL("select User { name }", schema)
      );
      assertEquals(afterDelete.rows.length, 0);

      await dropAll(pool);
    } finally {
      await pool.close();
    }
  }
});

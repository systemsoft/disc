/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: a `with` binding bound to a bare object type is the set of
 * its objects.
 *
 * `with u := User select u { name }` compiled to `WITH u AS (SELECT *)`,
 * which PostgreSQL rejects ("SELECT * with no tables specified is not
 * valid"); a binding selected from it (`v := (select u filter …)`) lost the
 * type, so `v { name }` could not project its shape, and `count(u)` compared
 * a multi-row scalar subquery. Each case runs the compiled SQL and reads the
 * rows back.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type BindingPerson {
    required name -> str;
    rank -> int64;
  }
}`;

const TABLES = ["binding_person"];

async function withSchema(run: (pool: ConnectionPool, schema: Schema) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();
  try {
    await dropAll(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    if (!schema) {
      throw new Error("no schema after applySchema");
    }
    await pool.query(
      `INSERT INTO binding_person (id, name, rank) VALUES
        (gen_random_uuid(), 'ada', 1), (gen_random_uuid(), 'bob', 2), (gen_random_uuid(), 'cy', 3)`
    );
    await run(pool, schema);
    await manager.close();
  } finally {
    await dropAll(pool);
    await pool.close();
  }
}

async function dropAll(pool: ConnectionPool): Promise<void> {
  for (const table of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/*** The single column of each row, in row order. ***/
async function values(pool: ConnectionPool, schema: Schema, edgeql: string, params: unknown[] = []): Promise<unknown[]> {
  const result = await pool.query(compileEdgeQL(edgeql, schema), params);
  return result.rows.map(row => {
    const columns = Object.values(row);
    assertEquals(columns.length, 1, `expected one column per row for ${edgeql}: ${Object.keys(row).join(", ")}`);
    const value = columns[0];
    return typeof value === "bigint" ? Number(value) : value;
  });
}

Deno.test({
  name: "PG with type binding: a shape over the binding answers every object, like selecting the type",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const expected = await values(pool, schema, "select BindingPerson { name } order by .name");
      assertEquals(expected, [{ name: "ada" }, { name: "bob" }, { name: "cy" }]);
      assertEquals(await values(pool, schema, "with u := BindingPerson select u { name } order by .name"), expected);
      assertEquals(await values(pool, schema, "with u := default::BindingPerson select u { name } order by .name"), expected);
      assertEquals(
        await values(pool, schema, "with u := BindingPerson select u { name } order by .rank desc limit 1"),
        [{ name: "cy" }]
      );
      assertEquals(await values(pool, schema, "with u := BindingPerson, v := u select v { name } order by .name"), expected);
      // A binding's own order by / limit / offset pick its objects.
      assertEquals(
        await values(pool, schema, "with u := (select BindingPerson order by .rank desc limit 1) select u { name }"),
        [{ name: "cy" }]
      );
      assertEquals(
        await values(pool, schema, "with u := BindingPerson, v := (select u order by .rank offset 1 limit 1) select v { name }"),
        [{ name: "bob" }]
      );
    })
});

Deno.test({
  name: "PG with type binding: a binding filtered from the type binding keeps its shape",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(
        await values(pool, schema, "with u := BindingPerson, v := (select u filter .name = <str>$n) select v { name }", ["bob"]),
        [{ name: "bob" }]
      );
      assertEquals(
        await values(pool, schema, "with u := (select BindingPerson), v := (select u filter .rank > 1) select v { name, rank } order by .rank"),
        [{ name: "bob", rank: 2 }, { name: "cy", rank: 3 }]
      );
    })
});

Deno.test({
  name: "PG with type binding: filter, implicit shape and count over the binding",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const [row] = await values(pool, schema, "with u := BindingPerson select u filter .name = 'ada'") as Record<string, unknown>[];
      assertEquals(row.name, "ada");
      assertEquals(row.rank, 1);
      assertEquals(await values(pool, schema, "with u := BindingPerson select count(u)"), [3]);
      assertEquals(await values(pool, schema, "with u := (select BindingPerson filter .rank > 1) select count(u)"), [2]);
      assertEquals(await values(pool, schema, "with u := BindingPerson, v := (select u filter .rank > 2) select count(v)"), [1]);
      assertEquals(await values(pool, schema, "with u := (select BindingPerson filter .rank > 5) select exists u"), [false]);
      assertEquals(await values(pool, schema, "with u := BindingPerson select exists u"), [true]);
    })
});

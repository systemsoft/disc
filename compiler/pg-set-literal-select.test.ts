/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: a selected set literal is a set of rows, one per element.
 *
 * `select {1, 2, 3}` compiled to `SELECT (1, 2, 3)` — one row holding a
 * record — so `select {<uuid>$a, <uuid>$b}` answered one value, `select {}`
 * answered a NULL row and `count({1, 2, 3})` was 1. Only the rows PostgreSQL
 * returns show it, so each case runs the compiled SQL and reads them back.
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
  type SetLiteralItem {
    label -> str;
    rank -> int64;
  }
}`;

const TABLES = ["set_literal_item"];
const UUID_A = "01234567-89ab-7cde-8f01-00000000000a";
const UUID_B = "01234567-89ab-7cde-8f01-00000000000b";

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
      `INSERT INTO set_literal_item (id, label, rank) VALUES
        (gen_random_uuid(), 'a', 1), (gen_random_uuid(), 'b', 2), (gen_random_uuid(), 'c', 3)`
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
  name: "PG set literal: select of scalar elements is one row per element, in order, duplicates kept",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select {1, 2, 3}"), [1, 2, 3]);
      assertEquals(await values(pool, schema, "select {3, 1, 2}"), [3, 1, 2]);
      assertEquals(await values(pool, schema, "select {1, 1}"), [1, 1]);
      assertEquals(await values(pool, schema, "select {'x', 'y'}"), ["x", "y"]);
      assertEquals(await values(pool, schema, "select {7}"), [7]);
      assertEquals(await values(pool, schema, "select {}"), []);
      assertEquals(await values(pool, schema, "select {1, {2, 3}, {}}"), [1, 2, 3]);
      // Mixed numeric elements share one column type.
      assertEquals((await values(pool, schema, "select {1, 2.5}")).map(Number), [1, 2.5]);
    })
});

Deno.test({
  name: "PG set literal: select of parameters answers each parameter",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select {<str>$a, <str>$b}", ["x", "y"]), ["x", "y"]);
      assertEquals(await values(pool, schema, "select {<uuid>$a, <uuid>$b}", [UUID_A, UUID_B]), [UUID_A, UUID_B]);
    })
});

Deno.test({
  name: "PG set literal: limit, offset and distinct apply to the whole set",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select {1, 2, 3} limit 2"), [1, 2]);
      assertEquals(await values(pool, schema, "select {1, 2, 3} offset 1"), [2, 3]);
      const distinct = (await values(pool, schema, "select distinct {2, 1, 2}")) as number[];
      assertEquals(distinct.sort(), [1, 2]);
    })
});

Deno.test({
  name: "PG set literal: elements that are object queries contribute all of their rows",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const rows = await values(
        pool,
        schema,
        `select {
          (select SetLiteralItem { label } filter .rank > 1 order by .rank),
          (select SetLiteralItem { label } filter .rank = 1),
          (select SetLiteralItem { label } order by .rank desc limit 1)
        }`
      );
      assertEquals(rows, [{ label: "b" }, { label: "c" }, { label: "a" }, { label: "c" }]);
    })
});

Deno.test({
  name: "PG set literal: aggregates, with-bindings, for and in over set literals",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select count({1, 2, 2})"), [3]);
      assertEquals(await values(pool, schema, "select count({})"), [0]);
      assertEquals((await values(pool, schema, "select sum({1, 2, 3})")).map(Number), [6]);
      assertEquals(await values(pool, schema, "with xs := {1, 2} select xs"), [1, 2]);
      assertEquals(await values(pool, schema, "for x in {1, {2, 3}} union (select x)"), [1, 2, 3]);
      const labels = await values(pool, schema, "select SetLiteralItem { label } filter .label in {'a', {'c'}} order by .label");
      assertEquals(labels, [{ label: "a" }, { label: "c" }]);
    })
});

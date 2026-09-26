/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `/`, `//` and `%` answer Gel's values, not PostgreSQL's.
 *
 * `select 7 / 2` answered 3 (PG integer division), `select 7 // 2` was a
 * syntax error (PG has no `//`) and `select -7 % 2` answered -1 (PG's `%`
 * takes the sign of the dividend). Gel answers 3.5, 3 and 1. Only the values
 * PostgreSQL returns show it, so each case runs the compiled SQL.
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
  type DivisionItem {
    count -> int64;
    label -> str;
    price -> decimal;
    ratio -> float64;
    small -> int32;
  }
}`;

const TABLES = ["division_item"];

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
      `INSERT INTO division_item (id, label, count, small, ratio, price) VALUES
        (gen_random_uuid(), 'a', 7, -7, 7.5, 7),
        (gen_random_uuid(), 'b', 2, 2, 2, 2)`
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

/*** The single column of the single row, with bigint and numeric strings read as numbers. ***/
async function value(pool: ConnectionPool, schema: Schema, edgeql: string, params: unknown[] = []): Promise<unknown> {
  const rows = await values(pool, schema, edgeql, params);
  assertEquals(rows.length, 1, `expected one row for ${edgeql}`);
  return rows[0];
}

async function values(pool: ConnectionPool, schema: Schema, edgeql: string, params: unknown[] = []): Promise<unknown[]> {
  const result = await pool.query(compileEdgeQL(edgeql, schema), params);
  return result.rows.map(row => {
    const columns = Object.values(row);
    assertEquals(columns.length, 1, `expected one column per row for ${edgeql}`);
    const column = columns[0];
    return typeof column === "bigint" || typeof column === "string" ? Number(column) : column;
  });
}

Deno.test({
  name: "PG division: int / int is a float64 division",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await value(pool, schema, "select 7 / 2"), 3.5);
      assertEquals(await value(pool, schema, "select -7 / 2"), -3.5);
      assertEquals(await value(pool, schema, "select 1 / 3"), 1 / 3);
      assertEquals(await value(pool, schema, "select <int32>7 / <int16>2"), 3.5);
      assertEquals(await value(pool, schema, "select <int64>$a / <int64>$b", [7, 2]), 3.5);
      assertEquals(await value(pool, schema, "select (7 + 1) / 3 * 3"), 8);
    })
});

Deno.test({
  name: "PG division: float operands divide as floats, decimal and bigint as decimals",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await value(pool, schema, "select 7.0 / 2"), 3.5);
      assertEquals(await value(pool, schema, "select 7.5 / 2"), 3.75);
      assertEquals(await value(pool, schema, "select <float64>7 / <float64>2"), 3.5);
      assertEquals(await value(pool, schema, "select <decimal>7 / <decimal>2"), 3.5);
      assertEquals(await value(pool, schema, "select <decimal>1 / <decimal>3"), 0.3333333333333333);
      assertEquals(await value(pool, schema, "select <bigint>7 / <bigint>2"), 3.5);
      assertEquals(await value(pool, schema, "select <decimal>7 / 2"), 3.5);
    })
});

Deno.test({
  name: "PG division: int properties divide as floats in a shape, a filter and order by",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(
        await values(pool, schema, "select DivisionItem { label, half := .count / 2, third := .small / 3 } order by .label"),
        [{ half: 3.5, label: "a", third: -7 / 3 }, { half: 1, label: "b", third: 2 / 3 }]
      );
      // 7 / 2 = 3.5 passes `> 3`; integer division (3) would not.
      assertEquals(await values(pool, schema, "select DivisionItem { label } filter .count / 2 > 3"), [{ label: "a" }]);
      assertEquals(await values(pool, schema, "select DivisionItem { label } filter .ratio / 2 = 3.75"), [{ label: "a" }]);
      assertEquals(
        await values(pool, schema, "select DivisionItem { label, p := .price / 2 } filter .label = 'a'"),
        [{ label: "a", p: 3.5 }]
      );
    })
});

Deno.test({
  name: "PG floor division rounds toward negative infinity",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await value(pool, schema, "select 7 // 2"), 3);
      assertEquals(await value(pool, schema, "select -7 // 2"), -4);
      assertEquals(await value(pool, schema, "select 7 // -2"), -4);
      assertEquals(await value(pool, schema, "select -10 // 4"), -3);
      assertEquals(await value(pool, schema, "select 3.7 // 1.1"), 3);
      assertEquals(await value(pool, schema, "select -7.5 // 2"), -4);
      assertEquals(await value(pool, schema, "select <decimal>(-7) // <decimal>2"), -4);
      assertEquals(await value(pool, schema, "select <bigint>(-7) // <bigint>2"), -4);
      assertEquals(
        await values(pool, schema, "select DivisionItem { label, h := .small // 2 } order by .label"),
        [{ h: -4, label: "a" }, { h: 1, label: "b" }]
      );
    })
});

Deno.test({
  name: "PG modulo takes the sign of the divisor",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await value(pool, schema, "select 10 % 4"), 2);
      assertEquals(await value(pool, schema, "select -10 % 4"), 2);
      assertEquals(await value(pool, schema, "select -7 % 2"), 1);
      assertEquals(await value(pool, schema, "select 7 % -2"), -1);
      assertEquals(await value(pool, schema, "select 7.5 % 2"), 1.5);
      assertEquals(await value(pool, schema, "select -7.5 % 2"), 0.5);
      assertEquals(await value(pool, schema, "select <decimal>(-7) % <decimal>2"), 1);
      assertEquals(await value(pool, schema, "select <bigint>(-7) % <bigint>2"), 1);
      assertEquals(
        await values(pool, schema, "select DivisionItem { label } filter .small % 2 = 1"),
        [{ label: "a" }]
      );
    })
});

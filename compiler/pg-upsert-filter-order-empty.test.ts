/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end for three bugs that compiled to SQL that ran without error
 * but did the wrong thing (or did not run), so only real rows show them:
 *
 *   - `unless conflict … else (update … filter …)` ignored the filter and
 *     updated the conflicting row anyway;
 *   - a path read in that else-update (`set { runs := .runs + 1 }`) was an
 *     unqualified column, ambiguous between the row and `excluded`;
 *   - `order by … empty first|last` was dropped, leaving PG's default NULL
 *     placement;
 *   - a set literal of parameters (`.id in {<uuid>$a, <uuid>$b}`) compiled to
 *     `IN (?, ?)`.
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
  type UpsertProgram {
    required name -> str;
  }
  type UpsertMaint {
    required program -> UpsertProgram;
    gc_owed_since -> datetime;
    runs -> int64;
    constraint exclusive on (.program);
  }
  type EmptyOrderItem {
    label -> str;
    rank -> int64;
  }
  type EmptyOrderList {
    multi items -> EmptyOrderItem;
  }
}`;

const TABLES = ["upsert_maint", "upsert_program", "empty_order_list_items", "empty_order_list", "empty_order_item"];
const PROGRAM_ID = "01234567-89ab-7cde-8f01-23456789abcd";
const OLD_TIMESTAMP = "2020-01-01T00:00:00Z";

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

async function seedProgram(pool: ConnectionPool): Promise<void> {
  await pool.query(`INSERT INTO upsert_program (id, name) VALUES ('${PROGRAM_ID}', 'p1')`);
}

Deno.test({
  name: "PG upsert: else-update filter excludes the conflicting row (set only if empty)",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await seedProgram(pool);
      const upsert = compileEdgeQL(
        `insert UpsertMaint { program := <UpsertProgram><uuid>$p, gc_owed_since := datetime_current() }
         unless conflict on (.program)
         else (update UpsertMaint filter not exists .gc_owed_since set { gc_owed_since := datetime_current() })`,
        schema
      );

      // No row yet: the insert happens.
      assertEquals((await pool.query(upsert, [PROGRAM_ID])).rowCount, 1, "first run inserts");

      // The row's timestamp is set, so the filter excludes it: no update.
      await pool.query(`UPDATE upsert_maint SET gc_owed_since = '${OLD_TIMESTAMP}'`);
      assertEquals((await pool.query(upsert, [PROGRAM_ID])).rowCount, 0, "filtered-out conflict returns no row");
      const kept = await pool.query("SELECT gc_owed_since FROM upsert_maint");
      assertEquals(kept.rowCount, 1);
      assertEquals((kept.rows[0].gc_owed_since as Date).toISOString(), "2020-01-01T00:00:00.000Z");

      // Once it is empty again, the filter admits it and the update runs.
      await pool.query("UPDATE upsert_maint SET gc_owed_since = NULL");
      assertEquals((await pool.query(upsert, [PROGRAM_ID])).rowCount, 1, "admitted conflict is updated");
      const updated = await pool.query("SELECT gc_owed_since FROM upsert_maint");
      assertEquals(updated.rows[0].gc_owed_since instanceof Date, true, "gc_owed_since set by the update");
    })
});

Deno.test({
  name: "PG upsert: else-update reads the conflicting row's properties in set and filter",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await seedProgram(pool);
      const upsert = compileEdgeQL(
        `insert UpsertMaint { program := <UpsertProgram><uuid>$p, runs := 1 }
         unless conflict on .program
         else (update UpsertMaint filter .runs < 3 set { runs := .runs + 1 })`,
        schema
      );

      for (let i = 0; i < 4; i++) {
        await pool.query(upsert, [PROGRAM_ID]);
      }

      // insert → 1, conflicts → 2, 3, then `.runs < 3` stops further updates.
      const result = await pool.query("SELECT runs FROM upsert_maint");
      assertEquals(result.rowCount, 1);
      assertEquals(Number(result.rows[0].runs), 3);
    })
});

Deno.test({
  name: "PG order by: empty first / empty last place empty values for both directions and multi-key",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await pool.query(
        `INSERT INTO empty_order_item (id, label, rank) VALUES
          (gen_random_uuid(), 'b', 1),
          (gen_random_uuid(), NULL, 1),
          (gen_random_uuid(), 'a', 2),
          (gen_random_uuid(), NULL, 2)`
      );

      async function labels(orderBy: string): Promise<(string | null)[]> {
        const sql = compileEdgeQL(`select EmptyOrderItem { label, rank } order by ${orderBy}`, schema);
        const result = await pool.query(sql);
        return result.rows.map(row => {
          const data = (row.jsonb_build_object ?? row) as Record<string, unknown>;
          return `${data.rank}:${data.label}`;
        });
      }

      assertEquals(await labels(".label empty first then .rank"), ["1:null", "2:null", "2:a", "1:b"]);
      assertEquals(await labels(".label empty last then .rank"), ["2:a", "1:b", "1:null", "2:null"]);
      assertEquals(await labels(".label asc empty first then .rank"), ["1:null", "2:null", "2:a", "1:b"]);
      assertEquals(await labels(".label desc empty first then .rank"), ["1:null", "2:null", "1:b", "2:a"]);
      assertEquals(await labels(".label desc empty last then .rank"), ["1:b", "2:a", "1:null", "2:null"]);
      // Multi-key: the second key's empty placement applies within ties.
      assertEquals(await labels(".rank desc then .label empty first"), ["2:null", "2:a", "1:null", "1:b"]);
      assertEquals(await labels(".rank then .label desc empty last"), ["1:b", "1:null", "2:a", "2:null"]);
    })
});

Deno.test({
  name: "PG order by: without empty first/last, empty sorts first asc and last desc (Gel's default)",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await pool.query(
        `INSERT INTO empty_order_item (id, label, rank) VALUES
          ('01234567-89ab-7cde-8f01-000000000001', 'b', 1),
          ('01234567-89ab-7cde-8f01-000000000002', NULL, 2),
          ('01234567-89ab-7cde-8f01-000000000003', 'a', 3)`
      );
      await pool.query("INSERT INTO empty_order_list (id) VALUES ('01234567-89ab-7cde-8f01-0000000000f0')");
      await pool.query(
        `INSERT INTO empty_order_list_items (source_id, target_id)
         SELECT '01234567-89ab-7cde-8f01-0000000000f0', id FROM empty_order_item`
      );

      async function rows(edgeql: string): Promise<Record<string, unknown>[]> {
        const result = await pool.query(compileEdgeQL(edgeql, schema));
        return result.rows.map(row => (row.jsonb_build_object ?? row) as Record<string, unknown>);
      }

      // Top-level select, both directions and a later key.
      const asc = await rows("select EmptyOrderItem { label } order by .label");
      assertEquals(asc.map(row => row.label), [null, "a", "b"]);
      const desc = await rows("select EmptyOrderItem { label } order by .label desc");
      assertEquals(desc.map(row => row.label), ["b", "a", null]);
      const later = await rows("select EmptyOrderItem { label } order by .rank * 0 then .label");
      assertEquals(later.map(row => row.label), [null, "a", "b"]);

      // Link sub-shape ordering inside jsonb_agg.
      const list = await rows("select EmptyOrderList { items: { label } order by .label desc }");
      assertEquals((list[0].items as { label: string | null; }[]).map(item => item.label), ["b", "a", null]);
      const listAsc = await rows("select EmptyOrderList { items: { label } order by .label }");
      assertEquals((listAsc[0].items as { label: string | null; }[]).map(item => item.label), [null, "a", "b"]);

      // Window `over (order by …)`.
      const ranked = await rows("select EmptyOrderItem { label, n := row_number() over (order by .label) } order by .rank");
      assertEquals(ranked.map(row => [row.label, Number(row.n)]), [["b", 3], [null, 1], ["a", 2]]);
    })
});

Deno.test({
  name: "PG filter: .id in a set literal of uuid parameters",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const ids = [
        "01234567-89ab-7cde-8f01-000000000001",
        "01234567-89ab-7cde-8f01-000000000002",
        "01234567-89ab-7cde-8f01-000000000003"
      ];
      await pool.query(
        `INSERT INTO empty_order_item (id, label, rank) VALUES
          ('${ids[0]}', 'a', 1), ('${ids[1]}', 'b', 2), ('${ids[2]}', 'c', 3)`
      );
      const sql = compileEdgeQL(
        "select EmptyOrderItem { label } filter .id in {<uuid>$a, <uuid>$b} order by .label",
        schema
      );
      const result = await pool.query(sql, [ids[0], ids[2]]);
      const got = result.rows.map(row => ((row.jsonb_build_object ?? row) as Record<string, unknown>).label);
      assertEquals(got, ["a", "c"]);
    })
});

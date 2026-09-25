/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end for three shapes a downstream project hit:
 *
 * - `filter exists .prop` — used to emit `WHERE EXISTSgit_ref_1.peeled`
 *   (`missing FROM-clause entry`); now `IS NOT NULL` / `IS NULL`.
 * - `count(X filter …)` / `count((select X filter …))` with several matching
 *   rows — used to be a parse error / a scalar subquery inside `COUNT()` that
 *   fails with "more than one row returned by a subquery".
 * - `<optional str>$x` bound as null — used to be a parse error.
 * - `?=` / `?!=` / `??` — used to reach PG verbatim (`operator does not
 *   exist: text ?= text`); now IS [NOT] DISTINCT FROM / COALESCE.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type ExTag {
    required label -> str;
  }
  type ExRef {
    required name -> str;
    peeled -> str;
    size -> int64;
    multi tags -> ExTag;
  }
}`;

const TABLES = ["ex_ref_tags", "ex_ref", "ex_tag"];
const TAG_ID = "01234567-89ab-7cde-8f01-23456789abc1";
const REF_A = "01234567-89ab-7cde-8f01-23456789abc2";

async function dropAll(pool: { query: (sql: string) => Promise<unknown>; }) {
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

// Compiled `select X { ... }` returns one jsonb column per row.
function unwrap(row: Record<string, unknown>): Record<string, unknown> {
  return (row.jsonb_build_object ?? row) as Record<string, unknown>;
}

// A single scalar `select` returns one row with one column; read it whatever its name.
function scalar(rows: Record<string, unknown>[]): unknown {
  assertEquals(rows.length, 1);
  return Object.values(rows[0])[0];
}

Deno.test({
  name: "PG exists / count over a filtered set / optional param",
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
      assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`);
      const schema = manager.getSchema();
      if (!schema)
        throw new Error("no schema after applySchema");

      // Three refs named "head" (two peeled, one not) and one named "tag";
      // only ref A carries a tag.
      await pool.query(`INSERT INTO ex_tag (id, label) VALUES ('${TAG_ID}', 't')`);
      await pool.query(
        `INSERT INTO ex_ref (id, name, peeled, size)
         VALUES ('${REF_A}', 'head', 'abc', 1),
                (gen_random_uuid(), 'head', 'def', 2),
                (gen_random_uuid(), 'head', NULL, 4),
                (gen_random_uuid(), 'tag', NULL, 8)`
      );
      await pool.query(`INSERT INTO ex_ref_tags (source_id, target_id) VALUES ('${REF_A}', '${TAG_ID}')`);

      const rows = async (edgeql: string, params: unknown[] = []) =>
        (await pool.query(compileEdgeQL(edgeql, schema), params)).rows as Record<string, unknown>[];

      // exists on a property.
      assertEquals((await rows("select ExRef { id } filter exists .peeled")).length, 2, "exists .peeled");
      assertEquals((await rows("select ExRef { id } filter not exists .peeled")).length, 2, "not exists .peeled");

      // exists on a multi link.
      const tagged = await rows("select ExRef { id } filter exists .tags");
      assertEquals(tagged.map(r => unwrap(r).id), [REF_A], "exists .tags");

      // count over a filtered set with several matching rows.
      assertEquals(Number(scalar(await rows("select count(ExRef filter .name = 'head')"))), 3, "count(X filter …)");
      assertEquals(Number(scalar(await rows("select count((select ExRef filter .name = 'head'))"))), 3, "count((select …))");
      assertEquals(Number(scalar(await rows("select count(ExRef filter .name = 'none')"))), 0, "count over empty set");
      assertEquals(Number(scalar(await rows("select sum((select ExRef.size filter .name = 'head'))"))), 7, "sum over subquery");
      assertEquals(scalar(await rows("select exists (select ExRef filter .name = 'head')")), true, "exists (select …)");

      // An optional parameter passed as null, compared with the coalescing
      // operators: `?=` treats two empty sets as equal, so a null $p matches
      // the rows whose `peeled` is unset (IS NOT DISTINCT FROM).
      const eq = "select ExRef { name } filter .peeled ?= <optional str>$p";
      assertEquals((await rows(eq, [null])).length, 2, "?= null matches the unset rows");
      assertEquals((await rows(eq, ["abc"])).length, 1, "?= 'abc' matches one row");
      const neq = "select ExRef { name } filter .peeled ?!= <optional str>$p";
      assertEquals((await rows(neq, [null])).length, 2, "?!= null matches the set rows");
      assertEquals((await rows(neq, ["abc"])).length, 3, "?!= 'abc' includes the unset rows");
      assertEquals(scalar(await rows("select <optional str>$p", [null])), null, "optional param as SQL NULL");

      // `??` falls back to its right side when the left is empty.
      const nicks = await rows(`select ExRef { n := .peeled ?? "anon" } order by .size`);
      assertEquals(nicks.map(r => unwrap(r).n), ["abc", "def", "anon", "anon"], "?? in a computed shape");
      assertEquals(scalar(await rows(`select <optional str>$p ?? "anon"`, [null])), "anon", "?? on a null param");
      assertEquals(scalar(await rows(`select <optional str>$p ?? "anon"`, ["x"])), "x", "?? on a set param");

      await manager.close();
    } finally {
      await dropAll(pool);
      await pool.close();
    }
  }
});

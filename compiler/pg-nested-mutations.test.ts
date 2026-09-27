/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: mutations nested in other mutations run as one statement.
 *
 * An insert in a link assignment (`item := (insert NmItem { … })`, a set of
 * them for a multi link) inserts one object per object the outer statement
 * writes — per inserted object, per updated object, per `for` iteration —
 * and links it; an upsert's branches insert theirs only when that branch
 * runs. Several data-modifying statements in one query (two multi-link
 * updates, a mutation under a select in a `with` binding, a `for` over a set
 * literal of mutations) are lifted to the top-level WITH, as PostgreSQL
 * requires.
 *
 * Seed: item i1; order seed (no links).
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals, assertThrows } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type NmTag {
    required name: str;
  }
  type NmItem {
    required name: str;
    tag: NmTag;
    multi tags: NmTag;
  }
  type NmOrder {
    required label: str {
      constraint exclusive;
    };
    item: NmItem;
    multi items: NmItem;
  }
}`;

const TABLES = ["nm_order_items", "nm_item_tags", "nm_order", "nm_item", "nm_tag"];

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
    await pool.query("INSERT INTO nm_item (name) VALUES ('i1')");
    await pool.query("INSERT INTO nm_order (label) VALUES ('seed')");
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

async function run(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<Record<string, unknown>[]> {
  return (await pool.query(compileEdgeQL(edgeql, schema))).rows as Record<string, unknown>[];
}

/*** The first column of each row, sorted (independent of the database's collation). ***/
async function column(pool: ConnectionPool, sql: string): Promise<unknown[]> {
  return (await pool.query(sql)).rows.map(row => Object.values(row)[0]).sort();
}

/*** `label:item` for each order, `label:-` without an item. ***/
function orderItems(pool: ConnectionPool): Promise<unknown[]> {
  return column(pool, "SELECT o.label || ':' || COALESCE(i.name, '-') FROM nm_order o LEFT JOIN nm_item i ON i.id = o.item_id");
}

/*** `label:item` for each junction row of `items`. ***/
function orderLinks(pool: ConnectionPool): Promise<unknown[]> {
  return column(
    pool,
    "SELECT o.label || ':' || i.name FROM nm_order_items j JOIN nm_order o ON o.id = j.source_id JOIN nm_item i ON i.id = j.target_id"
  );
}

function itemNames(pool: ConnectionPool): Promise<unknown[]> {
  return column(pool, "SELECT name FROM nm_item");
}

Deno.test({
  name: "PG nested mutations: an insert in a single link assignment of an insert",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const rows = await run(pool, schema, "insert NmOrder { label := 'o1', item := (insert NmItem { name := 'x' }) }");
      assertEquals(rows.length, 1);
      assertEquals(rows[0].label, "o1");
      assertEquals(await column(pool, "SELECT id::text FROM nm_item WHERE name = 'x'"), [String(rows[0].item_id)]);
      assertEquals(await orderItems(pool), ["o1:x", "seed:-"]);

      // Nested two deep: the item's tag is inserted too.
      await run(pool, schema, "insert NmOrder { label := 'o2', item := (insert NmItem { name := 'y', tag := (insert NmTag { name := 't' }) }) }");
      assertEquals(await column(pool, "SELECT i.name || ':' || t.name FROM nm_item i JOIN nm_tag t ON t.id = i.tag_id"), ["y:t"]);
      assertEquals(await orderItems(pool), ["o1:x", "o2:y", "seed:-"]);
    })
});

Deno.test({
  name: "PG nested mutations: inserts in a multi link assignment of an insert",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "insert NmOrder { label := 'o2', items := {(insert NmItem { name := 'a' }), (insert NmItem { name := 'b' })} }");
      assertEquals(await orderLinks(pool), ["o2:a", "o2:b"]);

      // Mixed with selected targets, and a nested insert that links a multi link of its own.
      await run(
        pool,
        schema,
        "insert NmOrder { label := 'o3', items := {(select NmItem filter .name = 'i1'), (insert NmItem { name := 'c', tags := (insert NmTag { name := 't' }) })} }"
      );
      assertEquals(await orderLinks(pool), ["o2:a", "o2:b", "o3:c", "o3:i1"]);
      assertEquals(
        await column(pool, "SELECT i.name || ':' || t.name FROM nm_item_tags j JOIN nm_item i ON i.id = j.source_id JOIN nm_tag t ON t.id = j.target_id"),
        [
          "c:t"
        ]
      );
      assertEquals(await itemNames(pool), ["a", "b", "c", "i1"]);
    })
});

Deno.test({
  name: "PG nested mutations: an insert in a single link assignment of an update runs per updated object",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const rows = await run(pool, schema, "update NmOrder filter .label = 'seed' set { item := (insert NmItem { name := 'u' }) }");
      assertEquals(rows.length, 1);
      assertEquals(await orderItems(pool), ["seed:u"]);

      // No object updated: nothing inserted.
      await run(pool, schema, "update NmOrder filter .label = 'none' set { item := (insert NmItem { name := 'nobody' }) }");
      assertEquals(await itemNames(pool), ["i1", "u"]);

      // Two objects updated: one new item each, named from the updated object.
      await pool.query("INSERT INTO nm_order (label) VALUES ('second')");
      await run(pool, schema, "update NmOrder set { item := (insert NmItem { name := 'for ' ++ .label }) }");
      assertEquals(await orderItems(pool), ["second:for second", "seed:for seed"]);
      assertEquals(await column(pool, "SELECT count(*)::int FROM nm_item"), [4]);
    })
});

Deno.test({
  name: "PG nested mutations: inserts in a multi link assignment of an update run per updated object",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "update NmOrder filter .label = 'seed' set { items += (insert NmItem { name := 'v' }) }");
      assertEquals(await orderLinks(pool), ["seed:v"]);

      // `:=` keeps only the new set: a new item and a selected one.
      await run(pool, schema, "update NmOrder filter .label = 'seed' set { items := {(insert NmItem { name := 'w' }), (select NmItem filter .name = 'i1')} }");
      assertEquals(await orderLinks(pool), ["seed:i1", "seed:w"]);

      // Alongside a property assignment, for two objects.
      await pool.query("INSERT INTO nm_order (label) VALUES ('second')");
      await run(pool, schema, "update NmOrder set { label := .label ++ '!', items += (insert NmItem { name := 'z' }) }");
      assertEquals(await orderLinks(pool), ["second!:z", "seed!:i1", "seed!:w", "seed!:z"]);
      assertEquals(await column(pool, "SELECT count(*)::int FROM nm_item WHERE name = 'z'"), [2]);
    })
});

Deno.test({
  name: "PG nested mutations: a nested insert of an update links its own multi link, per updated object",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await pool.query("INSERT INTO nm_tag (name) VALUES ('t0')");
      await pool.query("INSERT INTO nm_order (label) VALUES ('second')");
      await run(
        pool,
        schema,
        "update NmOrder set { item := (insert NmItem { name := .label, tags := {(select NmTag filter .name = 't0'), (insert NmTag { name := 'new' })} }) }"
      );
      assertEquals(await orderItems(pool), ["second:second", "seed:seed"]);
      // Each new item: t0, and a new tag of its own.
      assertEquals(
        await column(pool, "SELECT i.name || ':' || t.name FROM nm_item_tags j JOIN nm_item i ON i.id = j.source_id JOIN nm_tag t ON t.id = j.target_id"),
        ["second:new", "second:t0", "seed:new", "seed:t0"]
      );
      assertEquals(await column(pool, "SELECT count(*)::int FROM nm_tag WHERE name = 'new'"), [2]);
    })
});

Deno.test({
  name: "PG nested mutations: an insert nested in a for body runs per iteration",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "for n in {'p', 'q'} union (insert NmOrder { label := n, item := (insert NmItem { name := n }) })");
      await run(pool, schema, "for n in array_unpack(['r', 's']) union (insert NmOrder { label := n, item := (insert NmItem { name := n ++ '1' }) })");
      await run(
        pool,
        schema,
        "for o in (select NmOrder filter .label = 'seed') union (insert NmOrder { label := o.label ++ '-copy', item := (insert NmItem { name := o.label }) })"
      );
      await run(
        pool,
        schema,
        "for n in {'m'} union (insert NmOrder { label := n, items := {(insert NmItem { name := 'm1' }), (insert NmItem { name := 'm2' })} })"
      );
      assertEquals(await orderItems(pool), ["m:-", "p:p", "q:q", "r:r1", "s:s1", "seed-copy:seed", "seed:-"]);
      assertEquals(await orderLinks(pool), ["m:m1", "m:m2"]);
    })
});

Deno.test({
  name: "PG nested mutations: an upsert inserts the nested objects of the branch that runs",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const upsert = (label: string): string =>
        `insert NmOrder { label := '${label}', item := (insert NmItem { name := 'new ${label}' }) } unless conflict on .label ` +
        `else (update NmOrder set { item := (insert NmItem { name := 'else ${label}' }) })`;

      // Conflict: the else branch runs.
      await run(pool, schema, upsert("seed"));
      assertEquals(await orderItems(pool), ["seed:else seed"]);
      // No conflict: the insert branch runs.
      await run(pool, schema, upsert("fresh"));
      assertEquals(await orderItems(pool), ["fresh:new fresh", "seed:else seed"]);
      assertEquals(await itemNames(pool), ["else seed", "i1", "new fresh"]);

      // A conflict without else writes nothing, the nested insert included.
      await run(pool, schema, "insert NmOrder { label := 'seed', item := (insert NmItem { name := 'dropped' }) } unless conflict on .label");
      assertEquals(await itemNames(pool), ["else seed", "i1", "new fresh"]);
    })
});

Deno.test({
  name: "PG nested mutations: a nested insert under a with binding or a select returns the outer object",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const rows = await run(pool, schema, "with o := (insert NmOrder { label := 'w1', item := (insert NmItem { name := 'x' }) }) select o { label }");
      assertEquals(rows.map(row => Object.values(row)[0]), [{ label: "w1" }]);
      await run(pool, schema, "select (update NmOrder filter .label = 'seed' set { items += (insert NmItem { name := 'y' }) }) { label }");
      assertEquals(await orderItems(pool), ["seed:-", "w1:x"]);
      assertEquals(await orderLinks(pool), ["seed:y"]);
    })
});

Deno.test({
  name: "PG nested mutations: several multi-link writes in one statement",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await pool.query("INSERT INTO nm_order (label) VALUES ('second')");
      await run(
        pool,
        schema,
        "with a := (update NmOrder filter .label = 'seed' set { items += (select NmItem filter .name = 'i1') }), " +
          "b := (update NmOrder filter .label = 'second' set { items += (select NmItem filter .name = 'i1') }) select {a, b}"
      );
      assertEquals(await orderLinks(pool), ["second:i1", "seed:i1"]);

      const rows = await run(
        pool,
        schema,
        "with x := (select (update NmOrder filter .label = 'seed' set { items := (select NmItem filter .name = 'i1') }) { label }) select x"
      );
      assertEquals(rows.length, 1);

      await run(pool, schema, "for n in {'seed', 'second'} union (update NmOrder filter .label = n set { items -= (select NmItem filter .name = 'i1') })");
      assertEquals(await orderLinks(pool), []);

      await run(pool, schema, "for n in {'a', 'b'} union (insert NmOrder { label := n, items := (select NmItem filter .name = 'i1') })");
      assertEquals(await orderLinks(pool), ["a:i1", "b:i1"]);

      await run(pool, schema, "for n in {'a', 'b'} union (update NmOrder filter .label = n set { label := n ++ '!' })");
      assertEquals(await column(pool, "SELECT label FROM nm_order"), ["a!", "b!", "second", "seed"]);
    })
});

Deno.test({
  name: "PG nested mutations: unsupported nesting fails to compile instead of emitting invalid SQL",
  ignore: !RUN_PG,
  fn: () =>
    withSchema((_pool, schema) => {
      for (
        const edgeql of [
          // A nested upsert: on conflict there would be no object to link.
          "insert NmOrder { label := 'x', item := (insert NmItem { name := 'y' } unless conflict) }",
          // An update or delete as a link's value.
          "insert NmOrder { label := 'x', item := (update NmItem filter .name = 'i1' set { name := 'z' }) }",
          // A bulk insert's multi links, and a nested insert in its else branch.
          "for n in array_unpack(['a']) union (insert NmOrder { label := n, items := (insert NmItem { name := n }) })",
          "for n in array_unpack(['a']) union (insert NmOrder { label := n } unless conflict on .label else (update NmOrder set { item := (insert NmItem { name := n }) }))"
        ]
      ) {
        assertThrows(() => compileEdgeQL(edgeql, schema), Error, "Compilation failed");
      }
      return Promise.resolve();
    })
});

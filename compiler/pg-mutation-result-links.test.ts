/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: a shape over a mutation's result sees the links the
 * statement wrote.
 *
 * PostgreSQL runs every part of a statement on one snapshot, so a shape that
 * read the tables directly saw them as they were before the statement: a
 * link assigned by the insert came back empty, an object inserted in a link
 * assignment came back null. As in Gel, `select (insert …) { … }`,
 * `with o := (update …) select o { … }` and the like answer the objects as
 * the statement leaves them — links, link properties, backlinks and computed
 * properties over them included — with select policies still applied to
 * the targets.
 *
 * Seed: items i1, i2; order seed (items: i1).
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type MrTag {
    required name: str;
  }
  type MrItem {
    required name: str;
    tag: MrTag;
    multi tags: MrTag;
  }
  type MrOrder {
    required label: str {
      constraint exclusive;
    };
    item: MrItem;
    multi items: MrItem {
      rank: int64;
    };
    n_items := count(.items);
  }
  type MrSecret {
    required name: str;
    shown: bool;
    access policy writable {
      allow insert, update;
    };
    access policy visible {
      allow select;
      using (.shown ?= true);
    };
  }
  type MrBox {
    required label: str;
    secret: MrSecret;
    multi secrets: MrSecret;
  }
  abstract type MrThing {
    required name: str;
    multi tags: MrTag;
  }
  type MrGadget extending MrThing {}
}`;

const TABLES = [
  "mr_gadget_tags",
  "mr_thing_tags",
  "mr_gadget",
  "mr_thing",
  "mr_box_secrets",
  "mr_box",
  "mr_secret",
  "mr_order_items",
  "mr_item_tags",
  "mr_order",
  "mr_item",
  "mr_tag"
];

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
    await pool.query("INSERT INTO mr_item (name) VALUES ('i1'), ('i2')");
    await pool.query("INSERT INTO mr_order (label) VALUES ('seed')");
    await pool.query(
      "INSERT INTO mr_order_items (source_id, target_id) SELECT o.id, i.id FROM mr_order o, mr_item i WHERE o.label = 'seed' AND i.name = 'i1'"
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

/**
 * The objects `edgeql` answers, each with its arrays of objects sorted by
 * `name` or `label` (a link's targets come back in no particular order).
 */
async function shapes(pool: ConnectionPool, schema: Schema, edgeql: string, sql = compileEdgeQL(edgeql, schema)): Promise<unknown[]> {
  const rows = (await pool.query(sql)).rows as Record<string, unknown>[];
  return rows.map(row => sorted(Object.values(row)[0]));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    const key = (item: unknown): string => {
      const object = item as Record<string, unknown> | null;
      return String(object?.name ?? object?.label ?? JSON.stringify(item));
    };
    return value.map(sorted).sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sorted(item)]));
  }
  return value;
}

/*** `edgeql` compiled with access control on and every type's policies registered, as the server does. ***/
function compileWithPolicies(edgeql: string, schema: Schema): string {
  const compiler = new EdgeQLCompiler(schema, {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
    enableAccessControl: true
  });
  for (const typeDef of schema.types.values()) {
    for (const policy of typeDef.accessPolicies ?? []) {
      compiler.registerAccessPolicy(policy);
    }
  }
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw new Error(`Compilation failed for ${edgeql}: ${result.error.message}`);
  }
  return new SQLCodeGenerator().generate(result.value);
}

Deno.test({
  name: "PG mutation result links: an insert's multi link, single link and nested inserts",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(
        await shapes(
          pool,
          schema,
          "select (insert MrOrder { label := 'o1', items := (select MrItem filter .name in {'i1', 'i2'}) }) { label, items: { name } }"
        ),
        [{ items: [{ name: "i1" }, { name: "i2" }], label: "o1" }]
      );

      // A single link to an object inserted by the same statement, two levels deep.
      assertEquals(
        await shapes(
          pool,
          schema,
          "select (insert MrOrder { label := 'o2', item := (insert MrItem { name := 'x', tag := (insert MrTag { name := 't' }) }) }) " +
            "{ label, item: { name, tag: { name } } }"
        ),
        [{ item: [{ name: "x", tag: [{ name: "t" }] }], label: "o2" }]
      );

      // New targets of a multi link, with a multi link of their own.
      assertEquals(
        await shapes(
          pool,
          schema,
          "select (insert MrOrder { label := 'o3', items := {(select MrItem filter .name = 'i1'), " +
            "(insert MrItem { name := 'y', tags := {(insert MrTag { name := 'u' }), (insert MrTag { name := 'v' })} })} }) " +
            "{ items: { name, tags: { name } } }"
        ),
        [{ items: [{ name: "i1", tags: [] }, { name: "y", tags: [{ name: "u" }, { name: "v" }] }] }]
      );
    })
});

Deno.test({
  name: "PG mutation result links: a with binding, link properties, computed properties and backlinks",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(
        await shapes(
          pool,
          schema,
          "with o := (insert MrOrder { label := 'w1', items := {(select MrItem filter .name = 'i2') { @rank := 2 }, " +
            "(insert MrItem { name := 'z' }) { @rank := 1 }} }) select o { label, items: { name, @rank }, n_items }"
        ),
        [{ items: [{ "@rank": 2, name: "i2" }, { "@rank": 1, name: "z" }], label: "w1", n_items: 2 }]
      );

      // The new item links back to the new order.
      assertEquals(
        await shapes(
          pool,
          schema,
          "select (insert MrOrder { label := 'w2', item := (insert MrItem { name := 'b' }) }) " +
            "{ item: { name, orders := .<item[is MrOrder] { label } } }"
        ),
        [{ item: [{ name: "b", orders: [{ label: "w2" }] }] }]
      );

      // A select of the binding, and a path from it.
      assertEquals(
        await shapes(pool, schema, "with o := (insert MrOrder { label := 'w3', items := (insert MrItem { name := 'p' }) }) select o.items { name }"),
        [{ name: "p" }]
      );
      assertEquals(
        await shapes(
          pool,
          schema,
          "with o := (insert MrOrder { label := 'w4', items := (insert MrItem { name := 'q' }) }), v := (select o filter .label = 'w4') " +
            "select v { label, items: { name } }"
        ),
        [{ items: [{ name: "q" }], label: "w4" }]
      );
    })
});

Deno.test({
  name: "PG mutation result links: reads that don't start from the result see the database as before the statement",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // As in Gel: only what is reached through the mutation's result reflects its writes.
      assertEquals(
        await shapes(
          pool,
          schema,
          "with o := (insert MrOrder { label := 'v1', items := (insert MrItem { name := 'new' }) }) " +
            "select o { items: { name }, names := MrItem.name, selected := (select MrItem.name), " +
            "n_items := count((select MrItem filter .name != 'x')), is_new := not exists (select MrOrder filter .label = 'v1') }"
        ),
        [{ is_new: true, items: [{ name: "new" }], n_items: 2, names: ["i1", "i2"], selected: ["i1", "i2"] }]
      );

      // A type's links read from the type are those before the statement; the result's are those after.
      assertEquals(
        await shapes(
          pool,
          schema,
          "select (update MrOrder filter .label = 'seed' set { items += (select MrItem filter .name = 'i2') }) " +
            "{ items: { name }, before := (select MrOrder { items: { name } } filter .label = 'seed') }"
        ),
        [{ before: { items: [{ name: "i1" }] }, items: [{ name: "i1" }, { name: "i2" }] }]
      );

      // A path from the result inside a read of the type still reflects the writes.
      assertEquals(
        await shapes(
          pool,
          schema,
          "with o := (update MrOrder filter .label = 'seed' set { items += (select MrItem filter .name = 'i2') }) " +
            "select o { linked := count((select MrItem filter .id in (select o.items.id))) }"
        ),
        [{ linked: 2 }]
      );
    })
});

Deno.test({
  name: "PG mutation result links: an update's :=, += and -= of a multi link",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const update = (set: string): Promise<unknown[]> =>
        shapes(pool, schema, `select (update MrOrder filter .label = 'seed' set { ${set} }) { items: { name, @rank }, n_items }`);

      assertEquals(await update("items += (select MrItem filter .name = 'i2')"), [{
        items: [{ "@rank": null, name: "i1" }, { "@rank": null, name: "i2" }],
        n_items: 2
      }]);
      assertEquals(await update("items -= (select MrItem filter .name = 'i1')"), [{ items: [{ "@rank": null, name: "i2" }], n_items: 1 }]);
      assertEquals(await update("items := {(select MrItem filter .name = 'i1') { @rank := 5 }, (insert MrItem { name := 'n' })}"), [{
        items: [{ "@rank": 5, name: "i1" }, { "@rank": null, name: "n" }],
        n_items: 2
      }]);
      // A link property set on a link that stays.
      assertEquals(await update("items += (select MrItem filter .name = 'i1') { @rank := 6 }"), [{
        items: [{ "@rank": 6, name: "i1" }, { "@rank": null, name: "n" }],
        n_items: 2
      }]);
      // With a scalar assignment too, in a with binding.
      assertEquals(
        await shapes(
          pool,
          schema,
          "with o := (update MrOrder filter .label = 'seed' set { label := 'seed2', items := {} }) select o { label, items: { name } }"
        ),
        [{ items: [], label: "seed2" }]
      );
    })
});

Deno.test({
  name: "PG mutation result links: an update's single link to a new object, and an upsert's two branches",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(
        await shapes(pool, schema, "select (update MrOrder filter .label = 'seed' set { item := (insert MrItem { name := 'u1' }) }) { item: { name } }"),
        [{ item: [{ name: "u1" }] }]
      );

      const upsert = (label: string): Promise<unknown[]> =>
        shapes(
          pool,
          schema,
          `select (insert MrOrder { label := '${label}', item := (insert MrItem { name := 'inserted' }) } ` +
            "unless conflict on .label else (update MrOrder set { item := (insert MrItem { name := 'updated' }) })) { label, item: { name } }"
        );
      assertEquals(await upsert("fresh"), [{ item: [{ name: "inserted" }], label: "fresh" }]);
      assertEquals(await upsert("seed"), [{ item: [{ name: "updated" }], label: "seed" }]);
    })
});

Deno.test({
  name: "PG mutation result links: a for over a set literal of shaped inserts",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(
        await shapes(
          pool,
          schema,
          "for x in {'f1', 'f2'} union (select (insert MrOrder { label := x, items := (insert MrItem { name := x ++ '-item' }) }) { label, items: { name } })"
        ),
        [{ items: [{ name: "f1-item" }], label: "f1" }, { items: [{ name: "f2-item" }], label: "f2" }]
      );
    })
});

Deno.test({
  name: "PG mutation result links: select policies still hide targets the statement wrote",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const edgeql = "select (insert MrBox { label := 'bx', secret := (insert MrSecret { name := 'hidden', shown := false }), " +
        "secrets := {(insert MrSecret { name := 'shown', shown := true }), (insert MrSecret { name := 'hidden2', shown := false })} }) " +
        "{ label, secret: { name }, secrets: { name } }";
      const [box] = await shapes(pool, schema, edgeql, compileWithPolicies(edgeql, schema)) as Record<string, unknown>[];
      assertEquals(box.label, "bx");
      assertEquals(box.secrets, [{ name: "shown" }]);
      assertEquals(box.secret ?? [], []);

      // A read of the type sees the objects from before the statement its policy shows.
      await pool.query("INSERT INTO mr_secret (name, shown) VALUES ('old-shown', true), ('old-hidden', false)");
      const counted = "select (insert MrSecret { name := 'new-shown', shown := true }) { name, n_shown := count((select MrSecret)) }";
      assertEquals(await shapes(pool, schema, counted, compileWithPolicies(counted, schema)), [{ n_shown: 2, name: "new-shown" }]);
    })
});

Deno.test({
  name: "PG mutation result links: a multi link declared on an abstract type, and an update of the abstract type",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // Written to the subtype's junction; read through the abstract type's.
      assertEquals(
        await shapes(pool, schema, "select (insert MrGadget { name := 'g1', tags := (insert MrTag { name := 't1' }) }) { name, tags: { name } }"),
        [{ name: "g1", tags: [{ name: "t1" }] }]
      );
      assertEquals(
        await shapes(pool, schema, "select (update MrThing filter .name = 'g1' set { tags += (insert MrTag { name := 't2' }) }) { name, tags: { name } }"),
        [{ name: "g1", tags: [{ name: "t1" }, { name: "t2" }] }]
      );
    })
});

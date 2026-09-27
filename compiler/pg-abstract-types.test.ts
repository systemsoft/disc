/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: the objects of an abstract type are its concrete subtypes'.
 *
 * An abstract type's own table holds no objects of its own: every object
 * lives in a concrete subtype's table. A path through the abstract type, a
 * `for` over it, an update or delete of it, and a link whose target is
 * abstract must all reach the subtypes' rows — never answer from the
 * abstract table alone, which would be silently empty.
 *
 * Seed: people ann, bob; companies acme; tags red, blue.
 *   ann.tags = {red}, acme.tags = {red, blue}.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const ABSTRACT_SDL = `module default {
  type AbsTag {
    required label: str;
  }
  abstract type AbsNamed {
    required name: str;
    code: str {
      constraint exclusive;
    };
    multi tags: AbsTag;
  }
  type AbsPerson extending AbsNamed {
    age: int32;
  }
  type AbsCompany extending AbsNamed {
    city: str;
  }
  type AbsThing {
    required title: str;
    required owner: AbsNamed;
    multi fans: AbsNamed;
    sponsor: AbsNamed {
      on target delete allow;
    };
  }
}`;

const TABLES = [
  "abs_thing_fans",
  "abs_named_tags",
  "abs_person_tags",
  "abs_company_tags",
  "abs_thing",
  "abs_person",
  "abs_company",
  "abs_named",
  "abs_tag"
];

async function withAbstractSchema(run: (pool: ConnectionPool, schema: Schema) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();
  try {
    await dropAll(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(ABSTRACT_SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    if (!schema) {
      throw new Error("no schema after applySchema");
    }
    for (
      const edgeql of [
        `insert AbsTag { label := "red" }`,
        `insert AbsTag { label := "blue" }`,
        `insert AbsPerson { name := "ann", age := 30, tags := (select AbsTag filter .label = "red") }`,
        `insert AbsPerson { name := "bob", age := 40 }`,
        `insert AbsCompany { name := "acme", city := "Oslo", tags := (select AbsTag filter .label in {"red", "blue"}) }`
      ]
    ) {
      await pool.query(compileEdgeQL(edgeql, schema));
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

/*** The single column of each row, in row order (a shaped row is its object). ***/
async function values(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<unknown[]> {
  const result = await pool.query(compileEdgeQL(edgeql, schema));
  return result.rows.map(row => {
    const columns = Object.values(row);
    assertEquals(columns.length, 1, `expected one column per row for ${edgeql}: ${Object.keys(row).join(", ")}`);
    const value = columns[0];
    return typeof value === "bigint" ? Number(value) : value;
  });
}

async function sorted(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<unknown[]> {
  return (await values(pool, schema, edgeql)).map(value => JSON.stringify(value)).sort().map(value => JSON.parse(value));
}

/*** The rows a statement returns (a mutation's affected objects). ***/
async function rows(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<Record<string, unknown>[]> {
  return (await pool.query(compileEdgeQL(edgeql, schema))).rows as Record<string, unknown>[];
}

async function run(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<void> {
  await pool.query(compileEdgeQL(edgeql, schema));
}

// ---------------------------------------------------------------------------
// Bug 1: paths and `for` over an abstract type
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG abstract: a path rooted at an abstract type reads every concrete subtype",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      assertEquals(await sorted(pool, schema, "select AbsNamed.name"), ["acme", "ann", "bob"]);
      assertEquals(await sorted(pool, schema, "select AbsNamed { name } filter .name != 'bob'"), [{ name: "acme" }, { name: "ann" }]);
      assertEquals(await values(pool, schema, "select count(AbsNamed)"), [3]);
      // A multi link declared on the abstract type: each subtype keeps its own junction rows.
      assertEquals(await sorted(pool, schema, "select AbsNamed.tags.label"), ["blue", "red"]);
      assertEquals(await values(pool, schema, "select count(AbsNamed.tags)"), [2]);
    })
});

Deno.test({
  name: "PG abstract: a shape of an abstract type reads multi links declared on it",
  ignore: !RUN_PG,
  fn: async () => {
    await withAbstractSchema(async (pool, schema) => {
      const named = await values(pool, schema, "select AbsNamed { name, tags: { label } order by .label } order by .name");
      assertEquals(named, [
        { name: "acme", tags: [{ label: "blue" }, { label: "red" }] },
        { name: "ann", tags: [{ label: "red" }] },
        { name: "bob", tags: [] }
      ]);
      assertEquals(await sorted(pool, schema, "select AbsNamed { name } filter .tags.label = 'red'"), [{ name: "acme" }, { name: "ann" }]);
    });
  }
});

Deno.test({
  name: "PG abstract: a `for` over an abstract type iterates every concrete subtype",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      assertEquals(await sorted(pool, schema, "for n in AbsNamed union (select n.name)"), ["acme", "ann", "bob"]);
      assertEquals(await sorted(pool, schema, "for n in (select AbsNamed filter .name != 'ann') union (select n { name })"), [
        { name: "acme" },
        { name: "bob" }
      ]);
    })
});

// ---------------------------------------------------------------------------
// Bug 2: update and delete of an abstract type
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG abstract: update of an abstract type updates the matching objects of every subtype",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      const updated = await rows(pool, schema, "update AbsNamed filter .name in {'ann', 'acme'} set { name := .name ++ '!' }");
      assertEquals(updated.map(row => row.name).sort(), ["acme!", "ann!"]);
      assertEquals(await sorted(pool, schema, "select AbsPerson.name"), ["ann!", "bob"]);
      assertEquals(await sorted(pool, schema, "select AbsCompany.name"), ["acme!"]);

      // A multi link declared on the abstract type, on every subtype's junction.
      await run(pool, schema, "update AbsNamed filter .name in {'bob', 'acme!'} set { tags += (select AbsTag filter .label = 'blue') }");
      assertEquals(await values(pool, schema, "select AbsNamed { name, tags: { label } order by .label } order by .name"), [
        { name: "acme!", tags: [{ label: "blue" }, { label: "red" }] },
        { name: "ann!", tags: [{ label: "red" }] },
        { name: "bob", tags: [{ label: "blue" }] }
      ]);
    })
});

Deno.test({
  name: "PG abstract: an update of an abstract type bound in a with returns its objects",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      assertEquals(
        await sorted(pool, schema, "with u := (update AbsNamed filter .name != 'bob' set { name := 'x-' ++ .name }) select u { name }"),
        [{ name: "x-acme" }, { name: "x-ann" }]
      );
      assertEquals(await sorted(pool, schema, "select AbsNamed.name"), ["bob", "x-acme", "x-ann"]);
    })
});

Deno.test({
  name: "PG abstract: delete of an abstract type deletes the matching objects of every subtype",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      const deleted = await rows(pool, schema, "delete AbsNamed filter .name != 'bob'");
      assertEquals(deleted.map(row => row.name).sort(), ["acme", "ann"]);
      assertEquals(await sorted(pool, schema, "select AbsNamed.name"), ["bob"]);
      assertEquals(await sorted(pool, schema, "select AbsCompany.name"), []);
    })
});

Deno.test({
  name: "PG abstract: update and delete of a `for` variable over an abstract type",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      await run(pool, schema, "for n in (select AbsNamed filter .name != 'bob') union (update n set { name := n.name ++ '?' })");
      assertEquals(await sorted(pool, schema, "select AbsNamed.name"), ["acme?", "ann?", "bob"]);
      await run(pool, schema, "for n in (select AbsNamed filter .name = 'bob') union (delete n)");
      assertEquals(await sorted(pool, schema, "select AbsNamed.name"), ["acme?", "ann?"]);
    })
});

Deno.test({
  name: "PG abstract: insert of an abstract type is an error",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema((_pool, schema) => {
      assertThrows(() => compileEdgeQL(`insert AbsNamed { name := "x" }`, schema), Error, "abstract");
      return Promise.resolve();
    })
});

// ---------------------------------------------------------------------------
// Bug 3: links whose target is abstract
// ---------------------------------------------------------------------------

Deno.test({
  name: "PG abstract: a link to an abstract type stores, reads and filters through subtype objects",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      await run(
        pool,
        schema,
        `insert AbsThing { title := "t1", owner := (select AbsPerson filter .name = "ann" limit 1), fans := (select AbsNamed filter .name in {"bob", "acme"}) }`
      );
      await run(pool, schema, `insert AbsThing { title := "t2", owner := (select AbsCompany filter .name = "acme" limit 1) }`);

      assertEquals(await values(pool, schema, "select AbsThing { title, owner: { name }, fans: { name } order by .name } order by .title"), [
        { fans: [{ name: "acme" }, { name: "bob" }], owner: [{ name: "ann" }], title: "t1" },
        { fans: [], owner: [{ name: "acme" }], title: "t2" }
      ]);
      assertEquals(await values(pool, schema, "select AbsThing { title } filter .owner.name = 'acme'"), [{ title: "t2" }]);
      assertEquals(await values(pool, schema, "select AbsThing { title } filter .fans.name = 'bob'"), [{ title: "t1" }]);
      assertEquals(await sorted(pool, schema, "select AbsThing.owner.name"), ["acme", "ann"]);
      assertEquals(await sorted(pool, schema, "select AbsThing.fans.name"), ["acme", "bob"]);
      assertEquals(await sorted(pool, schema, "select AbsNamed.<owner[is AbsThing].title"), ["t1", "t2"]);
      assertEquals(await sorted(pool, schema, "select AbsThing { t := .owner.name }"), [{ t: "acme" }, { t: "ann" }]);
    })
});

Deno.test({
  name: "PG abstract: an id that is no object of the abstract type's subtypes is rejected",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      await assertRejects(() => run(pool, schema, `insert AbsThing { title := "bad", owner := <AbsNamed><uuid>"01234567-89ab-7cde-8f01-000000000099" }`));
      // A tag is an object, but not an AbsNamed.
      await assertRejects(() => pool.query(`INSERT INTO abs_thing (title, owner_id) SELECT 'bad', id FROM abs_tag LIMIT 1`));
    })
});

Deno.test({
  name: "PG abstract: deleting the target of a link to an abstract type follows the link's on target delete",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      await run(
        pool,
        schema,
        `insert AbsThing { title := "t1", owner := (select AbsPerson filter .name = "ann" limit 1), sponsor := (select AbsCompany filter .name = "acme" limit 1) }`
      );
      // Restrict (the default): the owner cannot be deleted while linked.
      await assertRejects(() => run(pool, schema, "delete AbsPerson filter .name = 'ann'"));
      await assertRejects(() => run(pool, schema, "delete AbsNamed filter .name = 'ann'"));
      assertEquals(await sorted(pool, schema, "select AbsPerson.name"), ["ann", "bob"]);

      // Allow: deleting the sponsor unsets the link.
      await run(pool, schema, "delete AbsCompany filter .name = 'acme'");
      assertEquals(await values(pool, schema, "select AbsThing { title, sponsor: { name } }"), [{ sponsor: null, title: "t1" }]);

      // Once nothing links to ann, she can be deleted.
      await run(pool, schema, "delete AbsThing");
      await run(pool, schema, "delete AbsNamed filter .name = 'ann'");
      assertEquals(await sorted(pool, schema, "select AbsNamed.name"), ["bob"]);
    })
});

Deno.test({
  name: "PG abstract: renaming a subtype object keeps a link to it valid",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      await run(pool, schema, `insert AbsThing { title := "t1", owner := (select AbsPerson filter .name = "ann" limit 1) }`);
      await run(pool, schema, "update AbsPerson filter .name = 'ann' set { name := 'anna' }");
      assertEquals(await values(pool, schema, "select AbsThing { owner: { name } }"), [{ owner: [{ name: "anna" }] }]);
    })
});

Deno.test({
  name: "PG abstract: a link to an abstract type can target an object inserted in the same statement",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      await run(pool, schema, `with c := (insert AbsCompany { name := "initech" }) insert AbsThing { title := "t1", owner := c }`);
      assertEquals(await values(pool, schema, "select AbsThing { owner: { name } }"), [{ owner: [{ name: "initech" }] }]);
    })
});

Deno.test({
  name: "PG abstract: an exclusive constraint of an abstract type holds across its subtypes",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      await run(pool, schema, "update AbsPerson filter .name = 'ann' set { code := 'x' }");
      await assertRejects(() => run(pool, schema, "update AbsCompany filter .name = 'acme' set { code := 'x' }"));
      // The constraint sees the current value, not the one a row had when inserted.
      await run(pool, schema, "update AbsPerson filter .name = 'ann' set { code := 'y' }");
      await run(pool, schema, "update AbsCompany filter .name = 'acme' set { code := 'x' }");
      assertEquals(await sorted(pool, schema, "select AbsNamed { name, code } filter exists .code"), [
        { code: "x", name: "acme" },
        { code: "y", name: "ann" }
      ]);
    })
});

Deno.test({
  name: "PG abstract: a database migrated before links to abstract types worked gets them on its next migration",
  ignore: !RUN_PG,
  fn: () =>
    withAbstractSchema(async (pool, schema) => {
      // As before: no triggers, and the abstract table empty.
      await pool.query("DROP TRIGGER disc_abstract_mirror ON abs_person");
      await pool.query("DROP TRIGGER disc_abstract_mirror ON abs_company");
      await pool.query("DELETE FROM abs_named");
      const link = `insert AbsThing { title := "t1", owner := (select AbsPerson filter .name = "ann" limit 1) }`;
      await assertRejects(() => run(pool, schema, link));

      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const migrated = await manager.applySchema(ABSTRACT_SDL);
      assertEquals(migrated.ok && migrated.value.length, 1);
      await run(pool, schema, link);
      assertEquals(await values(pool, schema, "select AbsThing { owner: { name } }"), [{ owner: [{ name: "ann" }] }]);

      // Once in place, there is nothing more to migrate.
      const again = await manager.applySchema(ABSTRACT_SDL);
      assertEquals(again.ok && again.value.length, 0);
      await manager.close();
    })
});

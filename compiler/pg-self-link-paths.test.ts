/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: link paths on a type that links to itself.
 *
 * A path like `.manager.name` compiles to a correlated subquery over the
 * link's target table. When the target is the source's own table, that
 * subquery reads the same table the outer row comes from, so unless the inner
 * reference gets its own alias, the outer row's name (`"self_person"` in an
 * update/delete, or an outer sub-shape's table) is captured by the inner FROM
 * and the correlation compares a row with itself. The SQL runs; the rows are
 * wrong. Likewise a backlink step `.<manager[is SelfPerson]` must not be
 * mistaken for the forward link `.manager` the type also has.
 *
 * Seed: Ann manages Bob, Bob manages Cid; Ann reports {Bob}, Bob reports {Cid}.
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
  type SelfPerson {
    required name: str {
      constraint exclusive;
    };
    title: str;
    manager: SelfPerson;
    multi reports: SelfPerson;
  }
}`;

const ANN = "01234567-89ab-7cde-8f01-00000000000a";
const BOB = "01234567-89ab-7cde-8f01-00000000000b";
const CID = "01234567-89ab-7cde-8f01-00000000000c";

async function withSeededSchema(run: (pool: ConnectionPool, schema: Schema) => Promise<void>): Promise<void> {
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
      `INSERT INTO self_person (id, name, manager_id) VALUES
        ('${ANN}', 'Ann', NULL), ('${BOB}', 'Bob', '${ANN}'), ('${CID}', 'Cid', '${BOB}')`
    );
    await pool.query(
      `INSERT INTO self_person_reports (source_id, target_id) VALUES ('${ANN}', '${BOB}'), ('${BOB}', '${CID}')`
    );
    await run(pool, schema);
    await manager.close();
  } finally {
    await dropAll(pool);
    await pool.close();
  }
}

async function dropAll(pool: ConnectionPool): Promise<void> {
  await pool.query("DROP TABLE IF EXISTS self_person_reports CASCADE");
  await pool.query("DROP TABLE IF EXISTS self_person CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/*** `name → title` for every row, after running `edgeql`. ***/
async function titlesAfter(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<Record<string, string | null>> {
  await pool.query(compileEdgeQL(edgeql, schema));
  const result = await pool.query("SELECT name, title FROM self_person ORDER BY name");
  return Object.fromEntries(result.rows.map(row => [row.name as string, row.title as string | null]));
}

/*** The JSON objects a `select … { shape }` returns. ***/
async function selectRows(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<Record<string, unknown>[]> {
  const result = await pool.query(compileEdgeQL(edgeql, schema));
  return result.rows.map(row => (row.jsonb_build_object ?? row) as Record<string, unknown>);
}

async function remainingNames(pool: ConnectionPool): Promise<string[]> {
  const result = await pool.query("SELECT name FROM self_person ORDER BY name");
  return result.rows.map(row => row.name as string);
}

Deno.test({
  name: "PG self link: update filter through a single link reads the outer row's link",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      const titles = await titlesAfter(pool, schema, "update SelfPerson filter .manager.name = 'Ann' set { title := 'x' }");
      assertEquals(titles, { Ann: null, Bob: "x", Cid: null });
    })
});

Deno.test({
  name: "PG self link: update set expression through a single link",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      const titles = await titlesAfter(pool, schema, "update SelfPerson set { title := .manager.name }");
      assertEquals(titles, { Ann: null, Bob: "Ann", Cid: "Bob" });
    })
});

Deno.test({
  name: "PG self link: update through a two-hop single-link chain",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      const titles = await titlesAfter(pool, schema, "update SelfPerson filter .manager.manager.name = 'Ann' set { title := 'x' }");
      assertEquals(titles, { Ann: null, Bob: null, Cid: "x" });
    })
});

Deno.test({
  name: "PG self link: delete filter through a single link",
  ignore: !RUN_PG,
  fn: async () => {
    await withSeededSchema(async (pool, schema) => {
      await pool.query(compileEdgeQL("delete SelfPerson filter .manager.name = 'Bob'", schema));
      assertEquals(await remainingNames(pool), ["Ann", "Bob"]);
    });
  }
});

Deno.test({
  name: "PG self link: update filter through a multi link",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      const titles = await titlesAfter(pool, schema, "update SelfPerson filter .reports.name = 'Cid' set { title := 'x' }");
      assertEquals(titles, { Ann: null, Bob: "x", Cid: null });
    })
});

Deno.test({
  name: "PG self link: count over a backlink in an update set",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      const titles = await titlesAfter(pool, schema, "update SelfPerson set { title := <str>count(.<manager[is SelfPerson]) }");
      assertEquals(titles, { Ann: "1", Bob: "1", Cid: "0" });
    })
});

Deno.test({
  name: "PG self link: a backlink comparison is not the same-named forward link",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      // Those managing someone named Bob: Ann — not Cid, whose manager is Bob.
      const titles = await titlesAfter(pool, schema, "update SelfPerson filter .<manager[is SelfPerson].name = 'Bob' set { title := 'x' }");
      assertEquals(titles, { Ann: "x", Bob: null, Cid: null });

      const rows = await selectRows(pool, schema, "select SelfPerson { name } filter .<manager[is SelfPerson].name = 'Bob'");
      assertEquals(rows.map(row => row.name), ["Ann"]);

      // Junction-backed: those in the reports of someone named Ann.
      const reported = await selectRows(pool, schema, "select SelfPerson { name } filter .<reports[is SelfPerson].name = 'Ann'");
      assertEquals(reported.map(row => row.name), ["Bob"]);
    })
});

Deno.test({
  name: "PG self link: upsert else-update reads the conflicting row's link",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      const titles = await titlesAfter(
        pool,
        schema,
        `insert SelfPerson { name := 'Cid' } unless conflict on .name
         else (update SelfPerson filter .manager.name = 'Bob' set { title := .manager.name })`
      );
      assertEquals(titles, { Ann: null, Bob: null, Cid: "Bob" });
    })
});

Deno.test({
  name: "PG self link: select filter and computed through a single link",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      const rows = await selectRows(
        pool,
        schema,
        "select SelfPerson { name, boss := .manager.name } filter .manager.name = 'Ann'"
      );
      assertEquals(rows, [{ boss: "Ann", name: "Bob" }]);
    })
});

Deno.test({
  name: "PG self link: nested sub-shapes correlate each level to its parent",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      const managers = await selectRows(
        pool,
        schema,
        "select SelfPerson { name, manager: { name, manager: { name } } } filter .name = 'Cid'"
      );
      assertEquals(managers, [{ manager: [{ manager: [{ name: "Ann" }], name: "Bob" }], name: "Cid" }]);

      const reports = await selectRows(
        pool,
        schema,
        "select SelfPerson { name, reports: { name, reports: { name } } } filter .name = 'Ann'"
      );
      assertEquals(reports, [{ name: "Ann", reports: [{ name: "Bob", reports: [{ name: "Cid" }] }] }]);

      const inner = await selectRows(
        pool,
        schema,
        "select SelfPerson { name, reports: { name, boss := .manager.name } } filter .name = 'Ann'"
      );
      assertEquals(inner, [{ name: "Ann", reports: [{ boss: "Ann", name: "Bob" }] }]);
    })
});

Deno.test({
  name: "PG self link: update returning a sub-shape through the self link",
  ignore: !RUN_PG,
  fn: () =>
    withSeededSchema(async (pool, schema) => {
      const rows = await selectRows(
        pool,
        schema,
        "select (update SelfPerson filter .name = 'Cid' set { title := 'x' }) { name, manager: { name, manager: { name } } }"
      );
      assertEquals(rows, [{ manager: [{ manager: [{ name: "Ann" }], name: "Bob" }], name: "Cid" }]);
    })
});

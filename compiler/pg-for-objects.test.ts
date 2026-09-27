/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `for x in <objects> union (…)` runs the body once per
 * object, with `x` that object.
 *
 * The iterator can be a select of a type (with filter / order by / limit), a
 * bare type, a `with` binding or a path; the body a select (shaped or not),
 * a bare expression, an insert, an update or a delete. Each case runs the
 * compiled SQL and reads the rows back.
 *
 * Seed: users ann, bob, cy; ann.posts = {Hello, World}, bob.posts = {Zed};
 * authors: Hello, World → ann, Zed → bob.
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
  type ForPost {
    required title: str;
    author: ForUser;
  }
  type ForUser {
    required name: str;
    multi posts: ForPost;
  }
}`;

const TABLES = ["for_user_posts", "for_user", "for_post"];

const ID = (n: number): string => `01234567-89ab-7cde-8f01-${n.toString().padStart(12, "0")}`;
const [ANN, BOB, CY] = [ID(1), ID(2), ID(3)];
const [HELLO, WORLD, ZED] = [ID(11), ID(12), ID(13)];

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
    await pool.query(`INSERT INTO for_user (id, name) VALUES ('${ANN}', 'ann'), ('${BOB}', 'bob'), ('${CY}', 'cy')`);
    await pool.query(
      `INSERT INTO for_post (id, title, author_id) VALUES ('${HELLO}', 'Hello', '${ANN}'), ('${WORLD}', 'World', '${ANN}'), ('${ZED}', 'Zed', '${BOB}')`
    );
    await pool.query(
      `INSERT INTO for_user_posts (source_id, target_id) VALUES ('${ANN}', '${HELLO}'), ('${ANN}', '${WORLD}'), ('${BOB}', '${ZED}')`
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

/*** The single column of each row, sorted (a `for` result is a set). ***/
async function sortedValues(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<unknown[]> {
  const result = await pool.query(compileEdgeQL(edgeql, schema));
  return result
    .rows
    .map(row => {
      const columns = Object.values(row);
      assertEquals(columns.length, 1, `expected one column per row for ${edgeql}: ${Object.keys(row).join(", ")}`);
      const value = columns[0];
      return JSON.stringify(typeof value === "bigint" ? Number(value) : value);
    })
    .sort()
    .map(value => JSON.parse(value));
}

async function rows(pool: ConnectionPool, sql: string): Promise<Record<string, unknown>[]> {
  return (await pool.query(sql)).rows as Record<string, unknown>[];
}

Deno.test({
  name: "PG for over objects: a select body sees each object",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await sortedValues(pool, schema, "for x in (select ForUser filter .name != 'cy') union (select x { name })"), [
        { name: "ann" },
        { name: "bob" }
      ]);
      assertEquals(await sortedValues(pool, schema, "for u in ForUser union (select u.name)"), ["ann", "bob", "cy"]);
      assertEquals(await sortedValues(pool, schema, "for u in ForUser union u.name"), ["ann", "bob", "cy"]);
      assertEquals(await sortedValues(pool, schema, "for u in ForUser union (u.name ++ '!')"), ["ann!", "bob!", "cy!"]);
      // The iterator's order by / limit pick the objects.
      assertEquals(await sortedValues(pool, schema, "for u in (select ForUser order by .name desc limit 1) union (select u { name, n := count(.posts) })"), [
        { n: 0, name: "cy" }
      ]);
      // Paths from the variable, and subqueries correlated to it.
      assertEquals(await sortedValues(pool, schema, "for u in (select ForUser filter .name = 'ann') union (select u.posts.title)"), ["Hello", "World"]);
      assertEquals(
        await sortedValues(pool, schema, "for u in ForUser union (select ForPost { title } filter .author = u and u.name = 'bob')"),
        [{ title: "Zed" }]
      );
      assertEquals(
        await sortedValues(pool, schema, "for u in (select ForUser filter .name = 'ann') union (select u { name, posts: { title } order by .title })"),
        [{ name: "ann", posts: [{ title: "Hello" }, { title: "World" }] }]
      );
    })
});

Deno.test({
  name: "PG for over objects: a with binding or a path as the iterator",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await sortedValues(pool, schema, "with us := (select ForUser filter .name = 'bob') for u in us union (select u.name)"), ["bob"]);
      assertEquals(await sortedValues(pool, schema, "for p in ForUser.posts union (select p.title)"), ["Hello", "World", "Zed"]);
      assertEquals(await sortedValues(pool, schema, "for n in ForUser.name union (select n ++ '?')"), ["ann?", "bob?", "cy?"]);
      // Nested: the inner iterator is a path from the outer variable.
      assertEquals(
        await sortedValues(pool, schema, "for u in ForUser union (for p in u.posts union (select u.name ++ ':' ++ p.title))"),
        ["ann:Hello", "ann:World", "bob:Zed"]
      );
    })
});

Deno.test({
  name: "PG for over objects: an insert body runs once per object",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await pool.query(compileEdgeQL(
        "for x in (select ForUser filter .name in {'ann', 'bob'}) union (insert ForPost { author := x, title := x.name ++ '!' })",
        schema
      ));
      assertEquals(
        await rows(pool, "SELECT p.title, u.name FROM for_post p JOIN for_user u ON u.id = p.author_id WHERE p.title LIKE '%!' ORDER BY p.title"),
        [{ name: "ann", title: "ann!" }, { name: "bob", title: "bob!" }]
      );
      // A scalar set iterator still inserts one row per element.
      await pool.query(compileEdgeQL("for t in {'p', 'q'} union (insert ForPost { title := t })", schema));
      assertEquals(await rows(pool, "SELECT title FROM for_post WHERE title IN ('p', 'q') ORDER BY title"), [{ title: "p" }, { title: "q" }]);
    })
});

Deno.test({
  name: "PG for over objects: an update body updates each object",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await pool.query(compileEdgeQL("for x in (select ForUser filter .name != 'ann') union (update x set { name := x.name ++ '2' })", schema));
      assertEquals(await rows(pool, "SELECT name FROM for_user ORDER BY name"), [{ name: "ann" }, { name: "bob2" }, { name: "cy2" }]);

      // Another type's objects, correlated to the variable.
      await pool.query(compileEdgeQL(
        "for x in ForUser union (update ForPost filter .author = x set { title := .title ++ ' by ' ++ x.name })",
        schema
      ));
      assertEquals(await rows(pool, "SELECT title FROM for_post ORDER BY title"), [
        { title: "Hello by ann" },
        { title: "World by ann" },
        { title: "Zed by bob2" }
      ]);

      // No objects, no updates.
      await pool.query(compileEdgeQL("for x in (select ForUser filter .name = 'nobody') union (update ForPost set { title := 'gone' })", schema));
      assertEquals((await rows(pool, "SELECT title FROM for_post WHERE title = 'gone'")).length, 0);
    })
});

Deno.test({
  name: "PG for over objects: a delete body deletes each object",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await pool.query(compileEdgeQL("for x in (select ForPost filter .title != 'Hello') union (delete x)", schema));
      assertEquals(await rows(pool, "SELECT title FROM for_post ORDER BY title"), [{ title: "Hello" }]);
    })
});

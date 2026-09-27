/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: paths over links as sets of objects.
 *
 * `select User.posts` is the set of distinct posts linked from any user; a
 * trailing property (`User.posts.title`) is read once per such post. The
 * same set, correlated to the current object, backs computed paths through
 * multi links (`titles := .posts.title`) and backlink sub-shapes
 * (`.<author[is Post] { title }`), which come back as JSON arrays.
 *
 * Seed:
 *   users ann, bob, cy; ann.posts = {Hello, World}, bob.posts = {World, Zed};
 *   ann.best = bob.best = Hello; authors: Hello, World → ann, Zed → bob.
 *   comments: Hello {c-one, c-two}, World {c-two}, Zed {c-three}.
 *   people: Ann; Bob and Dee report to Ann; Cid reports to Bob.
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

const PATH_SDL = `module default {
  type PathComment {
    required body: str;
  }
  type PathPost {
    required title: str;
    author: PathUser;
    multi comments: PathComment;
  }
  type PathUser {
    required name: str {
      constraint exclusive;
    };
    best: PathPost;
    multi posts: PathPost;
  }
  type PathPerson {
    required name: str;
    manager: PathPerson;
    multi reports: PathPerson;
  }
}`;

const TABLES = [
  "path_user_posts",
  "path_post_comments",
  "path_person_reports",
  "path_user",
  "path_post",
  "path_comment",
  "path_person"
];

const ID = (n: number): string => `01234567-89ab-7cde-8f01-${n.toString().padStart(12, "0")}`;
const [ANN, BOB, CY] = [ID(1), ID(2), ID(3)];
const [HELLO, WORLD, ZED] = [ID(11), ID(12), ID(13)];
const [C1, C2, C3] = [ID(21), ID(22), ID(23)];
const [P_ANN, P_BOB, P_CID, P_DEE] = [ID(31), ID(32), ID(33), ID(34)];

async function withPathSchema(run: (pool: ConnectionPool, schema: Schema) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();
  try {
    await dropAll(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(PATH_SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    if (!schema) {
      throw new Error("no schema after applySchema");
    }
    await pool.query(`INSERT INTO path_comment (id, body) VALUES ('${C1}', 'c-one'), ('${C2}', 'c-two'), ('${C3}', 'c-three')`);
    await pool.query(`INSERT INTO path_user (id, name) VALUES ('${ANN}', 'ann'), ('${BOB}', 'bob'), ('${CY}', 'cy')`);
    await pool.query(
      `INSERT INTO path_post (id, title, author_id) VALUES ('${HELLO}', 'Hello', '${ANN}'), ('${WORLD}', 'World', '${ANN}'), ('${ZED}', 'Zed', '${BOB}')`
    );
    await pool.query(`UPDATE path_user SET best_id = '${HELLO}' WHERE name IN ('ann', 'bob')`);
    await pool.query(
      `INSERT INTO path_user_posts (source_id, target_id) VALUES ('${ANN}', '${HELLO}'), ('${ANN}', '${WORLD}'), ('${BOB}', '${WORLD}'), ('${BOB}', '${ZED}')`
    );
    await pool.query(
      `INSERT INTO path_post_comments (source_id, target_id) VALUES ('${HELLO}', '${C1}'), ('${HELLO}', '${C2}'), ('${WORLD}', '${C2}'), ('${ZED}', '${C3}')`
    );
    await pool.query(
      `INSERT INTO path_person (id, name, manager_id) VALUES
        ('${P_ANN}', 'Ann', NULL), ('${P_BOB}', 'Bob', '${P_ANN}'), ('${P_CID}', 'Cid', '${P_BOB}'), ('${P_DEE}', 'Dee', '${P_ANN}')`
    );
    await pool.query(
      `INSERT INTO path_person_reports (source_id, target_id) VALUES ('${P_ANN}', '${P_BOB}'), ('${P_ANN}', '${P_DEE}'), ('${P_BOB}', '${P_CID}')`
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

Deno.test({
  name: "PG path select: a link path is the set of distinct linked objects",
  ignore: !RUN_PG,
  fn: () =>
    withPathSchema(async (pool, schema) => {
      // World is linked from ann and bob, and comes back once.
      assertEquals(await values(pool, schema, "select PathUser.posts { title } order by .title"), [
        { title: "Hello" },
        { title: "World" },
        { title: "Zed" }
      ]);
      assertEquals(await sorted(pool, schema, "select PathUser.posts.title"), ["Hello", "World", "Zed"]);
      assertEquals(await values(pool, schema, "select PathUser.best { title }"), [{ title: "Hello" }]);
      assertEquals(await values(pool, schema, "select PathUser.best.title"), ["Hello"]);
      // Two hops through multi links: c-two is reached from two posts, once.
      assertEquals(await sorted(pool, schema, "select PathUser.posts.comments.body"), ["c-one", "c-three", "c-two"]);
      // Without a shape, the objects' properties.
      const [world] = await values(pool, schema, "select PathUser.posts filter .title = 'World'") as Record<string, unknown>[];
      assertEquals([world.id, world.title], [WORLD, "World"]);
    })
});

Deno.test({
  name: "PG path select: filter, order by, offset and limit apply to the path's objects",
  ignore: !RUN_PG,
  fn: () =>
    withPathSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select PathUser.posts { title } filter .title != 'Hello' order by .title desc"), [
        { title: "Zed" },
        { title: "World" }
      ]);
      assertEquals(await values(pool, schema, "select PathUser.posts { title } order by .title offset 1 limit 1"), [{ title: "World" }]);
      assertEquals(await values(pool, schema, "select PathUser.posts.comments { body } filter .body like 'c-t%' order by .body"), [
        { body: "c-three" },
        { body: "c-two" }
      ]);
    })
});

Deno.test({
  name: "PG path select: a backlink path is the set of objects linking to the source",
  ignore: !RUN_PG,
  fn: () =>
    withPathSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select PathUser.<author[is PathPost] { title } order by .title"), [
        { title: "Hello" },
        { title: "World" },
        { title: "Zed" }
      ]);
      assertEquals(await sorted(pool, schema, "select PathPerson.<manager[is PathPerson].name"), ["Bob", "Cid", "Dee"]);
      // Junction-backed: those in someone's reports.
      assertEquals(await sorted(pool, schema, "select PathPerson.<reports[is PathPerson].name"), ["Ann", "Bob"]);
    })
});

Deno.test({
  name: "PG path select: a path rooted at a with binding starts from the binding's objects",
  ignore: !RUN_PG,
  fn: () =>
    withPathSchema(async (pool, schema) => {
      assertEquals(await sorted(pool, schema, "with u := (select PathUser filter .name = 'ann') select u.posts.title"), ["Hello", "World"]);
      assertEquals(
        await values(pool, schema, "with u := (select PathUser filter .name = 'bob') select u.posts { title } order by .title"),
        [{ title: "World" }, { title: "Zed" }]
      );
    })
});

Deno.test({
  name: "PG path select: aggregates over path sets",
  ignore: !RUN_PG,
  fn: () =>
    withPathSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select count(PathUser.posts)"), [3]);
      assertEquals(await values(pool, schema, "select count(PathUser.posts.comments)"), [3]);
      assertEquals(await values(pool, schema, "select exists PathUser.posts"), [true]);
      assertEquals(await values(pool, schema, "select PathUser { name, n := count(.posts) } order by .name"), [
        { n: 2, name: "ann" },
        { n: 2, name: "bob" },
        { n: 0, name: "cy" }
      ]);
      assertEquals(await values(pool, schema, "select PathUser { name, n := count(.posts.comments) } order by .name"), [
        { n: 2, name: "ann" },
        { n: 2, name: "bob" },
        { n: 0, name: "cy" }
      ]);
    })
});

Deno.test({
  name: "PG computed path: a path through multi links is an array per object",
  ignore: !RUN_PG,
  fn: () =>
    withPathSchema(async (pool, schema) => {
      const rows = await values(
        pool,
        schema,
        "select PathUser { name, titles := .posts.title, bodies := .posts.comments.body } order by .name"
      ) as { bodies: string[]; name: string; titles: string[]; }[];
      assertEquals(rows.map(row => ({ ...row, bodies: row.bodies.toSorted(), titles: row.titles.toSorted() })), [
        { bodies: ["c-one", "c-two"], name: "ann", titles: ["Hello", "World"] },
        { bodies: ["c-three", "c-two"], name: "bob", titles: ["World", "Zed"] },
        { bodies: [], name: "cy", titles: [] }
      ]);

      // Through the reports of a self-linked type.
      const people = await values(pool, schema, "select PathPerson { name, r := .reports.name } filter .name = 'Ann'") as {
        name: string;
        r: string[];
      }[];
      assertEquals(people.map(person => person.r.toSorted()), [["Bob", "Dee"]]);
    })
});

Deno.test({
  name: "PG backlink sub-shape: the objects linking here, as an array of shaped objects",
  ignore: !RUN_PG,
  fn: () =>
    withPathSchema(async (pool, schema) => {
      assertEquals(
        await values(pool, schema, "select PathPerson { name, reports_to_me := .<manager[is PathPerson] { name } order by .name } order by .name"),
        [
          { name: "Ann", reports_to_me: [{ name: "Bob" }, { name: "Dee" }] },
          { name: "Bob", reports_to_me: [{ name: "Cid" }] },
          { name: "Cid", reports_to_me: [] },
          { name: "Dee", reports_to_me: [] }
        ]
      );

      const expected = [
        { authored: [{ title: "World" }], name: "ann" },
        { authored: [{ title: "Zed" }], name: "bob" },
        { authored: [], name: "cy" }
      ];
      assertEquals(
        await values(
          pool,
          schema,
          "select PathUser { name, authored := .<author[is PathPost] { title } filter .title != 'Hello' order by .title } order by .name"
        ),
        expected
      );
      // Gel's spelling: a parenthesized select of the backlink.
      assertEquals(
        await values(
          pool,
          schema,
          "select PathUser { name, authored := (select .<author[is PathPost] { title } filter .title != 'Hello' order by .title) } order by .name"
        ),
        expected
      );
      // Sub-shapes nest, each correlated to its own object.
      assertEquals(
        await values(
          pool,
          schema,
          "select PathPerson { name, down := .<manager[is PathPerson] { name, down := .<manager[is PathPerson] { name } } } filter .name = 'Ann'"
        )
          .then(rows => (rows as { down: { down: unknown[]; name: string; }[]; }[]).map(row => row.down.toSorted((a, b) => a.name.localeCompare(b.name)))),
        [[{ down: [{ name: "Cid" }], name: "Bob" }, { down: [], name: "Dee" }]]
      );
    })
});

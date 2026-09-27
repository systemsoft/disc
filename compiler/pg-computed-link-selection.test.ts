/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: a schema-declared COMPUTED LINK (`auth := .author`,
 * `bf := .author.best_friend`, `single first := (select .<post[is …] … limit 1)`,
 * `multi ordered := (select .<post[is …] order by …)`) selects like a stored
 * link:
 *
 * - with a sub-shape, a single one is a one-element array `[{…}]` or `null`
 *   when empty (the deliberate Gel divergence pinned in
 *   `tests/gel-divergence-pins.test.ts`); a multi one is an array;
 * - without one, a single one is the target's id (or `null`), a multi one the
 *   targets' ids;
 * - inside another link's sub-shape too, and path-based ones in `filter` and
 *   `order by` (`filter .auth.name = …`).
 *
 * Regression guard for `column <table>.auth does not exist`: the computed was
 * classified as a property, so its sub-shape read a column.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import type { Schema } from "./context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type ClUser {
    required name: str;
    best_friend: ClUser;
  }
  type ClPost {
    required title: str;
    required author: ClUser;
    auth := .author;
    bf := .author.best_friend;
    single first_comment := (select .<post[is ClComment] order by .created limit 1);
    latest := (select .<post[is ClComment] order by .created desc limit 1);
    multi ordered := (select .<post[is ClComment] order by .created);
  }
  type ClComment {
    required post: ClPost;
    required body: str;
    required created: datetime;
  }
}`;

const TABLES = ["cl_comment", "cl_post", "cl_user"];
const U1 = "00000000-0000-7000-8000-000000000001";
const U2 = "00000000-0000-7000-8000-000000000002";
const P1 = "00000000-0000-7000-8000-00000000000a";
const P2 = "00000000-0000-7000-8000-00000000000b";
const C1 = "00000000-0000-7000-8000-0000000000c1";
const C2 = "00000000-0000-7000-8000-0000000000c2";

type Pool = ReturnType<typeof makePool>;

async function dropAll(pool: Pool): Promise<void> {
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/*** Migrate, then: u1 → best friend u2; p1 by u1 with comments c1 (earlier), c2; p2 by u2 with none. ***/
async function setup(pool: Pool): Promise<{ manager: SchemaManager; schema: Schema; }> {
  await dropAll(pool);
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  const applied = await manager.applySchema(SDL);
  assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`);
  const schema = manager.getSchema();
  if (!schema)
    throw new Error("no schema after applySchema");

  await pool.query(`INSERT INTO cl_user (id, name) VALUES ('${U1}', 'u1'), ('${U2}', 'u2')`);
  await pool.query(`UPDATE cl_user SET best_friend_id = '${U2}' WHERE id = '${U1}'`);
  await pool.query(`INSERT INTO cl_post (id, title, author_id) VALUES ('${P1}', 'p1', '${U1}'), ('${P2}', 'p2', '${U2}')`);
  await pool.query(
    `INSERT INTO cl_comment (id, post_id, body, created)
     VALUES ('${C1}', '${P1}', 'c1', '2026-01-01T00:00:00Z'), ('${C2}', '${P1}', 'c2', '2026-01-02T00:00:00Z')`
  );
  return { manager, schema };
}

async function rows(pool: Pool, schema: Schema, query: string): Promise<Record<string, unknown>[]> {
  const res = await pool.query(compileEdgeQL(query, schema));
  return res.rows.map(row => (row as Record<string, unknown>).jsonb_build_object as Record<string, unknown>);
}

function pgTest(name: string, fn: (pool: Pool, schema: Schema) => Promise<void>): void {
  Deno.test({
    name: `PG computed link selection: ${name}`,
    ignore: !RUN_PG,
    fn: async () => {
      const pool = makePool(await getTestDsn());
      await pool.initialize();
      try {
        const { manager, schema } = await setup(pool);
        try {
          await fn(pool, schema);
        } finally {
          await manager.close();
        }
      } finally {
        await dropAll(pool);
        await pool.close();
      }
    }
  });
}

pgTest("alias of a single link with a sub-shape matches the stored link", async (pool, schema) => {
  assertEquals(await rows(pool, schema, "select ClPost { title, author: { name }, auth: { name } } order by .title"), [
    { author: [{ name: "u1" }], auth: [{ name: "u1" }], title: "p1" },
    { author: [{ name: "u2" }], auth: [{ name: "u2" }], title: "p2" }
  ]);
});

pgTest("path through a link with nested sub-shapes, empty is null", async (pool, schema) => {
  assertEquals(
    await rows(pool, schema, "select ClPost { title, bf: { name, best_friend: { name } }, auth: { bf2 := .best_friend { name } } } order by .title"),
    [
      { auth: [{ bf2: [{ name: "u2" }] }], bf: [{ best_friend: null, name: "u2" }], title: "p1" },
      { auth: [{ bf2: [] }], bf: null, title: "p2" }
    ]
  );
});

pgTest("single select … limit 1 backlink with a sub-shape, empty is null", async (pool, schema) => {
  assertEquals(await rows(pool, schema, "select ClPost { title, first_comment: { body }, latest: { body } } order by .title"), [
    { first_comment: [{ body: "c1" }], latest: [{ body: "c2" }], title: "p1" },
    { first_comment: null, latest: null, title: "p2" }
  ]);
});

pgTest("multi select backlink with a sub-shape keeps its order, empty is []", async (pool, schema) => {
  assertEquals(await rows(pool, schema, "select ClPost { title, ordered: { body } } order by .title"), [
    { ordered: [{ body: "c1" }, { body: "c2" }], title: "p1" },
    { ordered: [], title: "p2" }
  ]);
  // The sub-shape's own filter and order by apply to the computed's objects.
  assertEquals(await rows(pool, schema, `select ClPost { title, ordered: { body } filter .body != 'c1' } filter .title = 'p1'`), [
    { ordered: [{ body: "c2" }], title: "p1" }
  ]);
  assertEquals(await rows(pool, schema, "select ClPost { title, ordered: { body } order by .created desc } filter .title = 'p1'"), [
    { ordered: [{ body: "c2" }, { body: "c1" }], title: "p1" }
  ]);
});

pgTest("without a sub-shape a computed link is its target's id, like a stored link", async (pool, schema) => {
  assertEquals(await rows(pool, schema, "select ClPost { title, author, auth, bf, first_comment } order by .title"), [
    { auth: U1, author: U1, bf: U2, first_comment: C1, title: "p1" },
    { auth: U2, author: U2, bf: null, first_comment: null, title: "p2" }
  ]);
  const [p1] = await rows(pool, schema, "select ClPost { ordered } filter .title = 'p1'");
  assertEquals(p1, { ordered: [C1, C2] });
});

pgTest("inside another link's sub-shape", async (pool, schema) => {
  assertEquals(await rows(pool, schema, "select ClComment { body, post: { title, auth: { name }, first_comment: { body } } } order by .body"), [
    { body: "c1", post: [{ auth: [{ name: "u1" }], first_comment: [{ body: "c1" }], title: "p1" }] },
    { body: "c2", post: [{ auth: [{ name: "u1" }], first_comment: [{ body: "c1" }], title: "p1" }] }
  ]);
});

pgTest("filter and order by through a path-based computed link", async (pool, schema) => {
  assertEquals(await rows(pool, schema, `select ClPost { title } filter .auth.name = 'u1'`), [{ title: "p1" }]);
  assertEquals(await rows(pool, schema, `select ClPost { title } filter .bf.name = 'u2'`), [{ title: "p1" }]);
  assertEquals(await rows(pool, schema, `select ClPost { title } filter exists .bf`), [{ title: "p1" }]);
  assertEquals(await rows(pool, schema, "select ClPost { title } order by .auth.name desc"), [{ title: "p2" }, { title: "p1" }]);
});

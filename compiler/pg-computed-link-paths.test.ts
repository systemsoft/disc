/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: a schema-declared computed link over a `(select …)`
 * (`single first_comment := (select .<post[is …] order by … limit 1)`,
 * `multi recent := (select .<post[is …] order by … desc limit 2)`) followed
 * in paths — `.first_comment.body`, `exists .first_comment`,
 * `count(.recent)`, `filter`, `order by` — and a sub-shape's own
 * `filter` / `order by` / `limit` applied to the computed's result; plus a
 * computed property over a backlink (`bodies := .<post[is …].body`).
 *
 * Expected values are Gel 7.1's for the same schema and data.
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
  type CpUser {
    required name: str;
  }
  type CpPost {
    required title: str;
    required author: CpUser;
    required single link auth := .author;
    single link first_comment := (select .<post[is CpComment] order by .created limit 1);
    multi link recent := (select .<post[is CpComment] order by .created desc limit 2);
    multi ordered := (select .<post[is CpComment] order by .created);
    property bodies := .<post[is CpComment].body;
    multi property labels := {.title, .title ++ '!'};
    comments := .<post[is CpComment];
  }
  type CpComment {
    required post: CpPost;
    required body: str;
    required created: datetime;
  }
}`;

const TABLES = ["cp_comment", "cp_post", "cp_user"];
const U1 = "00000000-0000-7000-8000-000000000001";
const P1 = "00000000-0000-7000-8000-00000000000a";
const P2 = "00000000-0000-7000-8000-00000000000b";

type Pool = ReturnType<typeof makePool>;

async function dropAll(pool: Pool): Promise<void> {
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/*** Migrate, then: p1 with comments c1, c2, c3 (in that order of creation); p2 with none. ***/
async function setup(pool: Pool): Promise<{ manager: SchemaManager; schema: Schema; }> {
  await dropAll(pool);
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  const applied = await manager.applySchema(SDL);
  assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : JSON.stringify(applied)}`);
  const schema = manager.getSchema();
  if (!schema)
    throw new Error("no schema after applySchema");

  await pool.query(`INSERT INTO cp_user (id, name) VALUES ('${U1}', 'u1')`);
  await pool.query(`INSERT INTO cp_post (id, title, author_id) VALUES ('${P1}', 'p1', '${U1}'), ('${P2}', 'p2', '${U1}')`);
  await pool.query(
    `INSERT INTO cp_comment (id, post_id, body, created) VALUES
       ('00000000-0000-7000-8000-0000000000c1', '${P1}', 'c1', '2026-01-01T00:00:00Z'),
       ('00000000-0000-7000-8000-0000000000c2', '${P1}', 'c2', '2026-01-02T00:00:00Z'),
       ('00000000-0000-7000-8000-0000000000c3', '${P1}', 'c3', '2026-01-03T00:00:00Z')`
  );
  return { manager, schema };
}

async function rows(pool: Pool, schema: Schema, query: string): Promise<Record<string, unknown>[]> {
  const res = await pool.query(compileEdgeQL(query, schema));
  return res.rows.map(row => (row as Record<string, unknown>).jsonb_build_object as Record<string, unknown>);
}

function pgTest(name: string, fn: (pool: Pool, schema: Schema) => Promise<void>): void {
  Deno.test({
    name: `PG computed link paths: ${name}`,
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

pgTest("paths through a (select …) computed link in a shape", async (pool, schema) => {
  assertEquals(
    await rows(
      pool,
      schema,
      "select CpPost { title, fb := .first_comment.body, has := exists .first_comment, n := count(.recent), no := count(.ordered), an := .auth.name } order by .title"
    ),
    [
      { an: "u1", fb: "c1", has: true, n: 2, no: 3, title: "p1" },
      { an: "u1", fb: null, has: false, n: 0, no: 0, title: "p2" }
    ]
  );
});

pgTest("filter and order by through a (select …) computed link", async (pool, schema) => {
  assertEquals(await rows(pool, schema, `select CpPost { title } filter .first_comment.body = 'c1'`), [{ title: "p1" }]);
  assertEquals(await rows(pool, schema, "select CpPost { title } filter exists .first_comment"), [{ title: "p1" }]);
  assertEquals(await rows(pool, schema, "select CpPost { title } filter not exists .first_comment"), [{ title: "p2" }]);
  assertEquals(await rows(pool, schema, "select CpPost { title } filter count(.recent) > 1"), [{ title: "p1" }]);
  assertEquals(await rows(pool, schema, `select CpPost { title } filter 'c3' in .recent.body`), [{ title: "p1" }]);
  // `recent` keeps the two latest: c1 is not among them.
  assertEquals(await rows(pool, schema, `select CpPost { title } filter 'c1' in .recent.body`), []);
  assertEquals(await rows(pool, schema, "select CpPost { title } order by .first_comment.created desc empty last"), [
    { title: "p1" },
    { title: "p2" }
  ]);
  assertEquals(await rows(pool, schema, "select CpPost { title, fp := .first_comment.post.title } order by .title"), [
    { fp: "p1", title: "p1" },
    { fp: null, title: "p2" }
  ]);
});

pgTest("select of a path through a (select …) computed link", async (pool, schema) => {
  assertEquals(await rows(pool, schema, "select CpPost.first_comment { body }"), [{ body: "c1" }]);
  assertEquals(await rows(pool, schema, "select CpPost.recent { body } order by .body"), [{ body: "c2" }, { body: "c3" }]);
});

pgTest("a sub-shape's filter, order by and limit apply to the computed's result", async (pool, schema) => {
  // recent = [c3, c2]; drop c3, order by created, keep one.
  assertEquals(
    await rows(pool, schema, "select CpPost { title, recent: { body } filter .body != 'c3' order by .created limit 1 } order by .title"),
    [{ recent: [{ body: "c2" }], title: "p1" }, { recent: [], title: "p2" }]
  );
  assertEquals(await rows(pool, schema, "select CpPost { title, recent: { body } order by .created } order by .title"), [
    { recent: [{ body: "c2" }, { body: "c3" }], title: "p1" },
    { recent: [], title: "p2" }
  ]);
  // Without an order by, the computed's own order stands.
  assertEquals(await rows(pool, schema, "select CpPost { title, recent: { body } limit 1 } order by .title"), [
    { recent: [{ body: "c3" }], title: "p1" },
    { recent: [], title: "p2" }
  ]);
  assertEquals(await rows(pool, schema, "select CpPost { title, recent: { body } offset 1 } order by .title"), [
    { recent: [{ body: "c2" }], title: "p1" },
    { recent: [], title: "p2" }
  ]);
  assertEquals(await rows(pool, schema, `select CpPost { title, first_comment: { body } filter .body = 'zz' } order by .title`), [
    { first_comment: null, title: "p1" },
    { first_comment: null, title: "p2" }
  ]);
  // A computed without a limit takes the shape's limit as its own.
  assertEquals(await rows(pool, schema, "select CpPost { title, ordered: { body } limit 2 } filter .title = 'p1'"), [
    { ordered: [{ body: "c1" }, { body: "c2" }], title: "p1" }
  ]);
});

pgTest("a backlink's sub-shape takes a limit and offset", async (pool, schema) => {
  assertEquals(await rows(pool, schema, "select CpPost { title, comments: { body } order by .created desc offset 1 limit 1 } order by .title"), [
    { comments: [{ body: "c2" }], title: "p1" },
    { comments: [], title: "p2" }
  ]);
});

pgTest("a computed property over a backlink is its values", async (pool, schema) => {
  const [p1, p2] = await rows(pool, schema, "select CpPost { title, bodies, labels } order by .title");
  assertEquals({ ...p1, bodies: [...(p1.bodies as string[])].sort() }, { bodies: ["c1", "c2", "c3"], labels: ["p1", "p1!"], title: "p1" });
  assertEquals(p2, { bodies: [], labels: ["p2", "p2!"], title: "p2" });
  assertEquals(await rows(pool, schema, `select CpPost { title } filter 'c2' in .bodies`), [{ title: "p1" }]);
  assertEquals(await rows(pool, schema, "select CpPost { title, nb := count(.bodies) } order by .title"), [
    { nb: 3, title: "p1" },
    { nb: 0, title: "p2" }
  ]);
});

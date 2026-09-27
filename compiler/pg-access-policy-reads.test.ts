/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: a select policy filters every read of its type's objects,
 * not only the top-level select.
 *
 * As in Gel, an object the select policy hides is absent wherever the query
 * reaches it: through a `with` binding, a `for` iterator, a path (as its
 * root, an intermediate hop or its end), a computed path, a link or backlink
 * sub-shape, a bare link, an aggregate, `exists`, a filter over a path, or a
 * mutation's returning shape.
 *
 * Seed (current user: ann):
 *   users ann (visible), bob (hidden by `own`);
 *   posts A1 (ann, published), A2 (ann, unpublished → hidden),
 *         B1 (bob, published), B2 (bob, unpublished → hidden);
 *   ann.posts = {A1, A2}, bob.posts = {B1, B2}; ann.best = A2, bob.best = A1;
 *   comments (no policy): A1 {c1}, A2 {c2}, B1 {c3};
 *   notes (select open to all, update/delete only while unlocked): n-open, n-locked.
 *
 * Writes follow Gel's "any object that cannot be selected, cannot be modified
 * either": tasks are visible while `visible` and editable while not `done`,
 * so only t-edit (visible, not done) may be updated or deleted; drafts allow
 * update and delete but not select, so none can be.
 *
 * Policies are inherited: docs and sheets extend AcpOwned (`owned`: all, for
 * the owner); sheets add `shared` (select of the sheet titled 'shared').
 *
 * Custom globals (`acp_tenant`, `acp_label` with a default, required
 * `acp_level` with a default, `acp::tenant` in another module) filter rows
 * by the value `set global` gives them.
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

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type AcpComment {
    required body: str;
  }
  type AcpNote {
    required body: str;
    locked: bool;
    access policy read {
      allow select;
    };
    access policy edit_unlocked {
      allow update, delete;
      using (.locked ?= false);
    };
  }
  type AcpPost {
    required title: str;
    published: bool;
    author: AcpUser;
    multi comments: AcpComment;
    access policy visible {
      allow all;
      using (.published ?= true);
    };
  }
  type AcpTask {
    required name: str {
      constraint exclusive;
    };
    body: str;
    visible: bool;
    done: bool;
    multi tags: AcpComment;
    access policy see {
      allow select;
      using (.visible ?= true);
    };
    access policy edit {
      allow insert, update, delete;
      using (.done ?= false);
    };
  }
  type AcpDraft {
    required body: str;
    access policy write_only {
      allow update, delete;
    };
  }
  abstract type AcpOwned {
    required title: str;
    owner: uuid;
    access policy owned {
      allow all;
      using (.owner ?= global current_user);
    };
  }
  type AcpDoc extending AcpOwned {}
  type AcpSheet extending AcpOwned {
    access policy shared {
      allow select;
      using (.title ?= 'shared');
    };
  }
  global acp_tenant: uuid;
  global acp_label: str {
    default := 'public';
  };
  global required acp_level: int64 {
    default := 1;
  };
  type AcpTenantRow {
    required label: str;
    tenant: uuid;
    access policy tenant_rows {
      allow all;
      using (.tenant ?= global acp_tenant);
    };
  }
  type AcpLabelRow {
    required label: str;
    level: int64;
    access policy by_label {
      allow select;
      using (.label ?= global acp_label);
    };
    access policy by_level {
      allow update;
      using (.level ?= global acp_level);
    };
  }
  type AcpUser {
    required name: str {
      constraint exclusive;
    };
    secret: str;
    best: AcpPost;
    multi posts: AcpPost;
    access policy own {
      allow all;
      using (.id ?= global current_user);
    };
  }
}
module acp {
  global tenant: uuid;
  type AcpModRow {
    required label: str;
    tenant: uuid;
    access policy tenant_rows {
      allow select;
      using (.tenant ?= global tenant);
    };
  }
}`;

const TABLES = [
  "acp_user_posts",
  "acp_post_comments",
  "acp_task_tags",
  "acp_user",
  "acp_post",
  "acp_comment",
  "acp_note",
  "acp_task",
  "acp_draft",
  "acp_doc",
  "acp_sheet",
  "acp_owned",
  "acp_tenant_row",
  "acp_label_row"
];

/*** The table of `acp::AcpModRow` (named by the migration engine for a non-default module). ***/
async function modTables(pool: ConnectionPool): Promise<string[]> {
  const result = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE '%acp_mod_row%'");
  return result.rows.map(row => String(Object.values(row)[0]));
}

const ID = (n: number): string => `01234567-89ab-7cde-8f01-${n.toString().padStart(12, "0")}`;
const [ANN, BOB] = [ID(1), ID(2)];
const [A1, A2, B1, B2] = [ID(11), ID(12), ID(13), ID(14)];
const [C1, C2, C3] = [ID(21), ID(22), ID(23)];
const [N_OPEN, N_LOCKED] = [ID(31), ID(32)];
const [T_EDIT, T_HIDDEN, T_DONE] = [ID(41), ID(42), ID(43)];
const [TENANT_1, TENANT_2] = [ID(51), ID(52)];

async function withSchema(run: (pool: ConnectionPool, schema: Schema) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();
  try {
    await dropAll(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
    const schema = manager.getSchema();
    if (!schema) {
      throw new Error("no schema after applySchema");
    }
    await pool.query(`INSERT INTO acp_comment (id, body) VALUES ('${C1}', 'c1'), ('${C2}', 'c2'), ('${C3}', 'c3')`);
    await pool.query(`INSERT INTO acp_note (id, body, locked) VALUES ('${N_OPEN}', 'n-open', false), ('${N_LOCKED}', 'n-locked', true)`);
    await pool.query(`INSERT INTO acp_user (id, name, secret) VALUES ('${ANN}', 'ann', 'ann-s'), ('${BOB}', 'bob', 'bob-s')`);
    await pool.query(
      `INSERT INTO acp_post (id, title, published, author_id) VALUES
        ('${A1}', 'A1', true, '${ANN}'), ('${A2}', 'A2', false, '${ANN}'), ('${B1}', 'B1', true, '${BOB}'), ('${B2}', 'B2', false, '${BOB}')`
    );
    await pool.query(`UPDATE acp_user SET best_id = CASE name WHEN 'ann' THEN '${A2}'::uuid ELSE '${A1}'::uuid END`);
    await pool.query(
      `INSERT INTO acp_user_posts (source_id, target_id) VALUES ('${ANN}', '${A1}'), ('${ANN}', '${A2}'), ('${BOB}', '${B1}'), ('${BOB}', '${B2}')`
    );
    await pool.query(`INSERT INTO acp_post_comments (source_id, target_id) VALUES ('${A1}', '${C1}'), ('${A2}', '${C2}'), ('${B1}', '${C3}')`);
    await pool.query(
      `INSERT INTO acp_task (id, name, body, visible, done) VALUES
        ('${T_EDIT}', 't-edit', 'b', true, false), ('${T_HIDDEN}', 't-hidden', 'b', false, false), ('${T_DONE}', 't-done', 'b', true, true)`
    );
    await pool.query("INSERT INTO acp_draft (body) VALUES ('d1')");
    await pool.query(`INSERT INTO acp_doc (title, owner) VALUES ('ann-doc', '${ANN}'), ('bob-doc', '${BOB}')`);
    await pool.query(`INSERT INTO acp_sheet (title, owner) VALUES ('ann-sheet', '${ANN}'), ('shared', '${BOB}'), ('bob-sheet', '${BOB}')`);
    await pool.query(`INSERT INTO acp_tenant_row (label, tenant) VALUES ('r1', '${TENANT_1}'), ('r2', '${TENANT_2}')`);
    await pool.query("INSERT INTO acp_label_row (label, level) VALUES ('public', 1), ('secret', 2)");
    await run(pool, schema);
    await manager.close();
  } finally {
    await dropAll(pool);
    await pool.close();
  }
}

async function dropAll(pool: ConnectionPool): Promise<void> {
  for (const table of [...TABLES, ...await modTables(pool)]) {
    await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/*** Compile `edgeql` as ann, with every type's policies registered the way the server does. ***/
function compileAsAnn(edgeql: string, schema: Schema): string {
  const compiler = new EdgeQLCompiler(schema, {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
    accessContext: { userId: ANN },
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

/*** The single column of each row, in row order (a shaped row is its object). ***/
async function values(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<unknown[]> {
  const result = await pool.query(compileAsAnn(edgeql, schema));
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

/*** Run a mutation as ann. ***/
async function run(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<void> {
  await pool.query(compileAsAnn(edgeql, schema));
}

async function column(pool: ConnectionPool, sql: string): Promise<unknown[]> {
  return (await pool.query(sql)).rows.map(row => Object.values(row)[0]);
}

Deno.test({
  name: "PG access policy reads: the top-level select is filtered (baseline)",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select AcpUser { name }"), [{ name: "ann" }]);
      assertEquals(await sorted(pool, schema, "select AcpPost.title"), ["A1", "B1"]);
    })
});

Deno.test({
  name: "PG access policy reads: a with binding holds only the objects the policy shows",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "with u := AcpUser select u { name, secret }"), [{ name: "ann", secret: "ann-s" }]);
      assertEquals(await values(pool, schema, "with u := (select AcpUser) select u { name }"), [{ name: "ann" }]);
      assertEquals(await values(pool, schema, "with u := (select AcpUser filter .name = 'bob') select u.posts { title }"), []);
      assertEquals(await values(pool, schema, "with u := AcpUser, v := (select u) select v.name"), ["ann"]);
      // A binding named like the table: its query reads the table, the body the binding.
      assertEquals(await values(pool, schema, "with acp_user := (select AcpUser) select acp_user { name }"), [{ name: "ann" }]);
    })
});

Deno.test({
  name: "PG access policy reads: a for over objects iterates only the objects the policy shows",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "for u in AcpUser union (select u { name })"), [{ name: "ann" }]);
      assertEquals(await sorted(pool, schema, "for p in (select AcpPost) union (select p.title)"), ["A1", "B1"]);

      await run(pool, schema, "for u in (select AcpUser) union (update u set { secret := 'x' })");
      assertEquals(await column(pool, "SELECT secret FROM acp_user ORDER BY name"), ["x", "bob-s"]);

      await run(pool, schema, "for u in (select AcpUser filter .name = 'bob') union (delete u)");
      assertEquals(await column(pool, "SELECT name FROM acp_user ORDER BY name"), ["ann", "bob"]);
    })
});

Deno.test({
  name: "PG access policy reads: an update or delete body of a for honours its own policy",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // Both notes are visible; only the unlocked one may be updated or deleted.
      await run(pool, schema, "for n in AcpNote union (update n set { body := 'edited' })");
      assertEquals(await column(pool, "SELECT body FROM acp_note ORDER BY id"), ["edited", "n-locked"]);

      await run(pool, schema, "for n in (select AcpNote) union (delete n)");
      assertEquals(await column(pool, "SELECT body FROM acp_note ORDER BY id"), ["n-locked"]);
    })
});

Deno.test({
  name: "PG access policy reads: a path's root, intermediate and reached objects are all filtered",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // B1 is published but reached only through bob, who is hidden.
      assertEquals(await values(pool, schema, "select AcpUser.posts { title }"), [{ title: "A1" }]);
      assertEquals(await values(pool, schema, "select AcpUser.posts.title"), ["A1"]);
      // c2 hangs off hidden A2, c3 off B1 reached through hidden bob.
      assertEquals(await values(pool, schema, "select AcpUser.posts.comments { body }"), [{ body: "c1" }]);
      assertEquals(await values(pool, schema, "select AcpUser.posts.comments.body"), ["c1"]);
      assertEquals(await values(pool, schema, "select AcpUser.best { title }"), []);
      assertEquals(await values(pool, schema, "select AcpUser.<author[is AcpPost] { title }"), [{ title: "A1" }]);
      assertEquals(await values(pool, schema, "select AcpPost.author.name"), ["ann"]);
      // A2 is hidden; B1 is visible and reached from a comment, not through bob.
      assertEquals(await sorted(pool, schema, "select AcpComment.<comments[is AcpPost].title"), ["A1", "B1"]);
    })
});

Deno.test({
  name: "PG access policy reads: computed paths and link or backlink sub-shapes are filtered",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select AcpUser { name, titles := .posts.title }"), [{ name: "ann", titles: ["A1"] }]);
      assertEquals(await values(pool, schema, "select AcpUser { name, authored := .<author[is AcpPost] { title } }"), [{
        authored: [{ title: "A1" }],
        name: "ann"
      }]);
      // A single link to a hidden object reads as no link.
      assertEquals(await values(pool, schema, "select AcpUser { name, posts: { title }, best: { title } }"), [{
        best: null,
        name: "ann",
        posts: [{ title: "A1" }]
      }]);
      assertEquals(await values(pool, schema, "select AcpPost { title, author: { name } } order by .title"), [
        { author: [{ name: "ann" }], title: "A1" },
        { author: null, title: "B1" }
      ]);
      // A bare link to a hidden object is empty, not its id.
      assertEquals(await values(pool, schema, "select AcpPost { title, author } order by .title"), [
        { author: ANN, title: "A1" },
        { author: null, title: "B1" }
      ]);
      assertEquals(await values(pool, schema, "select AcpUser { name, posts }"), [{ name: "ann", posts: [A1] }]);
      assertEquals(await values(pool, schema, "select AcpComment { body, on_post := .<comments[is AcpPost].title } order by .body"), [
        { body: "c1", on_post: ["A1"] },
        { body: "c2", on_post: [] },
        { body: "c3", on_post: ["B1"] }
      ]);
      assertEquals(await values(pool, schema, "select AcpUser { name, bp := .best.title }"), [{ bp: null, name: "ann" }]);
      assertEquals(await values(pool, schema, "select AcpUser { name, t := .best.comments.body }"), [{ name: "ann", t: [] }]);
      assertEquals(await values(pool, schema, "select AcpUser { name, pc := .posts.comments { body } }"), [{ name: "ann", pc: [{ body: "c1" }] }]);
    })
});

Deno.test({
  name: "PG access policy reads: aggregates and exists count only visible objects",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select count(AcpUser)"), [1]);
      assertEquals(await values(pool, schema, "select count(AcpUser.posts)"), [1]);
      assertEquals(await values(pool, schema, "select AcpUser { name, n := count(.posts) }"), [{ n: 1, name: "ann" }]);
      assertEquals(await values(pool, schema, "select exists (select AcpUser filter .name = 'bob')"), [false]);
      assertEquals(await values(pool, schema, "select AcpUser { name, has := exists .best }"), [{ has: false, name: "ann" }]);
      assertEquals(await values(pool, schema, "select AcpComment { body, n := count(.<comments[is AcpPost]) } order by .body"), [
        { body: "c1", n: 1 },
        { body: "c2", n: 0 },
        { body: "c3", n: 1 }
      ]);
      assertEquals(await values(pool, schema, "select AcpPost { title, has := exists .author } order by .title"), [
        { has: true, title: "A1" },
        { has: false, title: "B1" }
      ]);
    })
});

Deno.test({
  name: "PG access policy reads: set literals, groups and casts of subqueries are filtered",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const both = await values(pool, schema, "select {(select AcpUser filter .name = 'bob'), (select AcpUser filter .name = 'ann')}") as {
        name: string;
      }[];
      assertEquals(both.map(user => user.name), ["ann"]);
      assertEquals(await sorted(pool, schema, "select {(select AcpUser.name), 'z'}"), ["ann", "z"]);
      const [group] = await values(pool, schema, "group AcpPost by .published") as { elements: { title: string; }[]; }[];
      assertEquals(group.elements.map(post => post.title).sort(), ["A1", "B1"]);
      assertEquals((await values(pool, schema, "select <json>(select AcpUser)") as { name: string; }[]).map(user => user.name), ["ann"]);
    })
});

Deno.test({
  name: "PG access policy reads: a filter over a path does not see hidden objects",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select AcpUser { name } filter .posts.title = 'A2'"), []);
      assertEquals(await values(pool, schema, "select AcpUser { name } filter .posts.title = 'A1'"), [{ name: "ann" }]);
      assertEquals(await values(pool, schema, "select AcpUser { name } filter .posts.id = <uuid>'" + A2 + "'"), []);
      assertEquals(await values(pool, schema, "select AcpPost { title } filter .author.name = 'bob'"), []);
      assertEquals(await values(pool, schema, "select AcpPost { title } filter .author.secret = 'bob-s'"), []);
      assertEquals(await values(pool, schema, "select AcpPost { title } filter .author.id = <uuid>'" + BOB + "'"), []);
      assertEquals(await values(pool, schema, "select AcpPost { title } filter .author = <uuid>'" + BOB + "'"), []);
      assertEquals(await values(pool, schema, "select AcpPost { title } filter .author.id in (select AcpUser.id)"), [{ title: "A1" }]);
      assertEquals(await values(pool, schema, "select AcpComment { body } filter .<comments[is AcpPost].title = 'A2'"), []);
    })
});

Deno.test({
  name: "PG access policy reads: a mutation's link subquery and returning shape do not see hidden objects",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(
        await values(
          pool,
          schema,
          "select (insert AcpPost { title := 'N', published := true, author := (select AcpUser filter .name = 'bob' limit 1) }) { title, author: { name } }"
        ),
        [{ author: null, title: "N" }]
      );
      assertEquals(await column(pool, "SELECT author_id FROM acp_post WHERE title = 'N'"), [null]);
    })
});

/*** Run `edgeql` statements as ann in one transaction (so `set global` holds); the single column of the last one's rows. ***/
async function inSession(pool: ConnectionPool, schema: Schema, ...edgeql: string[]): Promise<unknown[]> {
  return await pool.transaction(async connection => {
    let rows: Record<string, unknown>[] = [];
    for (const statement of edgeql) {
      rows = (await connection.query(compileAsAnn(statement, schema))).rows as Record<string, unknown>[];
    }
    return rows.map(row => Object.values(row)[0]);
  });
}

Deno.test({
  name: "PG access policy writes: update and delete reach only objects the select policy shows",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // t-hidden passes the update policy but not the select policy.
      assertEquals(await values(pool, schema, "select (update AcpTask set { body := 'u' }) { name }"), [{ name: "t-edit" }]);
      assertEquals(await column(pool, "SELECT name FROM acp_task WHERE body = 'u'"), ["t-edit"]);

      await run(pool, schema, "update AcpTask filter .name = 't-hidden' set { body := 'u2' }");
      assertEquals(await column(pool, "SELECT body FROM acp_task WHERE name = 't-hidden'"), ["b"]);

      assertEquals(await values(pool, schema, "with t := (delete AcpTask) select t { name }"), [{ name: "t-edit" }]);
      assertEquals(await column(pool, "SELECT name FROM acp_task ORDER BY name"), ["t-done", "t-hidden"]);
    })
});

Deno.test({
  name: "PG access policy writes: objects that cannot be selected cannot be updated or deleted",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select (update AcpDraft set { body := 'x' }) { body }"), []);
      await run(pool, schema, "delete AcpDraft");
      assertEquals(await column(pool, "SELECT body FROM acp_draft"), ["d1"]);
    })
});

Deno.test({
  name: "PG access policy writes: a for body updates and deletes only selectable objects",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "for n in {'a'} union (update AcpTask set { body := n })");
      assertEquals(await column(pool, "SELECT name FROM acp_task WHERE body = 'a'"), ["t-edit"]);

      await run(pool, schema, "for c in (select AcpComment filter .body = 'c1') union (update AcpTask set { body := c.body })");
      assertEquals(await column(pool, "SELECT name FROM acp_task WHERE body = 'c1'"), ["t-edit"]);

      await run(pool, schema, "for n in {'a'} union (delete AcpTask)");
      assertEquals(await column(pool, "SELECT name FROM acp_task ORDER BY name"), ["t-done", "t-hidden"]);
    })
});

Deno.test({
  name: "PG access policy writes: an upsert's else branch updates only a selectable, updatable conflicting object",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const upsert = (name: string): string =>
        `insert AcpTask { name := '${name}', visible := true } unless conflict on .name else (update AcpTask set { body := 'upserted' })`;
      await run(pool, schema, upsert("t-edit"));
      await run(pool, schema, upsert("t-hidden"));
      await run(pool, schema, upsert("t-done"));
      assertEquals(await column(pool, "SELECT name FROM acp_task WHERE body = 'upserted'"), ["t-edit"]);
      assertEquals(await column(pool, "SELECT count(*)::int FROM acp_task"), [3]);
    })
});

Deno.test({
  name: "PG access policy writes: a multi-link update writes links only from selectable, updatable objects",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "update AcpTask set { tags += (select AcpComment filter .body = 'c1') }");
      assertEquals(await column(pool, "SELECT t.name FROM acp_task_tags j JOIN acp_task t ON t.id = j.source_id"), ["t-edit"]);

      await run(pool, schema, "update AcpTask set { body := 'm', tags := (select AcpComment filter .body = 'c2') }");
      assertEquals(await column(pool, "SELECT name FROM acp_task WHERE body = 'm'"), ["t-edit"]);
      assertEquals(await column(pool, "SELECT source_id::text FROM acp_task_tags"), [T_EDIT]);
    })
});

Deno.test({
  name: "PG access policy inheritance: a subtype is filtered by its parent's policies and its own",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await values(pool, schema, "select AcpDoc.title"), ["ann-doc"]);
      assertEquals(await sorted(pool, schema, "select AcpSheet.title"), ["ann-sheet", "shared"]);
      // The abstract parent reads each subtype's rows under that subtype's policies.
      assertEquals(await sorted(pool, schema, "select AcpOwned { title }"), [{ title: "ann-doc" }, { title: "ann-sheet" }, { title: "shared" }]);
      assertEquals(await values(pool, schema, "select count(AcpDoc)"), [1]);
      // So does a path, and a `for`, over the abstract parent.
      assertEquals(await sorted(pool, schema, "select AcpOwned.title"), ["ann-doc", "ann-sheet", "shared"]);
      assertEquals(await sorted(pool, schema, "for o in AcpOwned union (select o.title)"), ["ann-doc", "ann-sheet", "shared"]);
    })
});

Deno.test({
  name: "PG access policy inheritance: an update or delete of the abstract parent answers to each subtype's policies",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // 'shared' is visible, but only the owner may update it (the parent's `owned`).
      await run(pool, schema, "update AcpOwned set { title := .title ++ '!' }");
      assertEquals(await column(pool, "SELECT title FROM acp_doc ORDER BY title"), ["ann-doc!", "bob-doc"]);
      assertEquals(await column(pool, "SELECT title FROM acp_sheet ORDER BY title"), ["ann-sheet!", "bob-sheet", "shared"]);

      await run(pool, schema, "delete AcpOwned");
      assertEquals(await column(pool, "SELECT title FROM acp_doc ORDER BY title"), ["bob-doc"]);
      assertEquals(await column(pool, "SELECT title FROM acp_sheet ORDER BY title"), ["bob-sheet", "shared"]);
    })
});

Deno.test({
  name: "PG access policy inheritance: writes to a subtype answer to its parent's policies",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "update AcpDoc set { title := 'x' }");
      assertEquals(await column(pool, "SELECT title FROM acp_doc ORDER BY title"), ["bob-doc", "x"]);

      // 'shared' is visible through the sheet's own policy, but only the owner may delete (the parent's `owned`).
      await run(pool, schema, "delete AcpSheet");
      assertEquals(await column(pool, "SELECT title FROM acp_sheet ORDER BY title"), ["bob-sheet", "shared"]);
    })
});

Deno.test({
  name: "PG access policy globals: a row policy over a custom uuid global filters by the value set",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await inSession(pool, schema, "select AcpTenantRow.label"), []);
      assertEquals(await inSession(pool, schema, `set global acp_tenant := <uuid>'${TENANT_1}'`, "select AcpTenantRow.label"), ["r1"]);
      assertEquals(await inSession(pool, schema, `set global default::acp_tenant := <uuid>'${TENANT_2}'`, "select AcpTenantRow.label"), ["r2"]);
      await inSession(pool, schema, `set global acp_tenant := <uuid>'${TENANT_2}'`, "update AcpTenantRow set { label := 'r2-edited' }");
      assertEquals(await column(pool, "SELECT label FROM acp_tenant_row ORDER BY label"), ["r1", "r2-edited"]);
    })
});

Deno.test({
  name: "PG access policy globals: an unset global with a default reads as its default, in policies and queries",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await inSession(pool, schema, "select AcpLabelRow.label"), ["public"]);
      assertEquals(await inSession(pool, schema, "set global acp_label := 'secret'", "select AcpLabelRow.label"), ["secret"]);
      assertEquals(await inSession(pool, schema, "select global acp_label"), ["public"]);
      // Updates need the row visible (acp_label) and at the level (the required acp_level, 1 unless set).
      await inSession(pool, schema, "update AcpLabelRow set { label := 'public-edited' }");
      await inSession(pool, schema, "set global acp_label := 'secret'", "update AcpLabelRow set { label := 'secret-edited' }");
      await inSession(pool, schema, "set global acp_level := 2", "set global acp_label := 'secret'", "update AcpLabelRow set { label := 'secret-at-2' }");
      assertEquals(await column(pool, "SELECT label FROM acp_label_row ORDER BY level"), ["public-edited", "secret-at-2"]);
    })
});

Deno.test({
  name: "PG access policy globals: a policy in another module reads that module's global",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const [table] = await modTables(pool);
      await pool.query(`INSERT INTO "${table}" (label, tenant) VALUES ('m1', '${TENANT_1}'), ('m2', '${TENANT_2}')`);
      assertEquals(await inSession(pool, schema, "select acp::AcpModRow.label"), []);
      assertEquals(await inSession(pool, schema, `set global acp::tenant := <uuid>'${TENANT_2}'`, "select acp::AcpModRow.label"), ["m2"]);
    })
});

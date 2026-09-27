/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Paths over links and `for` loops over objects, at the SQL level: a path's
 * objects are the reached type's rows whose ids are `IN` the ids each hop
 * reaches, and a `for` variable over objects is a row of the iterator. Rows
 * are checked in pg-path-select.test.ts and pg-for-objects.test.ts.
 */

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import type { AccessPolicy } from "../access/types.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `module default {
  abstract type Named {
    required name: str;
  }
  type Tag extending Named;
  type Comment {
    required body: str;
  }
  type Post {
    required title: str;
    author: User;
    multi comments: Comment;
  }
  type User {
    required name: str;
    best: Post;
    multi posts: Post;
    multi tags: str;
    multi labels: Named;
  }
  type Person {
    required name: str;
    nickname: str;
    manager: Person;
    multi reports: Person;
  }
}`;

let cachedSchema: Schema | undefined;

async function schema(): Promise<Schema> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(SDL);
    if (!parsed.ok) {
      throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
    }
    cachedSchema = manager.modulesToSchema(parsed.value);
  }
  return cachedSchema;
}

async function sqlOf(edgeql: string): Promise<string> {
  const result = new EdgeQLCompiler(await schema(), { enableAccessControl: false }).compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw result.error;
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");
}

async function errorOf(edgeql: string): Promise<CompilationError> {
  const result = new EdgeQLCompiler(await schema(), { enableAccessControl: false }).compile(new EdgeQLParser(edgeql).parse());
  assert(!result.ok, `expected ${edgeql} to fail`);
  return result.error;
}

Deno.test("path select - a multi link path reads the target table, keeping ids reached from the source type", async () => {
  const sql = await sqlOf("select User.posts { title }");
  assertMatch(
    sql,
    /^SELECT jsonb_build_object\('title', post_(\d+)\.title\) FROM post AS post_\1 WHERE post_\1\.id IN \(SELECT (__j_posts_\d+)\.target_id FROM user_posts AS \2 WHERE \2\.source_id IN \(SELECT (user_\d+)\.id FROM "user" AS \3\)\)$/
  );
});

Deno.test("path select - the filter is ANDed with the path's condition and resolves on the reached type", async () => {
  const sql = await sqlOf("select User.posts { title } filter .title = 'x' order by .title limit 1");
  assertMatch(sql, /WHERE \(post_(\d+)\.id IN \(.*\)\) AND \(post_\1\.title = 'x'\) ORDER BY post_\1\.title ASC LIMIT 1$/);
});

Deno.test("path select - a trailing property is read from each reached object", async () => {
  const sql = await sqlOf("select User.posts.comments.body");
  assertMatch(sql, /^SELECT comment_(\d+)\.body FROM comment AS comment_\1 WHERE comment_\1\.id IN \(SELECT __j_comments_\d+\.target_id FROM post_comments/);
  assertStringIncludes(sql, "FROM user_posts AS __j_posts_");
});

Deno.test("path select - a single link hop reads the link column of the source rows", async () => {
  const sql = await sqlOf("select User.best.title");
  assertMatch(sql, /WHERE post_\d+\.id IN \(SELECT (__f_best_\d+)\.best_id FROM "user" AS \1 WHERE \1\.id IN \(SELECT user_\d+\.id FROM "user"/);
});

Deno.test("path select - a trailing multi property is one row per value", async () => {
  assertStringIncludes(await sqlOf("select Post.author.tags"), "SELECT unnest(user_");
});

Deno.test("path select - Type.property keeps its single-table SQL", async () => {
  assertEquals(await sqlOf("select User.name"), `SELECT user_1.name FROM "user" AS user_1`);
});

Deno.test("path select - an optional trailing property adds no element for an object without it", async () => {
  assertEquals(
    await sqlOf("select Person.nickname"),
    "SELECT person_1.nickname FROM person AS person_1 WHERE person_1.nickname IS NOT NULL"
  );
  assertMatch(await sqlOf("select Person.manager.nickname"), /WHERE \(person_(\d+)\.id IN \(.*\)\) AND \(person_\1\.nickname IS NOT NULL\)$/);
});

Deno.test("path select - exists over a type reads a select of its objects", async () => {
  assertMatch(await sqlOf("select exists User"), /^SELECT EXISTS \(SELECT .* FROM "user" AS user_\d+\)$/);
});

Deno.test("path select - a backlink hop keeps the objects whose link holds a reached id", async () => {
  assertMatch(
    await sqlOf("select User.<author[is Post] { title }"),
    /SELECT (__b_author_\d+)\.id FROM post AS \1 WHERE \1\.author_id IN \(SELECT user_\d+\.id/
  );
  // Junction-backed: the junction's source rows for the reached targets.
  assertMatch(
    await sqlOf("select Person.<reports[is Person].name"),
    /SELECT (__bj_reports_\d+)\.source_id FROM person_reports AS \1 WHERE \1\.target_id IN \(SELECT person_\d+\.id/
  );
});

Deno.test("path select - a with binding root starts from the binding's ids", async () => {
  const sql = await sqlOf("with u := (select User filter .name = 'a') select u.posts.title");
  assertMatch(sql, /WHERE __j_posts_\d+\.source_id IN \(SELECT (u_\d+)\.id FROM u AS \1\)/);
});

Deno.test("path select - aggregates and exists read a select of the path", async () => {
  assertMatch(await sqlOf("select count(User.posts)"), /^SELECT \(SELECT COUNT\(\*\) FROM \(SELECT .* FROM post AS post_\d+ WHERE .*\) AS __set\)$/);
  assertStringIncludes(await sqlOf("select exists User.posts.comments"), "EXISTS (SELECT");
  // One object's set: correlated to the shape's row.
  assertMatch(await sqlOf("select User { n := count(.posts.comments) }"), /__j_posts_\d+\.source_id = user_1\.id/);
});

Deno.test("path select - the reached type's select policy applies to the path's rows", async () => {
  const compiler = new EdgeQLCompiler(await schema(), {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: false, mode: "permissive" },
    enableAccessControl: true
  });
  const denyPosts: AccessPolicy = { actions: [{ allow: false, operations: ["select"] }], name: "deny_posts", objectType: "Post" };
  compiler.registerAccessPolicy(denyPosts);
  const result = compiler.compile(new EdgeQLParser("select User.posts { title }").parse());
  assert(result.ok);
  assertMatch(
    new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " "),
    /FROM \( SELECT \* FROM post AS __policy_rows WHERE FALSE \) AS post_\d+ WHERE post_\d+\.id IN/
  );
});

Deno.test("computed path - a path through a multi link is a JSON array of the values", async () => {
  const sql = await sqlOf("select User { titles := .posts.title }");
  assertMatch(
    sql,
    /'titles', \(SELECT COALESCE\(jsonb_agg\(__agg\.v\), '\[\]'::jsonb\) FROM \(SELECT post_(\d+)\.title FROM post AS post_\1 WHERE post_\1\.id IN \(SELECT (__j_posts_\d+)\.target_id FROM user_posts AS \2 WHERE \2\.source_id = user_1\.id\)\) AS __agg\(v\)\)/
  );
});

Deno.test("computed path - a path through single links stays one value", async () => {
  const sql = await sqlOf("select Person { boss := .manager.name }");
  assertStringIncludes(sql, `'boss', (SELECT "__l0_manager"."name" FROM "person" "__l0_manager"`);
});

Deno.test("computed path - a bare path to objects answers their ids", async () => {
  assertMatch(
    await sqlOf("select User { ps := .posts }"),
    /'ps', \(SELECT COALESCE\(jsonb_agg\(__agg\.v\), '\[\]'::jsonb\) FROM \(SELECT jsonb_build_object\('id', post_\d+\.id\)/
  );
});

Deno.test("backlink sub-shape - a shaped backlink is an array of shaped objects, with its filter and order", async () => {
  const expected =
    /'r', \(SELECT COALESCE\(jsonb_agg\(__agg\.v\), '\[\]'::jsonb\) FROM \(SELECT jsonb_build_object\('name', person_(\d+)\.name\) FROM person AS person_\1 WHERE \(person_\1\.id IN \(SELECT (__b_manager_\d+)\.id FROM person AS \2 WHERE \2\.manager_id = person_1\.id\)\) AND \(person_\1\.name != ''\) ORDER BY person_\1\.name ASC\) AS __agg\(v\)\)/;
  assertMatch(await sqlOf("select Person { r := .<manager[is Person] { name } filter .name != '' order by .name }"), expected);
  assertMatch(await sqlOf("select Person { r := (select .<manager[is Person] { name } filter .name != '' order by .name) }"), expected);
});

Deno.test("backlink sub-shape - a lone unshaped backlink keeps its [{ id }] form", async () => {
  assertStringIncludes(
    await sqlOf("select Person { r := .<manager[is Person] }"),
    `(SELECT COALESCE(jsonb_agg(jsonb_build_object('id', "__bl_manager"."id")), '[]'::jsonb) FROM "person" "__bl_manager"`
  );
});

Deno.test("path select - unsupported steps fail with a clear error and location", async () => {
  assertStringIncludes((await errorOf("select User.posts@role")).message, "a link property in a selected path is not supported yet");
  assertStringIncludes((await errorOf("select User.posts[is Post]")).message, "a type intersection in a selected path is not supported yet");
  const unknown = await errorOf("select Nope.posts");
  assertStringIncludes(unknown.message, "Cannot select 'Nope.posts'");
  assertEquals([unknown.context?.location?.line, unknown.context?.location?.column], [1, 8]);

  const backlink = await errorOf("select\n  User.<author");
  assertStringIncludes(backlink.message, "without a type intersection");
  assertEquals([backlink.context?.location?.line, backlink.context?.location?.column], [2, 7]);
});

Deno.test("path select - a path through an abstract type reads its concrete subtypes' table", async () => {
  // Named's objects are Tags: its own table holds none.
  assertMatch(await sqlOf("select User.labels.name"), /^SELECT (named_\d+)\.name FROM \(SELECT id, __type__, name FROM tag\) AS \1 WHERE/);
  assertMatch(await sqlOf("select Named.name"), /^SELECT (named_\d+)\.name FROM \(SELECT id, __type__, name FROM tag\) AS \1$/);
});

Deno.test("for over objects - a select body reads the iterator row in LATERAL", async () => {
  const sql = await sqlOf("for x in (select User filter .name = 'a' order by .name limit 2) union (select x { name, n := count(.posts) })");
  assertMatch(
    sql,
    /^SELECT for_sub\.\* FROM \(SELECT \* FROM "user" AS (user_\d+) WHERE \1\.name = 'a' ORDER BY \1\.name ASC LIMIT 2\) AS (for_iter_\d+), LATERAL \(SELECT jsonb_build_object\('name', \2\.name, 'n', \(SELECT COUNT\(\*\) FROM "user_posts" WHERE "user_posts"\."source_id" = "\2"\."id"\)\)\) AS for_sub$/
  );
  // A bare type, a path, and a bare expression body.
  assertMatch(
    await sqlOf("for x in User union x.name"),
    /^SELECT for_sub\.\* FROM \(SELECT \* FROM "user" AS user_\d+\) AS (for_iter_\d+), LATERAL \(SELECT \1\.name\) AS for_sub$/
  );
  assertMatch(await sqlOf("for p in User.posts union (select p.title)"), /FROM \(SELECT \* FROM post AS post_\d+ WHERE post_\d+\.id IN \(/);
});

Deno.test("for over objects - an insert body is INSERT … SELECT from the iterator, x its id", async () => {
  assertMatch(
    await sqlOf("for x in User union (insert Post { author := x, title := x.name })"),
    /^INSERT INTO post \(author_id, title\) SELECT (for_iter_\d+)\.id, \1\.name FROM \(SELECT \* FROM "user" AS user_\d+\) AS \1 RETURNING id$/
  );
});

Deno.test("for over objects - an update body is UPDATE … FROM the iterator; `update x` keeps x's row", async () => {
  assertMatch(
    await sqlOf("for x in (select User filter .name = 'a') union (update x set { name := x.name ++ '!' })"),
    /^UPDATE "user" SET name = (for_iter_\d+)\.name \|\| '!' FROM \(SELECT \* FROM "user" AS user_\d+ WHERE user_\d+\.name = 'a'\) AS \1 WHERE "user"\.id = \1\.id RETURNING "user"\.\*$/
  );
  assertMatch(
    await sqlOf("for x in User union (update Post filter .author = x set { title := x.name })"),
    /^UPDATE post SET title = (for_iter_\d+)\.name FROM .* AS \1 WHERE post\.author_id = \1\.id RETURNING post\.\*$/
  );
  assertStringIncludes((await errorOf("for x in User union (update x set { posts += (select Post) })")).message, "cannot assign a multi link yet");
});

Deno.test("for over objects - a delete body is DELETE … USING the iterator", async () => {
  assertMatch(
    await sqlOf("for x in (select Post filter .title = 'a') union (delete x)"),
    /^DELETE FROM post USING \(SELECT \* FROM post AS post_\d+ WHERE post_\d+\.title = 'a'\) AS (for_iter_\d+) WHERE post\.id = \1\.id RETURNING post\.\*$/
  );
});

Deno.test("for over objects - an abstract type iterates its concrete subtypes' objects", async () => {
  assertStringIncludes(await sqlOf("for x in Named union (select x.name)"), "FROM tag");
});

Deno.test("for over values - a path to values is a subquery iterator", async () => {
  assertEquals(
    await sqlOf("for n in User.name union (select n)"),
    `SELECT for_sub.* FROM (SELECT user_1.name FROM "user" AS user_1) AS for_iter(val), LATERAL (SELECT for_iter.val) AS for_sub`
  );
});

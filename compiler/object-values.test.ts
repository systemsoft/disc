/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Objects as values, as Gel 7.1 treats them:
 *
 *   - Compared (`=`, `!=`, `?=`, `?!=`, `in`, `not in`), objects are their
 *     identity: a select of objects compiles to their ids, not their JSON
 *     (`uuid = jsonb` failed in PostgreSQL), and a multi link to its targets'
 *     ids. So does a select of objects assigned to a link.
 *   - A `with` binding of a select, update or delete keeping at most one
 *     object is one object; a path from a binding of possibly several, as the
 *     value of a single property or link, is a compile error.
 *   - A shape on `(select …)` and on `(with … select …)`.
 *
 * See server/object-values-pg.test.ts for the same queries against PostgreSQL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Tag {
    required name: str {
      constraint exclusive;
    };
  };

  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    best_friend: User;
    multi friends: User;
  };

  type Post {
    required title: str;
    required author: User;
    multi tags: Tag;
    number: int64;
  };

  type Counter {
    required name: str {
      constraint exclusive;
    };
    required last: int64;
  };
}
`;

const AUTHOR = "author := <User><uuid>$u";
const SINGLE_NUMBER = "possibly more than one element returned by an expression for a property 'number' declared as 'single'";

let cachedSchema: Schema | undefined;

async function testSchema(): Promise<Schema> {
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
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  assert(result.ok, `expected '${edgeql}' to compile: ${result.ok ? "" : result.error.message}`);
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

async function errorOf(edgeql: string): Promise<string> {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  assert(!result.ok, `expected '${edgeql}' not to compile`);
  return result.error.message;
}

/*** The WHERE clause of `sql`'s outermost select. ***/
function whereOf(sql: string): string {
  return sql.slice(sql.lastIndexOf(" WHERE "));
}

Deno.test("object values - a single link compared with a select of objects compares ids", async () => {
  const sql = await sqlOf("select Post { title } filter .author = (select User filter .email = <str>$e)");

  assert(/WHERE post_1\.author_id = \( SELECT (user_\d+)\.id FROM "user" AS \1 WHERE \1\.email = CAST\(\$1 AS text\) \)$/.test(sql), sql);
});

Deno.test("object values - a select of objects on either side, and under !=, ?=, in and not in", async () => {
  const reversed = await sqlOf("select Post { title } filter (select User filter .email = <str>$e) = .author");
  assert(/WHERE \( SELECT (user_\d+)\.id FROM "user" AS \1 WHERE \1\.email = CAST\(\$1 AS text\) \) = post_1\.author_id$/.test(reversed), reversed);

  for (const [op, sqlOp] of [["!=", "!="], ["?=", "IS NOT DISTINCT FROM"], ["in", "IN"], ["not in", "NOT IN"]]) {
    const sql = await sqlOf(`select Post { title } filter .author ${op} (select User filter .name = <str>$n)`);
    assertStringIncludes(sql, `WHERE post_1.author_id ${sqlOp} ( SELECT user_2.id FROM "user" AS user_2 WHERE user_2.name = CAST($1 AS text) )`);
  }
});

Deno.test("object values - a multi link compared with a select of objects compares its targets' ids", async () => {
  const equal = await sqlOf("select Post { title } filter .tags = (select Tag filter .name = <str>$n)");
  assertStringIncludes(
    equal,
    `WHERE EXISTS (SELECT 1 FROM "post_tags" "__j_tags" WHERE "__j_tags"."source_id" = "post_1"."id" AND "__j_tags"."target_id" = ( SELECT tag_2.id FROM tag AS tag_2 WHERE tag_2.name = CAST($1 AS text) ))`
  );

  const member = await sqlOf("select Post { title } filter .tags in (select Tag filter .name = <str>$n)");
  assertStringIncludes(member, `"__j_tags"."target_id" IN ( SELECT tag_2.id FROM tag AS tag_2 WHERE tag_2.name = CAST($1 AS text) ))`);
});

Deno.test("object values - a multi link compared with a with-bound select, and a path through links", async () => {
  const bound = await sqlOf("with t := (select Tag filter .name = <str>$n) select Post { title } filter .tags = t");
  assert(!whereOf(bound).includes("jsonb_build_object"), bound);
  assertStringIncludes(bound, "= ( SELECT id FROM t )");

  const through = await sqlOf("select Post { title } filter .author.best_friend = (select User filter .email = <str>$e)");
  assert(/ = \( SELECT (user_\d+)\.id FROM "user" AS \1 WHERE \1\.email = CAST\(\$1 AS text\) \)$/.test(through), through);
});

Deno.test("object values - a detached select assigned to a link is its objects' ids", async () => {
  const single = await sqlOf(`insert User { name := 'b', email := 'b@x', best_friend := (select detached User filter .email = <str>$e) }`);
  assert(/VALUES \('b', 'b@x', \( SELECT (user_\d+)\.id FROM "user" AS \1 WHERE \1\.email = CAST\(\$1 AS text\) \)\)/.test(single), single);

  const multi = await sqlOf(`insert User { name := 'b', email := 'b@x', friends := (select detached User filter .name = <str>$n) }`);
  assert(/SELECT (user_\d+)\.id FROM "user" AS \1 WHERE \1\.name = CAST\(\$1 AS text\)/.test(multi), multi);
  assert(!multi.includes("jsonb_build_object"), multi);

  const many = await errorOf("insert User { name := 'b', email := 'b@x', best_friend := (select detached User filter .name = 'a') }");
  assertStringIncludes(many, "possibly more than one element returned by an expression for a link 'best_friend' declared as 'single'");
});

Deno.test("object values - a path from a with binding of possibly several objects is refused as a single value", async () => {
  const refused = [
    `with n := (select Counter filter .last > 0) insert Post { title := 'x', ${AUTHOR}, number := n.last }`,
    `with n := (select Counter) insert Post { title := 'x', ${AUTHOR}, number := n.last }`,
    `with n := (update Counter set { last := .last + 1 }) insert Post { title := 'x', ${AUTHOR}, number := n.last }`,
    `with n := (select Counter) update Post filter .title = 'p1' set { number := n.last }`,
    `with n := (select Counter) insert Post { title := 'x', ${AUTHOR}, number := (select n.last) }`,
    `with n := (select Counter) insert Post { title := 'x', ${AUTHOR}, number := n.last + 1 }`,
    `with n := (select Counter), m := n insert Post { title := 'x', ${AUTHOR}, number := m.last }`,
    `with n := (select Counter) insert Post { title := 'x', ${AUTHOR}, number := n.last } unless conflict`
  ];
  for (const query of refused) {
    assertEquals(await errorOf(query), SINGLE_NUMBER, query);
  }

  const link = await errorOf("with u := (select User filter .name = 'ann') insert Post { title := 'x', author := u.best_friend }");
  assertEquals(link, "possibly more than one element returned by an expression for a link 'author' declared as 'single'");
});

Deno.test("object values - a path from a with binding of at most one object, or an aggregate of several, is one value", async () => {
  const accepted = [
    `with n := (select Counter filter .name = <str>$c) insert Post { title := 'x', ${AUTHOR}, number := n.last }`,
    `with n := (select Counter filter .id = <uuid>$c) insert Post { title := 'x', ${AUTHOR}, number := n.last }`,
    `with n := (select Counter limit 1) insert Post { title := 'x', ${AUTHOR}, number := n.last }`,
    `with n := (update Counter filter .name = 'c1' and .last > 0 set { last := .last + 1 }) insert Post { title := 'x', ${AUTHOR}, number := n.last }`,
    `with n := (delete Counter filter .name = 'c1') insert Post { title := 'x', ${AUTHOR}, number := n.last }`,
    `with n := (select Counter filter .name = 'c1'), m := n insert Post { title := 'x', ${AUTHOR}, number := m.last }`,
    `with n := (select Counter) insert Post { title := 'x', ${AUTHOR}, number := max(n.last) }`,
    `with n := (select Counter) insert Post { title := 'x', ${AUTHOR}, number := assert_single(n.last) }`,
    `with n := (select Counter filter .name = 'c1') update Post filter .title = 'p1' set { number := n.last }`
  ];
  for (const query of accepted) {
    await sqlOf(query);
  }

  // A binding of one object is one value in a shape too; of several, an array.
  const one = await sqlOf("with n := (select Counter filter .name = 'c1') select Post { k := n.last }");
  assertStringIncludes(one, "'k', ( SELECT n_3.last FROM n AS n_3 )");
  const several = await sqlOf("with n := (select Counter) select Post { k := n.last }");
  assertStringIncludes(several, "jsonb_agg");
});

Deno.test("object values - select (select …) { shape } is the inner select with the shape", async () => {
  const shaped = await sqlOf("select (select User filter .email = <str>$e) { name }");
  assertEquals(shaped, await sqlOf("select User { name } filter .email = <str>$e"));

  // The outer shape replaces the inner one.
  assertEquals(await sqlOf("select (select User { email } filter .email = <str>$e) { name }"), shaped);

  // Filtered or ordered again: through a binding of the inner select.
  const again = await sqlOf("select (select User order by .name limit 2) { name } order by .email");
  assert(again.startsWith("WITH s AS ( SELECT * FROM \"user\" AS user_1 ORDER BY user_1.name ASC LIMIT 2 )"), again);
  assert(again.endsWith("ORDER BY s_2.email ASC"), again);
});

Deno.test("object values - select (with … select …) { shape } is with … select (select …) { shape }", async () => {
  const inner = await sqlOf("select (with x := <str>$e select User filter .email = x) { name }");
  assertEquals(inner, await sqlOf("with x := <str>$e select (select User filter .email = x) { name }"));
  assertEquals(inner, await sqlOf("with x := <str>$e select User { name } filter .email = x"));

  const bound = await sqlOf("select (with t := (select Tag filter .name = 'b') select Post filter t in .tags) { title } order by .title");
  assert(bound.startsWith("WITH t AS ( SELECT * FROM tag AS tag_1 WHERE tag_1.name = 'b' ), s AS ("), bound);
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A select over a group (`select (group T by …) { … } filter … order by …`),
 * as Gel 7.1 allows it: one SQL `GROUP BY` whose select item is the shape,
 * its filter the `HAVING` and its order by, offset and limit the groups'.
 * The shape reads the group's `key`, `grouping` and `elements`; a computable
 * aggregates the elements over the group's rows (`count(.elements)` is
 * `COUNT(*)`), and the filter and order by read the shape's computables.
 *
 * See server/select-over-group-pg.test.ts for the same queries against PostgreSQL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type User {
    required name: str;
    active: bool;
    role: str;
    score: int64;
  };
  type Post {
    required title: str;
    author: User;
  };
}
`;

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

async function compiled(edgeql: string): Promise<{ error?: string; sql?: string; }> {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  return result.ok ? { sql: new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ") } : { error: result.error.message };
}

async function sqlOf(edgeql: string): Promise<string> {
  const { error, sql } = await compiled(edgeql);
  assert(sql, `expected '${edgeql}' to compile: ${error}`);
  return sql;
}

Deno.test("select over group - the shape is each group's object, its computables aggregating the group's rows", async () => {
  assertEquals(
    await sqlOf("select (group User by .role) { key: {role}, n := count(.elements), total := sum(.elements.score) }"),
    "SELECT jsonb_build_object('key', jsonb_build_object('role', user_1.role), 'n', COUNT(*), 'total', SUM(user_1.score)) " +
      "FROM \"user\" AS user_1 GROUP BY user_1.role"
  );
});

Deno.test("select over group - filter, order by and limit apply to the groups and read the shape's computables", async () => {
  const sql = await sqlOf("select (group User by .role) { key: {role}, n := count(.elements) } filter .n > 1 order by .key.role limit 1");

  assertStringIncludes(sql, "GROUP BY user_1.role HAVING COUNT(*) > 1 ORDER BY user_1.role ASC NULLS FIRST LIMIT 1");
});

Deno.test("select over group - elements take the select's sub-shape; grouping reads as the group's, a bare key as Gel's empty object", async () => {
  const sql = await sqlOf("select (group User { name } by .role) { key, grouping, elements: { score } }");

  assertStringIncludes(sql, "'key', jsonb_build_object()");
  assertStringIncludes(sql, "'grouping', jsonb_build_array('role')");
  assertStringIncludes(sql, "'elements', jsonb_agg(jsonb_build_object('score', user_1.score))");
});

Deno.test("select over group - a group has no other field, with Gel's error", async () => {
  for (const [query, field] of [["{ role }", "role"], ["{ key: {name} }", "name"], ["{ n := count(.members) }", "members"]]) {
    const { error } = await compiled(`select (group User by .role) ${query}`);
    assertEquals(error, `object type 'std::FreeObject' has no link or property '${field}'`);
  }
});

Deno.test("select over group - a computable of the elements' values is each group's set of them", async () => {
  const sql = await sqlOf("select (group User by .role) { key: {role}, names := .elements.name, n := count(.elements) }");

  assertStringIncludes(sql, "'names', COALESCE(jsonb_agg(user_1.name) FILTER (WHERE user_1.name IS NOT NULL), '[]'::jsonb)");
  assertStringIncludes(sql, "'n', COUNT(*)");
});

Deno.test("select over group - the elements' sub-shape takes a filter, an order by and a limit", async () => {
  const sql = await sqlOf("select (group User by .role) { elements: { name } filter .score > 3 order by .name desc limit 1 }");

  assertStringIncludes(
    sql,
    "jsonb_agg(jsonb_build_object('name', user_1.name) ORDER BY user_1.name DESC NULLS LAST) FILTER (WHERE user_1.score > 3)"
  );
  assertStringIncludes(sql, "jsonb_path_query_array(");
});

Deno.test("select over group - `.elements { … }` and a select of the elements are the group's objects in that shape", async () => {
  assertStringIncludes(
    await sqlOf("select (group User by .role) { e := .elements { name } }"),
    "'e', jsonb_agg(jsonb_build_object('name', user_1.name))"
  );
  assertStringIncludes(
    await sqlOf("select (group User by .role) { e := (select .elements { name } filter .score > 3) }"),
    "'e', COALESCE(jsonb_agg(jsonb_build_object('name', user_1.name)) FILTER (WHERE user_1.score > 3), '[]'::jsonb)"
  );
});

Deno.test("group - the grouped objects may be a select, a with binding or a path", async () => {
  const selected = await sqlOf("group (select User filter .active) { name } by .role");
  assertStringIncludes(selected, "WITH ");
  assertStringIncludes(selected, "WHERE user_1.active");
  assertStringIncludes(selected, "'elements', jsonb_agg(jsonb_build_object('name', ");

  assertStringIncludes(await sqlOf("with u := (select User filter .score > 3) group u { name } by .role"), "GROUP BY u_");
  assertStringIncludes(await sqlOf("group Post.author { name } by .role"), "GROUP BY ");
  assertStringIncludes(await sqlOf("select (group (select User filter .active) by .role) { key: {role}, n := count(.elements) }"), "'n', COUNT(*)");
});

Deno.test("group - grouping sets, cube and rollup group by several sets of keys, `grouping` naming each set's", async () => {
  const cube = await sqlOf("group User by cube(.role, .active)");
  assertStringIncludes(cube, "GROUP BY CUBE(user_1.role, user_1.active)");
  assertStringIncludes(cube, "GROUPING(user_1.role)");

  assertStringIncludes(await sqlOf("group User by rollup(.role, .active)"), "GROUP BY ROLLUP(user_1.role, user_1.active)");
  assertStringIncludes(await sqlOf("group User by {.role, .active}"), "GROUP BY GROUPING SETS(user_1.role, user_1.active)");
  assertStringIncludes(
    await sqlOf("group User by .role, {.active, (.name, .score)}"),
    "GROUP BY user_1.role, GROUPING SETS(user_1.active, (user_1.name, user_1.score))"
  );
  assertStringIncludes(await sqlOf("group User by (.role, .active)"), "GROUP BY user_1.role, user_1.active");
});

Deno.test("select over group - the outer filter and order by aggregate the elements, as in `count(.elements) > 1`", async () => {
  assertStringIncludes(
    await sqlOf("select (group User by .role) { key: {role}, n := count(.elements) } filter count(.elements) > 1 order by max(.elements.score)"),
    "GROUP BY user_1.role HAVING COUNT(*) > 1 ORDER BY MAX(user_1.score) ASC NULLS FIRST"
  );
});

Deno.test("select over group - a filter of the elements' values keeps a group any of them passes", async () => {
  assertStringIncludes(await sqlOf("select (group User by .role) { key: {role} } filter .elements.score > 4"), "HAVING BOOL_OR(user_1.score > 4)");
  assertStringIncludes(
    await sqlOf("select (group User by .role) { key: {role} } filter 'bob' in .elements.name or .key.role = 'admin'"),
    "(BOOL_OR(user_1.name = 'bob')) OR (user_1.role = 'admin')"
  );
});

Deno.test("select over group - `in` and `exists` of the elements' values are one value for the group", async () => {
  assertStringIncludes(await sqlOf("select (group User by .role) { key: {role} } filter 'ann' in .elements.name"), "HAVING BOOL_OR(user_1.name = 'ann')");
  assertStringIncludes(
    await sqlOf("select (group User by .role) { key: {role} } filter 'ann' not in .elements.name"),
    "HAVING NOT BOOL_OR(user_1.name = 'ann')"
  );
  const shaped = await sqlOf("select (group User by .role) { key: {role}, has := exists .elements.score, ann := 'ann' in .elements.name }");
  assertStringIncludes(shaped, "'has', COUNT(user_1.score) > 0");
  assertStringIncludes(shaped, "'ann', BOOL_OR(user_1.name = 'ann')");
});

Deno.test("select over group - an order by of the elements' values is a set, with Gel's error", async () => {
  const { error } = await compiled("select (group User by .role) { key: {role} } order by .elements.name");
  assertEquals(error, "possibly more than one element returned by an expression where only singletons are allowed");
});

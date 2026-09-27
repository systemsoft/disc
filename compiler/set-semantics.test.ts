/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Sets where EdgeQL has them and SQL has one value:
 *
 * - A `with` binding of a parenthesised select of scalars
 *   (`a := (select array_unpack(…))`) is a CTE whose one column is `value`,
 *   so `select a filter a > 1 order by a` reads the current row's value, not
 *   the whole CTE as a scalar subquery.
 * - A `for` body over objects is a set: an object without an optional value
 *   adds no element.
 * - An element-wise function (`str_upper`, `len`, …) over a set argument (a
 *   path from a type, a multi path, a set literal, a set-returning call) is
 *   applied to each element, the arguments' sets crossed: a select of the call
 *   reads each argument's set as a FROM item. Aggregates read the call's rows.
 * - `select x := expr …` names the selected set: it is `with x := expr
 *   select x …`, where `x` in the filter and order by is the current element.
 *
 * Real-PG coverage: `compiler/pg-set-semantics.test.ts`.
 */

import { assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Post {
    required title: str;
  }
  type User {
    required name: str;
    visits: int64;
    tags: array<str>;
    multi nicks: str;
    best: Post;
    multi posts: Post;
  }
}
`;

function schema(): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });

  if (!parsed.ok)
    throw parsed.error;

  return mgr.modulesToSchema(parsed.value);
}

function compile(edgeql: string): string {
  const result = new EdgeQLCompiler(schema(), { enableAccessControl: false }).compile(new EdgeQLParser(edgeql).parse());

  if (!result.ok)
    throw result.error;

  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

// ── with a := (select <scalars>) ─────────────────────────────────────────

Deno.test("with binding of a select of scalars: filter and order by read the current row", () => {
  const sql = compile("with a := (select array_unpack(<array<int64>>$x)) select a filter a > 1 order by a desc");

  assertStringIncludes(sql, "WITH a (value) AS (SELECT UNNEST(CAST($1 AS bigint[])))");
  assertStringIncludes(sql, "WHERE a_1.value > 1");
  assertStringIncludes(sql, "ORDER BY a_1.value DESC");
});

Deno.test("with binding of a select of a type's property is scalars, not the type's objects", () => {
  const sql = compile("with a := (select User.name) select a filter a != 'x'");

  assertMatch(sql, /^WITH a \(value\) AS \(SELECT user_\d+\.name FROM "user" AS user_\d+\)/);
  assertStringIncludes(sql, "WHERE a_2.value != 'x'");
});

// ── for over objects: empty values add no element ────────────────────────

Deno.test("for over objects: a scalar expression body of an optional value adds no element for an empty one", () => {
  assertStringIncludes(compile("for u in User union (u.visits + 1)"), "WHERE for_sub IS NOT NULL");
  assertStringIncludes(compile("for u in User union str_upper(u.name)"), "WHERE for_sub IS NOT NULL");
  // A shape is never empty.
  assertEquals(compile("for u in User union u { name }").includes("IS NOT NULL"), false);
});

// ── element-wise functions over set arguments ────────────────────────────

Deno.test("element-wise function over a path from a type: applied to each of the path's values", () => {
  assertMatch(
    compile("select str_upper(User.name)"),
    /^SELECT UPPER\(__arg_\d+\.value\) FROM \(SELECT user_\d+\.name FROM "user" AS user_\d+\) AS __arg_\d+\(value\)$/
  );
  assertMatch(compile("select len(User.name)"), /^SELECT LENGTH\(__arg_\d+\.value\) FROM /);
  // The argument's static type still picks the function.
  assertMatch(compile("select len(User.tags)"), /^SELECT CARDINALITY\(__arg_\d+\.value\) FROM /);
});

Deno.test("element-wise function over a multi path of the current object: a shape element is its array", () => {
  const sql = compile("select User { name, up := str_upper(.posts.title) }");

  assertStringIncludes(sql, "'up', (SELECT COALESCE(jsonb_agg(__agg.v), '[]'::jsonb) FROM (SELECT UPPER(");
});

Deno.test("aggregates over a path from a type aggregate the path's set", () => {
  assertStringIncludes(compile("select count(User.posts.title)"), "SELECT COUNT(*) FROM (SELECT");
  assertStringIncludes(compile("select array_agg(User.name)"), "ARRAY_AGG(__set.value)");
  assertStringIncludes(compile("select count(str_upper(User.name))"), "SELECT COUNT(*) FROM (SELECT UPPER(");
});

Deno.test("element-wise function over a set literal: one element each, multiple set arguments crossed", () => {
  assertMatch(
    compile("select str_upper({'a', 'b'})"),
    /^SELECT UPPER\(__arg_\d+\.value\) FROM \(SELECT set_\d+\.\* FROM \(SELECT 'a' UNION ALL SELECT 'b'\) AS set_\d+\) AS __arg_\d+\(value\)$/
  );
  assertMatch(
    compile("select str_repeat({'a', 'b'}, {1, 2})"),
    /^SELECT REPEAT\(__arg_\d+\.value, __arg_\d+\.value\) FROM \(.*\) AS __arg_\d+\(value\), \(.*\) AS __arg_\d+\(value\)$/
  );
  // A singleton argument stays a value.
  assertEquals(compile("select str_upper({'a'})"), "SELECT UPPER(('a'))");
  // Nested element-wise calls: the inner call is the outer call's set.
  assertMatch(compile("select str_upper(str_trim({' a', 'b '}))"), /^SELECT UPPER\(__arg_\d+\.value\) FROM \(SELECT TRIM\(__arg_\d+\.value\) FROM /);
});

Deno.test("element-wise function over a set elsewhere in an expression is a compile error, not a record or a scalar subquery", () => {
  const error = assertThrows(() => compile("select str_upper({'a', 'b'}) ++ '!'"));
  assertStringIncludes((error as Error).message, "str_upper()");
  assertStringIncludes((error as Error).message, "set");
});

// ── select x := expr ─────────────────────────────────────────────────────

Deno.test("named select: the name in the filter and order by is the current element", () => {
  const objects = compile("select u := User { name } filter u.name = 'a' order by u.name");
  assertMatch(objects, /WHERE u_\d+\.name = 'a' ORDER BY u_\d+\.name ASC/);

  assertStringIncludes(compile("select n := 1 + 1"), "WITH n (value) AS (SELECT 1 + 1)");
  assertStringIncludes(compile("select a := array_unpack(<array<int64>>$x) filter a > 1"), "WHERE a_1.value > 1");
});

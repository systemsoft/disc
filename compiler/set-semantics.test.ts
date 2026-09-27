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
 * - Operators (`+`, `++`, `=`, `and`, `not`, …) and casts over a set apply to
 *   each element like element-wise functions, set operands crossed (`in`
 *   only over its left operand). A set-valued computed shape element is an
 *   array. A filter over a set is true when any element is (Gel's
 *   `EXISTS (SELECT FROM <set> WHERE <value>)`); an order by over a set is an
 *   error, as in Gel.
 * - So is a comparison of a multi property, multi link path or backlink
 *   (`.nicks = 'a'`, `.posts.title = x`): one boolean per element (Gel:
 *   `select User { b := .nicks = 'a1' }` is `[true, false]`). A filter's
 *   condition that is such a comparison, or an `and` of them, tests any
 *   element in place (`'a' = ANY(nicks)`, EXISTS over the link): the filter
 *   is true when any element is, which for a conjunction is each comparison
 *   having a true element. Under `or` and `not` it is one boolean per
 *   element, as in Gel: `not (.nicks = 'a1')` is "some nick is not a1", and
 *   an empty operand leaves no element to be true.
 * - `any(<such a comparison>)` is one boolean, tested in place: the form the
 *   SDK's filters compile to (`not any(.nicks = 'a1')`: no nick is a1).
 * - An aggregate (`any`, `count`, `sum`, …) over one value of the current
 *   object (`any(.visits > 1)`, `count(.best)`) aggregates that value's set
 *   of at most one element, not the enclosing select's rows.
 * - `and`, `or` and `if … else` over an operand that may be empty (an
 *   optional property) are empty when it is, where SQL has `NULL OR TRUE`
 *   true: `filter .visits = 1 or .name = 'bob'` keeps no object without
 *   visits. `?=`, `??` and `exists` give an empty operand a value.
 * - Two comparisons of the same multi path are independent (`.nicks = 'a1'
 *   and .nicks = 'a2'` needs a nick of each), as with Gel's `future
 *   simple_scoping`; pinned in `tests/gel-divergence-pins.test.ts`.
 *
 * Real-PG coverage: `compiler/pg-set-semantics.test.ts`.
 */

import { assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { CompilationError } from "../lib/errors.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Tag {
    required name: str;
  }
  type Post {
    required title: str;
    multi tags: Tag;
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
  const error = assertThrows(() => compile("select [str_upper({'a', 'b'})]"));
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

// ── element-wise operators over sets ─────────────────────────────────────

Deno.test("operator over a set literal: applied to each element, the set is the select's FROM", () => {
  assertMatch(
    compile("select {1, 2} + 1"),
    /^SELECT __arg_\d+\.value \+ 1 FROM \(SELECT set_\d+\.\* FROM \(SELECT 1 UNION ALL SELECT 2\) AS set_\d+\) AS __arg_\d+\(value\)$/
  );
  assertMatch(compile("select 'a' ++ {'x', 'y'}"), /^SELECT 'a' \|\| __arg_\d+\.value FROM \(.*\) AS __arg_\d+\(value\)$/);
  assertMatch(compile("select {1, 2} = 1"), /^SELECT __arg_\d+\.value = 1 FROM /);
  assertMatch(compile("select not {true, false}"), /^SELECT NOT __arg_\d+\.value FROM /);
  assertMatch(compile("select -{1, 2}"), /^SELECT -__arg_\d+\.value FROM /);
  assertMatch(compile("select <str>{1, 2}"), /^SELECT CAST\(__arg_\d+\.value AS text\) FROM /);
  // `in` applies to each element of its left operand; its right operand is a whole set.
  assertMatch(compile("select {1, 2} in {1}"), /^SELECT __arg_\d+\.value IN \(1\) FROM \(.*\) AS __arg_\d+\(value\)$/);
});

Deno.test("operator over two sets: the operands' sets are crossed, left outermost", () => {
  assertMatch(
    compile("select {1, 2} + {10, 20}"),
    /^SELECT (__arg_\d+)\.value \+ (__arg_\d+)\.value FROM \(.*\) AS \1\(value\), \(.*\) AS \2\(value\)$/
  );
});

Deno.test("operator over a path from a type: applied to each of the path's values", () => {
  assertMatch(
    compile("select User.name ++ '!'"),
    /^SELECT __arg_\d+\.value \|\| '!' FROM \(SELECT user_\d+\.name FROM "user" AS user_\d+\) AS __arg_\d+\(value\)$/
  );
});

Deno.test("operator over a set with an operand that may be empty: an empty operand adds no element", () => {
  assertMatch(compile("select User { v := .visits + {1, 2} }"), /WHERE user_\d+\.visits IS NOT NULL/);
  // A literal is never empty; `?=` compares empty operands.
  assertEquals(compile("select {1, 2} + 1").includes("IS NOT NULL"), false);
  assertEquals(compile("select User { v := .visits ?= {1, 2} }").includes("IS NOT NULL"), false);
});

Deno.test("nested operators and functions over sets: each set-valued operand is the outer expression's set", () => {
  assertMatch(compile("select ({1, 2} + 1) * 2"), /^SELECT __arg_\d+\.value \* 2 FROM \(SELECT __arg_\d+\.value \+ 1 FROM /);
  assertMatch(compile("select str_upper({'a', 'b'} ++ '!')"), /^SELECT UPPER\(__arg_\d+\.value\) FROM \(SELECT __arg_\d+\.value \|\| '!' FROM /);
  assertMatch(compile("select str_upper({'a', 'b'}) ++ '!'"), /^SELECT __arg_\d+\.value \|\| '!' FROM \(SELECT UPPER\(__arg_\d+\.value\) FROM /);
  assertStringIncludes(compile("select count({1, 2} + {10, 20})"), "SELECT COUNT(*) FROM (SELECT");
});

Deno.test("for body over a set operator: one element per crossed pair", () => {
  assertMatch(compile("for x in {1, 2} union x + {10, 20}"), /__arg_\d+\.value/);
});

Deno.test("set-valued computed shape element: its elements as an array", () => {
  assertStringIncludes(compile("select User { x := {1, 2} }"), "'x', (SELECT COALESCE(jsonb_agg(__agg.v), '[]'::jsonb) FROM (SELECT set_");
  assertMatch(
    compile("select User { y := {.name, 'z'} }"),
    /'y', \(SELECT COALESCE\(jsonb_agg\(__agg\.v\), '\[\]'::jsonb\) FROM \(SELECT set_\d+\.\* FROM \(SELECT user_\d+\.name UNION ALL SELECT 'z'\)/
  );
  assertMatch(
    compile("select User { z := .name ++ {'a', 'b'} }"),
    /'z', \(SELECT COALESCE\(jsonb_agg\(__agg\.v\), '\[\]'::jsonb\) FROM \(SELECT user_\d+\.name \|\| __arg_\d+\.value FROM /
  );
  assertMatch(
    compile("select User { n := .nicks ++ '!' }"),
    /'n', \(SELECT COALESCE\(jsonb_agg\(__agg\.v\), '\[\]'::jsonb\) FROM \(SELECT __arg_\d+\.value \|\| '!' FROM /
  );
  // A one-element set is one value.
  assertStringIncludes(compile("select User { x := {1} }"), "'x', (1)");
});

Deno.test("filter over a set: true when any element is true (Gel: EXISTS over the set's true elements)", () => {
  assertMatch(
    compile("select User { name } filter {1, 2} = .visits"),
    /WHERE EXISTS \(SELECT 1 FROM \(.*\) AS (__arg_\d+)\(value\) WHERE \(user_\d+\.visits IS NOT NULL\) AND \(\1\.value = user_\d+\.visits\)\)$/
  );
  assertMatch(compile("select User { name } filter .name ++ {'x', 'y'} = 'annx'"), /WHERE EXISTS \(SELECT 1 FROM \(SELECT user_\d+\.name \|\| /);
  // Other conditions join the set's elements in the same EXISTS.
  assertMatch(
    compile("select User { name } filter .name = 'ann' and {1, 2} = .visits"),
    /WHERE EXISTS \(SELECT 1 FROM .* WHERE .*\(\(user_\d+\.name = 'ann'\) AND \(__arg_\d+\.value\)\)\)$/
  );
  // A comparison with a multi path tests any element in place (see "comparison of a multi path in a filter").
  assertMatch(compile("select User { name } filter .nicks = 'a'"), /WHERE 'a' = ANY\(user_\d+\.nicks\)$/);
  assertMatch(compile("select User { name } filter .name in {'a', 'b'}"), /WHERE user_\d+\.name IN \('a', 'b'\)$/);
});

/*** The line and column of the compile error `edgeql` fails with. ***/
function errorLocation(edgeql: string): [number | undefined, number | undefined] {
  const error = assertThrows(() => compile(edgeql), CompilationError);
  return [error.context?.location?.line, error.context?.location?.column];
}

Deno.test("order by a set is a compile error with its location, as in Gel", () => {
  const error = assertThrows(() => compile("select User { name } order by {1, 2}"));
  assertStringIncludes((error as Error).message, "order by");
  assertStringIncludes((error as Error).message, "more than one element");
  assertEquals(errorLocation("select User { name } order by {1, 2}"), [1, 31]);
  assertThrows(() => compile("select User { name } order by .name ++ {'a', 'b'}"), CompilationError, "order by");
});

Deno.test("a set as one value inside another expression is a compile error with its location, not a record", () => {
  assertThrows(() => compile("select [{1, 2} + 1]"), CompilationError, "'+' of a set is a set");
  assertEquals(errorLocation("select [{1, 2} + 1]"), [1, 9]);
  assertThrows(() => compile("select ({1, 2} + 1) ?? 3"), CompilationError, "of a set is a set");
  assertThrows(() => compile("select {1, 2} ?? 3"), CompilationError, "'??' of a set operand");
  assertThrows(() => compile("select User { name } filter .name = ({'a', 'b'} ?? 'c')"), CompilationError);
  // A set literal anywhere but as `in`'s right operand.
  assertEquals(errorLocation("select (1, {2, 3})"), [1, 12]);
  assertThrows(() => compile("select [{1, 2}]"), CompilationError, "set of several elements");
  assertThrows(() => compile("update User filter .name = 'x' set { name := {'a', 'b'} }"), CompilationError, "set of several elements");
  // A set test over a set literal still reads its rows.
  assertStringIncludes(compile("select enumerate({'a', 'b'})"), "ROW_NUMBER() OVER ()");
});

// ── comparisons of multi paths ───────────────────────────────────────────

/*** A shape element `name` compiled to the array of the rows of `SELECT <select> FROM …`. ***/
const ELEMENTS = (name: string, select: string): RegExp =>
  new RegExp(`'${name}', \\(SELECT COALESCE\\(jsonb_agg\\(__agg\\.v\\), '\\[\\]'::jsonb\\) FROM \\(SELECT ${select} FROM `);

Deno.test("comparison of a multi path in a shape element: one boolean per element (Gel), an array", () => {
  const perElement = (edgeql: string, select: string): void => {
    const sql = compile(edgeql);
    assertMatch(sql, ELEMENTS("b", select), edgeql);
    assertEquals(sql.includes("= ANY(") || sql.includes("EXISTS"), false, edgeql);
  };
  perElement("select User { b := .nicks = 'a1' }", "__arg_\\d+\\.value = 'a1'");
  assertMatch(compile("select User { b := .nicks = 'a1' }"), /FROM \(SELECT unnest\(user_\d+\.nicks\) AS nicks\) AS __arg_\d+\(value\)/);
  perElement("select User { b := 'a1' = .nicks }", "'a1' = __arg_\\d+\\.value");
  perElement("select User { b := .nicks in {'a1'} }", "__arg_\\d+\\.value IN \\('a1'\\)");
  perElement("select User { b := .nicks like 'a%' }", "__arg_\\d+\\.value LIKE 'a%'");
  // Multi links, several hops, and a backlink.
  perElement("select User { b := .posts.title = 'p1' }", "__arg_\\d+\\.value = 'p1'");
  perElement("select User { b := .posts.tags.name = 't1' }", "__arg_\\d+\\.value = 't1'");
  perElement("select Post { b := .<posts[is User].name = 'ann' }", "__arg_\\d+\\.value = 'ann'");
  // `in` a multi path is one boolean: its right operand is a whole set.
  assertStringIncludes(compile("select User { b := 'a1' in .nicks }"), "'b', 'a1' = ANY(user_1.nicks)");
});

Deno.test("comparison of a multi path selected, in a for body or as a function's argument: one element per element", () => {
  assertMatch(compile("select User { b := (select .nicks = 'a1') }"), ELEMENTS("b", "__arg_\\d+\\.value = 'a1'"));
  assertMatch(compile("for u in User union (u.nicks = 'a1')"), /LATERAL \(SELECT __arg_\d+\.value = 'a1' FROM /);
  assertMatch(compile("select User { c := count(.nicks = 'a1') }"), /'c', \(SELECT COUNT\(\*\) FROM \(SELECT __arg_\d+\.value = 'a1' FROM /);
  assertMatch(compile("select User { c := count(.posts.title = 'p1') }"), /'c', \(SELECT COUNT\(\*\) FROM \(SELECT __arg_\d+\.value = 'p1' FROM /);
  // `exists` of the comparison: whether it has elements.
  assertMatch(compile("select User { e := exists (.nicks = 'a1') }"), /'e', EXISTS \(SELECT __arg_\d+\.value = 'a1' FROM /);
});

Deno.test("comparison of a multi path in an order by or inside another expression is a compile error, as other sets", () => {
  assertThrows(() => compile("select User { name } order by .nicks = 'a1'"), CompilationError, "order by");
  assertEquals(errorLocation("select User { name } order by .nicks = 'a1'"), [1, 32]);
  assertThrows(() => compile("select User { name } order by .posts.title = 'p1'"), CompilationError, "more than one element");
  assertThrows(() => compile("select User { b := [.nicks = 'a1'] }"), CompilationError, "'=' of a set is a set");
  assertEquals(errorLocation("select User { b := [.nicks = 'a1'] }"), [1, 22]);
  assertThrows(() => compile("select User { b := [.posts.title = 'p1'] }"), CompilationError, "'=' of a set is a set");
});

Deno.test("comparison of a multi path in a filter: true when any element matches, compiled in place", () => {
  assertMatch(compile("select User { name } filter .nicks = 'a1'"), /WHERE 'a1' = ANY\(user_\d+\.nicks\)$/);
  assertMatch(compile("select User { name } filter 'a1' = .nicks"), /WHERE 'a1' = ANY\(user_\d+\.nicks\)$/);
  assertMatch(compile("select User { name } filter .posts.title = 'p1'"), /WHERE EXISTS \(SELECT 1 FROM "user_posts" .*"__t_posts"\."title" = 'p1'\)$/);
  assertMatch(
    compile("select User { name } filter .posts.tags.name = 't1'"),
    /WHERE EXISTS \(SELECT 1 FROM "post" "__h0_posts" .*"__h1_tags"\."name" = 't1'\)\)$/
  );
  assertMatch(
    compile("select Post { title } filter .<posts[is User].name = 'ann'"),
    /WHERE EXISTS \(SELECT 1 FROM "user_posts" "__blj_posts" .*"__bl_posts"\."name" = 'ann'\)$/
  );
  // Through `and`; each comparison is independent (simple scoping).
  const combined = compile("select User { name } filter .nicks = 'a1' and .posts.title = 'x' and .nicks = 'a2'");
  assertMatch(combined, /WHERE \(\('a1' = ANY\(user_1\.nicks\)\) AND \(EXISTS \(SELECT 1 FROM "user_posts" .*\)\)\) AND \('a2' = ANY\(user_1\.nicks\)\)$/);
  assertEquals(combined.includes("__arg_"), false);
  // An update's and a delete's filter too.
  assertMatch(compile("update User filter .nicks = 'a1' set { visits := 1 }"), /WHERE 'a1' = ANY\(/);
  assertMatch(compile("delete User filter .posts.title = 'p1'"), /WHERE EXISTS \(SELECT 1 FROM "user_posts"/);
});

Deno.test("comparison of a multi path under not or or in a filter: one boolean per element, as in Gel", () => {
  // `not (.nicks = 'a1')`: some nick is not a1 (Gel), not "no nick is a1".
  assertMatch(
    compile("select User { name } filter not (.nicks = 'a1')"),
    /WHERE EXISTS \(SELECT 1 FROM \(SELECT (__arg_\d+)\.value = 'a1' FROM \(SELECT unnest\(user_\d+\.nicks\) AS nicks\) AS \1\(value\)\) AS (__arg_\d+)\(value\) WHERE NOT \2\.value\)$/
  );
  assertMatch(
    compile("select User { name } filter not (.posts.title = 'p1')"),
    /WHERE EXISTS \(SELECT 1 FROM \(SELECT __arg_\d+\.value = 'p1' FROM .* WHERE NOT __arg_\d+\.value\)$/
  );
  // `or`: an empty operand has no element, so the condition has none either.
  assertMatch(
    compile("select User { name } filter .posts.title = 'p1' or .name = 'x'"),
    /WHERE EXISTS \(SELECT 1 FROM \(SELECT __arg_\d+\.value = 'p1' FROM .*\) AS (__arg_\d+)\(value\) WHERE .*\(\(\1\.value\) OR \(user_\d+\.name = 'x'\)\)\)$/
  );
  // An `and` under `or` or `not` is per element too.
  const nested = compile("select User { name } filter not (.nicks = 'a1' and .name = 'x')");
  assertEquals(nested.includes("= ANY("), false, nested);
  assertStringIncludes(nested, "WHERE NOT __arg_");
  // An update's filter too.
  assertMatch(compile("update User filter not (.nicks = 'a1') set { visits := 1 }"), /WHERE EXISTS \(SELECT 1 FROM \(SELECT __arg_/);
});

Deno.test("any() of a comparison of a multi path: one boolean, tested in place", () => {
  assertMatch(compile("select User { name } filter any(.nicks = 'a1')"), /WHERE 'a1' = ANY\(user_\d+\.nicks\)$/);
  assertMatch(compile("select User { name } filter not any(.nicks = 'a1')"), /WHERE NOT 'a1' = ANY\(user_\d+\.nicks\)$/);
  assertMatch(
    compile("select User { name } filter not any(.posts.title = 'p1')"),
    /WHERE NOT EXISTS \(SELECT 1 FROM "user_posts" .*"__t_posts"\."title" = 'p1'\)$/
  );
  assertMatch(compile("select User { name } filter any(.nicks in array_unpack(<array<str>>$x))"), /WHERE user_\d+\.nicks && /);
  assertStringIncludes(compile("select User { b := any(.nicks = 'a1') }"), "'b', 'a1' = ANY(user_1.nicks)");
  // The SDK's filters: in place through `and`, `or` and `not`.
  const sdk = compile(
    "select User { name } filter (not (any(.nicks = <str>$p0))) and (any(.posts.title = <str>$p1)) or (any(.posts.tags.name = <str>$p2))"
  );
  assertStringIncludes(sdk, "WHERE ((NOT CAST($1 AS text) = ANY(user_1.nicks)) AND (EXISTS (SELECT 1 FROM \"user_posts\"");
  assertEquals(sdk.includes("__arg_"), false, sdk);
});

Deno.test("any() and all() of another set of booleans aggregate its rows", () => {
  assertMatch(
    compile("select User { name } filter not any(.best.tags.name = 't1')"),
    /WHERE NOT \(SELECT COALESCE\(BOOL_OR\(__set\.value\), FALSE\) FROM \(SELECT __arg_\d+\.value = 't1' FROM .*\) AS __set\(value\)\)$/
  );
  assertMatch(
    compile("select User { b := all(.nicks = 'a1') }"),
    /'b', \(SELECT COALESCE\(BOOL_AND\(__set\.value\), TRUE\) FROM \(SELECT __arg_\d+\.value = 'a1' FROM .*\) AS __set\(value\)\)/
  );
});

// ── aggregates over a value of the current object ────────────────────────

Deno.test("aggregate over a path of the current object in a shape aggregates that object's set, not the table's", () => {
  const perObject = (edgeql: string, aggregate: string): void => {
    const sql = compile(edgeql);
    assertStringIncludes(sql, `(SELECT ${aggregate} FROM (SELECT `, edgeql);
    assertMatch(sql, /\) AS __set\(value\) WHERE __set\.value IS NOT NULL\)/, edgeql);
    assertEquals(/(BOOL_OR|BOOL_AND|COUNT|SUM|MIN|MAX|ARRAY_AGG|AVG)\(user_/.test(sql), false, sql);
  };
  perObject("select User { b := any(.visits > 1) }", "COALESCE(BOOL_OR(__set.value), FALSE)");
  perObject("select User { b := all(.visits > 1) }", "COALESCE(BOOL_AND(__set.value), TRUE)");
  perObject("select User { c := count(.visits) }", "COUNT(*)");
  perObject("select User { s := sum(.visits) }", "COALESCE(SUM(__set.value), 0)");
  perObject("select User { m := min(.visits) }", "MIN(__set.value)");
  perObject("select User { m := max(.best.title) }", "MAX(__set.value)");
  perObject("select User { a := array_agg(.visits) }", "COALESCE(ARRAY_AGG(__set.value), '{}')");
  perObject("select User { m := math::mean(.visits) }", "AVG(__set.value)");
  perObject("select User { c := count(.best) }", "COUNT(*)");
});

Deno.test("aggregate over a value of the current object in a filter, an order by or a for body: one per object", () => {
  assertMatch(
    compile("select User { name } filter any(.visits > 1)"),
    /WHERE \(SELECT COALESCE\(BOOL_OR\(__set\.value\), FALSE\) FROM \(SELECT user_\d+\.visits > 1\)/
  );
  assertMatch(compile("select User { name } filter count(.visits) = 0"), /WHERE \(SELECT COUNT\(\*\) FROM \(SELECT user_\d+\.visits\)/);
  assertMatch(compile("select User { name } order by count(.visits)"), /ORDER BY \(SELECT COUNT\(\*\) FROM \(SELECT user_\d+\.visits\)/);
  assertMatch(compile("for u in User union count(u.visits)"), /LATERAL \(SELECT \(SELECT COUNT\(\*\) FROM \(SELECT for_iter_\d+\.visits\)/);
});

Deno.test("all() and other aggregates over a comparison of a multi path aggregate its elements", () => {
  assertMatch(
    compile("select User { b := all(.nicks = 'a1') }"),
    /'b', \(SELECT COALESCE\(BOOL_AND\(__set\.value\), TRUE\) FROM \(SELECT __arg_\d+\.value = 'a1' FROM /
  );
  assertMatch(compile("select User { b := any(.nicks ++ '!' = 'a1!') }"), /'b', \(SELECT COALESCE\(BOOL_OR\(__set\.value\), FALSE\) FROM /);
});

// ── empty operands of and, or and if ─────────────────────────────────────

Deno.test("or / and over an operand that may be empty is empty when it is (Gel), not SQL's NULL OR TRUE", () => {
  // In a filter: the `or` holds only when its operands have values.
  assertMatch(
    compile("select User { name } filter .visits = 1 or .name = 'bob'"),
    /WHERE \(\(user_(\d+)\.visits = 1\) OR \(user_\1\.name = 'bob'\)\) AND \(\(user_\1\.visits = 1\) IS NOT NULL\)$/
  );
  // Elsewhere, the empty set (NULL) when an operand is empty.
  assertStringIncludes(
    compile("select User { b := .visits = 1 or .name = 'bob' }"),
    "'b', CASE WHEN (user_1.visits = 1) IS NOT NULL THEN (user_1.visits = 1) OR (user_1.name = 'bob') END"
  );
  assertStringIncludes(
    compile("select User { b := .visits = 1 and false }"),
    "'b', CASE WHEN (user_1.visits = 1) IS NOT NULL THEN (user_1.visits = 1) AND (FALSE) END"
  );
  assertStringIncludes(compile("select User { name } filter not (.visits = 1 and .name = 'x')"), "WHERE NOT CASE WHEN (user_1.visits = 1) IS NOT NULL THEN");
});

Deno.test("or / and over operands that are never empty compile as they are", () => {
  assertMatch(compile("select User { name } filter .name = 'a' or .name = 'b'"), /WHERE \(user_\d+\.name = 'a'\) OR \(user_\d+\.name = 'b'\)$/);
  // A filter's conjunction: NULL and FALSE keep no object alike.
  assertMatch(compile("select User { name } filter .visits = 1 and .name = 'x'"), /WHERE \(user_\d+\.visits = 1\) AND \(user_\d+\.name = 'x'\)$/);
  // `?=`, `exists`, `any()` and `count()` have a value for an empty operand.
  assertMatch(
    compile("select User { name } filter .visits ?= 1 or .name = 'x'"),
    /WHERE \(user_\d+\.visits IS NOT DISTINCT FROM 1\) OR \(user_\d+\.name = 'x'\)$/
  );
  assertMatch(compile("select User { name } filter not exists .visits or .name = 'x'"), /WHERE \(user_\d+\.visits IS NULL\) OR \(user_\d+\.name = 'x'\)$/);
  assertMatch(
    compile("select User { name } filter any(.nicks = <str>$a) or .name = <str>$b"),
    /WHERE \(CAST\(\$1 AS text\) = ANY\(user_\d+\.nicks\)\) OR \(user_\d+\.name = CAST\(\$2 AS text\)\)$/
  );
});

Deno.test("`x ?? false` in a filter's condition is `x`: the SDK's form keeps an index usable", () => {
  assertMatch(
    compile("select User { name } filter ((.visits = <int64>$a) ?? false) or ((.name = <str>$b) ?? false)"),
    /WHERE \(user_\d+\.visits = CAST\(\$1 AS bigint\)\) OR \(user_\d+\.name = CAST\(\$2 AS text\)\)$/
  );
  // Under `not` it is not read only for being true: the COALESCE stays.
  assertStringIncludes(compile("select User { name } filter not ((.visits = 1) ?? false)"), "WHERE NOT COALESCE(user_1.visits = 1, FALSE)");
  assertStringIncludes(compile("select User { b := (.visits = 1) ?? false }"), "'b', COALESCE(user_1.visits = 1, FALSE)");
});

Deno.test("if / else over a condition that may be empty is empty when it is (Gel), not the else branch", () => {
  assertStringIncludes(
    compile("select User { i := 'y' if .visits = 1 else 'n' }"),
    "'i', CASE WHEN user_1.visits = 1 THEN 'y' WHEN NOT user_1.visits = 1 THEN 'n' END"
  );
  assertStringIncludes(compile("select User { i := 'y' if .name = 'x' else 'n' }"), "'i', CASE WHEN user_1.name = 'x' THEN 'y' ELSE 'n' END");
});

Deno.test("a group's filter still aggregates the group's rows", () => {
  assertStringIncludes(compile("group User by .name filter count(User) > 1"), "HAVING COUNT(*) > 1");
});

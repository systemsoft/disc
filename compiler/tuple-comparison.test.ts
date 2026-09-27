/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Whole-tuple comparisons and `array<tuple>` literal writes (compile level;
 * the values are checked against PostgreSQL in
 * server/tuple-comparison-pg.test.ts).
 *
 * Tuples are jsonb, and equal tuples can be different JSON (a datetime as
 * `…Z` or `…+00:00`), so `=`, `!=`, `?=`, `in` rebuild both sides with each
 * such element read as its type (`to_jsonb(CAST(t ->> 'at' AS timestamptz))`).
 * An `array<tuple>` literal is a jsonb array (`jsonb_build_array`), not
 * `ARRAY[…]` (jsonb[]).
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { tupleTypeElements } from "./compiler-base.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

function schemaFromSDL(sdl: string): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(sdl);
  if (!parsed.ok) {
    throw parsed.error;
  }
  return manager.modulesToSchema(parsed.value);
}

const schema = schemaFromSDL(`module default {
  type TupRow {
    required name: str;
    t: tuple<n: int64, at: datetime>;
    u: tuple<int64, datetime>;
    d: tuple<x: decimal, inner: tuple<s: str, at: datetime>>;
    s: tuple<a: str, b: str>;
    ts: array<tuple<n: int64, s: str>>;
  };
};`);

function count(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

Deno.test("tupleTypeElements - splits named, unnamed and nested tuple types", () => {
  assertEquals(tupleTypeElements("tuple<n: int64, at: datetime>"), [{ name: "n", type: "int64" }, { name: "at", type: "datetime" }]);
  assertEquals(tupleTypeElements("tuple<int64, std::str>"), [{ type: "int64" }, { type: "std::str" }]);
  assertEquals(tupleTypeElements("tuple<x: decimal, inner: tuple<s: str, at: datetime>>"), [
    { name: "x", type: "decimal" },
    { name: "inner", type: "tuple<s: str, at: datetime>" }
  ]);
  assertEquals(tupleTypeElements("array<str>"), null);
});

Deno.test("Tuple comparison - `=` reads datetime elements as timestamptz on both sides", () => {
  const sql = compileEdgeQL(`select TupRow { name } filter .t = (n := 1, at := <datetime>'2024-01-01T00:00:00Z')`, schema);
  assertStringIncludes(sql, "to_jsonb(CAST(tuprow_1.t ->> 'at' AS timestamptz))");
  assertEquals(count(sql, "->> 'at' AS timestamptz))"), 2, sql); // the column and the literal
  assertEquals(count(sql, "->> 'n' AS bigint))"), 2, sql);
});

Deno.test("Tuple comparison - a parameter is compared through the same rebuild", () => {
  const sql = compileEdgeQL(`select TupRow { name } filter .t = <tuple<n: int64, at: datetime>>$t`, schema);
  assertStringIncludes(sql, "CAST($1 AS jsonb)");
  assertEquals(count(sql, "to_jsonb(CAST("), 4, sql);
});

Deno.test("Tuple comparison - unnamed tuples are read by index and rebuilt as arrays", () => {
  const sql = compileEdgeQL(`select TupRow { name } filter .u = (1, <datetime>'2024-01-01T00:00:00Z')`, schema);
  assertStringIncludes(sql, "to_jsonb(CAST(tuprow_1.u ->> 1 AS timestamptz))");
  assertEquals(count(sql, "->> 1 AS timestamptz))"), 2, sql);
});

Deno.test("Tuple comparison - nested tuples are rebuilt, strings kept as is", () => {
  const sql = compileEdgeQL(`select TupRow { name } filter .d = (x := 1.5n, inner := (s := "q", at := <datetime>'2024-01-01T00:00:00Z'))`, schema);
  assertStringIncludes(sql, "(tuprow_1.d -> 'inner') ->> 'at'");
  assertStringIncludes(sql, "(tuprow_1.d -> 'inner') -> 's'");
  assertStringIncludes(sql, "AS numeric))");
});

Deno.test("Tuple comparison - `?=`, `!=` and `in` rebuild every operand", () => {
  const optional = compileEdgeQL(`select TupRow { name } filter .t ?= <tuple<n: int64, at: datetime>>{}`, schema);
  assertStringIncludes(optional, "IS NOT DISTINCT FROM");
  assertEquals(count(optional, "to_jsonb(CAST("), 4, optional);

  const unequal = compileEdgeQL(`select TupRow { name } filter .t != (n := 1, at := <datetime>'2024-01-01T00:00:00Z')`, schema);
  assertEquals(count(unequal, "to_jsonb(CAST("), 4, unequal);

  const member = compileEdgeQL(
    `select TupRow { name } filter .t in {(n := 1, at := <datetime>'2024-01-01T00:00:00Z'), (n := 2, at := <datetime>'2024-01-01T00:00:00Z')}`,
    schema
  );
  assertStringIncludes(member, " IN (");
  assertEquals(count(member, "to_jsonb(CAST("), 6, member);
});

Deno.test("Tuple comparison - a tuple of strings only is compared as stored", () => {
  const sql = compileEdgeQL(`select TupRow { name } filter .s = (a := "x", b := "y")`, schema);
  assert(!sql.includes("to_jsonb"), sql);
  assertStringIncludes(sql, "tuprow_1.s = jsonb_build_object('a', 'x', 'b', 'y')");
});

Deno.test("array<tuple> literal - insert writes a jsonb array", () => {
  const sql = compileEdgeQL(`insert TupRow { name := "a", ts := [(n := 1, s := "a"), (n := 2, s := "b")] }`, schema);
  assertStringIncludes(sql, "jsonb_build_array(jsonb_build_object('n', 1, 's', 'a'), jsonb_build_object('n', 2, 's', 'b'))");
  assert(!sql.includes("ARRAY["), sql);
});

Deno.test("array<tuple> literal - an empty cast is an empty jsonb array", () => {
  const sql = compileEdgeQL(`insert TupRow { name := "a", ts := <array<tuple<n: int64, s: str>>>[] }`, schema);
  assertStringIncludes(sql, "jsonb_build_array()");
  assert(!sql.includes("ARRAY["), sql);
});

Deno.test("array<tuple> literal - update set writes a jsonb array", () => {
  const sql = compileEdgeQL(`update TupRow filter .name = "a" set { ts := [(n := 3, s := "c")] }`, schema);
  assertStringIncludes(sql, "jsonb_build_array(jsonb_build_object('n', 3, 's', 'c'))");
});

Deno.test("Tuple comparison - named and unnamed tuples compare by position", () => {
  const literals = compileEdgeQL(`select (1, 'a') = (a := 1, b := 'a')`, schema);
  assertStringIncludes(literals, "->> 0 AS bigint))");
  assertStringIncludes(literals, "->> 'a' AS bigint))");

  const stored = compileEdgeQL(`select TupRow { name } filter .u = (a := 1, b := <datetime>'2024-01-01T00:00:00Z')`, schema);
  assertStringIncludes(stored, "to_jsonb(CAST(tuprow_1.u ->> 1 AS timestamptz))");
  assertStringIncludes(stored, "->> 'b' AS timestamptz))");

  // Strings only, but named differently: rebuilt by position all the same.
  const strings = compileEdgeQL(`select TupRow { name } filter .s = ("x", "y")`, schema);
  assertStringIncludes(strings, "jsonb_build_array(tuprow_1.s -> 'a', tuprow_1.s -> 'b')");
});

Deno.test("Tuple membership - `in array_unpack(<array<tuple<…>>>$p)` reads the jsonb array's elements", () => {
  const sql = compileEdgeQL(`select TupRow { name } filter .t in array_unpack(<array<tuple<n: int64, at: datetime>>>$p)`, schema);
  assertStringIncludes(sql, "jsonb_array_elements(CAST($1 AS jsonb))");
  assertStringIncludes(sql, "->> 'at' AS timestamptz))");
  assert(!sql.includes("ANY("), sql);

  const literal = compileEdgeQL(`select (2, 'b') not in array_unpack([(1, 'a'), (2, 'b')])`, schema);
  assertStringIncludes(literal, "NOT IN (");
  assertStringIncludes(literal, "jsonb_array_elements(jsonb_build_array(");
});

Deno.test("Tuple order - `order by` a tuple sorts by its typed elements in declared order", () => {
  const sql = compileEdgeQL(`select TupRow { name } order by .t desc`, schema);
  assertStringIncludes(sql, "ROW(CAST(tuprow_1.t ->> 'n' AS bigint), CAST(tuprow_1.t ->> 'at' AS timestamptz))");
  assertStringIncludes(sql, "END DESC");

  const nested = compileEdgeQL(`select TupRow { name } order by .d`, schema);
  assertStringIncludes(nested, "ROW(CAST(tuprow_1.d ->> 'x' AS numeric), ROW((tuprow_1.d -> 'inner') -> 's', CAST(");
});

Deno.test("Tuple distinct - `select distinct` of a tuple dedupes its canonical form", () => {
  const sql = compileEdgeQL(`select distinct TupRow.t`, schema);
  assertStringIncludes(sql, "SELECT DISTINCT");
  assertStringIncludes(sql, "jsonb_build_object('n', to_jsonb(CAST(");
});

Deno.test("Tuple distinct - ordering a distinct set of tuples by a tuple is Gel's cardinality QueryError", () => {
  // Gel 7.1: the order key is not bound to the distinct subject, so it is a set.
  assertThrows(
    () => compileEdgeQL(`select distinct TupRow.t order by TupRow.t`, schema),
    Error,
    "possibly more than one element returned by an expression where only singletons are allowed"
  );
});

Deno.test("Tuple group - `group … by` a tuple property groups its canonical form", () => {
  const sql = compileEdgeQL(`group TupRow by .t`, schema);
  assertStringIncludes(sql, "GROUP BY\nCASE\nWHEN tuprow_1.t IS NULL THEN NULL\nELSE jsonb_build_object('n', to_jsonb(CAST(");
  // The key too: the value the rows were grouped by.
  assertStringIncludes(sql, "jsonb_build_object('t', CASE");
});

Deno.test("Tuple write - a parameter written to a tuple property is stored canonical", () => {
  const insert = compileEdgeQL(`insert TupRow { name := "a", t := <tuple<n: int64, at: datetime>>$t }`, schema);
  assertStringIncludes(insert, "to_jsonb(CAST(CAST($1 AS jsonb) ->> 'at' AS timestamptz))");

  const update = compileEdgeQL(`update TupRow filter .name = "a" set { u := <tuple<int64, datetime>>$u }`, schema);
  assertStringIncludes(update, "to_jsonb(CAST(CAST($1 AS jsonb) ->> 1 AS timestamptz))");

  // A literal is built from typed values: canonical already.
  const literal = compileEdgeQL(`insert TupRow { name := "a", t := (n := 1, at := <datetime>'2024-01-01T00:00:00Z') }`, schema);
  assert(!literal.includes("to_jsonb"), literal);
});

Deno.test("array<tuple> write - a parameter written to an array<tuple> property has each tuple stored canonical", () => {
  const insert = compileEdgeQL(`insert TupRow { name := "a", ts := <array<tuple<n: int64, s: str>>>$ts }`, schema);
  assertStringIncludes(insert, "jsonb_array_elements(CAST($1 AS jsonb))");
  assertStringIncludes(insert, "jsonb_build_object('n', to_jsonb(CAST(");

  const update = compileEdgeQL(`update TupRow filter .name = "a" set { ts := <array<tuple<n: int64, s: str>>>$ts }`, schema);
  assertStringIncludes(update, "jsonb_array_elements(CAST($1 AS jsonb))");
});

Deno.test("array<tuple> expressions - literals are jsonb arrays wherever they appear", () => {
  for (const query of [`select [(1, 'a')]`, `select [(1, 'a')] ++ <array<tuple<int64, str>>>$p`, `select len([(1, 'a')])`]) {
    const sql = compileEdgeQL(query, schema);
    assert(!sql.includes("ARRAY["), `${query}: ${sql}`);
  }
  assertStringIncludes(compileEdgeQL(`select len(<array<tuple<int64, str>>>$p)`, schema), "jsonb_array_length(CAST($1 AS jsonb))");
  assertStringIncludes(compileEdgeQL(`select array_unpack(<array<tuple<int64, str>>>$p)`, schema), "jsonb_array_elements(CAST($1 AS jsonb))");
  assertStringIncludes(compileEdgeQL(`select (<array<tuple<int64, str>>>$p)[0]`, schema), "disc_index(CAST($1 AS jsonb), 0)");
  assertStringIncludes(compileEdgeQL(`select array_agg((1, 'a'))`, schema), "to_jsonb(");
});

Deno.test("Distinct - an order key not bound to the distinct subject is Gel's singleton QueryError", () => {
  // Gel 7.1: `distinct` makes a new set; a path from a type or a set binding
  // in the order by is not bound to its elements.
  for (
    const query of [
      `select distinct TupRow.t order by TupRow.t`,
      `select distinct TupRow.name order by TupRow.name`,
      `select distinct TupRow order by TupRow.name`,
      `select distinct TupRow { name } order by TupRow.name`,
      `select distinct TupRow.name order by len(TupRow.name)`,
      `with n := TupRow.name select distinct n order by n`
    ]
  ) {
    assertThrows(
      () => compileEdgeQL(query, schema),
      Error,
      "possibly more than one element returned by an expression where only singletons are allowed",
      query
    );
  }
  for (
    const query of [
      `select distinct TupRow { name } order by .name`,
      `select distinct TupRow order by .name`,
      `select distinct TupRow.name order by count(TupRow)`,
      `select distinct {1, 2, 2} order by 1`,
      `select TupRow.name order by TupRow.name`,
      `for x in (select TupRow) union (select distinct x.name order by x.name)`
    ]
  ) {
    compileEdgeQL(query, schema);
  }
});

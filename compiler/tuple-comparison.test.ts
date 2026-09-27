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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

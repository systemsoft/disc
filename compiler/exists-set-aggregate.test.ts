/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `exists` and set-aggregates over filtered sets.
 *
 * - `exists .prop` used to render the unary operator glued to its operand
 *   (`WHERE EXISTSgit_ref_1.peeled`). On a scalar it is `IS NOT NULL`; on a
 *   link set or a subquery it is a set test.
 * - `count((select X filter …))` used to wrap the subquery in `COUNT(…)`, a
 *   scalar subquery that fails as soon as it yields more than one row. An
 *   aggregate over a set subquery aggregates the subquery's rows.
 *
 * Real-PG coverage lives in `pg-exists-count-optional.test.ts`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import * as SQL from "./sql.ts";

const SDL = `
module default {
  type Tag {
    required label -> str;
  }

  type GitRef {
    required name -> str;
    peeled -> str;
    size -> int64;
    target -> Tag;
    multi tags -> Tag;
  }
}
`;

function schema() {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });
  if (!parsed.ok)
    throw parsed.error;
  return mgr.modulesToSchema(parsed.value);
}

function compile(edgeql: string): string {
  const result = new EdgeQLCompiler(schema()).compile(
    new EdgeQLParser(edgeql).parse()
  );
  if (!result.ok)
    throw result.error;
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

Deno.test("exists - exists on a property is IS NOT NULL", () => {
  const sql = compile("select GitRef { id } filter exists .peeled");
  assertEquals(/EXISTS\S/.test(sql), false, sql);
  assertStringIncludes(sql, "WHERE gitref_1.peeled IS NOT NULL");
});

Deno.test("exists - not exists on a property is IS NULL", () => {
  const sql = compile("select GitRef { id } filter not exists .peeled");
  assertStringIncludes(sql, "WHERE gitref_1.peeled IS NULL");
});

Deno.test("exists - exists on a single link tests its FK column", () => {
  const sql = compile("select GitRef { id } filter exists .target");
  assertStringIncludes(sql, "WHERE gitref_1.target_id IS NOT NULL");
});

Deno.test("exists - exists on a multi link tests the junction rows", () => {
  const sql = compile("select GitRef { id } filter exists .tags");
  assertStringIncludes(sql, `(SELECT COUNT(*) FROM "git_ref_tags" WHERE "git_ref_tags"."source_id" = "gitref_1"."id") > 0`);
});

Deno.test("exists - exists on a subquery is EXISTS (subquery)", () => {
  const sql = compile("select exists (select GitRef filter .name = 'a')");
  assertStringIncludes(sql, "EXISTS ( SELECT");
  assertStringIncludes(sql, "WHERE gitref_1.name = 'a'");
});

Deno.test("exists - std::exists() over a subquery is EXISTS (subquery), not a scalar IS NOT NULL", () => {
  const sql = compile("select std::exists((select GitRef filter .name = 'a'))");
  assertStringIncludes(sql, "EXISTS ( SELECT");
  assertEquals(sql.includes("IS NOT NULL"), false, sql);
});

Deno.test("unary - word operators are separated from their operand", () => {
  const sql = compile("select GitRef { id } filter distinct .name = 'a'");
  assertStringIncludes(sql, "DISTINCT gitref_1.name");
});

Deno.test("SQL.isNotNull renders a postfix IS NOT NULL", () => {
  const gen = new SQLCodeGenerator();
  assertEquals(gen.generateExpression(SQL.isNotNull("peeled")), "peeled IS NOT NULL");
  assertEquals(
    gen.generateExpression(SQL.isNotNull(SQL.createColumnReference("peeled", "r"))),
    "r.peeled IS NOT NULL"
  );
});

Deno.test("aggregate - count over a filtered subquery counts its rows", () => {
  const sql = compile("select count((select GitRef filter .name = 'a'))");
  assertEquals(/COUNT\(\s*\(/.test(sql), false, sql);
  assertStringIncludes(sql, "SELECT COUNT(*) FROM (");
  assertStringIncludes(sql, "WHERE gitref_1.name = 'a'");
});

Deno.test("aggregate - count(X filter …) parses and counts the filtered set", () => {
  const sql = compile("select count(GitRef filter .name = 'a')");
  assertStringIncludes(sql, "SELECT COUNT(*) FROM (");
  assertStringIncludes(sql, "WHERE gitref_1.name = 'a'");
});

Deno.test("aggregate - sum/min/max/avg over a scalar subquery aggregate its rows", () => {
  const cases: [string, string][] = [
    ["sum", "COALESCE(SUM(__set.value), 0)"],
    ["min", "MIN(__set.value)"],
    ["max", "MAX(__set.value)"],
    ["avg", "AVG(__set.value)"]
  ];
  for (const [fn, expected] of cases) {
    const sql = compile(`select ${fn}((select GitRef.size filter .name = 'a'))`);
    assertStringIncludes(sql, `SELECT ${expected} FROM (`, fn);
    assertStringIncludes(sql, "AS __set(value)", fn);
  }
});

Deno.test("aggregate - array_agg over a subquery aggregates its rows", () => {
  const sql = compile("select array_agg((select GitRef.name filter .size > 1))");
  assertStringIncludes(sql, "SELECT COALESCE(ARRAY_AGG(__set.value), '{}') FROM (");
});

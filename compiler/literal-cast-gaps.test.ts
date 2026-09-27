/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Compile-level: bytes literals, tuple casts, `json_get`'s path and default,
 * `<str>` of dates and times, scalar `is` tests, the `cal::duration_normalize_*`
 * functions, an empty statement value, a cast to a constrained scalar and
 * `<json>` of objects. The values Gel 7.1 answers are checked end to end in
 * server/json-cast-pg.test.ts, server/duration-iso-pg.test.ts and
 * migration/scalar-constraints-pg.test.ts.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import type { Schema } from "./context.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const SDL = `
module default {
  scalar type Pos extending int64 { constraint min_value(0); };
  type JT {
    ld: cal::local_date;
    dd: cal::date_duration;
    age: int64;
  };
}`;

let cachedSchema: Schema | undefined;

async function sqlOf(edgeql: string): Promise<string> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(SDL);
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    cachedSchema = manager.modulesToSchema(parsed.value);
  }
  return compileEdgeQL(edgeql, cachedSchema).replace(/\s+/g, " ");
}

Deno.test("literal and cast gaps - a bytes literal is its exact bytes, as hex bytea input", async () => {
  assertStringIncludes(await sqlOf(String.raw`select b'\x00\xffA'`), String.raw`CAST('\x00ff41' AS bytea)`);
  assertStringIncludes(await sqlOf(`select b''`), String.raw`CAST('\x' AS bytea)`);
});

Deno.test("literal and cast gaps - a bytes literal is base64 in a tuple and to_str reads it as UTF-8", async () => {
  assertStringIncludes(await sqlOf(`select (b'ab', 1)`), "translate(encode(CAST(");
  assertStringIncludes(await sqlOf(`select to_str(b'ab')`), "convert_from(");
});

Deno.test("literal and cast gaps - a tuple literal cast to a named tuple type names its elements", async () => {
  assertStringIncludes(await sqlOf(`select <tuple<a: int64, b: str>>(1, 'x')`), "jsonb_build_object('a', CAST(1 AS bigint), 'b', CAST('x' AS text))");
  assertStringIncludes(await sqlOf(`select <tuple<a: int64>>(b := '5')`), "jsonb_build_object('a', CAST('5' AS bigint))");
  assertStringIncludes(await sqlOf(`select <tuple<int64, str>>(c := 1, d := 'x')`), "jsonb_build_array(CAST(1 AS bigint), CAST('x' AS text))");
  // An element of it is that element, typed.
  assertEquals(await sqlOf(`select (<tuple<a: int64, b: str>>(1, 'x')).a`), "SELECT CAST(1 AS bigint)");
});

Deno.test("literal and cast gaps - json_get takes a variadic path and a default", async () => {
  assertStringIncludes(await sqlOf(`select json_get(to_json('{}'), 'a', '0', 'b')`), "jsonb_extract_path(");
  const withDefault = await sqlOf(`select json_get(to_json('{}'), 'a', default := <json>1)`);
  assertStringIncludes(withDefault, "COALESCE(jsonb_extract_path(");
  assertThrows(() => compileEdgeQL(`select json_get(to_json('{}'), 'a', nope := 1)`, cachedSchema!), Error, "not 'nope'");
});

Deno.test("literal and cast gaps - <str> of a datetime or local_datetime is its ISO text", async () => {
  for (const type of ["datetime", "cal::local_datetime"]) {
    assertStringIncludes(await sqlOf(`select <str><${type}>'2024-01-02T00:00:00'`), `btrim(CAST(to_jsonb(`);
    assertStringIncludes(await sqlOf(`select to_str(<${type}>'2024-01-02T00:00:00')`), `btrim(CAST(to_jsonb(`);
  }
  // A format keeps to_str's own.
  assertEquals((await sqlOf(`select <str><cal::local_date>'2024-01-02'`)).includes("btrim"), false);
});

Deno.test("literal and cast gaps - `is` a scalar type is known when the query compiles", async () => {
  assertEquals(await sqlOf(`select <cal::local_date>'2024-01-02' is cal::local_date`), "SELECT TRUE");
  // Divergence: Gel 7.1 answers false for every scalar `is not` (`select 1 is
  // not str` and `select 1 is not int64` alike); Disc negates `is`.
  assertEquals(await sqlOf(`select 1 is not str`), "SELECT TRUE");
  assertEquals(await sqlOf(`select 1 is anyint`), "SELECT TRUE");
  assertEquals(await sqlOf(`select <Pos>1 is int64`), "SELECT TRUE");
  assertEquals(await sqlOf(`select 1 is Pos`), "SELECT FALSE");
  // An operand that may be empty keeps its emptiness.
  assertStringIncludes(await sqlOf(`select JT { x := .age is int64 }`), "CASE WHEN jt_1.age IS NOT NULL THEN TRUE END");
});

Deno.test("literal and cast gaps - cal::duration_normalize_days and _hours", async () => {
  assertStringIncludes(await sqlOf(`select cal::duration_normalize_hours(<cal::relative_duration>'25 hours')`), "justify_hours(");
  // Of a date duration it is a date duration: zero is P0D.
  assertStringIncludes(await sqlOf(`select cal::duration_normalize_days(<cal::date_duration>'0 days')`), "disc_date_duration_text(justify_days(");
});

Deno.test("literal and cast gaps - a statement's value that may be empty is no row", async () => {
  assertStringIncludes(await sqlOf(`select <str>{}`), "IS NOT NULL");
  assertEquals((await sqlOf(`select 'a'`)).includes("IS NOT NULL"), false);
});

Deno.test("literal and cast gaps - a zero date duration is P0D where its type is known", async () => {
  for (
    const query of [
      `with x := <cal::date_duration>'0 days' select x`,
      `select <cal::date_duration>'0 days' ?? <cal::date_duration>'1 day'`,
      `select <cal::date_duration>'0 days' if true else <cal::date_duration>'1 day'`,
      `select {<cal::date_duration>'0 days', <cal::date_duration>'1 day'}`,
      `select array_agg(JT.dd)`,
      `for x in JT union [x.dd]`
    ]
  ) {
    assertStringIncludes(await sqlOf(query), "disc_date_duration_text(", query);
  }
});

Deno.test("literal and cast gaps - a cast to a constrained scalar checks its constraints", async () => {
  const sql = await sqlOf(`select <Pos>-1`);
  assertStringIncludes(sql, "disc_check_constraint(");
  assertStringIncludes(sql, "Minimum allowed value for Pos is 0.");
  assertStringIncludes(sql, "violated constraint ''std::min_value'' on scalar type ''default::Pos''");
  assertStringIncludes(await sqlOf(`select <array<Pos>>[1]`), "bool_and(disc_check_constraint(");
  assertEquals((await sqlOf(`select <int64>-1`)).includes("disc_check_constraint"), false);
});

Deno.test("literal and cast gaps - <json> of objects is each object's JSON", async () => {
  assertStringIncludes(await sqlOf(`select <json>JT`), "jsonb_build_object('id', jt_1.id)");
  assertStringIncludes(await sqlOf(`select <json>JT { age }`), "jsonb_build_object('age', jt_1.age)");
});

Deno.test("literal and cast gaps - a tuple or array of paths from a type is one per object", async () => {
  const sql = await sqlOf(`select (JT.dd, JT.ld)`);
  assertStringIncludes(sql, "FROM jt AS jt_1 WHERE (jt_1.dd IS NOT NULL) AND (jt_1.ld IS NOT NULL)");
  assertStringIncludes(await sqlOf(`select [JT.ld]`), "ARRAY[jt_1.ld]");
});

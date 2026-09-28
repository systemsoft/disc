/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `decimal` and `bigint` values are checked for NaN and ±Infinity.
 *
 * PostgreSQL's numeric holds them; Gel's decimal and bigint do not. Every cast
 * to one (and `to_decimal`/`to_bigint`) goes through `disc_finite_numeric`
 * (lib/stdlib-sql.ts), which raises InvalidValueError for them, and so does a
 * value written to a decimal or bigint property without a cast. A numeric
 * literal or an integer cannot be one, so it is left as it was.
 *
 * A bigint has no fractional part either: the same check rejects one, except
 * that a cast from a decimal or a float rounds, as Gel's casts do.
 *
 * See server/numeric-nonfinite-pg.test.ts for what PostgreSQL answers.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { buildParameterTypeMap, EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  scalar type Count extending bigint;
  type Reading {
    required label: str;
    big: bigint;
    dec: decimal;
    multi decs: decimal;
    f64: float64;
    n: int32;
    multi sensors: Sensor {
      weight: decimal;
    };
  }
  type Sensor {
    required name: str;
  }
}
`;

function schema(): Schema {
  const manager = new SchemaManager({ dryRun: true });
  const parsed = manager.parseSDL(SDL, { validate: false });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return manager.modulesToSchema(parsed.value);
}

function compileStatement(edgeql: string) {
  const result = new EdgeQLCompiler(schema(), { enableAccessControl: false }).compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

function compile(edgeql: string): string {
  return new SQLCodeGenerator().generate(compileStatement(edgeql)).replace(/\s+/g, " ");
}

Deno.test("finite numeric - a cast to decimal or bigint is checked", () => {
  assertStringIncludes(compile("select <decimal>$d"), "disc_finite_numeric(CAST($1 AS numeric), 'std::decimal')");
  assertStringIncludes(compile("select <bigint>'12'"), "disc_finite_numeric(CAST(disc_str_to_bigint('12') AS numeric), 'std::bigint')");
  assertStringIncludes(compile("select <decimal><float64>'NaN'"), "disc_finite_numeric(CAST(CAST('NaN' AS double precision) AS numeric), 'std::decimal')");
  assertStringIncludes(compile("select <array<bigint>>$b"), "disc_finite_numeric(CAST($1 AS numeric[]), 'std::bigint')");
  assertStringIncludes(compile("select <decimal><json>$j"), "disc_finite_numeric(CAST(");
});

Deno.test("finite numeric - to_decimal and to_bigint are checked", () => {
  assertStringIncludes(compile("select to_decimal('1.5')"), "disc_finite_numeric(CAST('1.5' AS numeric), 'std::decimal')");
  assertStringIncludes(compile("select to_bigint('7')"), "disc_finite_numeric(CAST(disc_str_to_bigint('7') AS numeric), 'std::bigint')");
});

Deno.test("finite numeric - a numeric literal or an integer is not checked", () => {
  for (const query of ["select <decimal>7", "select <decimal>-7", "select <bigint>2.5", "select 1.5n", "select Reading { x := <decimal>.n }"]) {
    assertEquals(compile(query).includes("disc_finite_numeric"), false, query);
  }
});

Deno.test("finite numeric - a value written to a decimal or bigint property without a cast is checked", () => {
  assertStringIncludes(compile("insert Reading { label := 'a', dec := $d }"), "disc_finite_numeric(CAST($1 AS numeric), 'std::decimal')");
  assertStringIncludes(compile("insert Reading { label := 'a', dec := .f64 }"), "'std::decimal')");
  assertStringIncludes(compile("update Reading set { big := $b }"), "disc_finite_numeric(CAST($1 AS numeric), 'std::bigint')");
  assertStringIncludes(compile("update Reading set { decs += $d }"), "disc_finite_numeric(CAST(");
  assertStringIncludes(
    compile("insert Reading { label := 'a', sensors := (select Sensor) { @weight := $w } }"),
    "disc_finite_numeric(CAST($1 AS numeric), 'std::decimal')"
  );
});

Deno.test("finite numeric - a cast from a decimal or a float to bigint rounds, as Gel's casts do", () => {
  for (const query of ["select <bigint>1.5n", "select <bigint>2.5", "select Reading { x := <bigint>.dec }", "select <bigint><float64>$f"]) {
    assertStringIncludes(compile(query), "round(", query);
  }
  for (const query of ["select <bigint>'1.5'", "select <bigint>$b", "select <bigint>7", "select <decimal>1.5"]) {
    assertEquals(compile(query).includes("round("), false, query);
  }
  assertEquals(compile("select <bigint>1.5n").includes("disc_finite_numeric"), false);
  assertStringIncludes(compile("select <bigint><float64>$f"), "disc_finite_numeric(");
});

Deno.test("finite numeric - a float cast to an integer or bigint is a float8 first: PostgreSQL rounds it half to even, as Gel does", () => {
  // A float literal is numeric to PostgreSQL, whose round and int casts go half away from zero.
  assertStringIncludes(compile("select <bigint>2.5"), "round(CAST(2.5 AS double precision))");
  assertStringIncludes(compile("select <int64>2.5"), "CAST(CAST(2.5 AS double precision) AS bigint)");
  assertStringIncludes(compile("select <int32>(2.5 + 1)"), "CAST(CAST(2.5 + 1 AS double precision) AS integer)");
  assertStringIncludes(compile("select Reading { x := <int16>.f64 }"), "CAST(CAST(reading_1.f64 AS double precision) AS smallint)");
  assertStringIncludes(compile("select <array<int64>>[2.5, 3.5]"), "CAST(CAST(ARRAY[2.5, 3.5] AS double precision[]) AS bigint[])");
  // A decimal rounds half away from zero, as PostgreSQL's numeric does.
  assertStringIncludes(compile("select <bigint>2.5n"), "round(CAST(2.5 AS numeric))");
  assertEquals(compile("select <int64>2.5n").includes("double precision"), false);
  assertEquals(compile("select <int64>'2'").includes("double precision"), false);
});

Deno.test("finite numeric - a decimal or float written to a bigint property is checked, an integer is not", () => {
  assertStringIncludes(compile("insert Reading { label := 'a', big := 1.5 }"), "'std::bigint')");
  assertStringIncludes(compile("insert Reading { label := 'a', big := 1.5n }"), "'std::bigint')");
  assertEquals(compile("insert Reading { label := 'a', big := 7n }").includes("disc_finite_numeric"), false);
  assertEquals(compile("insert Reading { label := 'a', dec := 1.5n }").includes("disc_finite_numeric"), false);
});

Deno.test("finite numeric - a cast to a scalar extending bigint is checked as a bigint", () => {
  assertStringIncludes(compile("select <Count>$c"), "disc_finite_numeric(CAST($1 AS numeric), 'std::bigint')");
});

Deno.test("finite numeric - a checked value is not checked twice, and other properties are not checked", () => {
  const sql = compile("insert Reading { label := 'a', dec := <decimal>$d, big := 5, n := $n, f64 := $f }");
  assertEquals(sql.split("disc_finite_numeric").length - 1, 1, sql);
});

Deno.test("finite numeric - a checked parameter still binds as numeric", () => {
  assertEquals(buildParameterTypeMap(compileStatement("select <decimal>$d")).get(1), "numeric");
  assertEquals(buildParameterTypeMap(compileStatement("insert Reading { label := 'a', dec := $d }")).get(1), "numeric");
});

Deno.test("finite numeric - a cast of a decimal or float array to array<bigint> rounds each element", () => {
  for (
    const query of [
      "select <array<bigint>><array<decimal>>$x",
      "select <array<bigint>>[1.5n, 2.5n]",
      "select <array<bigint>>[1.5, 2]",
      "select <array<bigint>><array<float64>>$f",
      "with x := <array<decimal>>$x select <array<bigint>>x"
    ]
  ) {
    assertStringIncludes(compile(query), "ARRAY(SELECT round(e.v) FROM UNNEST(", query);
    assertStringIncludes(compile(query), "'std::bigint')", query);
  }
  for (const query of ["select <array<bigint>>['1.5']", "select <array<bigint>>$b", "select <array<bigint>>[1, 2]", "select <array<decimal>>[1.5n]"]) {
    assertEquals(compile(query).includes("round("), false, query);
  }
  assertEquals(buildParameterTypeMap(compileStatement("select <array<bigint>><array<decimal>>$x")).get(1), "numeric[]");
});

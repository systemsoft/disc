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
  assertStringIncludes(compile("select <bigint>'12'"), "disc_finite_numeric(CAST('12' AS numeric), 'std::bigint')");
  assertStringIncludes(compile("select <decimal><float64>'NaN'"), "disc_finite_numeric(CAST(CAST('NaN' AS double precision) AS numeric), 'std::decimal')");
  assertStringIncludes(compile("select <array<bigint>>$b"), "disc_finite_numeric(CAST($1 AS numeric[]), 'std::bigint')");
  assertStringIncludes(compile("select <decimal><json>$j"), "disc_finite_numeric(CAST(");
});

Deno.test("finite numeric - to_decimal and to_bigint are checked", () => {
  assertStringIncludes(compile("select to_decimal('1.5')"), "disc_finite_numeric(CAST('1.5' AS numeric), 'std::decimal')");
  assertStringIncludes(compile("select to_bigint('7')"), "disc_finite_numeric(CAST('7' AS numeric), 'std::bigint')");
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

Deno.test("finite numeric - a checked value is not checked twice, and other properties are not checked", () => {
  const sql = compile("insert Reading { label := 'a', dec := <decimal>$d, big := 5, n := $n, f64 := $f }");
  assertEquals(sql.split("disc_finite_numeric").length - 1, 1, sql);
});

Deno.test("finite numeric - a checked parameter still binds as numeric", () => {
  assertEquals(buildParameterTypeMap(compileStatement("select <decimal>$d")).get(1), "numeric");
  assertEquals(buildParameterTypeMap(compileStatement("insert Reading { label := 'a', dec := $d }")).get(1), "numeric");
});

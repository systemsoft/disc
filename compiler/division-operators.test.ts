/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Division operators: `/`, `//`, `%` follow Gel's numeric semantics, not
 * PostgreSQL's.
 *
 *   int / int     → float64 (PG `7 / 2` truncates to 3; Gel answers 3.5)
 *   x // y        → floor division, rounding toward negative infinity
 *                   (`-7 // 2` is -4; `//` is not a PG operator at all)
 *   x % y         → modulo with the sign of the divisor (`-7 % 2` is 1; PG's
 *                   `%` takes the sign of the dividend and answers -1)
 *
 * Operand types come from literals, casts and schema properties; see
 * pg-division-operators.test.ts for the values PostgreSQL returns.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const ast = new EdgeQLParser(source).parse();
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  return codegen.generate(result.value).replace(/\s+/g, " ");
}

Deno.test("division: int / int divides as float64", () => {
  assertStringIncludes(compileEdgeQL("select 7 / 2"), "7 / CAST(2 AS double precision)");
});

Deno.test("division: an int property divided by an int divides as float64, in a shape and a filter", () => {
  const sql = compileEdgeQL("select User { ratio := .age / 2 } filter .age / 2 > 1");
  assertStringIncludes(sql, "'ratio', user_1.age / CAST(2 AS double precision)");
  assertStringIncludes(sql, "WHERE (user_1.age / CAST(2 AS double precision)) > (1)");
});

Deno.test("division: a float literal divides as float64 even when it is integral", () => {
  assertStringIncludes(compileEdgeQL("select 7.0 / 2"), "7 / CAST(2 AS double precision)");
});

Deno.test("division: decimal and bigint operands divide as decimal", () => {
  assertStringIncludes(compileEdgeQL("select <decimal>7 / <decimal>2"), "CAST(7 AS numeric) / CAST(2 AS numeric)");
  assertStringIncludes(compileEdgeQL("select <bigint>7 / <bigint>2"), "CAST(7 AS numeric) / CAST(2 AS numeric)");
  assertStringIncludes(compileEdgeQL("select <decimal>7 / 2"), "CAST(7 AS numeric) / 2");
});

Deno.test("floor division: ints floor through numeric and keep an integer type", () => {
  assertStringIncludes(compileEdgeQL("select -7 // 2"), "CAST(FLOOR(CAST(-7 AS numeric) / 2) AS bigint)");
  // int32 // int32 stays int32; a literal is int64, the wider type.
  assertStringIncludes(compileEdgeQL("select User { h := .age // <int32>2 }"), "CAST(FLOOR(CAST(user_1.age AS numeric) / CAST(2 AS integer)) AS integer)");
  assertStringIncludes(compileEdgeQL("select User { h := .age // 2 }"), "CAST(FLOOR(CAST(user_1.age AS numeric) / 2) AS bigint)");
});

Deno.test("floor division: floats floor a float division, decimals a decimal one", () => {
  assertStringIncludes(compileEdgeQL("select 7.5 // 2"), "FLOOR(7.5 / CAST(2 AS double precision))");
  assertStringIncludes(compileEdgeQL("select <decimal>7 // <decimal>2"), "FLOOR(CAST(7 AS numeric) / CAST(2 AS numeric))");
});

Deno.test("modulo: ints and decimals take the sign of the divisor", () => {
  assertEquals(compileEdgeQL("select -7 % 2").trim(), "SELECT (((-7) % (2)) + (2)) % (2)");
  assertStringIncludes(
    compileEdgeQL("select <decimal>7 % <decimal>2"),
    "((CAST(7 AS numeric) % CAST(2 AS numeric)) + (CAST(2 AS numeric))) % (CAST(2 AS numeric))"
  );
});

Deno.test("modulo: floats subtract the floored quotient (PostgreSQL has no float %)", () => {
  assertStringIncludes(compileEdgeQL("select 7.5 % 2"), "(7.5) - (FLOOR(7.5 / CAST(2 AS double precision)) * 2)");
});

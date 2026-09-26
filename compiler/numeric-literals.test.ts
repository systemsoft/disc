/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Numeric literals and casts over prefix operators.
 *
 *   10n          → a bigint literal, CAST(10 AS numeric) (Disc stores bigint
 *                  as numeric); it lexed as the int64 10
 *   1.5n         → a decimal literal, CAST(1.5 AS numeric); it lexed as the
 *                  float64 1.5 followed by an identifier `n`
 *   <int64>-7    → a cast of `-7`; it was a syntax error ("Unexpected
 *                  token: -")
 *
 * See pg-numeric-literals.test.ts for the values PostgreSQL returns.
 */

import { assertStringIncludes } from "@std/assert";
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

Deno.test("numeric literals: 10n is a numeric bigint, keeping every digit", () => {
  assertStringIncludes(compileEdgeQL("select 10n"), "CAST(10 AS numeric)");
  assertStringIncludes(compileEdgeQL("select 12345678901234567890n"), "CAST(12345678901234567890 AS numeric)");
});

Deno.test("numeric literals: 1.5n is a numeric decimal, keeping its scale", () => {
  assertStringIncludes(compileEdgeQL("select 1.5n"), "CAST(1.5 AS numeric)");
  assertStringIncludes(compileEdgeQL("select 1.50n"), "CAST(1.50 AS numeric)");
});

Deno.test("numeric literals: bigint and decimal literals divide as decimals", () => {
  assertStringIncludes(compileEdgeQL("select 10n / 4n"), "CAST(10 AS numeric) / CAST(4 AS numeric)");
  assertStringIncludes(compileEdgeQL("select 10n // 4n"), "FLOOR(CAST(10 AS numeric) / CAST(4 AS numeric))");
  assertStringIncludes(compileEdgeQL("select 7.5n / 2"), "CAST(7.5 AS numeric) / 2");
});

Deno.test("casts over prefix operators compile to a cast of the negated value", () => {
  assertStringIncludes(compileEdgeQL("select <decimal>-7"), "CAST(-7 AS numeric)");
  assertStringIncludes(compileEdgeQL("select <int64>-7 + 1"), "CAST(-7 AS bigint) + 1");
});

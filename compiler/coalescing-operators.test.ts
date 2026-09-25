/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Coalescing operators: `?=`, `?!=`, `??`.
 *
 * These used to be passed through to PostgreSQL verbatim (`text ?= text`,
 * `text ?? unknown` — no such operators). They now lower to
 * `IS NOT DISTINCT FROM`, `IS DISTINCT FROM`, and `COALESCE(...)`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import type * as AST from "../edgeql/ast.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema } from "./context.ts";

const schema = createTestSchema();
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const compiler = new EdgeQLCompiler(schema);
  const ast = new EdgeQLParser(source).parse();
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  return codegen.generate(result.value);
}

// The filter expression of `select User filter <expr>`.
function parseFilter(expr: string): AST.Expression {
  const query = new EdgeQLParser(`select User filter ${expr}`).parse() as AST.SelectQuery;
  if (!query.filter) {
    throw new Error("no filter parsed");
  }
  return query.filter;
}

Deno.test("Coalescing parser — ?? binds tighter than =", () => {
  const filter = parseFilter(`.name ?? "x" = "y"`) as AST.BinaryOp;
  assertEquals(filter.op, "=");
  assertEquals((filter.left as AST.BinaryOp).op, "??");
});

Deno.test("Coalescing parser — ?= sits at the comparison level, below ??", () => {
  const filter = parseFilter(`.name ?= .email ?? "x"`) as AST.BinaryOp;
  assertEquals(filter.op, "?=");
  assertEquals((filter.right as AST.BinaryOp).op, "??");
});

Deno.test("Coalescing parser — ?= binds tighter than and", () => {
  const filter = parseFilter(`.name ?= "a" and .email ?!= "b"`) as AST.BinaryOp;
  assertEquals(filter.op, "AND");
  assertEquals((filter.left as AST.BinaryOp).op, "?=");
  assertEquals((filter.right as AST.BinaryOp).op, "?!=");
});

Deno.test("Coalescing compile — ?= lowers to IS NOT DISTINCT FROM", () => {
  const sql = compileEdgeQL(`select User { name } filter .name ?= <optional str>$x`);
  assertStringIncludes(sql, "user_1.name IS NOT DISTINCT FROM CAST($1 AS text)");
});

Deno.test("Coalescing compile — ?!= lowers to IS DISTINCT FROM", () => {
  const sql = compileEdgeQL(`select User { name } filter .name ?!= <optional str>$x`);
  assertStringIncludes(sql, "user_1.name IS DISTINCT FROM CAST($1 AS text)");
});

Deno.test("Coalescing compile — ?? lowers to COALESCE", () => {
  const sql = compileEdgeQL(`select User { n := .name ?? "anon" }`);
  assertStringIncludes(sql, "COALESCE(user_1.name, 'anon')");
});

Deno.test("Coalescing compile — chained ?? nests COALESCE", () => {
  const sql = compileEdgeQL(`select User { n := .name ?? .email ?? "anon" }`);
  assertEquals((sql.match(/COALESCE\(/g) ?? []).length, 2);
  assertStringIncludes(sql, "'anon')");
});

Deno.test("Coalescing compile — no raw ?= / ?? reaches the SQL", () => {
  const sql = compileEdgeQL(`select User { n := .name ?? "anon" } filter .email ?= "a" and .name ?!= "b"`);
  assertEquals(sql.includes("??"), false);
  assertEquals(sql.includes("?="), false);
  assertEquals(sql.includes("?!="), false);
});

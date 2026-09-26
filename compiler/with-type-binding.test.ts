/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A `with` binding bound to a bare object type (`with u := User`) is the set
 * of that type's objects, exactly like `with u := (select User)`. It compiled
 * to `WITH u AS (SELECT *)` — no FROM — which PostgreSQL rejects ("SELECT *
 * with no tables specified is not valid"). A binding selecting from another
 * binding (`v := (select u filter …)`) is typed by it, so `v { name }` projects
 * a shape, and `count(u)` counts its rows.
 *
 * See pg-with-type-binding.test.ts for the rows PostgreSQL returns.
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

Deno.test("with type binding: a bare type binding compiles like a select of the type", () => {
  assertEquals(
    compileEdgeQL("with u := User select u { name }"),
    compileEdgeQL("with u := (select User) select u { name }")
  );
  assertStringIncludes(compileEdgeQL("with u := User select u { name }"), "WITH u AS ( SELECT * FROM users AS user_1 )");
});

Deno.test("with type binding: a binding selected from a type binding keeps the type for its shape", () => {
  const sql = compileEdgeQL("with u := User, v := (select u filter .name = <str>$n) select v { name }");
  assertStringIncludes(sql, "v AS ( SELECT * FROM u AS u_2 WHERE u_2.name = CAST($1 AS text) )");
  assertStringIncludes(sql, "SELECT jsonb_build_object('name', v_3.name) FROM v AS v_3");
});

Deno.test("with type binding: filter and implicit shape over a type binding", () => {
  const sql = compileEdgeQL("with u := User select u filter .name = 'a'");
  assertStringIncludes(sql, "WITH u AS ( SELECT * FROM users AS user_1 )");
  assertStringIncludes(sql, "FROM u AS u_2 WHERE u_2.name = 'a'");
});

Deno.test("with type binding: count and exists over a binding aggregate its rows", () => {
  assertStringIncludes(compileEdgeQL("with u := User select count(u)"), "SELECT ( SELECT COUNT(*) FROM ( SELECT");
  assertStringIncludes(compileEdgeQL("with u := (select User) select exists u"), "SELECT EXISTS ( SELECT");
});

Deno.test("with type binding: a binding's order by, limit and offset stay in its CTE", () => {
  assertStringIncludes(
    compileEdgeQL("with u := (select User order by .name offset 1 limit 2) select u { name }"),
    "WITH u AS ( SELECT * FROM users AS user_1 ORDER BY user_1.name ASC LIMIT 2 OFFSET 1 )"
  );
});

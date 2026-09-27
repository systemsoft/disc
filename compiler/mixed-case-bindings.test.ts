/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Names with capital letters bound by `with`, `for` and `select x := …`:
 *
 * - A bound name is an identifier, not the type name a capitalised name
 *   otherwise reads as (`with Foo := … select Foo` used to be "Type 'Foo'
 *   not found"), in the bindings after it and in the body only.
 * - A binding's CTE keeps its case, quoted wherever the SQL generator writes
 *   it (`WITH "myRows" AS …`), as hand-written SQL does (`mutationOverlay`
 *   reads `"NewP"`); unquoted, PostgreSQL folds it to lower case.
 * - Table aliases made from a name are lower case (`myrows_2`), so they are
 *   the same name quoted (`"myrows_2"."id"`) and bare.
 *
 * Real-PG coverage: `compiler/pg-mixed-case-bindings.test.ts`.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type * as AST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Post {
    required title: str;
  }
  type User {
    required name: str;
    visits: int64;
    multi posts: Post;
  }
}
`;

function schema(): Schema {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });
  if (!parsed.ok) {
    throw parsed.error;
  }
  return mgr.modulesToSchema(parsed.value);
}

function compile(edgeql: string): string {
  const result = new EdgeQLCompiler(schema()).compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw result.error;
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

Deno.test("parser: a capitalised with, for or select name is an identifier where it is bound", () => {
  const withBlock = new EdgeQLParser("with Foo := (select User), Bar := Foo select Bar").parse() as AST.WithBlock;
  assertEquals(withBlock.bindings[1].value.kind, "Identifier");
  assertEquals((withBlock.body as AST.SelectQuery).expr.kind, "Identifier");

  const forQuery = new EdgeQLParser("for Xs in {1, 2} union (Xs + 1)").parse() as AST.ForQuery;
  assertEquals(((forQuery.body as AST.SelectQuery).expr as AST.BinaryOp).left.kind, "Identifier");
  // The iterator is outside the variable's scope.
  assertEquals((new EdgeQLParser("for User in User union (User.name)").parse() as AST.ForQuery).iterator.kind, "TypeName");

  const named = new EdgeQLParser("select Mine := User filter Mine.name = 'a'").parse() as AST.WithBlock;
  assertEquals(named.bindings[0].value.kind, "TypeName");
  assertEquals((named.body as AST.SelectQuery).expr.kind, "Identifier");

  // Outside the with block, the name is a type again.
  const union = new EdgeQLParser("select {(with Foo := 1 select Foo), (select Foo)}").parse() as AST.SelectQuery;
  const [inner, outer] = (union.expr as AST.SetExpr).elements as AST.Subquery[];
  assertEquals(((inner.query as AST.WithBlock).body as AST.SelectQuery).expr.kind, "Identifier");
  assertEquals((outer.query as AST.SelectQuery).expr.kind, "TypeName");
});

Deno.test("a mixed-case with binding's CTE is quoted where declared and read; its aliases are lower case", () => {
  const sql = compile("with myRows := User select myRows { name, n := count(.posts) }");
  assertStringIncludes(sql, `WITH "myRows" AS (`);
  assertStringIncludes(sql, `FROM "myRows" AS myrows_`);
  assertStringIncludes(sql, `"user_posts"."source_id" = "myrows_`);
  assertEquals(/[^"]myRows/.test(sql), false, sql);
});

Deno.test("a capitalised binding compiles as the binding: with, for and select names", () => {
  assertStringIncludes(compile("with Foo := (select User filter .name = 'a') select Foo { name }"), `FROM "Foo" AS foo_`);
  assertStringIncludes(compile("with Foo := (select User) select count(Foo)"), `FROM "Foo" AS`);
  assertStringIncludes(compile("for Xs in {1, 2} union (Xs + 1)"), "+ 1");
  assertStringIncludes(compile("select Mine := User { name } filter Mine.name = 'a'"), `WITH "Mine" AS (`);
});

Deno.test("a mixed-case mutation binding is read through its quoted CTE", () => {
  const sql = compile("with NewP := (insert Post { title := 'a' }) select NewP { title }");
  assertStringIncludes(sql, `WITH "NewP" AS ( INSERT INTO post`);
  assertStringIncludes(sql, `FROM "NewP"`);
});

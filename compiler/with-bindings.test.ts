/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Names bound in a `with` block are resolvable in the body (D12).
 *
 * A plain expression binding (`x := <str>$n`) is inlined at each use. A
 * set-valued binding (`prog := (select Program …)`) is a CTE; in expression
 * position its name stands for the ids of its rows. A binding selected from
 * (`select x`, `select m { id }`) is a CTE, as before.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const FIXTURE_URL = new URL("../tests/fixtures/git-forge.disc", import.meta.url);

let cachedSchema: Schema | undefined;

async function testSchema(): Promise<Schema> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(await Deno.readTextFile(FIXTURE_URL));
    if (!parsed.ok) {
      throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
    }
    cachedSchema = manager.modulesToSchema(parsed.value);
  }
  return cachedSchema;
}

async function compile(edgeql: string): Promise<string> {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").trim();
}

Deno.test("with-binding: a parameter binding is inlined where the body uses it", async () => {
  const sql = await compile("with x := <str>$n select GitRef { id } filter .name = x");

  assertStringIncludes(sql, "gitref_1.name = CAST($1 AS text)");
  assert(!sql.startsWith("WITH"), `an inlined binding needs no CTE: ${sql}`);
});

Deno.test("with-binding: a binding used twice is inlined twice, on one parameter slot", async () => {
  const sql = await compile("with x := <str>$n select GitRef { id } filter .name = x or .target = x");

  assertEquals(sql.split("CAST($1 AS text)").length - 1, 2);
  assert(!sql.includes("$2"), sql);
});

Deno.test("with-binding: a later binding can use an earlier one", async () => {
  const sql = await compile("with a := <str>$n, b := a ++ '/x' select GitRef { id } filter .name = b");

  assertStringIncludes(sql, "(gitref_1.name) = (CAST($1 AS text) || '/x')");
});

Deno.test("with-binding: a selected object is a CTE, and its name in link position is its id", async () => {
  const sql = await compile(
    "with prog := (select Program filter .id = <uuid>$p) insert GitRef { program := prog, name := <str>$n, target := <str>$t }"
  );

  assertStringIncludes(sql, "WITH prog AS ( SELECT * FROM program AS program_1 WHERE program_1.id = CAST($1 AS uuid) )");
  assertStringIncludes(sql, "INSERT INTO git_ref (program_id, name, target) VALUES (( SELECT id FROM prog ), CAST($2 AS text), CAST($3 AS text))");
});

Deno.test("with-binding: a set-valued binding used twice is one CTE", async () => {
  const sql = await compile(
    "with prog := (select Program filter .id = <uuid>$p) select GitRef { id } filter .program = prog or .program = prog"
  );

  assertEquals(sql.split("prog AS (").length - 1, 1);
  assertEquals(sql.split("( SELECT id FROM prog )").length - 1, 2);
});

Deno.test("with-binding: selecting a plain binding still reads it from a CTE", async () => {
  assertEquals(await compile("with x := 5 select x"), "WITH x AS ( SELECT 5 ) SELECT x_1.* FROM x AS x_1");
});

Deno.test("with-binding: the mutation with-form is unchanged", async () => {
  const sql = await compile("with m := (update GitRef filter .name = <str>$n set { target := <str>$t }) select m { id }");

  assertEquals(
    sql,
    "WITH m AS ( UPDATE git_ref SET target = CAST($2 AS text) WHERE git_ref.name = CAST($1 AS text) RETURNING * ) " +
      "SELECT jsonb_build_object('id', m_1.id) FROM m AS m_1"
  );
});

Deno.test("with-binding: the name is gone after the block", async () => {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  assert(compiler.compile(new EdgeQLParser("with x := <str>$n select GitRef { id } filter .name = x").parse()).ok);

  const after = compiler.compile(new EdgeQLParser("select GitRef { id } filter .name = x").parse());
  assert(!after.ok);
  assertStringIncludes(after.error.message, "'x' cannot be resolved");
});

Deno.test("with-binding: a for-iterator variable shadows a binding of the same name", async () => {
  const sql = await compile("with x := 'outer' for x in {'a', 'b'} union (insert Program { name := x })");

  assertStringIncludes(sql, "VALUES ('a'), ('b')");
});

Deno.test("with-binding: the name is gone after a block that fails to compile", async () => {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  assert(!compiler.compile(new EdgeQLParser("with x := <str>$n select Missing { id } filter .name = x").parse()).ok);

  const after = compiler.compile(new EdgeQLParser("select GitRef { id } filter .name = x").parse());
  assert(!after.ok);
  assertStringIncludes(after.error.message, "'x' cannot be resolved");
});

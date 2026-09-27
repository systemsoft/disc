/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A path from a `with` binding of objects (`n.last`, `n.program.name`,
 * `n.program`), and a shape on `select (with … <mutation>)`.
 *
 *   - As one value (an insert's or update's value) the path is
 *     `(select n.last)`; a path to objects is their id.
 *   - A binding of an insert (upsert included) is one object, as Gel infers
 *     it: a path from it in a shape or a filter is one value, not an array or
 *     an any-element test. A binding of a select stays a set.
 *   - `select (with B <mutation>) { … }` compiles as `with B select (<mutation>) { … }`.
 *
 * The schema is a git forge's issue numbering, as its author wrote it. See
 * server/numbering-upsert-pg.test.ts for the same queries against PostgreSQL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Program {
    required name: str;
  }

  type User {
    required name: str;
  }
}

module collab {
  type Numbering {
    required program: default::Program {
      constraint exclusive;
    };
    required last: int64;
  };

  type Bug {
    required program: default::Program;
    required author: default::User;
    required number: int64;
    required title: str;
  };
}
`;

const UPSERT = "insert collab::Numbering { program := <default::Program><uuid>$p, last := 1 } " +
  "unless conflict on .program else (update collab::Numbering set { last := .last + 1 })";
const BUG_VALUES = "program := <default::Program><uuid>$p, author := <default::User><uuid>$u, title := <str>$t";

let cachedSchema: Schema | undefined;

async function testSchema(): Promise<Schema> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(SDL);
    if (!parsed.ok) {
      throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
    }
    cachedSchema = manager.modulesToSchema(parsed.value);
  }
  return cachedSchema;
}

async function sqlOf(edgeql: string): Promise<string> {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  assert(result.ok, `expected '${edgeql}' to compile: ${result.ok ? "" : result.error.message}`);
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

Deno.test("with-bound paths - n.last in an insert's values is (select n.last)", async () => {
  const bare = await sqlOf(`with n := (${UPSERT}) insert collab::Bug { ${BUG_VALUES}, number := n.last }`);
  const selected = await sqlOf(`with n := (${UPSERT}) insert collab::Bug { ${BUG_VALUES}, number := (select n.last) }`);

  assertEquals(bare, selected);
  assertStringIncludes(bare, "( SELECT n_1.last FROM n AS n_1 )");
});

Deno.test("with-bound paths - n.last of a with-bound select is (select n.last) too", async () => {
  const sql = await sqlOf(`with n := (select collab::Numbering filter .last = 1) insert collab::Bug { ${BUG_VALUES}, number := n.last }`);

  assert(/, \( SELECT (n_\d+)\.last FROM n AS \1 \)\) RETURNING \*$/.test(sql), sql);
});

Deno.test("with-bound paths - n.program as a link value is the linked object's id; n.program.name its property", async () => {
  const sql = await sqlOf(
    `with n := (${UPSERT}) insert collab::Bug { program := n.program, author := <default::User><uuid>$u, number := n.last, title := n.program.name }`
  );

  assert(/INSERT INTO bug \(program_id, author_id, number, title\) VALUES \(\( SELECT (program_\d+)\.id FROM program AS \1 WHERE/.test(sql), sql);
  assert(/, \( SELECT (program_\d+)\.name FROM program AS \1 WHERE/.test(sql), sql);
});

Deno.test("with-bound paths - n.last in an update's values and filter", async () => {
  const sql = await sqlOf(`with n := (${UPSERT}) update collab::Bug filter .number = n.last set { number := n.last + 1 }`);

  assertStringIncludes(sql, "SET number = ( SELECT n_1.last FROM n AS n_1 ) + 1");
  assert(/WHERE bug\.number = \( SELECT (n_\d+)\.last FROM n AS \1 \)/.test(sql), sql);
});

Deno.test("with-bound paths - a path from an inserted object is one value in a shape; from a select, an array", async () => {
  const inserted = await sqlOf(`with n := (${UPSERT}) select collab::Bug { number, x := n.last, y := n.id }`);
  assert(!inserted.includes("jsonb_agg"), inserted);
  assertStringIncludes(inserted, "'x', ( SELECT n_2.last FROM n AS n_2 )");
  assertStringIncludes(inserted, "'y', ( SELECT n_3.id FROM n AS n_3 )");

  const selected = await sqlOf("with n := (select collab::Numbering) select collab::Bug { number, x := n.last }");
  assertStringIncludes(selected, "jsonb_agg");
});

Deno.test("with-bound paths - select (with … insert …) { shape } is with … select (insert …) { shape }", async () => {
  const insert = `insert collab::Bug { ${BUG_VALUES}, number := n.last }`;
  const inner = await sqlOf(`select (with n := (${UPSERT}) ${insert}) { number }`);
  const outer = await sqlOf(`with n := (${UPSERT}) select (${insert}) { number }`);

  assertEquals(inner, outer);
  assert(inner.startsWith("WITH n AS ( INSERT INTO numbering"), inner);
  assertStringIncludes(inner, "ON CONFLICT (program_id) DO UPDATE SET last = numbering.last + 1 RETURNING * ), m AS ( INSERT INTO bug");
  assert(inner.endsWith("SELECT jsonb_build_object('number', m_2.number) FROM m AS m_2"), inner);
});

Deno.test("with-bound paths - select (with … update|delete …) { shape }, and bindings of several with blocks", async () => {
  const update = await sqlOf("select (with a := 1, b := a + 1 update collab::Numbering set { last := .last + b }) { last }");
  assertEquals(update, await sqlOf("with a := 1, b := a + 1 select (update collab::Numbering set { last := .last + b }) { last }"));

  const del = await sqlOf("select (with k := 9 delete collab::Bug filter .number = k) { number }");
  assertEquals(del, await sqlOf("with k := 9 select (delete collab::Bug filter .number = k) { number }"));

  // The outer block already binds `m`: the mutation's CTE takes another name.
  const nested = await sqlOf(`with m := 5 select (with n := (${UPSERT}) insert collab::Bug { ${BUG_VALUES}, number := n.last + m }) { number }`);
  assert(/\), (m_\d+) AS \( INSERT INTO bug .* FROM \1 AS \1_\d+$/.test(nested), nested);
});

Deno.test("with-bound paths - a shape on (with … select …) is still refused", async () => {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser("select (with x := 1 select collab::Bug) { number }").parse());

  assert(!result.ok);
  assertStringIncludes(result.error.message, "A shape on a parenthesized query is only supported for insert, update and delete");
});

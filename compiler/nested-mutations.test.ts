/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Where nested mutations land in the compiled SQL: every INSERT, UPDATE and
 * DELETE is the statement itself or a CTE of its top-level WITH, as
 * PostgreSQL requires, under a name no other CTE of the query has; a
 * mutation left inside an expression is a compile error. End-to-end
 * behaviour: pg-nested-mutations.test.ts.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Item {
    required name: str;
  }
  type Cart {
    required label: str;
    item: Item;
    multi items: Item;
  }
}
`;

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

async function compile(edgeql: string): Promise<{ error?: string; sql?: string; }> {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  return result.ok ? { sql: new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ") } : { error: result.error.message };
}

/*** The names of the top-level CTEs of `sql`, in order. ***/
function cteNames(sql: string): string[] {
  return [...sql.matchAll(/(?:WITH|\),) (\w+) AS \(/g)].map(match => match[1]);
}

Deno.test("nested mutations - an insert in a link assignment is a CTE reading the ids the outer insert stores", async () => {
  const { sql = "" } = await compile("insert Cart { label := 'o', item := (insert Item { name := 'x' }) }");
  assertEquals(cteNames(sql), ["nested_ids", "ins", "nested"]);
  assertStringIncludes(sql, "nested_ids AS ( SELECT disc_uuidv7() AS __nested_0 )");
  assertStringIncludes(sql, "INSERT INTO cart (label, item_id) VALUES ('o', ( SELECT __nested_0 FROM nested_ids ))");
  assertStringIncludes(sql, "INSERT INTO item (id, name) SELECT nested_ids.__nested_0, 'x' FROM nested_ids AS nested_ids");
  assertStringIncludes(sql, "WHERE nested_ids.__nested_0 IN ( SELECT item_id FROM ins )");
  assert(!/FROM \( INSERT/.test(sql), sql);
});

Deno.test("nested mutations - an update's nested insert runs once per updated row", async () => {
  const { sql = "" } = await compile("update Cart set { item := (insert Item { name := .label }) }");
  assertEquals(cteNames(sql), ["upd", "nested_rows", "nested"]);
  assertStringIncludes(sql, "SET item_id = disc_uuidv7()");
  assertStringIncludes(sql, "INSERT INTO item (id, name) SELECT cart.item_id, cart.label FROM nested_rows AS cart");
});

Deno.test("nested mutations - the CTEs of several multi-link writes get distinct names at the top level", async () => {
  const twoUpdates = await compile(
    "with a := (update Cart filter .label = 'a' set { items += (select Item) }), b := (update Cart filter .label = 'b' set { items += (select Item) }) select {a, b}"
  );
  const names = cteNames(twoUpdates.sql ?? "");
  assertEquals(names.length, 6, twoUpdates.sql);
  assertEquals(new Set(names).size, names.length, twoUpdates.sql);

  // Under a select in a binding, and in the body of a `for` over a set literal.
  for (
    const edgeql of [
      "with x := (select (update Cart set { items := (select Item) }) { label }) select x",
      "for n in {'a', 'b'} union (insert Cart { label := n, items := (select Item) })",
      "for n in {'a', 'b'} union (update Cart filter .label = n set { label := n ++ '!' })"
    ]
  ) {
    const { sql = "" } = await compile(edgeql);
    assert(sql.startsWith("WITH "), sql);
    assert(!/\( WITH/.test(sql) && !/UNION ALL (UPDATE|INSERT|WITH)/.test(sql), sql);
    assertEquals(new Set(cteNames(sql)).size, cteNames(sql).length, sql);
  }
});

Deno.test("nested mutations - a mutation inside an expression is a compile error", async () => {
  const { error = "" } = await compile("insert Cart { label := 'o', item := (update Item filter .name = 'x' set { name := 'y' }) }");
  assertStringIncludes(error, "Cannot run an update of 'item' inside an expression");

  const nestedUpsert = await compile("insert Cart { label := 'o', item := (insert Item { name := 'x' } unless conflict) }");
  assertStringIncludes(nestedUpsert.error ?? "", "cannot have `unless conflict`");
});

Deno.test("nested mutations - a shape over a mutation reads its links through the statement's CTEs; other SQL is unchanged", async () => {
  // A shape over the insert: the junction as the statement leaves it, and the
  // target table with the object the nested insert adds.
  const { sql = "" } = await compile(
    "select (insert Cart { label := 'o', items := (select Item), item := (insert Item { name := 'x' }) }) { items: { name }, item: { name } }"
  );
  assertStringIncludes(sql, "ON CONFLICT DO NOTHING RETURNING * )");
  assertStringIncludes(sql, `("source_id", "target_id") NOT IN (SELECT "source_id", "target_id" FROM "link_0") UNION ALL SELECT * FROM link_0`);
  assertStringIncludes(sql, `("id") NOT IN (SELECT "id" FROM "nested") UNION ALL SELECT * FROM nested`);

  // The same insert without a shape, and a shape over the tables alone.
  const bare = await compile("insert Cart { label := 'o', items := (select Item), item := (insert Item { name := 'x' }) }");
  const select = await compile("select Cart { items: { name }, item: { name } }");
  for (const plain of [bare.sql ?? "", select.sql ?? ""]) {
    assert(!plain.includes("NOT IN") && !plain.includes("UNION ALL") && !plain.includes("RETURNING * ) nested"), plain);
  }
  assertStringIncludes(bare.sql ?? "", "ON CONFLICT DO NOTHING ), nested");
});

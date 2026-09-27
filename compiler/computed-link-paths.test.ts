/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A `(select …)` computed link followed in a path, a sub-shape's own
 * `limit` / `offset`, and a computed property over a backlink compile (the
 * rows are checked against PostgreSQL in pg-computed-link-paths.test.ts).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { compileEdgeQL } from "./test-helpers.ts";

const manager = new SchemaManager({ dryRun: true });
const parsed = manager.parseSDL(`module default {
  type U { required name: str; }
  type P {
    required title: str;
    required author: U;
    single link first := (select .<post[is C] order by .created limit 1);
    multi link recent := (select .<post[is C] order by .created desc limit 2);
    property bodies := .<post[is C].body;
    title2 := .title ++ '!';
  }
  type C { required post: P; required body: str; required created: datetime; }
}`);
if (!parsed.ok) {
  throw parsed.error;
}
const schema = manager.modulesToSchema(parsed.value);

for (
  const query of [
    "select P { t := .first.body, e := exists .first, n := count(.recent) }",
    "select P { title } filter .first.body = 'c1' order by .first.created",
    "select P { title } filter 'c2' in .recent.body",
    "select P.recent { body }",
    "select P { recent: { body } filter .body != 'x' order by .created offset 1 limit 1 }",
    "select P { bodies } filter 'c2' in .bodies"
  ]
) {
  Deno.test(`computed link paths - compiles: ${query}`, () => {
    compileEdgeQL(query, schema);
  });
}

Deno.test("computed link paths - a sub-shape parses offset and limit after filter and order by", () => {
  const query = new EdgeQLParser("select P { recent: { body } filter .body != 'x' order by .created offset 1 limit 2 }").parse();
  const select = query.kind === "SelectQuery" ? query : undefined;
  const element = select?.shape?.elements[0];
  assertEquals(element?.filter?.kind, "BinaryOp");
  assertEquals(element?.orderBy?.length, 1);
  assertEquals(element?.offset?.kind, "Literal");
  assertEquals(element?.limit?.kind, "Literal");
});

Deno.test("computed link paths - a computed property is its expression in a filter, not a column", () => {
  const sql = compileEdgeQL("select P { title } filter .title2 = 'p1!'", schema);
  assertEquals(sql.includes(".title2"), false, sql);
  assertStringIncludes(sql, "||");
});

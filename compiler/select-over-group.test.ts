/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * A select over a group (`select (group T by …) { … } filter … order by …`),
 * as Gel 7.1 allows it: one SQL `GROUP BY` whose select item is the shape,
 * its filter the `HAVING` and its order by, offset and limit the groups'.
 * The shape reads the group's `key`, `grouping` and `elements`; a computable
 * aggregates the elements over the group's rows (`count(.elements)` is
 * `COUNT(*)`), and the filter and order by read the shape's computables.
 *
 * See server/select-over-group-pg.test.ts for the same queries against PostgreSQL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type User {
    required name: str;
    role: str;
    score: int64;
  };
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

async function compiled(edgeql: string): Promise<{ error?: string; sql?: string; }> {
  const compiler = new EdgeQLCompiler(await testSchema(), { enableAccessControl: false });
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  return result.ok ? { sql: new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ") } : { error: result.error.message };
}

async function sqlOf(edgeql: string): Promise<string> {
  const { error, sql } = await compiled(edgeql);
  assert(sql, `expected '${edgeql}' to compile: ${error}`);
  return sql;
}

Deno.test("select over group - the shape is each group's object, its computables aggregating the group's rows", async () => {
  assertEquals(
    await sqlOf("select (group User by .role) { key: {role}, n := count(.elements), total := sum(.elements.score) }"),
    "SELECT jsonb_build_object('key', jsonb_build_object('role', user_1.role), 'n', COUNT(*), 'total', SUM(user_1.score)) " +
      "FROM \"user\" AS user_1 GROUP BY user_1.role"
  );
});

Deno.test("select over group - filter, order by and limit apply to the groups and read the shape's computables", async () => {
  const sql = await sqlOf("select (group User by .role) { key: {role}, n := count(.elements) } filter .n > 1 order by .key.role limit 1");

  assertStringIncludes(sql, "GROUP BY user_1.role HAVING COUNT(*) > 1 ORDER BY user_1.role ASC NULLS FIRST LIMIT 1");
});

Deno.test("select over group - elements take the select's sub-shape; key and grouping read as the group's", async () => {
  const sql = await sqlOf("select (group User { name } by .role) { key, grouping, elements: { score } }");

  assertStringIncludes(sql, "'key', jsonb_build_object('role', user_1.role)");
  assertStringIncludes(sql, "'grouping', jsonb_build_array('role')");
  assertStringIncludes(sql, "'elements', jsonb_agg(jsonb_build_object('score', user_1.score))");
});

Deno.test("select over group - a group has no other field, with Gel's error", async () => {
  for (const [query, field] of [["{ role }", "role"], ["{ key: {name} }", "name"], ["{ n := count(.members) }", "members"]]) {
    const { error } = await compiled(`select (group User by .role) ${query}`);
    assertEquals(error, `object type 'std::FreeObject' has no link or property '${field}'`);
  }
});

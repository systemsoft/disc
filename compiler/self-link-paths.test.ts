/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Link paths on a type that links to itself: every subquery over the link's
 * target table aliases it, so the outer row's reference (the bare table name
 * in an update/delete, or a parent sub-shape's alias) is never captured by
 * the inner FROM. Rows are checked in pg-self-link-paths.test.ts.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `module default {
  type Person {
    required name: str {
      constraint exclusive;
    };
    title: str;
    manager: Person;
    multi reports: Person;
  }
}`;

let cachedSchema: Schema | undefined;

async function sqlOf(edgeql: string): Promise<string> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(SDL);
    if (!parsed.ok) {
      throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
    }
    cachedSchema = manager.modulesToSchema(parsed.value);
  }
  const result = new EdgeQLCompiler(cachedSchema, { enableAccessControl: false }).compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw result.error;
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

const MANAGER_NAME = `(SELECT "__l0_manager"."name" FROM "person" "__l0_manager" WHERE "__l0_manager"."id" = "person"."manager_id")`;

Deno.test("self link - update filter and set read the updated row's link", async () => {
  const sql = await sqlOf("update Person filter .manager.name = 'A' set { title := .manager.name }");
  assertStringIncludes(sql, `SET title = ${MANAGER_NAME}`);
  assertStringIncludes(sql, `WHERE ${MANAGER_NAME} = 'A'`);
});

Deno.test("self link - delete filter reads the deleted row's link", async () => {
  const sql = await sqlOf("delete Person filter .manager.name = 'A'");
  assertStringIncludes(sql, `WHERE ${MANAGER_NAME} = 'A'`);
});

Deno.test("self link - upsert else-update reads the conflicting row's link", async () => {
  const sql = await sqlOf(
    "insert Person { name := 'A' } unless conflict on .name else (update Person filter .manager.name = 'B' set { title := .manager.name })"
  );
  assertStringIncludes(sql, `DO UPDATE SET title = ${MANAGER_NAME} WHERE ${MANAGER_NAME} = 'B'`);
});

Deno.test("self link - each hop of a link chain has its own alias", async () => {
  const sql = await sqlOf("update Person filter .manager.manager.name = 'A' set { title := 'x' }");
  assertStringIncludes(
    sql,
    `(SELECT "__l1_manager"."name" FROM "person" "__l1_manager" WHERE "__l1_manager"."id" = (SELECT "__l0_manager"."manager_id" FROM "person" "__l0_manager" WHERE "__l0_manager"."id" = "person"."manager_id"))`
  );
});

Deno.test("self link - backlink count correlates to the outer row", async () => {
  const sql = await sqlOf("update Person set { title := <str>count(.<manager[is Person]) }");
  assertStringIncludes(sql, `(SELECT COUNT(*) FROM "person" "__bl_manager" WHERE "__bl_manager"."manager_id" = "person"."id")`);
});

Deno.test("self link - backlink comparison is EXISTS over the backlinked rows, not the forward link", async () => {
  const sql = await sqlOf("update Person filter .<manager[is Person].name = 'B' set { title := 'x' }");
  assertStringIncludes(
    sql,
    `EXISTS (SELECT 1 FROM "person" "__bl_manager" WHERE "__bl_manager"."manager_id" = "person"."id" AND "__bl_manager"."name" = 'B')`
  );
});

Deno.test("self link - junction-backed backlink comparison joins through the junction", async () => {
  const sql = await sqlOf("select Person { name } filter .<reports[is Person].name = 'B'");
  assert(
    /EXISTS \(SELECT 1 FROM "person_reports" "__blj_reports" INNER JOIN "person" "__bl_reports" ON "__bl_reports"\."id" = "__blj_reports"\."source_id" WHERE "__blj_reports"\."target_id" = "person_\d+"\."id" AND "__bl_reports"\."name" = 'B'\)/
      .test(sql),
    sql
  );
});

Deno.test("self link - nested sub-shapes correlate each level to its parent's alias", async () => {
  const sql = await sqlOf("select Person { manager: { name, manager: { name } } }");
  assertStringIncludes(sql, "FROM person AS person_3 WHERE person_3.id = person_2.manager_id");
  assertStringIncludes(sql, "FROM person AS person_2 WHERE person_2.id = person_1.manager_id");
});

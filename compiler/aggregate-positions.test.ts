/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Aggregates over one value of the current object, by where they sit:
 *
 * - In a filter, an order by, an update's or delete's filter, they aggregate
 *   the object's own set of at most one element, as in a shape: a scalar
 *   subquery over `(SELECT <value>) AS __set(value)`. In place (`BOOL_OR(…)`
 *   in WHERE) PostgreSQL rejects them: "aggregate functions are not allowed
 *   in WHERE". So through a chain of single links (`.best.lead.name`), and a
 *   chain ending in a single link (`count(.best.lead)`, `exists .best.lead`).
 * - In a group's filter (HAVING) they aggregate the group's rows in place;
 *   a select nested in that filter is per object again.
 *
 * Real-PG coverage: `compiler/pg-aggregate-positions.test.ts`.
 */

import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Lead {
    required name: str;
  }
  type Post {
    required title: str;
    lead: Lead;
  }
  type User {
    required name: str;
    team: str;
    visits: int64;
    best: Post;
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

const LEAD_NAME = `(SELECT "__l1_lead"."name" FROM "lead" "__l1_lead" WHERE "__l1_lead"."id" = ` +
  `(SELECT "__l0_best"."lead_id" FROM "post" "__l0_best" WHERE "__l0_best"."id" = "user_1"."best_id"))`;

Deno.test("aggregate over a chain of single links in a filter: one per object", () => {
  const perObject = (edgeql: string, aggregate: string): void => {
    const sql = compile(edgeql);
    assertStringIncludes(sql, `( SELECT ${aggregate} FROM ( SELECT ${LEAD_NAME}`, edgeql);
    assertStringIncludes(sql, ") AS __set(value) WHERE __set.value IS NOT NULL )", edgeql);
  };
  perObject("select User { name } filter any(.best.lead.name = 'x')", "COALESCE(BOOL_OR(__set.value), FALSE)");
  perObject("select User { name } filter all(.best.lead.name = 'x')", "COALESCE(BOOL_AND(__set.value), TRUE)");
  perObject("select User { name } filter count(.best.lead.name) = 0", "COUNT(*)");
  perObject("select User { name } filter max(.best.lead.name) = 'y'", "MAX(__set.value)");
  perObject("select User { name } order by any(.best.lead.name = 'x')", "COALESCE(BOOL_OR(__set.value), FALSE)");
});

Deno.test("aggregate over a chain of single links in an update's and a delete's filter: one per object", () => {
  for (const edgeql of ["update User filter any(.best.lead.name = 'x') set { visits := 1 }", "delete User filter any(.best.lead.name = 'x')"]) {
    assertMatch(compile(edgeql), /WHERE \( SELECT COALESCE\(BOOL_OR\(__set\.value\), FALSE\) FROM \( SELECT \(SELECT "__l1_lead"\."name"/, edgeql);
  }
});

Deno.test("a chain of single links may end in a link: its FK column", () => {
  const leadId = `(SELECT "__l0_best"."lead_id" FROM "post" "__l0_best" WHERE "__l0_best"."id" = "user_1"."best_id")`;
  assertStringIncludes(compile("select User { name } filter count(.best.lead) = 1"), `( SELECT COUNT(*) FROM ( SELECT ${leadId} ) AS __set(value)`);
  assertStringIncludes(compile("select User { name } filter exists .best.lead"), `WHERE ${leadId} IS NOT NULL`);
});

Deno.test("aggregate in a group's filter aggregates the group's rows; a select in it is per object", () => {
  assertStringIncludes(compile("group User by .team filter sum(.visits) > 3"), "HAVING SUM(user_1.visits) > 3");
  assertStringIncludes(compile("group User by .team filter count(.visits) = 0"), "HAVING COUNT(user_1.visits) = 0");
  assertStringIncludes(compile("group User by .team filter any(.best.lead.name = 'x')"), `HAVING BOOL_OR(${LEAD_NAME} = 'x')`);
  assertStringIncludes(compile("group User by .team filter count(User) = 2"), "HAVING COUNT(*) = 2");
  const nested = compile("group User by .team filter count((select Post filter any(.lead.name = 'x'))) > 0");
  assertStringIncludes(nested, "WHERE ( SELECT COALESCE(BOOL_OR(__set.value), FALSE) FROM ( SELECT (SELECT \"__l0_lead\".\"name\"");
  assertEquals(nested.includes("HAVING BOOL_OR"), false, nested);
});

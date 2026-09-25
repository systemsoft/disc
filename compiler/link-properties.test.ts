/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Link properties compile against the link's junction table:
 *
 * - `@prop` in a link's sub-shape (and in its `filter` / `order by`) reads the
 *   junction column, keyed `"@prop"` in the result;
 * - `.link@prop <op> x` filters the source with EXISTS over the junction
 *   (true when any link matches);
 * - `link := (select T …) { @prop := v }` in an insert/update writes the column
 *   on the junction row; for an already-linked target the junction insert's
 *   `ON CONFLICT (source_id, target_id) DO UPDATE` sets the given properties.
 *
 * Real-PG coverage lives in `server/link-properties-pg.test.ts`.
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type * as EdgeQLAST from "../edgeql/ast.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { serializeSchema } from "./sdl-serializer.ts";

const SDL = `
module default {
  type User {
    required name: str;
  }
  type Program {
    required name: str;
    multi members: User {
      role: str;
      joinedAt: datetime;
    };
    multi viewers: User;
    owner: User;
  }
}
`;

function schema() {
  const mgr = new SchemaManager({ dryRun: true });
  const parsed = mgr.parseSDL(SDL, { validate: false });
  if (!parsed.ok)
    throw parsed.error;
  return mgr.modulesToSchema(parsed.value);
}

function compile(edgeql: string): string {
  const result = new EdgeQLCompiler(schema()).compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok)
    throw result.error;
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

function shapeOf(edgeql: string): EdgeQLAST.Shape {
  const query = new EdgeQLParser(edgeql).parse() as EdgeQLAST.SelectQuery;
  return query.shape!;
}

Deno.test("link properties - the compiler schema carries them on the link, with snake_case columns", () => {
  const members = schema().types.get("Program")!.links.get("members")!;

  assertEquals([...members.properties!.keys()], ["role", "joinedAt"]);
  assertEquals(members.properties!.get("joinedAt")!.columnName, "joined_at");
});

Deno.test("link properties - parse `@prop` and `@alias := expr` in a sub-shape", () => {
  const members = shapeOf(`select Program { members: { name, @role, @r := @role } }`).elements[0].shape!.elements;

  assertEquals(members[1].linkProperty, true);
  assertEquals(members[1].name?.name, "role");
  assertEquals(members[1].expr, { kind: "Path", steps: [{ kind: "PathStep", type: "link_property", name: "role" }] });
  assertEquals(members[2].linkProperty, true);
  assertEquals(members[2].computable, true);
  assertEquals(members[2].name?.name, "r");
});

Deno.test("link properties - parse `.link@prop` as a link step followed by a link-property step", () => {
  const query = new EdgeQLParser(`select Program filter .members@role = "admin"`).parse() as EdgeQLAST.SelectQuery;
  const left = (query.filter as EdgeQLAST.BinaryOp).left as EdgeQLAST.Path;

  assertEquals(left.steps.map(s => [s.type, s.name]), [["property", "members"], ["link_property", "role"]]);
});

Deno.test("link properties - `@prop` in a sub-shape reads the junction column", () => {
  const sql = compile(`select Program { members: { name, @role, @joinedAt } }`);

  assertStringIncludes(sql, "'@role', program_members.role");
  assertStringIncludes(sql, "'@joinedAt', program_members.joined_at");
});

Deno.test("link properties - a computed link property in a sub-shape", () => {
  const sql = compile(`select Program { members: { @r := @role ++ "!" } }`);

  assertStringIncludes(sql, "'@r', program_members.role || '!'");
});

Deno.test("link properties - sub-shape filter and order by on a link property", () => {
  const sql = compile(`select Program { members: { name } filter @role = "admin" order by @role desc }`);

  assertStringIncludes(sql, "AND (program_members.role = 'admin')");
  assertStringIncludes(sql, "ORDER BY program_members.role DESC");
});

Deno.test("link properties - `.link@prop` filter is EXISTS over the junction", () => {
  const sql = compile(`select Program filter .members@role = "admin"`);

  assertStringIncludes(
    sql,
    `EXISTS (SELECT 1 FROM "program_members" "__lp_members" WHERE "__lp_members"."source_id" = "program_1"."id" AND "__lp_members"."role" = 'admin')`
  );
});

Deno.test("link properties - `x in .link@prop` is EXISTS with equality", () => {
  const sql = compile(`select Program filter "admin" in .members@role`);

  assertStringIncludes(sql, `AND "__lp_members"."role" = 'admin')`);
});

Deno.test("link properties - `.link@prop in {…}` keeps the set membership inside the EXISTS", () => {
  const sql = compile(`select Program filter .members@role in {"admin", "owner"}`);

  assertStringIncludes(sql, `"__lp_members"."role" IN ('admin', 'owner')`);
});

Deno.test("link properties - insert writes link properties on the junction row", () => {
  const sql = compile(`insert Program { name := "p", members := (select User filter .name = "a") { @role := "admin" } }`);

  assertStringIncludes(sql, "INSERT INTO program_members (source_id, target_id, role) SELECT ins.id, sub.id, 'admin' FROM ins,");
  assertStringIncludes(sql, `ON CONFLICT (source_id, target_id) DO UPDATE SET role = EXCLUDED."role"`);
});

Deno.test("link properties - a set of shaped targets writes one junction insert per element", () => {
  const sql = compile(`insert Program { name := "p", members := {
    (select User filter .name = "a") { @role := "admin" },
    (select User filter .name = "b") { @role := <str>$r }
  } }`);

  assertStringIncludes(sql, "link_0 AS ( INSERT INTO program_members (source_id, target_id, role) SELECT ins.id, sub.id, 'admin'");
  assertStringIncludes(sql, "link_1 AS ( INSERT INTO program_members (source_id, target_id, role) SELECT ins.id, sub.id, CAST($1 AS text)");
});

Deno.test("link properties - a target without link properties keeps ON CONFLICT DO NOTHING", () => {
  const sql = compile(`insert Program { name := "p", members := (select User filter .name = "a") }`);

  assertStringIncludes(sql, "INSERT INTO program_members (source_id, target_id) SELECT ins.id, sub.id FROM ins,");
  assertStringIncludes(sql, "ON CONFLICT DO NOTHING");
});

Deno.test("link properties - update `+=` upserts the junction row's link properties", () => {
  const sql = compile(`update Program filter .name = "p" set { members += (select User filter .name = "b") { @role := "owner" } }`);

  assertStringIncludes(sql, "INSERT INTO program_members (source_id, target_id, role) SELECT upd.id, sub.id, 'owner' FROM upd,");
  assertStringIncludes(sql, `ON CONFLICT (source_id, target_id) DO UPDATE SET role = EXCLUDED."role"`);
});

Deno.test("link properties - update `:=` of a set keeps every new target out of the delete", () => {
  const sql = compile(`update Program filter .name = "p" set { members := {
    (select User filter .name = "a") { @role := "x" },
    (select User filter .name = "b")
  } }`);

  assertStringIncludes(sql, "DELETE FROM program_members WHERE (source_id IN ( SELECT id FROM upd )) AND ((target_id NOT IN ( SELECT user_1.id");
  assertStringIncludes(sql, "AND (target_id NOT IN ( SELECT user_2.id");
});

Deno.test("link properties - errors name the problem", () => {
  assertThrows(() => compile(`select Program { members: { @rank } }`), Error, "Link 'members' has no link property 'rank'");
  assertThrows(() => compile(`select Program { viewers: { @role } }`), Error, "Link 'viewers' has no link property 'role'");
  assertThrows(() => compile(`select Program { owner: { @role } }`), Error, "Link property '@role'");
  assertThrows(() => compile(`select Program { name } filter @role = "x"`), Error, "Link property '@role'");
  assertThrows(() => compile(`select Program filter .members@rank = 1`), Error, "Link 'members' has no link property 'rank'");
  assertThrows(
    () => compile(`insert Program { name := "p", members := (select User filter .name = "a") { @rank := 1 } }`),
    Error,
    "Link 'members' has no link property 'rank'"
  );
});

Deno.test("link properties - schema export keeps them in the link body, and re-parses", () => {
  const sdl = serializeSchema(schema());

  assertStringIncludes(sdl, "multi link members -> User {");
  assertStringIncludes(sdl, "role: str;");
  const mgr = new SchemaManager({ dryRun: true });
  const reparsed = mgr.parseSDL(sdl, { validate: false });
  if (!reparsed.ok)
    throw reparsed.error;
  const members = mgr.modulesToSchema(reparsed.value).types.get("Program")!.links.get("members")!;
  assertEquals([...members.properties!.keys()], ["role", "joinedAt"]);
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * DDL for altering an existing link. A link's `on target delete` policy is the
 * ON DELETE action of its foreign key, so changing it drops and re-adds that
 * constraint under the name CREATE gave it. Changes the migrator cannot make
 * (target, cardinality) throw instead of emitting a comment, so `disc migrate`
 * fails rather than recording a schema the database does not have.
 *
 * Real-PG coverage lives in `migration/alter-link-pg.test.ts`.
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { normalizeModules, SDLConverter, type Module } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";

function modules(sdl: string): Module[] {
  return normalizeModules(new SDLConverter().convertToModules(new SDLParser(sdl).parse()));
}

function bug(link: string): string {
  return `module default {
    type Program { required name: str; };
    type Bug { required title: str; ${link} };
  };`;
}

function migrationDDL(from: string, to: string): string[] {
  return new DDLGenerator().generateDDL(new SchemaDiffer().diff(modules(from), modules(to)));
}

function initialDDL(sdl: string): string[] {
  return new DDLGenerator().generateDDL(new SchemaDiffer().diff([], modules(sdl)));
}

const RESTRICT = "required link program: Program;";
const DELETE_SOURCE = "required link program: Program { on target delete delete source; };";

Deno.test("alter link - restrict → delete source re-adds the FK with ON DELETE CASCADE", () => {
  assertEquals(migrationDDL(bug(RESTRICT), bug(DELETE_SOURCE)), [
    "ALTER TABLE bug DROP CONSTRAINT fk_bug_program_id, " +
    "ADD CONSTRAINT fk_bug_program_id FOREIGN KEY (program_id) REFERENCES program (id) ON DELETE CASCADE;"
  ]);
});

Deno.test("alter link - the re-added constraint is the one CREATE emits for the new policy", () => {
  const created = initialDDL(bug(DELETE_SOURCE)).find(statement => statement.includes("fk_bug_program_id"))!;
  const altered = migrationDDL(bug(RESTRICT), bug(DELETE_SOURCE))[0];

  assertStringIncludes(altered, created.replace("ALTER TABLE bug ADD ", "").replace(/;$/, ""));
});

Deno.test("alter link - each on-target-delete policy maps to the FK action CREATE uses", () => {
  const cases: [string, string][] = [
    ["cascade", "CASCADE"],
    ["deferred restrict", "RESTRICT"],
    ["delete source", "CASCADE"],
    ["restrict", "RESTRICT"],
    ["set empty", "SET NULL"]
  ];

  for (const [policy, action] of cases) {
    const from = bug(action === "CASCADE" ? "link program: Program;" : "link program: Program { on target delete delete source; };");
    const to = bug(`link program: Program { on target delete ${policy}; };`);
    const ddl = migrationDDL(from, to).join("\n");

    assertStringIncludes(ddl, `REFERENCES program (id) ON DELETE ${action};`, policy);
  }
});

Deno.test("alter link - dropping the policy restores the default RESTRICT", () => {
  assertStringIncludes(migrationDDL(bug(DELETE_SOURCE), bug(RESTRICT)).join("\n"), "ON DELETE RESTRICT;");
});

Deno.test("alter link - multi link re-adds its junction table's target FK", () => {
  const ddl = migrationDDL(
    bug("multi link programs: Program { on target delete restrict; };"),
    bug("multi link programs: Program { on target delete set empty; };")
  );

  assertEquals(ddl, [
    "ALTER TABLE bug_programs DROP CONSTRAINT fk_bug_programs_target_id, " +
    "ADD CONSTRAINT fk_bug_programs_target_id FOREIGN KEY (target_id) REFERENCES program (id) ON DELETE CASCADE;"
  ]);
});

Deno.test("create type - multi link junction honours an explicit on-target-delete policy", () => {
  const junction = initialDDL(bug("multi link programs: Program { on target delete restrict; };"))
    .find(statement => statement.startsWith("CREATE TABLE bug_programs"))!;

  assertStringIncludes(junction, "REFERENCES program (id) ON DELETE RESTRICT");
});

Deno.test("create type - multi link junction cascades when no policy is set", () => {
  const junction = initialDDL(bug("multi link programs: Program;"))
    .find(statement => statement.startsWith("CREATE TABLE bug_programs"))!;

  assert(!junction.includes("RESTRICT"), junction);
  assertStringIncludes(junction, "REFERENCES program (id) ON DELETE CASCADE");
});

Deno.test("alter link - multi link restrict keeps linked targets from being deleted", () => {
  assertStringIncludes(
    migrationDDL(bug("multi link programs: Program;"), bug("multi link programs: Program { on target delete restrict; };")).join("\n"),
    "FOREIGN KEY (target_id) REFERENCES program (id) ON DELETE RESTRICT;"
  );
});

Deno.test("alter link - on source delete delete target creates the trigger against the link target", () => {
  const ddl = migrationDDL(bug(RESTRICT), bug("required link program: Program { on source delete delete target; };")).join("\n");

  assertStringIncludes(ddl, "CREATE OR REPLACE FUNCTION disc_source_delete_bug_program()");
  assertStringIncludes(ddl, "DELETE FROM program WHERE id = OLD.program_id;");
  assertStringIncludes(ddl, "CREATE TRIGGER trg_source_delete_bug_program BEFORE DELETE ON bug");
  assert(!ddl.includes("--"), ddl);
});

Deno.test("alter link - on source delete back to allow drops the trigger", () => {
  const ddl = migrationDDL(bug("required link program: Program { on source delete delete target; };"), bug(RESTRICT));

  assertEquals(ddl, [
    "DROP TRIGGER IF EXISTS trg_source_delete_bug_program ON bug;",
    "DROP FUNCTION IF EXISTS disc_source_delete_bug_program();"
  ]);
});

Deno.test("alter link - required changes set or drop NOT NULL on the FK column", () => {
  assertEquals(migrationDDL(bug("link program: Program;"), bug(RESTRICT)), ["ALTER TABLE bug ALTER COLUMN program_id SET NOT NULL;"]);
  assertEquals(migrationDDL(bug(RESTRICT), bug("link program: Program;")), ["ALTER TABLE bug ALTER COLUMN program_id DROP NOT NULL;"]);
});

Deno.test("alter link - changing the target throws, naming the link and the change", () => {
  const from = `module default {
    type Program { required name: str; };
    type Team { required name: str; };
    type Bug { link owner: Program; };
  };`;
  const to = from.replace("link owner: Program;", "link owner: Team;");

  const error = assertThrows(() => migrationDDL(from, to), Error);

  assertStringIncludes(error.message, "link 'owner' on 'bug'");
  assertStringIncludes(error.message, "target");
});

Deno.test("alter link - single ↔ multi throws instead of emitting a comment", () => {
  const error = assertThrows(() => migrationDDL(bug("link program: Program;"), bug("multi link program: Program;")), Error);

  assertStringIncludes(error.message, "link 'program' on 'bug'");
  assertStringIncludes(error.message, "single → multi");
});

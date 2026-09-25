/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SDL parsing, validation and DDL for link properties. A link property on a
 * `multi` link is a column of the link's junction table, typed like a normal
 * property (`required` → NOT NULL, `default`, constraints as CHECKs on the
 * junction). Adding, dropping or altering one on an existing link alters the
 * junction table. Link properties on a single link are rejected.
 *
 * Real-PG coverage lives in `server/link-properties-pg.test.ts`.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { normalizeModules, SDLConverter, type Module } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { SchemaValidator } from "../schema/validator.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import type * as Types from "./types.ts";

function modules(sdl: string): Module[] {
  return normalizeModules(new SDLConverter().convertToModules(new SDLParser(sdl).parse()));
}

function program(members: string): string {
  return `module default {
    type User { required name: str; };
    type Program { required name: str; ${members} };
  };`;
}

function initialDDL(sdl: string): string[] {
  const differ = new SchemaDiffer();
  return new DDLGenerator().generateDDL(differ.diff([], modules(sdl)));
}

function migrationDDL(from: string, to: string): string[] {
  return new DDLGenerator().generateDDL(new SchemaDiffer().diff(modules(from), modules(to)));
}

function validationErrors(sdl: string): string[] {
  return (new SchemaValidator().validate(new SDLParser(sdl).parse()).errors ?? []).map(e => e.message);
}

function membersLink(sdl: string): Types.LinkDefinition {
  const create = new SchemaDiffer().diff([], modules(sdl)).find(op =>
    op.kind === "CreateType" && (op as Types.CreateTypeOperation).typeName === "Program"
  ) as Types.CreateTypeOperation;
  return create.links.find(l => l.name === "members")!;
}

Deno.test("link properties - colon-form link body declares bare and `property` link properties", () => {
  const link = membersLink(program(`multi members: User { role: str; property since: datetime; };`));

  assertEquals(link.properties?.map(p => [p.name, p.type]), [["role", "str"], ["since", "datetime"]]);
});

Deno.test("link properties - arrow and `link name: T` forms declare link properties too", () => {
  const arrow = membersLink(program(`multi link members -> User { property role: str; };`));
  const colon = membersLink(program(`multi link members: User { role: str; };`));

  assertEquals(arrow.properties?.map(p => p.name), ["role"]);
  assertEquals(colon.properties?.map(p => p.name), ["role"]);
});

Deno.test("link properties - junction table carries typed columns, NOT NULL for required, defaults", () => {
  const ddl = initialDDL(program(`multi members: User {
    role: str;
    required rank: int64 { default := 0; };
    joinedAt: datetime;
  };`));
  const junction = ddl.find(s => s.startsWith("CREATE TABLE program_members"))!;

  assertStringIncludes(junction, "role TEXT");
  assert(!junction.includes("role TEXT NOT NULL"), junction);
  assertStringIncludes(junction, "rank BIGINT NOT NULL DEFAULT 0");
  assertStringIncludes(junction, "joined_at TIMESTAMP WITH TIME ZONE");
});

Deno.test("link properties - constraints become CHECKs on the junction table, after it is created", () => {
  const ddl = initialDDL(program(`multi members: User { role: str { constraint one_of("admin", "member"); }; };`));
  const createAt = ddl.findIndex(s => s.startsWith("CREATE TABLE program_members"));
  const checkAt = ddl.findIndex(s => s.includes("CHECK") && s.includes("program_members"));

  assert(checkAt > createAt, ddl.join("\n"));
  assertStringIncludes(ddl[checkAt], "ALTER TABLE program_members ADD CONSTRAINT chk_program_members_role_one_of");
  assertStringIncludes(ddl[checkAt], "role IN ('admin', 'member')");
});

Deno.test("link properties - adding a link with link properties creates them on its junction", () => {
  const ddl = migrationDDL(program(""), program(`multi members: User { role: str { constraint one_of("a", "b"); }; };`));

  assertStringIncludes(ddl.find(s => s.startsWith("CREATE TABLE program_members"))!, "role TEXT");
  assert(ddl.some(s => s.startsWith("ALTER TABLE program_members ADD CONSTRAINT chk_program_members_role_one_of")), ddl.join("\n"));
});

Deno.test("link properties - adding a link property to an existing link adds a junction column", () => {
  const ddl = migrationDDL(
    program(`multi members: User;`),
    program(`multi members: User { role: str; required rank: int64 { default := 0; }; };`)
  );

  assertEquals(ddl.filter(s => !s.startsWith("--")), [
    "ALTER TABLE program_members ADD COLUMN role TEXT NULL;",
    "ALTER TABLE program_members ADD COLUMN rank BIGINT NOT NULL DEFAULT 0;"
  ]);
});

Deno.test("link properties - dropping a link property drops its junction column", () => {
  const ddl = migrationDDL(program(`multi members: User { role: str; };`), program(`multi members: User;`));

  assertEquals(ddl.filter(s => !s.startsWith("--")), ["ALTER TABLE program_members DROP COLUMN IF EXISTS role;"]);
});

Deno.test("link properties - altering a link property alters its junction column", () => {
  const ddl = migrationDDL(
    program(`multi members: User { role: str; };`),
    program(`multi members: User { required role: str { constraint one_of("a", "b"); }; };`)
  );

  assert(ddl.includes("ALTER TABLE program_members ALTER COLUMN role SET NOT NULL;"), ddl.join("\n"));
  assert(ddl.some(s => s.startsWith("ALTER TABLE program_members ADD CONSTRAINT") && s.includes("CHECK")), ddl.join("\n"));
});

Deno.test("link properties - an unchanged link property produces no migration", () => {
  const sdl = program(`multi members: User { role: str; };`);

  assertEquals(new SchemaDiffer().diff(modules(sdl), modules(sdl)), []);
});

Deno.test("link properties - dropping a link property is classified as a data-losing change", () => {
  const ops = new SchemaDiffer().diff(modules(program(`multi members: User { role: str; };`)), modules(program(`multi members: User;`)));
  const alter = ops.find(op => op.kind === "AlterType") as Types.AlterTypeOperation;
  const alterLink = alter.operations.find(op => op.kind === "AlterLink") as Types.AlterLinkOperation;

  assertEquals(alterLink.propertyOperations?.map(op => op.kind), ["DropProperty"]);
});

Deno.test("link properties - validator rejects link properties on a single link", () => {
  const errors = validationErrors(program(`owner: User { role: str; };`));

  assertEquals(errors.length, 1);
  assertStringIncludes(errors[0], "Link 'owner': link properties are only supported on multi links");
});

Deno.test("link properties - validator rejects multi link properties and reserved names", () => {
  assertStringIncludes(validationErrors(program(`multi members: User { multi tags: str; };`))[0], "cannot be multi");
  assertStringIncludes(validationErrors(program(`multi members: User { source_id: str; };`))[0], "reserved");
});

Deno.test("link properties - validator rejects link properties on a scalar property", () => {
  assertStringIncludes(validationErrors(program(`nickname: str { role: str; };`))[0], "only links can have link properties");
});

Deno.test("link properties - validator accepts link properties on a multi link", () => {
  assertEquals(validationErrors(program(`multi members: User { role: str { constraint one_of("a"); }; };`)), []);
});

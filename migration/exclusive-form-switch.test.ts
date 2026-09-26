/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Moving an exclusive constraint between its type-level form
 * (`constraint exclusive on (.program)`) and its link- or property-level form
 * (`program: Program { constraint exclusive; }`) in one migration.
 *
 * Both forms declare the same unique index, `uk_<table>_<column>`. The switch
 * used to diff as a drop of one plus a create of the other, and the create ran
 * first: PostgreSQL refused it with "relation already exists".
 *
 * The PG tests require PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { normalizeModules, SDLConverter, type Module } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaDiffer } from "./differ.ts";
import { SchemaManager } from "./schema-manager.ts";

import type * as Types from "./types.ts";

const LINK_LEVEL = "required title: str; program: Program { constraint exclusive; };";
const LINK_TYPE_LEVEL = "required title: str; program: Program; constraint exclusive on (.program);";
const PROPERTY_LEVEL = "required title: str { constraint exclusive; }; program: Program;";
const PROPERTY_TYPE_LEVEL = "required title: str; program: Program; constraint exclusive on (.title);";

function bug(members: string): string {
  return `module default {
    type Program { required name: str; };
    type Bug { ${members} };
  };`;
}

function modules(sdl: string): Module[] {
  return normalizeModules(new SDLConverter().convertToModules(new SDLParser(sdl).parse()));
}

Deno.test("exclusive form switch - type-level to link-level exclusive diffs to nothing", () => {
  assertEquals(new SchemaDiffer().diff(modules(bug(LINK_TYPE_LEVEL)), modules(bug(LINK_LEVEL))), []);
});

Deno.test("exclusive form switch - link-level to type-level exclusive diffs to nothing", () => {
  assertEquals(new SchemaDiffer().diff(modules(bug(LINK_LEVEL)), modules(bug(LINK_TYPE_LEVEL))), []);
});

Deno.test("exclusive form switch - type-level to property-level exclusive diffs to nothing", () => {
  assertEquals(new SchemaDiffer().diff(modules(bug(PROPERTY_TYPE_LEVEL)), modules(bug(PROPERTY_LEVEL))), []);
});

Deno.test("exclusive form switch - property-level to type-level exclusive diffs to nothing", () => {
  assertEquals(new SchemaDiffer().diff(modules(bug(PROPERTY_LEVEL)), modules(bug(PROPERTY_TYPE_LEVEL))), []);
});

Deno.test("exclusive form switch - dropping a type-level exclusive on a link still drops its index", () => {
  const ops = new SchemaDiffer().diff(modules(bug(LINK_TYPE_LEVEL)), modules(bug("required title: str; program: Program;")));

  assertEquals(ops, [{ indexName: "uk_bug_program_id", kind: "DropIndex" } as Types.DropIndexOperation]);
});

async function migrate(pool: ConnectionPool, sdl: string): Promise<void> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    const result = await manager.applySchema(sdl);

    if (!result.ok)
      throw result.error;
  } finally {
    await manager.close();
  }
}

async function switchForms(from: string, to: string, row: (program: string) => [string, unknown[]], index: string): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();

  try {
    await resetTestDatabase(pool);
    await migrate(pool, bug(from));

    const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
    const [insert, params] = row(program);
    await pool.query(insert, params);

    await migrate(pool, bug(to));

    const error = await assertRejects(() => pool.query(insert, params));
    assertStringIncludes((error as Error).message, index, "the unique index still enforces the constraint");

    /*** The next migrate from the new form is a no-op. ***/
    await migrate(pool, bug(to));
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

const linkRow = (program: string): [string, unknown[]] => [`INSERT INTO bug (title, program_id) VALUES ('t', $1)`, [program]];
const propertyRow = (): [string, unknown[]] => [`INSERT INTO bug (title) VALUES ('same')`, []];

Deno.test({
  name: "PG exclusive form switch: link, type-level to link-level",
  ignore: !canRunPgTests(),
  fn: () => switchForms(LINK_TYPE_LEVEL, LINK_LEVEL, linkRow, "uk_bug_program_id")
});

Deno.test({
  name: "PG exclusive form switch: link, link-level to type-level",
  ignore: !canRunPgTests(),
  fn: () => switchForms(LINK_LEVEL, LINK_TYPE_LEVEL, linkRow, "uk_bug_program_id")
});

Deno.test({
  name: "PG exclusive form switch: property, type-level to property-level",
  ignore: !canRunPgTests(),
  fn: () => switchForms(PROPERTY_TYPE_LEVEL, PROPERTY_LEVEL, propertyRow, "uk_bug_title")
});

Deno.test({
  name: "PG exclusive form switch: property, property-level to type-level",
  ignore: !canRunPgTests(),
  fn: () => switchForms(PROPERTY_LEVEL, PROPERTY_TYPE_LEVEL, propertyRow, "uk_bug_title")
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Drift repair looks tables up by the name PostgreSQL stores: a quoted
 * identifier keeps its case (a camelCase link's junction is created as
 * `"channel_pinnedVideo"`), a bare one folds to lowercase.
 */

import { assert, assertEquals } from "@std/assert";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import {
  reconcileAbstractMirrors,
  reconcileCreateTables,
  reconcileLinkDeleteRules,
  withoutDropsOf,
  type ExistingColumn,
  type ExistingDeleteRules
} from "./reconcile.ts";
import type { DeclaredLink, MigrationOperation, MirrorAbstractTypeOperation } from "./types.ts";

const JUNCTION: ExistingColumn[] = [
  { dataType: "uuid", name: "source_id" },
  { dataType: "uuid", name: "target_id" }
];

const CREATE_JUNCTION = `CREATE TABLE "channel_pinnedVideo" (source_id UUID NOT NULL, target_id UUID NOT NULL);`;
const JUNCTION_CONSTRAINT = `ALTER TABLE "channel_pinnedVideo" ADD CONSTRAINT "uk_channel_pinnedVideo_source_target" UNIQUE (source_id, target_id);`;

Deno.test("reconcileCreateTables finds an existing quoted mixed-case table and skips its CREATE and dependents", async () => {
  const asked: string[] = [];
  const result = await reconcileCreateTables([CREATE_JUNCTION, JUNCTION_CONSTRAINT], tableName => {
    asked.push(tableName);
    return Promise.resolve(tableName === "channel_pinnedVideo" ? JUNCTION : null);
  });

  assertEquals(asked, ["channel_pinnedVideo"]);
  assertEquals(result.statements, []);
  assertEquals([...result.skippedTables], ["channel_pinnedVideo"]);
});

Deno.test("reconcileCreateTables folds a bare table name to lowercase", async () => {
  const asked: string[] = [];
  await reconcileCreateTables([`CREATE TABLE Widget (id UUID NOT NULL);`], tableName => {
    asked.push(tableName);
    return Promise.resolve(null);
  });

  assertEquals(asked, ["widget"]);
});

Deno.test("withoutDropsOf keeps a skipped quoted mixed-case table", () => {
  const rollback = [`DROP TABLE IF EXISTS "channel_pinnedVideo" CASCADE;`, `DROP TABLE IF EXISTS video CASCADE;`];

  assertEquals(withoutDropsOf(rollback, new Set(["channel_pinnedVideo"])), [`DROP TABLE IF EXISTS video CASCADE;`]);
});

Deno.test("reconcileCreateTables skips indexes on a skipped quoted table", async () => {
  const result = await reconcileCreateTables(
    [`CREATE TABLE "user" (id UUID NOT NULL);`, `CREATE UNIQUE INDEX uk_user_id ON "user" (id);`],
    tableName => Promise.resolve(tableName === "user" ? [{ dataType: "uuid", name: "id" }] : null)
  );

  assertEquals(result.statements, []);
});

/*** `Bug.program` declares `on target delete delete source`; the database's FK still restricts. ***/
const DELETE_SOURCE: DeclaredLink = {
  link: { annotations: {}, multi: false, name: "program", onTargetDelete: "CASCADE", required: true, target: "Program" },
  tableName: "bug",
  typeName: "Bug"
};

function restrictingDatabase(asked: string[][]): (tableNames: string[]) => Promise<ExistingDeleteRules> {
  return tableNames => {
    asked.push(tableNames);
    return Promise.resolve({
      foreignKeys: new Map([["bug.fk_bug_program_id", "RESTRICT"]]),
      tables: new Set(["bug"]),
      triggers: new Map<string, string>()
    });
  };
}

Deno.test("reconcileLinkDeleteRules re-adds a foreign key whose ON DELETE action differs from the declared one", async () => {
  const result = await reconcileLinkDeleteRules([DELETE_SOURCE], [], new DDLGenerator(), restrictingDatabase([]));

  assertEquals(result.missingForeignKeys, []);
  assertEquals(new DDLGenerator().generateDDL(result.operations), [
    "ALTER TABLE bug DROP CONSTRAINT fk_bug_program_id, ADD CONSTRAINT fk_bug_program_id FOREIGN KEY (program_id) REFERENCES program (id) ON DELETE CASCADE;"
  ]);
});

Deno.test("reconcileLinkDeleteRules leaves a link whose on target delete the migration itself changes", async () => {
  const asked: string[][] = [];
  const planned: MigrationOperation[] = [{
    kind: "AlterType",
    operations: [{ changes: [{ kind: "ChangeOnDelete", newValue: "CASCADE" }, { kind: "ChangeOnSourceDelete" }], kind: "AlterLink", linkName: "program" }],
    typeName: "Bug"
  } as MigrationOperation];

  const result = await reconcileLinkDeleteRules([DELETE_SOURCE], planned, new DDLGenerator(), restrictingDatabase(asked));

  assertEquals(result.operations, []);
  assertEquals(asked, [], "nothing left to look up, so the database is not queried");
});

Deno.test("reconcileLinkDeleteRules reports a foreign key that doesn't exist instead of creating it", async () => {
  const result = await reconcileLinkDeleteRules(
    [DELETE_SOURCE],
    [],
    new DDLGenerator(),
    () => Promise.resolve({ foreignKeys: new Map(), tables: new Set(["bug"]), triggers: new Map<string, string>() })
  );

  assertEquals(result.operations, []);
  assertEquals(result.missingForeignKeys.length, 1);
});

Deno.test("reconcileLinkDeleteRules skips a table that doesn't exist yet", async () => {
  const result = await reconcileLinkDeleteRules(
    [DELETE_SOURCE],
    [],
    new DDLGenerator(),
    () => Promise.resolve({ foreignKeys: new Map(), tables: new Set<string>(), triggers: new Map<string, string>() })
  );

  assertEquals(result, { missingForeignKeys: [], operations: [] });
});

Deno.test("reconcileAbstractMirrors creates missing and changed mirror triggers and drops unneeded ones", async () => {
  const existing = new Map([
    ["person", ["named"]],
    ["company", ["named"]],
    ["tag", ["named"]]
  ]);
  const operations = await reconcileAbstractMirrors(
    [
      { abstractTables: ["named"], tableName: "person" },
      { abstractTables: ["named", "base"], tableName: "company" },
      { abstractTables: ["named"], tableName: "robot" },
      { abstractTables: [], tableName: "tag" },
      { abstractTables: [], tableName: "note" }
    ],
    () => Promise.resolve(existing)
  );

  assertEquals(operations, [
    { abstractTables: ["named", "base"], kind: "MirrorAbstractType", tableName: "company" },
    { abstractTables: ["named"], kind: "MirrorAbstractType", tableName: "robot" },
    { abstractTables: [], kind: "MirrorAbstractType", tableName: "tag" }
  ]);
});

Deno.test("SchemaDiffer.declaredAbstractMirrors - each concrete type's abstract ancestors, at any depth, nearest first", () => {
  const schema = new SDLConverter().convertToModules(
    new SDLParser(`module default {
  abstract type Base { required name: str; };
  abstract type Named extending Base {};
  type Person extending Named {};
  type Employee extending Person {};
  type Tag {};
};`)
      .parse()
  );

  assertEquals(new SchemaDiffer().declaredAbstractMirrors(schema), [
    { abstractTables: ["named", "base"], tableName: "person" },
    { abstractTables: ["named", "base"], tableName: "employee" },
    { abstractTables: [], tableName: "tag" }
  ]);
});

Deno.test("DDLGenerator - MirrorAbstractType creates the trigger and copies existing rows, or drops the trigger", () => {
  const mirror = (abstractTables: string[]): MirrorAbstractTypeOperation => ({ abstractTables, kind: "MirrorAbstractType", tableName: "person" });
  const generator = new DDLGenerator();
  const created = generator.generateDDL([mirror(["named", "base"])]).join("\n");

  assert(created.includes("CREATE OR REPLACE FUNCTION disc_abstract_mirror()"), created);
  assert(
    created.includes(
      `CREATE OR REPLACE TRIGGER "disc_abstract_mirror" AFTER INSERT OR UPDATE OR DELETE ON person FOR EACH ROW EXECUTE FUNCTION disc_abstract_mirror('named', 'base');`
    ),
    created
  );
  assert(created.includes(`INSERT INTO named SELECT (jsonb_populate_record(NULL::named, to_jsonb(disc_row))).* FROM person AS disc_row`), created);
  assert(created.includes(`INSERT INTO base SELECT`), created);

  const dropped = generator.generateDDL([mirror([])]);
  assertEquals(dropped.filter(statement => !statement.startsWith("--")), [`DROP TRIGGER IF EXISTS "disc_abstract_mirror" ON person;`]);
});

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
  reconcileRewrites,
  withoutDropsOf,
  type ExistingColumn,
  type ExistingDeleteRules,
  type ExistingTrigger,
  type ExistingTriggers
} from "./reconcile.ts";
import type {
  AddRewriteOperation,
  AlterTypeOperation,
  DeclaredLink,
  DeclaredRewrites,
  DropRewriteOperation,
  MigrationOperation,
  MirrorAbstractTypeOperation,
  RewriteDefinition,
  TypeOperation
} from "./types.ts";

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
      deferredForeignKeys: new Set<string>(),
      foreignKeys: new Map([["bug.fk_bug_program_id", "RESTRICT"]]),
      tables: new Set(["bug"]),
      triggerBodies: new Map<string, string>(),
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

Deno.test("reconcileLinkDeleteRules defers the foreign key of a link to an abstract type, and only that", async () => {
  const toAbstract: DeclaredLink = { ...DELETE_SOURCE, link: { ...DELETE_SOURCE.link, onTargetDelete: "RESTRICT", targetAbstract: true } };
  const result = await reconcileLinkDeleteRules([toAbstract], [], new DDLGenerator(), restrictingDatabase([]));

  assertEquals(new DDLGenerator().generateDDL(result.operations), [
    "ALTER TABLE bug DROP CONSTRAINT fk_bug_program_id, ADD CONSTRAINT fk_bug_program_id FOREIGN KEY (program_id) REFERENCES program (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;"
  ]);

  // Deferred already: nothing to repair. A link to a concrete type whose FK is deferred is made immediate.
  const deferred = (): Promise<ExistingDeleteRules> =>
    Promise.resolve({
      deferredForeignKeys: new Set(["bug.fk_bug_program_id"]),
      foreignKeys: new Map([["bug.fk_bug_program_id", "RESTRICT"]]),
      tables: new Set(["bug"]),
      triggerBodies: new Map<string, string>(),
      triggers: new Map<string, string>()
    });
  assertEquals((await reconcileLinkDeleteRules([toAbstract], [], new DDLGenerator(), deferred)).operations, []);
  const toConcrete: DeclaredLink = { ...DELETE_SOURCE, link: { ...DELETE_SOURCE.link, onTargetDelete: "RESTRICT" } };
  assertEquals(new DDLGenerator().generateDDL((await reconcileLinkDeleteRules([toConcrete], [], new DDLGenerator(), deferred)).operations), [
    "ALTER TABLE bug DROP CONSTRAINT fk_bug_program_id, ADD CONSTRAINT fk_bug_program_id FOREIGN KEY (program_id) REFERENCES program (id) ON DELETE RESTRICT;"
  ]);
});

Deno.test("reconcileLinkDeleteRules turns a plain RESTRICT foreign key of a deferred restrict link into a deferred NO ACTION one", async () => {
  const deferredRestrict: DeclaredLink = { ...DELETE_SOURCE, link: { ...DELETE_SOURCE.link, onTargetDelete: "DEFERRED RESTRICT" } };
  const result = await reconcileLinkDeleteRules([deferredRestrict], [], new DDLGenerator(), restrictingDatabase([]));

  assertEquals(new DDLGenerator().generateDDL(result.operations), [
    "ALTER TABLE bug DROP CONSTRAINT fk_bug_program_id, ADD CONSTRAINT fk_bug_program_id FOREIGN KEY (program_id) REFERENCES program (id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;"
  ]);

  /*** A deferred RESTRICT (what a link to an abstract type gets) is still not a deferred restrict: its delete check is immediate. ***/
  const database = (onDelete: string): () => Promise<ExistingDeleteRules> => () =>
    Promise.resolve({
      deferredForeignKeys: new Set(["bug.fk_bug_program_id"]),
      foreignKeys: new Map([["bug.fk_bug_program_id", onDelete]]),
      tables: new Set(["bug"]),
      triggerBodies: new Map<string, string>(),
      triggers: new Map<string, string>()
    });
  assertEquals((await reconcileLinkDeleteRules([deferredRestrict], [], new DDLGenerator(), database("RESTRICT"))).operations.length, 1);
  assertEquals((await reconcileLinkDeleteRules([deferredRestrict], [], new DDLGenerator(), database("NO ACTION"))).operations, []);
});

Deno.test("SchemaDiffer marks the links whose target is abstract, and DDL defers their foreign keys", () => {
  const modules = new SDLConverter().convertToModules(
    new SDLParser(`module default {
  abstract type Named { required name: str; };
  type Person extending Named {};
  type Thing {
    link owner -> Named;
    multi link fans -> Named;
    link buyer -> Person;
  };
};`)
      .parse()
  );
  const differ = new SchemaDiffer();
  const links = differ.declaredLinks(modules).filter(entry => entry.tableName === "thing");
  assertEquals(links.map(entry => [entry.link.name, entry.link.targetAbstract ?? false]), [["owner", true], ["fans", true], ["buyer", false]]);

  const ddl = new DDLGenerator().generateDDL(differ.diff([], modules)).join("\n");
  assert(ddl.includes("REFERENCES named (id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;"), ddl);
  assert(/FOREIGN KEY \(target_id\) REFERENCES named \(id\) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED/.test(ddl), ddl);
  assert(ddl.includes("REFERENCES person (id) ON DELETE RESTRICT;"), ddl);
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
    () =>
      Promise.resolve({
        deferredForeignKeys: new Set<string>(),
        foreignKeys: new Map(),
        tables: new Set(["bug"]),
        triggerBodies: new Map<string, string>(),
        triggers: new Map<string, string>()
      })
  );

  assertEquals(result.operations, []);
  assertEquals(result.missingForeignKeys.length, 1);
});

Deno.test("reconcileLinkDeleteRules skips a table that doesn't exist yet", async () => {
  const result = await reconcileLinkDeleteRules(
    [DELETE_SOURCE],
    [],
    new DDLGenerator(),
    () =>
      Promise.resolve({
        deferredForeignKeys: new Set<string>(),
        foreignKeys: new Map(),
        tables: new Set<string>(),
        triggerBodies: new Map<string, string>(),
        triggers: new Map<string, string>()
      })
  );

  assertEquals(result, { missingForeignKeys: [], operations: [] });
});

/*** `Bug.program` declares `on source delete delete target if orphan`; the database's trigger may run another body. ***/
const IF_ORPHAN: DeclaredLink = {
  link: { annotations: {}, multi: false, name: "program", onSourceDelete: "DELETE TARGET IF ORPHAN", required: false, target: "Program" },
  tableName: "bug",
  typeName: "Bug"
};

function triggerDatabase(body: string): () => Promise<ExistingDeleteRules> {
  return () =>
    Promise.resolve({
      deferredForeignKeys: new Set<string>(),
      foreignKeys: new Map([["bug.fk_bug_program_id", "RESTRICT"]]),
      tables: new Set(["bug"]),
      triggerBodies: new Map([["bug.trg_source_delete_bug_program", body]]),
      triggers: new Map([["bug.trg_source_delete_bug_program", "AFTER"]])
    });
}

Deno.test("reconcileLinkDeleteRules replaces a source-delete trigger whose function body differs from the declared policy's", async () => {
  const plainDeleteTarget = " BEGIN DELETE FROM program WHERE id = OLD.program_id; RETURN NULL; END; ";
  const result = await reconcileLinkDeleteRules([IF_ORPHAN], [], new DDLGenerator(), triggerDatabase(plainDeleteTarget));
  const ddl = new DDLGenerator().generateDDL(result.operations);

  assertEquals(ddl.slice(0, 2), [
    "DROP TRIGGER IF EXISTS trg_source_delete_bug_program ON bug;",
    "DROP FUNCTION IF EXISTS disc_source_delete_bug_program();"
  ]);
  assert(ddl[2].includes("IF NOT EXISTS (SELECT 1 FROM bug WHERE program_id = OLD.program_id)"), ddl[2]);
  assertEquals(ddl.length, 4);
});

Deno.test("reconcileLinkDeleteRules leaves a source-delete trigger whose function body is the declared one", async () => {
  const body = ` ${new DDLGenerator().sourceDeleteTrigger("bug", IF_ORPHAN.link).body} `;
  const result = await reconcileLinkDeleteRules([IF_ORPHAN], [], new DDLGenerator(), triggerDatabase(body));

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

const STAMP: RewriteDefinition = { body: "datetime_of_statement()", events: ["insert"] };
const DECLARED_STAMP: DeclaredRewrites = { rewrites: [{ propertyName: "stamp", rewrite: STAMP }], tableName: "post", typeName: "Post" };

function addRewrite(propertyName: string, rewrite: RewriteDefinition): TypeOperation {
  return { kind: "AddRewrite", propertyName, rewrite } as AddRewriteOperation;
}

function dropRewrite(propertyName: string, events: RewriteDefinition["events"]): TypeOperation {
  return { events, kind: "DropRewrite", propertyName } as DropRewriteOperation;
}

/*** A database whose `post` table has `triggers`. ***/
function rewriteDatabase(...triggers: Partial<ExistingTrigger>[]): () => Promise<ExistingTriggers> {
  return () =>
    Promise.resolve({
      tables: new Set(["post"]),
      triggers: triggers.map(trigger => ({ beforeRow: true, body: "", events: ["insert"], function: "", name: "", table: "post", ...trigger }))
    });
}

/*** The trigger `DDLGenerator` creates for `rewrite`, as the database reports it. ***/
function createdRewrite(propertyName: string, rewrite: RewriteDefinition): Partial<ExistingTrigger> {
  const trigger = new DDLGenerator().rewriteTrigger("post", propertyName, rewrite);
  return { body: ` ${trigger.body} `, events: trigger.events, function: trigger.function, name: trigger.name };
}

Deno.test("reconcileRewrites leaves a rewrite trigger the DDL created", async () => {
  assertEquals(await reconcileRewrites([DECLARED_STAMP], [], new DDLGenerator(), rewriteDatabase(createdRewrite("stamp", STAMP))), []);
});

Deno.test("reconcileRewrites creates a missing rewrite trigger and drops one no rewrite declares", async () => {
  const operations = await reconcileRewrites(
    [DECLARED_STAMP],
    [],
    new DDLGenerator(),
    rewriteDatabase({ name: "post__gone__rewrite" }, { name: "post__audit" })
  );

  assertEquals(operations, [{
    kind: "AlterType",
    operations: [
      addRewrite("stamp", STAMP),
      dropRewrite("gone", ["insert", "update"])
    ],
    typeName: "Post"
  }]);
});

Deno.test("reconcileRewrites replaces a rewrite trigger whose body or events differ", async () => {
  const changedBody = await reconcileRewrites(
    [DECLARED_STAMP],
    [],
    new DDLGenerator(),
    rewriteDatabase({ ...createdRewrite("stamp", STAMP), body: " BEGIN NEW.stamp := now(); RETURN NEW; END; " })
  );
  const changedEvents = await reconcileRewrites(
    [DECLARED_STAMP],
    [],
    new DDLGenerator(),
    rewriteDatabase({ ...createdRewrite("stamp", STAMP), events: ["insert", "update"] })
  );
  const replaced: AlterTypeOperation[] = [{
    kind: "AlterType",
    operations: [
      dropRewrite("stamp", ["insert"]),
      addRewrite("stamp", STAMP)
    ],
    typeName: "Post"
  }];

  assertEquals(changedBody, replaced);
  assertEquals(changedEvents, replaced);
});

Deno.test("reconcileRewrites renames an update-only rewrite's trigger created under the insert rewrite's name", async () => {
  const touched: RewriteDefinition = { body: "datetime_of_statement()", events: ["update"] };
  const operations = await reconcileRewrites(
    [{ ...DECLARED_STAMP, rewrites: [{ propertyName: "touched", rewrite: touched }] }],
    [],
    new DDLGenerator(),
    rewriteDatabase({ ...createdRewrite("touched", touched), function: "post__touched__rewrite_fn", name: "post__touched__rewrite" })
  );

  assertEquals(operations[0].operations, [
    addRewrite("touched", touched),
    dropRewrite("touched", ["insert", "update"])
  ]);
});

Deno.test("reconcileRewrites skips what the migration itself changes and tables that don't exist", async () => {
  const database = rewriteDatabase({ name: "post__gone__rewrite" });
  const alterPost = (operation: TypeOperation): MigrationOperation => ({ kind: "AlterType", operations: [operation], typeName: "Post" } as MigrationOperation);

  assertEquals(await reconcileRewrites([DECLARED_STAMP], [{ kind: "CreateType", typeName: "Post" } as MigrationOperation], new DDLGenerator(), database), []);
  assertEquals(
    await reconcileRewrites(
      [DECLARED_STAMP],
      [
        alterPost({ kind: "AddProperty", property: { name: "stamp", rewrites: [STAMP] } } as TypeOperation),
        alterPost({ kind: "DropProperty", propertyName: "gone" } as TypeOperation)
      ],
      new DDLGenerator(),
      database
    ),
    []
  );
  assertEquals(
    await reconcileRewrites([DECLARED_STAMP], [], new DDLGenerator(), () => Promise.resolve({ tables: new Set<string>(), triggers: [] })),
    []
  );
});

Deno.test("SchemaDiffer.declaredRewrites - every type with its properties' rewrites, inherited ones included", () => {
  const schema = new SDLConverter().convertToModules(
    new SDLParser(`module default {
  abstract type Stamped { stamp: datetime { rewrite insert using (datetime_of_statement()); }; };
  type Post extending Stamped { title: str; };
  type Tag { label: str; };
};`)
      .parse()
  );
  const stamp = { propertyName: "stamp", rewrite: { body: "datetime_of_statement()", events: ["insert"] } };

  assertEquals(new SchemaDiffer().declaredRewrites(schema), [
    { rewrites: [stamp], tableName: "stamped", typeName: "Stamped" },
    { rewrites: [stamp], tableName: "post", typeName: "Post" },
    { rewrites: [], tableName: "tag", typeName: "Tag" }
  ]);
});

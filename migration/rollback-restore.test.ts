/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Rolling back a migration that dropped something recreates it.
 *
 * A drop's rollback used to be a `-- MANUAL ROLLBACK REQUIRED` stub (the
 * operation carries only the dropped object's name), so `disc migrate
 * --rollback` refused it. The schema the migration was planned from is known,
 * though: the rollback SQL stored at apply time now recreates each dropped
 * type, property, link, index, constraint, trigger, rewrite and enum from its
 * definition there, the way the forward CREATE path emits it, and names what
 * comes back empty.
 *
 * Real-PG coverage lives in `migration/rollback-restore-pg.test.ts`.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Module, normalizeModules, SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { MigrationEngine } from "./engine.ts";
import * as Types from "./types.ts";

function parseModules(src: string): Module[] {
  return normalizeModules(new SDLConverter().convertToModules(new SDLParser(src).parse()));
}

function engine(): MigrationEngine {
  return new MigrationEngine({
    autoApprove: true,
    backupBeforeMigration: false,
    databaseUrl: "",
    dryRun: true,
    migrationsDir: "",
    rollbackOnError: false,
    schemaFile: ""
  } as Types.MigrationConfig);
}

function collapse(statements: string[]): string[] {
  return statements.map(s => s.replace(/\s+/g, " ").trim()).filter(s => s !== "");
}

/*** The rollback SQL stored when migrating from `from` to `to`. ***/
function rollback(from: string, to: string): string[] {
  const e = engine();
  const plan = e.planMigration(parseModules(from), parseModules(to));

  if (!plan.ok)
    throw plan.error;

  const statements = e.generateRollbackSQL(plan.value.migrations[0], plan.value);

  if (!statements.ok)
    throw statements.error;

  return collapse(statements.value);
}

/*** The forward DDL migrating from `from` to `to`, comments left out. ***/
function forward(from: string, to: string): string[] {
  const e = engine();
  const plan = e.planMigration(parseModules(from), parseModules(to));

  if (!plan.ok)
    throw plan.error;

  const statements = e.generateDDL(plan.value);

  if (!statements.ok)
    throw statements.error;

  return collapse(statements.value).filter(s => !s.startsWith("--"));
}

function assertNoManualStep(statements: string[]): void {
  const manual = statements.filter(s => s.includes("MANUAL ROLLBACK REQUIRED") || s.includes("RAISE EXCEPTION 'Cannot auto-rollback"));
  assertEquals(manual, [], `the rollback needs no manual step:\n${statements.join("\n")}`);
}

/*** Every statement the forward DDL of `from` → `to` runs, in the same order, within `statements`. ***/
function assertRecreatesAsForward(statements: string[], from: string, to: string): void {
  let at = -1;

  for (const statement of forward(from, to)) {
    const found = statements.indexOf(statement, at + 1);
    assert(found > at, `the rollback runs, after the statements before it:\n  ${statement}\n\nrollback:\n${statements.join("\n")}`);
    at = found;
  }
}

const V1 = `module default {
  scalar type RbStatus extending enum<Draft, Live>;
  type RbChannel {
    required name: str;
    nickname: str { constraint exclusive; default := 'none'; };
    link pinned: RbVideo;
    multi likes: RbVideo;
  };
  type RbTag { required label: str; };
  type RbVideo {
    required title: str { constraint exclusive; };
    status: RbStatus;
    views: int64 { constraint min_value(0); };
    multi tags: RbTag { weight: int64; };
    link thumbnail: RbTag { on source delete delete target; };
    index on (.views);
  };
};`;

const V2 = `module default {
  type RbChannel { required name: str; };
  type RbTag { required label: str; };
};`;

/*** V2 on its own, with what the dropped type needs back: V1 without the V1-only members of RbChannel. ***/
const V2_WITH_VIDEO = `module default {
  scalar type RbStatus extending enum<Draft, Live>;
  type RbChannel { required name: str; };
  type RbTag { required label: str; };
  type RbVideo {
    required title: str { constraint exclusive; };
    status: RbStatus;
    views: int64 { constraint min_value(0); };
    multi tags: RbTag { weight: int64; };
    link thumbnail: RbTag { on source delete delete target; };
    index on (.views);
  };
};`;

Deno.test("Rollback of a dropped type recreates it, its enum, junction, index, exclusive constraint and delete-target trigger", () => {
  const statements = rollback(V1, V2);

  assertNoManualStep(statements);
  assertRecreatesAsForward(statements, V2, V2_WITH_VIDEO);

  const enumAt = statements.findIndex(s => s.startsWith("CREATE TYPE disc_enum_rbstatus AS ENUM ('Draft', 'Live')"));
  const tableAt = statements.findIndex(s => s.startsWith("CREATE TABLE rb_video "));
  assert(enumAt >= 0 && tableAt > enumAt, "the enum is recreated before the table using it");

  for (
    const expected of [
      "CREATE TABLE rb_video_tags ",
      "CREATE UNIQUE INDEX uk_rb_video_title ON rb_video (title);",
      "CHECK (views >= 0)",
      "CREATE TRIGGER trg_source_delete_rb_video_thumbnail AFTER DELETE ON rb_video",
      "CREATE INDEX idx_rb_video_views"
    ]
  )
    assert(statements.some(s => s.includes(expected)), `the rollback recreates ${expected}:\n${statements.join("\n")}`);
});

Deno.test("Rollback of dropped properties and links on a surviving type re-adds them as forward ADD would", () => {
  const statements = rollback(V1, V2);

  for (
    const expected of [
      "ALTER TABLE rb_channel ADD COLUMN nickname TEXT NULL DEFAULT 'none';",
      "CREATE UNIQUE INDEX uk_rb_channel_nickname ON rb_channel (nickname);",
      "ALTER TABLE rb_channel ADD COLUMN pinned_id UUID NULL;",
      "ALTER TABLE rb_channel ADD CONSTRAINT fk_rb_channel_pinned_id FOREIGN KEY (pinned_id) REFERENCES rb_video (id) ON DELETE RESTRICT;",
      "CREATE TABLE rb_channel_likes "
    ]
  )
    assert(statements.some(s => s.startsWith(expected)), `the rollback runs ${expected}:\n${statements.join("\n")}`);

  const videoAt = statements.findIndex(s => s.startsWith("CREATE TABLE rb_video "));
  const pinnedAt = statements.findIndex(s => s.startsWith("ALTER TABLE rb_channel ADD CONSTRAINT fk_rb_channel_pinned_id"));
  assert(videoAt >= 0 && pinnedAt > videoAt, "a link to a recreated type is re-added after its table");
});

Deno.test("Rollback of a drop names what comes back empty", () => {
  const warnings = rollback(V1, V2).filter(s => s.startsWith("-- RESTORED EMPTY:"));

  for (const name of ["table 'rb_video'", "column 'rb_channel.nickname'", "link 'rb_channel.pinned'", "link 'rb_channel.likes'"])
    assert(warnings.some(w => w.includes(name)), `a warning names ${name}:\n${warnings.join("\n")}`);
});

Deno.test("Rollback of a dropped index recreates it under its name", () => {
  const statements = rollback(
    `module default { type RbItem { required name: str; index on (.name); }; };`,
    `module default { type RbItem { required name: str; }; };`
  );

  assertNoManualStep(statements);
  assert(statements.includes("CREATE INDEX idx_rb_item_name ON rb_item (name);"), statements.join("\n"));
});

Deno.test("Rollback of a redefined index drops the new definition before recreating the old one", () => {
  const statements = rollback(
    `module default { type RbItem { required name: str; index on (.name); }; };`,
    `module default { type RbItem { required name: str; constraint exclusive on (.name); }; };`
  );

  assertNoManualStep(statements);
  const dropAt = statements.findIndex(s => s.startsWith("DROP INDEX IF EXISTS uk_rb_item_name"));
  const createAt = statements.indexOf("CREATE INDEX idx_rb_item_name ON rb_item (name);");
  assert(dropAt >= 0 && createAt > dropAt, statements.join("\n"));
});

Deno.test("Rollback of a dropped exclusive constraint recreates its unique index", () => {
  const statements = rollback(
    `module default { type RbItem { name: str { constraint exclusive; }; }; };`,
    `module default { type RbItem { name: str; }; };`
  );

  assertNoManualStep(statements);
  assert(statements.includes("CREATE UNIQUE INDEX uk_rb_item_name ON rb_item (name);"), statements.join("\n"));
});

Deno.test("Rollback of an added exclusive constraint drops its unique index", () => {
  const statements = rollback(
    `module default { type RbItem { name: str; }; };`,
    `module default { type RbItem { name: str { constraint exclusive; }; }; };`
  );

  assert(statements.includes("DROP INDEX IF EXISTS uk_rb_item_name;"), statements.join("\n"));
});

Deno.test("Rollback of a dropped trigger recreates it", () => {
  const statements = rollback(
    `module default { type RbItem { name: str; trigger touch after insert for each do (__new__.name); }; };`,
    `module default { type RbItem { name: str; }; };`
  );

  assertNoManualStep(statements);
  assert(statements.some(s => s.startsWith("CREATE TRIGGER rb_item__touch AFTER INSERT ON rb_item")), statements.join("\n"));
});

Deno.test("Rollback of a dropped rewrite recreates it", () => {
  const statements = rollback(
    `module default { type RbItem { stamp: datetime { rewrite insert using (datetime_of_statement()); }; }; };`,
    `module default { type RbItem { stamp: datetime; }; };`
  );

  assertNoManualStep(statements);
  assert(statements.some(s => s.startsWith("CREATE TRIGGER rb_item__stamp__rewrite BEFORE INSERT ON rb_item")), statements.join("\n"));
});

Deno.test("Rollback of a dropped property with a rewrite recreates the rewrite", () => {
  const from = `module default { type RbItem { name: str; stamp: datetime { rewrite insert using (datetime_of_statement()); }; }; };`;
  const statements = rollback(from, `module default { type RbItem { name: str; }; };`);

  assertNoManualStep(statements);
  assertRecreatesAsForward(statements, `module default { type RbItem { name: str; }; };`, from);
  assert(statements.some(s => s.startsWith("CREATE TRIGGER rb_item__stamp__rewrite BEFORE INSERT ON rb_item")), statements.join("\n"));
});

Deno.test("Rollback of an added property with a rewrite drops the rewrite", () => {
  const statements = rollback(
    `module default { type RbItem { name: str; }; };`,
    `module default { type RbItem { name: str; stamp: datetime { rewrite update using (datetime_of_statement()); }; }; };`
  );

  assert(statements.includes("DROP TRIGGER IF EXISTS rb_item__stamp__update_rewrite ON rb_item;"), statements.join("\n"));
  assert(statements.includes("DROP FUNCTION IF EXISTS rb_item__stamp__update_rewrite_fn();"), statements.join("\n"));
});

Deno.test("Rollback of a dropped enum recreates it with its values", () => {
  const statements = rollback(
    `module default { scalar type RbMood extending enum<Calm, Loud>; type RbItem { mood: RbMood; }; };`,
    `module default { type RbItem { mood: str; }; };`
  );

  assertNoManualStep(statements);
  const enumAt = statements.indexOf("CREATE TYPE disc_enum_rbmood AS ENUM ('Calm', 'Loud');");
  const retypeAt = statements.findIndex(s => s.includes("ALTER COLUMN mood TYPE disc_enum_rbmood"));
  assert(enumAt >= 0 && retypeAt > enumAt, `the enum is back before the column returns to it:\n${statements.join("\n")}`);
});

Deno.test("Rollback of a dropped link property re-adds its junction column", () => {
  const statements = rollback(
    `module default { type RbTag { label: str; }; type RbItem { multi tags: RbTag { weight: int64; }; }; };`,
    `module default { type RbTag { label: str; }; type RbItem { multi tags: RbTag; }; };`
  );

  assertNoManualStep(statements);
  assert(statements.includes("ALTER TABLE rb_item_tags ADD COLUMN weight BIGINT NULL;"), statements.join("\n"));
  assert(statements.some(s => s.startsWith("-- RESTORED EMPTY:") && s.includes("rb_item_tags.weight")), statements.join("\n"));
});

Deno.test("Rollback of a link made required or exclusive reverts it", () => {
  const statements = rollback(
    `module default { type RbTag { label: str; }; type RbItem { link tag: RbTag; }; };`,
    `module default { type RbTag { label: str; }; type RbItem { required link tag: RbTag { constraint exclusive; }; }; };`
  );

  assertNoManualStep(statements);
  assert(statements.includes("ALTER TABLE rb_item ALTER COLUMN tag_id DROP NOT NULL;"), statements.join("\n"));
  assert(statements.includes("DROP INDEX IF EXISTS uk_rb_item_tag_id;"), statements.join("\n"));
});

Deno.test("Rollback of a change to a multi property reverts it", () => {
  const statements = rollback(
    `module default { type RbItem { multi tags: str; }; };`,
    `module default { type RbItem { multi tags: str { constraint max_len_value(5); }; }; };`
  );

  assertNoManualStep(statements);
});

Deno.test("Rollback of a single → multi property change still needs a manual step", () => {
  const statements = rollback(
    `module default { type RbItem { tags: str; }; };`,
    `module default { type RbItem { multi tags: str; }; };`
  );

  assert(statements.some(s => s.includes("MANUAL ROLLBACK REQUIRED")), statements.join("\n"));
});

Deno.test("Rollback of a dropped type without the schema it was planned from keeps the manual step", () => {
  const e = engine();
  const migration: Types.Migration = {
    createdAt: new Date(),
    description: "drop",
    id: "m_drop",
    name: "drop",
    operations: [{ kind: "DropType", typeName: "RbItem" } as Types.DropTypeOperation],
    schemaHash: "hash"
  };
  const statements = e.generateRollbackSQL(migration);

  assert(statements.ok);
  assertStringIncludes(statements.value.join("\n"), "MANUAL ROLLBACK REQUIRED: Recreate table 'rb_item'");
});

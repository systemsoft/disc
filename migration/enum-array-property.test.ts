/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Non-`multi` properties typed `array<Enum>`.
 *
 * `tags: array<Priority>;` got a TEXT column, so reads returned the array's
 * text form (`{Low,High}`) and comparisons with an enum array failed. The
 * column is now the enum's array type (`disc_enum_priority[]`), like a
 * `multi` enum property. Databases migrated before keep their TEXT column
 * while the stored schema already says `array<Priority>`, so the diff sees no
 * change; `reconcileTextColumns` finds those columns and a
 * `ConvertTextColumn` operation converts them.
 *
 * Real-PG coverage lives in `migration/enum-array-property-pg.test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { MigrationEngine } from "./engine.ts";
import { reconcileTextColumns } from "./reconcile.ts";
import * as Types from "./types.ts";

const TASKS = `module default {
  scalar type Priority extending enum<Low, High>;
  type Task {
    required title: str;
    tags: array<Priority>;
  };
};`;

const AGENTS = `module agents {
  scalar type AgentStatus extending enum<Idle, Working>;
  type Agent {
    required name: str;
    history: array<AgentStatus>;
  };
};`;

function parseModules(src: string) {
  return new SDLConverter().convertToModules(new SDLParser(src).parse());
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

function ddl(before: string | null, after: string): string {
  const e = engine();
  const plan = e.planMigration(before === null ? null : parseModules(before), parseModules(after));
  assert(plan.ok, "expected plan to succeed");
  const statements = e.generateDDL(plan.value);
  assert(statements.ok, "expected DDL generation to succeed");
  return statements.value.map(s => s.replace(/\s+/g, " ")).join("\n");
}

Deno.test("array<Enum> property - a new type's column is the enum's array type", () => {
  const all = ddl(null, TASKS);

  assert(all.includes("tags disc_enum_priority[]"), all);
});

Deno.test("array<Enum> property - an enum of another module, bare and qualified", () => {
  const all = ddl(
    null,
    `${AGENTS}\nmodule default {
  type Log {
    states: array<agents::AgentStatus>;
  };
};`
  );

  assert(all.includes("history disc_enum_agentstatus[]"), all);
  assert(all.includes("states disc_enum_agentstatus[]"), all);
});

Deno.test("array<Enum> property - a same-named enum of another module gets its qualified type", () => {
  const all = ddl(
    null,
    `module default {
  scalar type Status extending enum<Open, Closed>;
  type Task {
    history: array<Status>;
  };
};
module agents {
  scalar type Status extending enum<Idle, Working>;
  type Agent {
    history: array<Status>;
  };
};`
  );

  assert(/CREATE TABLE task \(.*history disc_enum_status\[\]/.test(all), all);
  assert(/CREATE TABLE agent \(.*history disc_enum_agents__status\[\]/.test(all), all);
});

Deno.test("array<Enum> property - adding the property adds an enum array column", () => {
  const before = TASKS.replace("tags: array<Priority>;", "");
  const all = ddl(before, TASKS);

  assert(all.includes("ALTER TABLE task ADD COLUMN tags disc_enum_priority[]"), all);
});

Deno.test("array<Enum> property - changing a property's type to array<Enum> alters it to the enum array type", () => {
  const before = TASKS.replace("tags: array<Priority>;", "tags: array<str>;");
  const all = ddl(before, TASKS);

  assert(all.includes("ALTER TABLE task ALTER COLUMN tags TYPE disc_enum_priority[]"), all);
});

Deno.test("array<Enum> property - a link property's junction column is the enum's array type", () => {
  const all = ddl(
    null,
    `module default {
  scalar type Priority extending enum<Low, High>;
  type Person {
    required name: str;
  };
  type Team {
    multi link members -> Person {
      roles: array<Priority>;
    };
  };
};`
  );

  assert(/CREATE TABLE team_members \(.*roles disc_enum_priority\[\]/.test(all), all);
});

Deno.test("SchemaDiffer.declaredColumns - properties and link properties typed array<Enum>, with their enum's type", () => {
  const schema = parseModules(`${AGENTS}\nmodule default {
  scalar type Priority extending enum<Low, High>;
  type Task {
    required title: str;
    tags: array<Priority>;
    labels: array<str>;
    multi levels: Priority;
    multi link owners -> agents::Agent {
      roles: array<Priority>;
    };
  };
};`);
  const differ = new SchemaDiffer();
  const generator = new DDLGenerator();
  generator.setEnumScalars(differ.enumScalarNames(schema));
  const columns = differ
    .declaredColumns(schema, property => generator.propertyColumnType(property))
    .filter(column => column.propertyType.startsWith("array<") && column.pgType !== "TEXT[]");

  assertEquals(
    columns.sort((a, b) => a.tableName.localeCompare(b.tableName)),
    [
      { columnName: "history", pgType: "disc_enum_agentstatus[]", propertyType: "array<agents::AgentStatus>", tableName: "agent" },
      { columnName: "tags", pgType: "disc_enum_priority[]", propertyType: "array<Priority>", tableName: "task" },
      { columnName: "roles", pgType: "disc_enum_priority[]", propertyType: "array<Priority>", tableName: "task_owners" }
    ]
  );
});

Deno.test("reconcileTextColumns - converts only existing TEXT columns", async () => {
  const declared: Types.DeclaredColumn[] = [
    { columnName: "tags", pgType: "disc_enum_priority[]", propertyType: "array<Priority>", tableName: "task" },
    { columnName: "history", pgType: "disc_enum_status[]", propertyType: "array<Status>", tableName: "agent" },
    { columnName: "roles", pgType: "disc_enum_priority[]", propertyType: "array<Priority>", tableName: "missing" },
    { columnName: "added", pgType: "disc_enum_priority[]", propertyType: "array<Priority>", tableName: "task" }
  ];
  const existing: Record<string, { name: string; dataType: string; }[]> = {
    agent: [{ dataType: "ARRAY", name: "history" }],
    task: [{ dataType: "text", name: "tags" }]
  };

  const ops = await reconcileTextColumns(declared, [], async table => await Promise.resolve(existing[table] ?? null));

  assertEquals(ops, [
    { columnName: "tags", kind: "ConvertTextColumn", pgType: "disc_enum_priority[]", propertyType: "array<Priority>", tableName: "task" }
  ]);
});

Deno.test("ConvertTextColumn - checks every stored value, rewrites JSON arrays, then converts the column", () => {
  const op: Types.ConvertTextColumnOperation = {
    columnName: "tags",
    kind: "ConvertTextColumn",
    pgType: "disc_enum_priority[]",
    propertyType: "array<Priority>",
    tableName: "task"
  };
  const statements = new DDLGenerator().generateDDL([op]).map(s => s.replace(/\s+/g, " "));

  assertEquals(statements.length, 3, statements.join("\n"));
  assert(statements[0].startsWith("DO $$"), statements[0]);
  assert(statements[0].includes("FROM task WHERE tags IS NOT NULL"), statements[0]);
  assert(statements[0].includes("RAISE EXCEPTION 'Cannot convert task.tags from text to array<Priority>"), statements[0]);
  assert(statements[1].startsWith("UPDATE task SET tags ="), statements[1]);
  assertEquals(statements[2], "ALTER TABLE task ALTER COLUMN tags TYPE disc_enum_priority[] USING tags::disc_enum_priority[];");
});

Deno.test("ConvertTextColumn - rollback returns the column to text", () => {
  const op: Types.ConvertTextColumnOperation = {
    columnName: "tags",
    kind: "ConvertTextColumn",
    pgType: "disc_enum_priority[]",
    propertyType: "array<Priority>",
    tableName: "task"
  };

  assertEquals(new DDLGenerator().generateRollbackDDL([op]), ["ALTER TABLE task ALTER COLUMN tags TYPE TEXT USING tags::text;"]);
});

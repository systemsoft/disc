/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Same-named enums in different modules.
 *
 * `default::Status` and `agents::Status` both mapped to `disc_enum_status`, so
 * the migration failed with `type "disc_enum_status" already exists`. An enum
 * outside the default module whose name another enum shares gets its own
 * module-qualified type (`disc_enum_agents__status`); every other enum keeps
 * `disc_enum_<name>`, so existing databases need no migration. Because the
 * name depends on whether the name is shared, adding or removing the other
 * enum renames the type in place (`ALTER TYPE … RENAME TO`).
 *
 * Real-PG coverage lives in `migration/enum-collision-pg.test.ts`.
 */

import { assert, assertEquals } from "@std/assert";
import { SDLConverter } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { MigrationEngine } from "./engine.ts";
import * as Types from "./types.ts";

const AGENTS = `module agents {
  scalar type Status extending enum<Idle, Working>;
  type Agent {
    required name: str;
    status: Status;
    multi states: Status;
  };
};`;

const DEFAULT_STATUS = `module default {
  scalar type Status extending enum<Open, Closed>;
  type Task {
    required title: str;
    status: Status;
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

function ddl(before: string | null, after: string): string[] {
  const e = engine();
  const plan = e.planMigration(before === null ? null : parseModules(before), parseModules(after));
  assert(plan.ok, "expected plan to succeed");
  const statements = e.generateDDL(plan.value);
  assert(statements.ok, "expected DDL generation to succeed");
  return statements.value.map(s => s.replace(/\s+/g, " "));
}

function indexOf(statements: string[], fragment: string): number {
  const index = statements.findIndex(s => s.includes(fragment));
  assert(index >= 0, `expected a statement containing "${fragment}" in:\n${statements.join("\n")}`);
  return index;
}

Deno.test("enum collision - each same-named enum gets its own PG type and columns use it", () => {
  const statements = ddl(null, `${DEFAULT_STATUS}\n${AGENTS}`);
  const all = statements.join("\n");

  assert(all.includes("CREATE TYPE disc_enum_status AS ENUM ('Open', 'Closed')"), all);
  assert(all.includes("CREATE TYPE disc_enum_agents__status AS ENUM ('Idle', 'Working')"), all);
  assert(all.includes("status disc_enum_agents__status,"), all);
  assert(all.includes("states disc_enum_agents__status[]"), all);
  assert(/CREATE TABLE task \(.*status disc_enum_status\b/.test(all), all);
});

Deno.test("enum collision - an enum whose name no other enum shares keeps disc_enum_<name>", () => {
  const all = ddl(null, AGENTS).join("\n");

  assert(all.includes("CREATE TYPE disc_enum_status AS ENUM ('Idle', 'Working')"), all);
  assert(all.includes("states disc_enum_status[]"), all);
  assertEquals(all.includes("agents__"), false, all);
});

Deno.test("enum collision - adding a same-named default enum renames the existing type before creating the new one", () => {
  const statements = ddl(AGENTS, `${DEFAULT_STATUS}\n${AGENTS}`);

  const rename = indexOf(statements, "ALTER TYPE disc_enum_status RENAME TO disc_enum_agents__status");
  const create = indexOf(statements, "CREATE TYPE disc_enum_status AS ENUM ('Open', 'Closed')");
  assert(rename < create, statements.join("\n"));
  assertEquals(statements.some(s => s.includes("ALTER TABLE agent")), false, statements.join("\n"));
});

Deno.test("enum collision - removing the default enum renames the other back after dropping it", () => {
  const statements = ddl(`${DEFAULT_STATUS}\n${AGENTS}`, AGENTS);

  const drop = indexOf(statements, "DROP TYPE IF EXISTS disc_enum_status;");
  const rename = indexOf(statements, "ALTER TYPE disc_enum_agents__status RENAME TO disc_enum_status");
  assert(drop < rename, statements.join("\n"));
});

Deno.test("enum collision - a value added to the qualified enum alters the qualified type", () => {
  const after = AGENTS.replace("enum<Idle, Working>", "enum<Idle, Working, Offline>");
  const all = ddl(`${DEFAULT_STATUS}\n${AGENTS}`, `${DEFAULT_STATUS}\n${after}`).join("\n");

  assert(all.includes("ALTER TYPE disc_enum_agents__status ADD VALUE IF NOT EXISTS 'Offline'"), all);
});

Deno.test("enum collision - rollback of a rename renames back", () => {
  const e = engine();
  const plan = e.planMigration(parseModules(AGENTS), parseModules(`${DEFAULT_STATUS}\n${AGENTS}`));
  assert(plan.ok);
  // deno-lint-ignore no-explicit-any
  const rollback = (e as any).ddlGenerator.generateRollbackDDL(plan.value.migrations[0].operations) as string[];

  assert(rollback.some(s => s.includes("ALTER TYPE disc_enum_agents__status RENAME TO disc_enum_status")), rollback.join("\n"));
});

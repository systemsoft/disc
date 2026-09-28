/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * SDL defaults, constraint expressions and arguments, index expressions,
 * access-policy conditions, globals' defaults and aliases are parsed with the
 * EdgeQL expression grammar. A database migrated by an older Disc holds its
 * schema as the modules that Disc parsed (`disc_migrations.schema_modules`):
 * `tests/fixtures/sdl-expressions-83ec629-modules.json` is `SCHEMA` as Disc
 * 83ec629, before this, stored it. The same SDL parsed now must diff clean
 * against it — no operation, no DDL — or every existing database would
 * migrate on its next `disc migrate`.
 *
 * Requires PostgreSQL for the end-to-end case — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { normalizeModules, type Module } from "../schema/converter.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { MigrationEngine } from "./engine.ts";
import { SchemaManager } from "./schema-manager.ts";
import type * as Types from "./types.ts";

const SCHEMA = `module default {
  scalar type Status extending enum<Active, Closed>;
  scalar type Pct extending int64 {
    constraint min_value(0);
    constraint max_value(100);
  };
  scalar type Code extending str {
    constraint expression on (len(__subject__) <= 8);
    constraint one_of('A', 'B', 'C');
  };
  global current_owner: uuid;
  global tenant: str {
    default := 'main';
  };
  global limit_of: int64 {
    default := 10 * 2;
  };
  type Owner {
    required name: str;
  };
  type Account {
    required name: str {
      constraint exclusive;
      constraint max_len_value(50);
      default := 'anon';
    };
    score: int64 {
      default := 3;
      constraint min_value(-1);
      constraint expression on (__subject__ != 13);
    };
    ratio: float64 {
      default := 0.5;
    };
    created: datetime {
      default := datetime_current();
    };
    active: bool {
      default := true;
    };
    status: Status {
      default := Status.Active;
    };
    pct: Pct;
    code: Code;
    holder: uuid;
    owner: Owner;
    constraint expression on (.score >= 0 or .name = 'anon');
    constraint exclusive on ((.name, .score));
    index on (.name);
    index on ((.name, .score));
    access policy own allow all using (.holder ?= global current_owner);
    access policy main_only when (global tenant = 'main') allow select using (.active);
    access policy no_closed deny insert, update using (.status = Status.Closed) {
      errmessage := 'closed';
    };
  };
  alias BigAccounts := (select Account filter .score > 10);
  alias AccountNames := Account.name;
};
`;

/*** The modules Disc 83ec629 stored for SCHEMA. ***/
function storedModules(): Module[] {
  return JSON.parse(Deno.readTextFileSync(new URL("../tests/fixtures/sdl-expressions-83ec629-modules.json", import.meta.url)));
}

async function parsedModules(): Promise<Module[]> {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL(SCHEMA);
  assert(parsed.ok, parsed.ok ? "" : parsed.error.message);
  return normalizeModules(parsed.value);
}

Deno.test("SDL expressions - a schema an older Disc stored plans no migration against the same SDL parsed now", async () => {
  const engine = new MigrationEngine({
    autoApprove: true,
    backupBeforeMigration: false,
    databaseUrl: "",
    dryRun: true,
    migrationsDir: "",
    rollbackOnError: false,
    schemaFile: ""
  } as Types.MigrationConfig);
  const plan = engine.planMigration(storedModules(), await parsedModules());
  assert(plan.ok, plan.ok ? "" : plan.error.message);
  assertEquals(plan.value.migrations.flatMap(migration => migration.operations), []);
  const ddl = engine.generateDDL(plan.value);
  assert(ddl.ok, ddl.ok ? "" : ddl.error.message);
  assertEquals(ddl.value.map(statement => statement.trim()).filter(statement => statement !== "" && !statement.startsWith("--")), []);
});

Deno.test({
  name: "PG SDL expressions - a database whose baseline an older Disc stored migrates nothing for the same SDL",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    try {
      await resetTestDatabase(pool);
      const first = new SchemaManager({ pool });
      await first.initialize();
      const applied = await first.applySchema(SCHEMA);
      assert(applied.ok, applied.ok ? "" : applied.error.message);
      await first.close();

      // The baseline as the older Disc stored it.
      await pool.query(
        "UPDATE disc_migrations SET schema_modules = $1::jsonb WHERE applied_order = (SELECT max(applied_order) FROM disc_migrations)",
        [JSON.stringify(storedModules())]
      );

      const second = new SchemaManager({ pool });
      await second.initialize();
      const again = await second.applySchema(SCHEMA);
      assert(again.ok, again.ok ? "" : again.error.message);
      assertEquals(again.value.length, 0, "expected no migration");
      await second.close();
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

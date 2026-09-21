/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Index backfill (no PostgreSQL needed).
 *
 * The differ compares two schema snapshots and never looks at the database, so
 * an index that is declared in the stored baseline but was never created — every
 * type-level `constraint exclusive on (…)` written before Disc enforced them —
 * diffs to nothing. The backfill compares the declared indexes with the
 * database and plans `CREATE … INDEX IF NOT EXISTS` for the missing ones.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { DDLGenerator } from "./ddl.ts";
import { MigrationEngine } from "./engine.ts";
import { reconcileDeclaredIndexes } from "./reconcile.ts";
import { SchemaManager } from "./schema-manager.ts";
import * as Types from "./types.ts";

const SDL = `
  module default {
    type Program { required name: str; }
    type GitRef {
      required name: str;
      required link program -> Program;
      constraint exclusive on ((.program, .name));
    }
  }
`;

const refIndex: Types.IndexDefinition = {
  columns: ["program_id", "name"],
  declaration: "constraint exclusive on ((.program, .name))",
  name: "uk_git_ref_program_id_name",
  table: "git_ref",
  typeName: "GitRef",
  unique: true
};

function modulesOf(sdl: string) {
  const parsed = new SchemaManager({ dryRun: true }).parseSDL(sdl);

  if (!parsed.ok)
    throw parsed.error;

  return parsed.value;
}

/** A pool whose database holds `existingIndexes`, and whose DDL fails with `failWith` when set. */
function fakePool(existingIndexes: string[], failWith?: unknown): { executed: string[]; pool: ConnectionPool; } {
  const executed: string[] = [];

  const pool = {
    query: (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_indexes")) {
        const asked = params![0] as string[];
        return Promise.resolve({ rowCount: 0, rows: existingIndexes.filter(n => asked.includes(n)).map(indexname => ({ indexname })) });
      }

      return Promise.resolve({ rowCount: 0, rows: [] });
    },
    transaction: async (fn: (conn: { execute: (s: string) => Promise<void>; }) => Promise<void>) => {
      await fn({
        execute: (s: string) => {
          executed.push(s);
          return failWith !== undefined && s.startsWith("CREATE UNIQUE INDEX") ? Promise.reject(failWith) : Promise.resolve();
        }
      });
    }
  } as unknown as ConnectionPool;

  return { executed, pool };
}

function engineWith(pool: ConnectionPool): MigrationEngine {
  return new MigrationEngine({
    autoApply: false,
    backupBeforeMigration: false,
    connectionPool: pool,
    requireConfirmation: false,
    validateOperations: true
  } as unknown as Types.MigrationConfig);
}

Deno.test("reconcileDeclaredIndexes plans IF NOT EXISTS creation for a declared index the database lacks", async () => {
  const ops = await reconcileDeclaredIndexes([refIndex], [], () => Promise.resolve(new Set<string>()));

  assertEquals(ops, [{ ifNotExists: true, index: refIndex, kind: "CreateIndex" }]);
  assertEquals(new DDLGenerator().generateDDL(ops), [
    "CREATE UNIQUE INDEX IF NOT EXISTS uk_git_ref_program_id_name ON git_ref (program_id, name);"
  ]);
});

Deno.test("reconcileDeclaredIndexes plans nothing for an index that exists", async () => {
  const ops = await reconcileDeclaredIndexes([refIndex], [], names => Promise.resolve(new Set(names)));

  assertEquals(ops, []);
});

Deno.test("reconcileDeclaredIndexes leaves alone what the migration itself creates", async () => {
  const asked: string[][] = [];
  const planned: Types.MigrationOperation[] = [{ index: refIndex, kind: "CreateIndex" } as Types.CreateIndexOperation];

  const ops = await reconcileDeclaredIndexes([refIndex], planned, names => {
    asked.push(names);
    return Promise.resolve(new Set<string>());
  });

  assertEquals(ops, []);
  assertEquals(asked, [], "nothing left to look up, so the database is not queried");
});

Deno.test("engine: a no-op diff gains the missing declared index, and loses it again once it exists", async () => {
  const modules = modulesOf(SDL);

  const missing = engineWith(fakePool([]).pool);
  const emptyPlan = missing.planMigration(modules, modules);
  assertEquals(emptyPlan.ok && emptyPlan.value.operationsCount, 0);

  const plan = await missing.withIndexBackfill(emptyPlan.ok ? emptyPlan.value : null!, modules);
  assertEquals(plan.operationsCount, 1);
  assertEquals(plan.migrations[0].operations.map(op => op.kind), ["CreateIndex"]);
  assertEquals(plan.migrations[0].name, "createindex");

  const ddl = missing.generateDDL(plan);
  assertStringIncludes(
    ddl.ok ? ddl.value.join("\n") : "",
    "CREATE UNIQUE INDEX IF NOT EXISTS uk_git_ref_program_id_name ON git_ref (program_id, name);"
  );

  const present = engineWith(fakePool(["uk_git_ref_program_id_name"]).pool);
  const unchanged = await present.withIndexBackfill(emptyPlan.ok ? emptyPlan.value : null!, modules);
  assertEquals(unchanged.operationsCount, 0);
});

Deno.test("engine: a new type's index is created once, by the diff, not again by the backfill", async () => {
  const modules = modulesOf(SDL);
  const engine = engineWith(fakePool([]).pool);
  const planned = engine.planMigration(null, modules);
  const plan = await engine.withIndexBackfill(planned.ok ? planned.value : null!, modules);

  assertEquals(plan.migrations[0].operations.filter(op => op.kind === "CreateIndex").length, 1);
});

Deno.test("engine: without a database the plan is returned untouched", async () => {
  const modules = modulesOf(SDL);
  const engine = new MigrationEngine({ dryRun: true } as unknown as Types.MigrationConfig);
  const planned = engine.planMigration(modules, modules);
  const plan = await engine.withIndexBackfill(planned.ok ? planned.value : null!, modules);

  assertEquals(plan.operationsCount, 0);
});

Deno.test("engine: duplicate rows fail the unique index with the type, the constraint and a query that finds them", async () => {
  const modules = modulesOf(SDL);
  const duplicate = Object.assign(new Error(`could not create unique index "uk_git_ref_program_id_name"`), {
    fields: { code: "23505", detail: "Key (program_id, name)=(p1, main) is duplicated." }
  });
  const engine = engineWith(fakePool([], duplicate).pool);
  const planned = engine.planMigration(modules, modules);
  const plan = await engine.withIndexBackfill(planned.ok ? planned.value : null!, modules);

  const result = await engine.executeMigration(plan);
  const message = result.ok ? "" : result.error.message;

  assertEquals(result.ok, false);
  assertStringIncludes(message, "type 'GitRef'");
  assertStringIncludes(message, "'constraint exclusive on ((.program, .name))'");
  assertStringIncludes(message, "Key (program_id, name)=(p1, main) is duplicated.");
  assertStringIncludes(
    message,
    "SELECT program_id, name, count(*) FROM git_ref WHERE program_id IS NOT NULL AND name IS NOT NULL GROUP BY program_id, name HAVING count(*) > 1;"
  );
});

Deno.test("engine: any other failure keeps its own message", async () => {
  const modules = modulesOf(SDL);
  const engine = engineWith(fakePool([], Object.assign(new Error("lock timeout"), { fields: { code: "55P03" } })).pool);
  const planned = engine.planMigration(modules, modules);
  const plan = await engine.withIndexBackfill(planned.ok ? planned.value : null!, modules);

  const result = await engine.executeMigration(plan);

  assertEquals(result.ok, false);
  assertStringIncludes(result.ok ? "" : result.error.message, "lock timeout");
  assertEquals((result.ok ? "" : result.error.message).includes("duplicates"), false);
});

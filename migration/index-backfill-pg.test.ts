/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Index backfill against PostgreSQL.
 *
 * An existing deployment: `disc_migrations` already stores a schema snapshot
 * that declares `constraint exclusive on ((.program, .name))`, but the database
 * has no such index, because Disc used to ignore the declaration. The schema
 * diff is empty; `migrate` must create the index anyway, once.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

const FIXTURE = new URL("../tests/fixtures/git-forge.disc", import.meta.url);
const UNIQUE_INDEXES = ["uk_git_commit_program_id_object_id", "uk_git_object_program_id_object_id", "uk_git_ref_program_id_name"];

async function uniqueIndexes(pool: ConnectionPool): Promise<string[]> {
  const result = await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'uk\\_git\\_%' ORDER BY indexname`);
  return result.rows.map(row => row.indexname as string);
}

async function migrationCount(pool: ConnectionPool): Promise<number> {
  return (await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`)).rows[0].n as number;
}

/** A fresh manager per call, the way each `disc migrate` process starts from `disc_migrations`. */
async function withManager<T>(pool: ConnectionPool, fn: (manager: SchemaManager) => Promise<T>): Promise<T> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

/**
 * Leaves the database as an older Disc would have: fixture applied, baseline
 * recorded with the constraints in it, and none of their indexes.
 */
async function legacyDeployment(pool: ConnectionPool, sdl: string): Promise<void> {
  await resetTestDatabase(pool);

  const applied = await withManager(pool, manager => manager.applySchema(sdl));
  assertEquals(applied.ok, true, applied.ok ? "" : applied.error.message);

  for (const name of UNIQUE_INDEXES)
    await pool.query(`DROP INDEX ${name}`);

  assertEquals(await uniqueIndexes(pool), []);
}

Deno.test({
  name: "PG backfill: a baseline that already declares the constraint gets its missing unique indexes, once",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      const sdl = await Deno.readTextFile(FIXTURE);
      await legacyDeployment(pool, sdl);
      const recorded = await migrationCount(pool);

      /*** What `disc migrate --create` previews: the diff alone is empty, the backfill is not. ***/
      await withManager(pool, async manager => {
        const parsed = manager.parseSDL(sdl);
        const modules = parsed.ok ? parsed.value : [];
        const diffOnly = manager.planModules(modules);
        assertEquals(diffOnly.ok && diffOnly.value.operationsCount, 0);

        const plan = await manager.withIndexBackfill(diffOnly.ok ? diffOnly.value : null!, modules);
        assertEquals(plan.ok && plan.value.operationsCount, 3);

        const ddl = manager.generateDDL(plan.ok ? plan.value : null!);
        assertStringIncludes(ddl.ok ? ddl.value.join("\n") : "", "CREATE UNIQUE INDEX IF NOT EXISTS uk_git_ref_program_id_name ON git_ref (program_id, name);");
        assertEquals(await uniqueIndexes(pool), [], "a preview creates nothing");
      });

      const first = await withManager(pool, manager => manager.applySchema(sdl));
      assertEquals(first.ok && first.value.length, 1, first.ok ? "" : first.error.message);
      assertEquals(await uniqueIndexes(pool), UNIQUE_INDEXES);
      assertEquals(await migrationCount(pool), recorded + 1);

      const second = await withManager(pool, manager => manager.applySchema(sdl));
      assertEquals(second.ok && second.value.length, 0, "the second migrate is a no-op");
      assertEquals(await migrationCount(pool), recorded + 1);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG backfill: duplicate rows fail with the type, the constraint and a query that finds them",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      const sdl = await Deno.readTextFile(FIXTURE);
      await legacyDeployment(pool, sdl);

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('a') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO git_ref (program_id, name, target) VALUES ($1, 'refs/heads/main', 'x'), ($1, 'refs/heads/main', 'y')`, [program]);
      const recorded = await migrationCount(pool);

      const result = await withManager(pool, manager => manager.applySchema(sdl));
      const message = result.ok ? "" : result.error.message;

      assertEquals(result.ok, false);
      assertStringIncludes(message, "type 'GitRef'");
      assertStringIncludes(message, "'constraint exclusive on ((.program, .name))'");
      assertStringIncludes(message, "GROUP BY program_id, name HAVING count(*) > 1;");

      /*** One transaction: the two indexes that could have been built were rolled back with it. ***/
      assertEquals(await uniqueIndexes(pool), []);
      assertEquals(await migrationCount(pool), recorded);

      /*** The query from the message finds the offending key. ***/
      const query = /^\s*(SELECT .*;)$/m.exec(message)![1];
      const duplicates = await pool.query(query);
      assertEquals(duplicates.rows.map(row => [row.program_id, row.name, Number(row.count)]), [[program, "refs/heads/main", 2]]);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

Deno.test({
  name: "PG: adding a type-level exclusive to a type whose rows already violate it fails with the same explanation",
  ignore: !canRunPgTests(),
  fn: async () => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();

    try {
      await resetTestDatabase(pool);

      const tag = (members: string): string => `module default { type Tag { required name: str; required scope: str; ${members} } }`;
      const created = await withManager(pool, manager => manager.applySchema(tag("")));
      assertEquals(created.ok, true, created.ok ? "" : created.error.message);
      await pool.query(`INSERT INTO tag (name, scope) VALUES ('a', 'x'), ('a', 'x'), ('a', 'y')`);

      const result = await withManager(pool, manager => manager.applySchema(tag("constraint exclusive on ((.scope, .name));")));
      const message = result.ok ? "" : result.error.message;

      assertEquals(result.ok, false);
      assertStringIncludes(message, "type 'Tag'");
      assertStringIncludes(message, "'constraint exclusive on ((.scope, .name))'");
      assertStringIncludes(message, "SELECT scope, name, count(*) FROM tag");

      /*** Once the duplicate is gone the same migration applies. ***/
      await pool.query(`DELETE FROM tag WHERE ctid IN (SELECT min(ctid) FROM tag WHERE scope = 'x')`);
      const retried = await withManager(pool, manager => manager.applySchema(tag("constraint exclusive on ((.scope, .name));")));
      assertEquals(retried.ok, true, retried.ok ? "" : retried.error.message);
      assertEquals((await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uk_tag_scope_name'`)).rows.length, 1);
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

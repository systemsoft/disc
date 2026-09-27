/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Repairing link delete rules that drifted from the stored schema.
 *
 * Before the ALTER LINK path applied `on target delete` / `on source delete`
 * changes, `migrate` recorded the new schema while PostgreSQL kept the old
 * foreign-key action (and never created the delete-target trigger). The
 * snapshot already matches the SDL, so the diff is empty: `migrate` must read
 * the database, repair the rule once, and be a no-op after that.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

function schema(link: string): string {
  return `module default {
    type Program { required name: str; };
    type Bug { required title: str; ${link} };
  };`;
}

async function withManager<T>(pool: ConnectionPool, fn: (manager: SchemaManager) => Promise<T>): Promise<T> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

async function migrate(pool: ConnectionPool, sdl: string): Promise<number> {
  const result = await withManager(pool, manager => manager.applySchema(sdl));

  if (!result.ok)
    throw result.error;

  return result.value.length;
}

/*** What `disc migrate --create` / `--dry-run` would show: the diff alone is empty, the repair is not. ***/
async function preview(pool: ConnectionPool, sdl: string): Promise<string> {
  return await withManager(pool, async manager => {
    const parsed = manager.parseSDL(sdl);
    const modules = parsed.ok ? parsed.value : [];
    const diffOnly = manager.planModules(modules);
    assertEquals(diffOnly.ok && diffOnly.value.operationsCount, 0, "the stored snapshot already matches the SDL");

    const plan = await manager.withIndexBackfill(diffOnly.ok ? diffOnly.value : null!, modules);
    const ddl = manager.generateDDL(plan.ok ? plan.value : null!);
    return ddl.ok ? ddl.value.join("\n") : "";
  });
}

async function onDeleteAction(pool: ConnectionPool, constraint: string): Promise<string | undefined> {
  const result = await pool.query(`SELECT confdeltype FROM pg_constraint WHERE conname = $1`, [constraint]);
  return result.rows[0]?.confdeltype as string | undefined;
}

async function hasTrigger(pool: ConnectionPool, trigger: string): Promise<boolean> {
  return (await pool.query(`SELECT 1 FROM pg_trigger WHERE tgname = $1`, [trigger])).rows.length === 1;
}

async function count(pool: ConnectionPool, table: string): Promise<number> {
  return (await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
}

async function run(fn: (pool: ConnectionPool) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();

  try {
    await resetTestDatabase(pool);
    await fn(pool);
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG delete-rule drift: a single link's FK left at RESTRICT is re-added with CASCADE, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = schema("required link program: Program { on target delete delete source; };");
      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await onDeleteAction(pool, "fk_bug_program_id"), "c");

      /*** What a migrate before the ALTER LINK fix left behind: snapshot says delete source, the FK restricts. ***/
      await pool.query(
        `ALTER TABLE bug DROP CONSTRAINT fk_bug_program_id, ADD CONSTRAINT fk_bug_program_id FOREIGN KEY (program_id) REFERENCES program (id) ON DELETE RESTRICT`
      );

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('crash', $1)`, [program]);
      await assertRejects(() => pool.query(`DELETE FROM program WHERE id = $1`, [program]));

      assertStringIncludes(await preview(pool, sdl), "ON DELETE CASCADE");
      assertEquals(await onDeleteAction(pool, "fk_bug_program_id"), "r", "a preview changes nothing");

      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await onDeleteAction(pool, "fk_bug_program_id"), "c");

      await pool.query(`DELETE FROM program WHERE id = $1`, [program]);
      assertEquals(await count(pool, "bug"), 0);

      assertEquals(await migrate(pool, sdl), 0, "once repaired, the next migrate is a no-op");
    })
});

Deno.test({
  name: "PG delete-rule drift: a deferred restrict link's FK left at plain RESTRICT is re-added deferred, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = schema("required link program: Program { on target delete deferred restrict; };");
      assertEquals(await migrate(pool, sdl), 1);

      /*** What a migrate before deferred restrict existed left behind: a plain RESTRICT FK. ***/
      await pool.query(
        `ALTER TABLE bug DROP CONSTRAINT fk_bug_program_id, ADD CONSTRAINT fk_bug_program_id FOREIGN KEY (program_id) REFERENCES program (id) ON DELETE RESTRICT`
      );

      assertStringIncludes(await preview(pool, sdl), "ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED");
      assertEquals(await migrate(pool, sdl), 1);

      const rule = await pool.query(`SELECT confdeltype, condeferred FROM pg_constraint WHERE conname = 'fk_bug_program_id'`);
      assertEquals([rule.rows[0].confdeltype, rule.rows[0].condeferred], ["a", true]);

      assertEquals(await migrate(pool, sdl), 0, "once repaired, the next migrate is a no-op");
    })
});

Deno.test({
  name: "PG delete-rule drift: a multi link's junction FK left at RESTRICT is re-added with CASCADE, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = schema("multi link programs: Program;");
      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await onDeleteAction(pool, "fk_bug_programs_target_id"), "c");

      await pool.query(
        `ALTER TABLE bug_programs DROP CONSTRAINT fk_bug_programs_target_id, ADD CONSTRAINT fk_bug_programs_target_id FOREIGN KEY (target_id) REFERENCES program (id) ON DELETE RESTRICT`
      );

      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await onDeleteAction(pool, "fk_bug_programs_target_id"), "c");

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
      const bug = (await pool.query(`INSERT INTO bug (title) VALUES ('crash') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [bug, program]);
      await pool.query(`DELETE FROM program WHERE id = $1`, [program]);
      assertEquals(await count(pool, "bug_programs"), 0);

      assertEquals(await migrate(pool, sdl), 0);
    })
});

Deno.test({
  name: "PG delete-rule drift: a missing delete-target trigger is created, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = schema("multi link programs: Program { on source delete delete target; };");
      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await hasTrigger(pool, "trg_source_delete_bug_programs"), true);

      await pool.query(`DROP TRIGGER trg_source_delete_bug_programs ON bug_programs`);
      await pool.query(`DROP FUNCTION disc_source_delete_bug_programs()`);

      assertStringIncludes(await preview(pool, sdl), "CREATE TRIGGER trg_source_delete_bug_programs");

      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await hasTrigger(pool, "trg_source_delete_bug_programs"), true);

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
      const bug = (await pool.query(`INSERT INTO bug (title) VALUES ('crash') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [bug, program]);
      await pool.query(`DELETE FROM bug`);
      assertEquals(await count(pool, "program"), 0);

      assertEquals(await migrate(pool, sdl), 0);
    })
});

/*** Timing and table of each trigger with the given name (`BEFORE bug`, `AFTER bug_programs`). ***/
async function triggerTimings(pool: ConnectionPool, trigger: string): Promise<string[]> {
  const result = await pool.query(
    `SELECT CASE WHEN g.tgtype & 2 <> 0 THEN 'BEFORE' ELSE 'AFTER' END || ' ' || t.relname AS timing
       FROM pg_trigger g JOIN pg_class t ON t.oid = g.tgrelid WHERE g.tgname = $1 ORDER BY 1`,
    [trigger]
  );
  return result.rows.map(row => row.timing as string);
}

Deno.test({
  name: "PG delete-rule drift: a single link's BEFORE delete-target trigger is replaced by an AFTER one, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = schema("link program: Program { on source delete delete target; };");
      assertEquals(await migrate(pool, sdl), 1);

      /*** What `on source delete delete target` created before: a BEFORE trigger the RESTRICT FK blocks. ***/
      await pool.query(`DROP TRIGGER trg_source_delete_bug_program ON bug`);
      await pool.query(
        `CREATE OR REPLACE FUNCTION disc_source_delete_bug_program() RETURNS TRIGGER AS $$ BEGIN DELETE FROM program WHERE id = OLD.program_id; RETURN OLD; END; $$ LANGUAGE plpgsql`
      );
      await pool.query(`CREATE TRIGGER trg_source_delete_bug_program BEFORE DELETE ON bug FOR EACH ROW EXECUTE FUNCTION disc_source_delete_bug_program()`);

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('crash', $1)`, [program]);
      await assertRejects(() => pool.query(`DELETE FROM bug`));

      assertStringIncludes(await preview(pool, sdl), "CREATE TRIGGER trg_source_delete_bug_program AFTER DELETE ON bug");

      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await triggerTimings(pool, "trg_source_delete_bug_program"), ["AFTER bug"]);

      await pool.query(`DELETE FROM bug`);
      assertEquals(await count(pool, "program"), 0);

      assertEquals(await migrate(pool, sdl), 0, "once repaired, the next migrate is a no-op");
    })
});

Deno.test({
  name: "PG delete-rule drift: a multi link's delete-target trigger on the source table moves to the junction, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = schema("multi link programs: Program { on target delete restrict; on source delete delete target; };");
      assertEquals(await migrate(pool, sdl), 1);

      /*** What `on source delete delete target` created before: a BEFORE trigger on the source table. ***/
      await pool.query(`DROP TRIGGER trg_source_delete_bug_programs ON bug_programs`);
      await pool.query(
        `CREATE OR REPLACE FUNCTION disc_source_delete_bug_programs() RETURNS TRIGGER AS $$ BEGIN DELETE FROM program WHERE id IN (SELECT target_id FROM bug_programs WHERE source_id = OLD.id); RETURN OLD; END; $$ LANGUAGE plpgsql`
      );
      await pool.query(`CREATE TRIGGER trg_source_delete_bug_programs BEFORE DELETE ON bug FOR EACH ROW EXECUTE FUNCTION disc_source_delete_bug_programs()`);

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
      const bug = (await pool.query(`INSERT INTO bug (title) VALUES ('crash') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [bug, program]);
      await assertRejects(() => pool.query(`DELETE FROM bug`));

      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await triggerTimings(pool, "trg_source_delete_bug_programs"), ["AFTER bug_programs"]);

      await pool.query(`DELETE FROM bug`);
      assertEquals(await count(pool, "program"), 0);

      assertEquals(await migrate(pool, sdl), 0, "once repaired, the next migrate is a no-op");
    })
});

Deno.test({
  name: "PG delete-rule drift: a delete-target trigger the link no longer declares is dropped, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = schema("link program: Program { on target delete allow; };");
      assertEquals(await migrate(pool, sdl), 1);

      /*** The trigger an `on source delete delete target` left behind when removing it only emitted a comment. ***/
      await pool.query(
        `CREATE OR REPLACE FUNCTION disc_source_delete_bug_program() RETURNS TRIGGER AS $$ BEGIN DELETE FROM program WHERE id = OLD.program_id; RETURN OLD; END; $$ LANGUAGE plpgsql`
      );
      await pool.query(`CREATE TRIGGER trg_source_delete_bug_program BEFORE DELETE ON bug FOR EACH ROW EXECUTE FUNCTION disc_source_delete_bug_program()`);

      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await hasTrigger(pool, "trg_source_delete_bug_program"), false);

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('crash', $1)`, [program]);
      await pool.query(`DELETE FROM bug`);
      assertEquals(await count(pool, "program"), 1);

      assertEquals(await migrate(pool, sdl), 0);
    })
});

Deno.test({
  name: "PG delete-rule drift: a foreign key that doesn't exist at all is reported, not re-created",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = schema("link program: Program { on target delete delete source; };");
      assertEquals(await migrate(pool, sdl), 1);

      await pool.query(`ALTER TABLE bug DROP CONSTRAINT fk_bug_program_id`);

      assertEquals(await migrate(pool, sdl), 0);
      assertEquals(await onDeleteAction(pool, "fk_bug_program_id"), undefined);
    })
});

Deno.test({
  name: "PG delete-rule drift: source-delete triggers created now are left alone by the next migrate",
  ignore: !canRunPgTests(),
  fn: async () => {
    for (
      const link of [
        "link program: Program { on source delete delete target; };",
        "multi link programs: Program { on source delete delete target; };",
        "link program: Program { on source delete delete target if orphan; };",
        "multi link programs: Program { on source delete delete target if orphan; };"
      ]
    ) {
      await run(async pool => {
        assertEquals(await migrate(pool, schema(link)), 1, link);
        assertEquals(await migrate(pool, schema(link)), 0, link);
      });
    }
  }
});

Deno.test({
  name: "PG delete-rule drift: a delete-target trigger running another policy's body is replaced, once",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const sdl = schema("link program: Program { on source delete delete target if orphan; };");
      assertEquals(await migrate(pool, sdl), 1);

      /*** The body `delete target` gives the function: it deletes a target other bugs still link. ***/
      await pool.query(
        `CREATE OR REPLACE FUNCTION disc_source_delete_bug_program() RETURNS TRIGGER AS $$ BEGIN DELETE FROM program WHERE id = OLD.program_id; RETURN NULL; END; $$ LANGUAGE plpgsql`
      );

      assertStringIncludes(await preview(pool, sdl), "IF NOT EXISTS (SELECT 1 FROM bug WHERE program_id = OLD.program_id)");
      assertEquals(await migrate(pool, sdl), 1);
      assertEquals(await hasTrigger(pool, "trg_source_delete_bug_program"), true);

      const program = (await pool.query(`INSERT INTO program (name) VALUES ('disc') RETURNING id`)).rows[0].id as string;
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('first', $1), ('second', $1)`, [program]);
      await pool.query(`DELETE FROM bug WHERE title = 'first'`);
      assertEquals(await count(pool, "program"), 1, "still linked by 'second'");
      await pool.query(`DELETE FROM bug`);
      assertEquals(await count(pool, "program"), 0);

      assertEquals(await migrate(pool, sdl), 0);
    })
});

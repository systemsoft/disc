/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Link-level `constraint exclusive`: no two sources may link the same target.
 * On a single link that is a unique index on the `<link>_id` column; on a
 * multi link, a unique index on the junction table's `target_id`. Both use
 * the `uk_<table>_<column>` name a property-level exclusive uses, on CREATE,
 * on adding the link, and on adding or dropping the constraint.
 *
 * The PG tests require PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { compileEdgeQL } from "../compiler/test-helpers.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { normalizeModules, SDLConverter, type Module } from "../schema/converter.ts";
import { SDLParser } from "../schema/parser.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { DDLGenerator } from "./ddl.ts";
import { SchemaDiffer } from "./differ.ts";
import { SchemaManager } from "./schema-manager.ts";

const SINGLE_UNIQUE = "CREATE UNIQUE INDEX uk_bug_program_id ON bug (program_id);";
const MULTI_UNIQUE = "CREATE UNIQUE INDEX uk_bug_programs_target_id ON bug_programs (target_id);";

function modules(sdl: string): Module[] {
  return normalizeModules(new SDLConverter().convertToModules(new SDLParser(sdl).parse()));
}

function bug(link: string): string {
  return `module default {
    type Program { required name: str; };
    type Bug { required title: str; ${link} };
  };`;
}

function initialDDL(sdl: string): string[] {
  return new DDLGenerator().generateDDL(new SchemaDiffer().diff([], modules(sdl)));
}

function migrationDDL(from: string, to: string): string[] {
  return new DDLGenerator().generateDDL(new SchemaDiffer().diff(modules(from), modules(to)));
}

Deno.test("exclusive link - CREATE gives a single link a unique index on its FK column", () => {
  const ddl = initialDDL(bug("required link program -> Program { constraint exclusive; };"));

  assertEquals(ddl.filter(s => s === SINGLE_UNIQUE).length, 1, ddl.join("\n"));
});

Deno.test("exclusive link - colon form and link keyword form emit identical DDL", () => {
  assertEquals(
    initialDDL(bug("required program: Program { constraint exclusive; };")),
    initialDDL(bug("required link program -> Program { constraint exclusive; };"))
  );
});

Deno.test("exclusive link - CREATE gives a multi link a unique index on the junction's target_id, after the junction", () => {
  const ddl = initialDDL(bug("multi programs: Program { constraint exclusive; };"));
  const junction = ddl.findIndex(s => s.startsWith("CREATE TABLE bug_programs"));

  assertEquals(ddl.filter(s => s === MULTI_UNIQUE).length, 1, ddl.join("\n"));
  assert(junction >= 0 && ddl.indexOf(MULTI_UNIQUE) > junction, ddl.join("\n"));
});

Deno.test("exclusive link - a link without the constraint gets no unique index", () => {
  const ddl = initialDDL(bug("required program: Program; multi programs: Program;")).join("\n");

  assert(!ddl.includes("CREATE UNIQUE INDEX"), ddl);
});

Deno.test("exclusive link - link-level and type-level exclusive on the same link emit one index", () => {
  const ddl = initialDDL(bug("required program: Program { constraint exclusive; }; constraint exclusive on (.program);"));

  assertEquals(ddl.filter(s => s.includes("uk_bug_program_id")).length, 1, ddl.join("\n"));
});

Deno.test("exclusive link - an inherited exclusive link is unique on the subtype's table", () => {
  const ddl = initialDDL(`module default {
    type Program { required name: str; };
    abstract type Owned { required program: Program { constraint exclusive; }; };
    type Bug extending Owned { required title: str; };
  };`);

  assert(ddl.includes(SINGLE_UNIQUE), ddl.join("\n"));
});

Deno.test("exclusive link - adding an exclusive link to an existing type creates its unique index", () => {
  assert(migrationDDL(bug(""), bug("program: Program { constraint exclusive; };")).includes(SINGLE_UNIQUE));
  assert(migrationDDL(bug(""), bug("multi programs: Program { constraint exclusive; };")).includes(MULTI_UNIQUE));
});

Deno.test("exclusive link - adding the constraint to an existing link creates the unique index", () => {
  assertEquals(migrationDDL(bug("required program: Program;"), bug("required program: Program { constraint exclusive; };")), [SINGLE_UNIQUE]);
  assertEquals(migrationDDL(bug("multi programs: Program;"), bug("multi programs: Program { constraint exclusive; };")), [MULTI_UNIQUE]);
});

Deno.test("exclusive link - dropping the constraint drops the unique index", () => {
  assertEquals(migrationDDL(bug("required program: Program { constraint exclusive; };"), bug("required program: Program;")), [
    "DROP INDEX IF EXISTS uk_bug_program_id;"
  ]);
  assertEquals(migrationDDL(bug("multi programs: Program { constraint exclusive; };"), bug("multi programs: Program;")), [
    "DROP INDEX IF EXISTS uk_bug_programs_target_id;"
  ]);
});

Deno.test("exclusive link - an unchanged exclusive link diffs to nothing", () => {
  const sdl = bug("required program: Program { constraint exclusive; };");

  assertEquals(new SchemaDiffer().diff(modules(sdl), modules(sdl)), []);
});

async function withManager<T>(pool: ConnectionPool, fn: (manager: SchemaManager) => Promise<T>): Promise<T> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

async function migrate(pool: ConnectionPool, sdl: string): Promise<Schema> {
  return await withManager(pool, async manager => {
    const result = await manager.applySchema(sdl);

    if (!result.ok)
      throw result.error;

    return manager.getSchema()!;
  });
}

async function insertProgram(pool: ConnectionPool, name: string): Promise<string> {
  return (await pool.query(`INSERT INTO program (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;
}

async function withPool(fn: (pool: ConnectionPool) => Promise<void>): Promise<void> {
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
  name: "PG exclusive link: unless conflict on (.program) upserts against the link's unique index",
  ignore: !canRunPgTests(),
  fn: () =>
    withPool(async pool => {
      const schema = await migrate(pool, bug("required program: Program { constraint exclusive; };"));
      const program = await insertProgram(pool, "disc");
      const upsert = compileEdgeQL(
        `insert Bug { title := <str>$title, program := <Program><uuid>$program }
         unless conflict on (.program)
         else (update Bug set { title := <str>$title })`,
        schema
      );

      await pool.query(upsert, ["first", program]);
      await pool.query(upsert, ["second", program]);

      const rows = (await pool.query(`SELECT title FROM bug`)).rows;
      assertEquals(rows.map(r => r.title), ["second"]);
    })
});

Deno.test({
  name: "PG exclusive link: adding and dropping the constraint on an existing single link",
  ignore: !canRunPgTests(),
  fn: () =>
    withPool(async pool => {
      await migrate(pool, bug("program: Program;"));
      const program = await insertProgram(pool, "disc");
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('a', $1)`, [program]);

      await migrate(pool, bug("program: Program { constraint exclusive; };"));
      const error = await assertRejects(() => pool.query(`INSERT INTO bug (title, program_id) VALUES ('b', $1)`, [program]));
      assertStringIncludes((error as Error).message, "uk_bug_program_id");

      await migrate(pool, bug("program: Program;"));
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('b', $1)`, [program]);
    })
});

Deno.test({
  name: "PG exclusive link: a multi link target can be linked from only one source",
  ignore: !canRunPgTests(),
  fn: () =>
    withPool(async pool => {
      await migrate(pool, bug("multi programs: Program { constraint exclusive; };"));
      const program = await insertProgram(pool, "disc");
      const [first, second] = [
        (await pool.query(`INSERT INTO bug (title) VALUES ('a') RETURNING id`)).rows[0].id,
        (await pool.query(`INSERT INTO bug (title) VALUES ('b') RETURNING id`)).rows[0].id
      ];

      await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [first, program]);
      const error = await assertRejects(() => pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [second, program]));
      assertStringIncludes((error as Error).message, "uk_bug_programs_target_id");
    })
});

Deno.test({
  name: "PG exclusive link: a database migrated before link-level exclusive was honoured gets its unique indexes, once",
  ignore: !canRunPgTests(),
  fn: () =>
    withPool(async pool => {
      const sdl = `module default {
        type Program { required name: str; };
        type Bug { required title: str; program: Program { constraint exclusive; }; multi programs: Program { constraint exclusive; }; };
      };`;
      const indexes = async (): Promise<string[]> =>
        (await pool.query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('uk_bug_program_id', 'uk_bug_programs_target_id') ORDER BY indexname`))
          .rows
          .map(row => row.indexname as string);

      await migrate(pool, sdl);
      /*** Older Disc recorded this schema but created neither index. ***/
      await pool.query(`DROP INDEX uk_bug_program_id; DROP INDEX uk_bug_programs_target_id;`);

      const applied = await withManager(pool, async manager => {
        const result = await manager.applySchema(sdl);
        if (!result.ok)
          throw result.error;
        return result.value;
      });
      assertEquals(applied.length > 0, true);
      assertEquals(await indexes(), ["uk_bug_program_id", "uk_bug_programs_target_id"]);

      const again = await withManager(pool, async manager => {
        const result = await manager.applySchema(sdl);
        if (!result.ok)
          throw result.error;
        return result.value;
      });
      assertEquals(again, []);
    })
});

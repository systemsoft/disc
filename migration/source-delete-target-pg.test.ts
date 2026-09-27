/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `on source delete delete target` against a real database: deleting the
 * source deletes the targets it links to, whatever the link's `on target
 * delete` policy. The targets are deleted once the source row is gone, so a
 * single link's RESTRICT foreign key (the default) no longer blocks it, and a
 * multi link's targets are found although its junction rows cascade away.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

function schema(link: string): string {
  return `module default {
    type Program { required name: str; };
    type Bug { required title: str; ${link} };
  };`;
}

async function migrate(pool: ConnectionPool, sdl: string, allowUnsafe = false): Promise<void> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();

  try {
    const result = await manager.applySchema(sdl, { allowUnsafe });
    if (!result.ok)
      throw result.error;
  } finally {
    await manager.close();
  }
}

async function insertProgram(pool: ConnectionPool, name: string): Promise<string> {
  return (await pool.query(`INSERT INTO program (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;
}

async function insertBug(pool: ConnectionPool, title: string): Promise<string> {
  return (await pool.query(`INSERT INTO bug (title) VALUES ($1) RETURNING id`, [title])).rows[0].id as string;
}

async function programNames(pool: ConnectionPool): Promise<string[]> {
  return (await pool.query(`SELECT name FROM program ORDER BY name`)).rows.map(row => row.name as string);
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
  name: "PG on source delete delete target: a single link with the default RESTRICT target policy deletes its target",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      await migrate(pool, schema("link program: Program { on source delete delete target; };"));

      const program = await insertProgram(pool, "disc");
      await insertProgram(pool, "other");
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('crash', $1)`, [program]);
      await pool.query(`INSERT INTO bug (title) VALUES ('unlinked')`);

      await pool.query(`DELETE FROM bug`);
      assertEquals(await programNames(pool), ["other"]);
    })
});

Deno.test({
  name: "PG on source delete delete target: a multi link deletes every target, with a cascading or restricting junction",
  ignore: !canRunPgTests(),
  fn: async () => {
    for (const policy of ["", "on target delete restrict;"]) {
      await run(async pool => {
        await migrate(pool, schema(`multi link programs: Program { ${policy} on source delete delete target; };`));

        const bug = await insertBug(pool, "crash");
        for (const name of ["a", "b"]) {
          await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [bug, await insertProgram(pool, name)]);
        }
        await insertProgram(pool, "other");

        await pool.query(`DELETE FROM bug WHERE id = $1`, [bug]);
        assertEquals(await programNames(pool), ["other"], policy || "default policy");
        assertEquals((await pool.query(`SELECT count(*)::int AS n FROM bug_programs`)).rows[0].n, 0);
      });
    }
  }
});

Deno.test({
  name: "PG on source delete delete target: unlinking a multi link's target, or deleting the target, keeps the other side",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      await migrate(pool, schema("multi link programs: Program { on source delete delete target; };"));

      const bug = await insertBug(pool, "crash");
      const a = await insertProgram(pool, "a");
      const b = await insertProgram(pool, "b");
      await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2), ($1, $3)`, [bug, a, b]);

      await pool.query(`DELETE FROM bug_programs WHERE target_id = $1`, [a]);
      assertEquals(await programNames(pool), ["a", "b"], "unlinking leaves the target");

      await pool.query(`DELETE FROM program WHERE id = $1`, [b]);
      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM bug`)).rows[0].n, 1, "deleting the target leaves the source");
    })
});

Deno.test({
  name: "PG on source delete delete target: removing the link removes its trigger, so later deletes still work",
  ignore: !canRunPgTests(),
  fn: async () => {
    for (
      const [link, fn] of [
        ["link program: Program { on source delete delete target; };", "disc_source_delete_bug_program"],
        ["multi link programs: Program { on source delete delete target; };", "disc_source_delete_bug_programs"]
      ]
    ) {
      await run(async pool => {
        await migrate(pool, schema(link));
        await migrate(pool, schema(""), true);

        await insertBug(pool, "crash");
        await pool.query(`DELETE FROM bug`);

        const functions = await pool.query(`SELECT 1 FROM pg_proc WHERE proname = $1`, [fn]);
        assertEquals(functions.rows.length, 0, link);
      });
    }
  }
});

/*** Gel: `if orphan` deletes the target only if no other object links it via the same link; links by other names don't count. ***/
const IF_ORPHAN = "link program: Program { on source delete delete target if orphan; };";
const MULTI_IF_ORPHAN = "multi link programs: Program { on source delete delete target if orphan; };";

Deno.test({
  name: "PG delete target if orphan: a single link's shared target survives its first source and goes with the last",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      await migrate(pool, schema(IF_ORPHAN));

      const shared = await insertProgram(pool, "shared");
      const own = await insertProgram(pool, "own");
      await insertProgram(pool, "other");
      const first = (await pool.query(`INSERT INTO bug (title, program_id) VALUES ('first', $1) RETURNING id`, [shared])).rows[0].id as string;
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('second', $1), ('third', $2)`, [shared, own]);

      await pool.query(`DELETE FROM bug WHERE id = $1`, [first]);
      assertEquals(await programNames(pool), ["other", "own", "shared"], "still linked by 'second'");

      await pool.query(`DELETE FROM bug WHERE title = 'second'`);
      assertEquals(await programNames(pool), ["other", "own"]);

      await pool.query(`DELETE FROM bug`);
      assertEquals(await programNames(pool), ["other"]);
    })
});

Deno.test({
  name: "PG delete target if orphan: sources sharing a target deleted in one statement take it with them",
  ignore: !canRunPgTests(),
  fn: async () => {
    for (const link of [IF_ORPHAN, MULTI_IF_ORPHAN]) {
      await run(async pool => {
        await migrate(pool, schema(link));

        const shared = await insertProgram(pool, "shared");
        await insertProgram(pool, "other");
        for (const title of ["first", "second"]) {
          const bug = await insertBug(pool, title);
          if (link === IF_ORPHAN)
            await pool.query(`UPDATE bug SET program_id = $1 WHERE id = $2`, [shared, bug]);
          else
            await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [bug, shared]);
        }

        await pool.query(`DELETE FROM bug`);
        assertEquals(await programNames(pool), ["other"], link);
      });
    }
  }
});

Deno.test({
  name: "PG delete target if orphan: a multi link's shared target survives its first source and goes with the last",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      await migrate(pool, schema(MULTI_IF_ORPHAN));

      const shared = await insertProgram(pool, "shared");
      const own = await insertProgram(pool, "own");
      await insertProgram(pool, "other");
      const first = await insertBug(pool, "first");
      const second = await insertBug(pool, "second");
      await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2), ($1, $3), ($4, $2)`, [first, shared, own, second]);

      await pool.query(`DELETE FROM bug WHERE id = $1`, [first]);
      assertEquals(await programNames(pool), ["other", "shared"], "'own' was orphaned, 'shared' is still linked by 'second'");

      await pool.query(`DELETE FROM bug_programs`);
      assertEquals(await programNames(pool), ["other", "shared"], "unlinking leaves the target");

      await pool.query(`INSERT INTO bug_programs (source_id, target_id) VALUES ($1, $2)`, [second, shared]);
      await pool.query(`DELETE FROM bug WHERE id = $1`, [second]);
      assertEquals(await programNames(pool), ["other"]);
    })
});

Deno.test({
  name: "PG delete target if orphan: a link by another name doesn't keep the target (Gel semantics)",
  ignore: !canRunPgTests(),
  fn: async () => {
    /*** `reviewer` allows its target to go: the orphaned program is deleted and the other bug's `reviewer` is emptied. ***/
    await run(async pool => {
      await migrate(pool, schema(`${IF_ORPHAN} link reviewer: Program { on target delete allow; };`));

      const program = await insertProgram(pool, "disc");
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('owner', $1)`, [program]);
      await pool.query(`INSERT INTO bug (title, reviewer_id) VALUES ('reviewed', $1)`, [program]);

      await pool.query(`DELETE FROM bug WHERE title = 'owner'`);
      assertEquals(await programNames(pool), []);
      assertEquals((await pool.query(`SELECT reviewer_id FROM bug`)).rows, [{ reviewer_id: null }]);
    });

    /*** `reviewer` restricts (the default): deleting the orphaned target fails, and so does deleting its source. ***/
    await run(async pool => {
      await migrate(pool, schema(`${IF_ORPHAN} link reviewer: Program;`));

      const program = await insertProgram(pool, "disc");
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('owner', $1)`, [program]);
      await pool.query(`INSERT INTO bug (title, reviewer_id) VALUES ('reviewed', $1)`, [program]);

      await assertRejects(() => pool.query(`DELETE FROM bug WHERE title = 'owner'`));
      assertEquals(await programNames(pool), ["disc"]);
      assertEquals((await pool.query(`SELECT count(*)::int AS n FROM bug`)).rows[0].n, 2);
    });
  }
});

Deno.test({
  name: "PG delete target if orphan: switching to and from delete target via migrate changes what a delete takes",
  ignore: !canRunPgTests(),
  fn: () =>
    run(async pool => {
      const deleteTarget = "link program: Program { on source delete delete target; };";
      await migrate(pool, schema(deleteTarget));

      const shared = await insertProgram(pool, "shared");
      await pool.query(`INSERT INTO bug (title, program_id) VALUES ('a', $1), ('b', $1), ('c', $1)`, [shared]);

      await migrate(pool, schema(IF_ORPHAN));
      await pool.query(`DELETE FROM bug WHERE title = 'a'`);
      assertEquals(await programNames(pool), ["shared"], "if orphan keeps a target 'b' and 'c' still link");

      /*** Back to delete target: the next source takes the target, which `c`'s RESTRICT link then blocks. ***/
      await migrate(pool, schema(deleteTarget));
      await assertRejects(() => pool.query(`DELETE FROM bug WHERE title = 'b'`));

      await migrate(pool, schema(IF_ORPHAN));
      await pool.query(`DELETE FROM bug WHERE title = 'b'`);
      await pool.query(`DELETE FROM bug WHERE title = 'c'`);
      assertEquals(await programNames(pool), []);
    })
});

/*** Gel: a link declared on a parent type is the same link on every subtype, so a target another subtype's object links isn't orphaned. ***/
function inherited(link: string, parent = "abstract type Item", subtypes = ["Note", "Task"]): string {
  return `module default {
    type Tag { required name: str; };
    ${parent} { ${link} };
    ${subtypes.map(name => `type ${name} extending Item;`).join("\n    ")}
  };`;
}

const INHERITED_IF_ORPHAN = "link tag: Tag { on source delete delete target if orphan; };";
const INHERITED_MULTI_IF_ORPHAN = "multi link tags: Tag { on source delete delete target if orphan; };";

async function insertTag(pool: ConnectionPool, name: string): Promise<string> {
  return (await pool.query(`INSERT INTO tag (name) VALUES ($1) RETURNING id`, [name])).rows[0].id as string;
}

async function tagNames(pool: ConnectionPool): Promise<string[]> {
  return (await pool.query(`SELECT name FROM tag ORDER BY name`)).rows.map(row => row.name as string);
}

/*** Insert an object into `table` linked to `tag` through the single (`tag`) or the multi (`tags`) link. ***/
async function insertLinked(pool: ConnectionPool, table: string, tag: string, multi: boolean): Promise<string> {
  if (!multi)
    return (await pool.query(`INSERT INTO ${table} (tag_id) VALUES ($1) RETURNING id`, [tag])).rows[0].id as string;

  const id = (await pool.query(`INSERT INTO ${table} DEFAULT VALUES RETURNING id`)).rows[0].id as string;
  await pool.query(`INSERT INTO ${table}_tags (source_id, target_id) VALUES ($1, $2)`, [id, tag]);
  return id;
}

async function migrationCount(pool: ConnectionPool): Promise<number> {
  return (await pool.query(`SELECT count(*)::int AS n FROM disc_migrations`)).rows[0].n as number;
}

Deno.test({
  name: "PG delete target if orphan: a target another subtype links through the inherited link survives, and goes with the last source",
  ignore: !canRunPgTests(),
  fn: async () => {
    for (const parent of ["abstract type Item", "type Item"]) {
      for (const link of [INHERITED_IF_ORPHAN, INHERITED_MULTI_IF_ORPHAN]) {
        const multi = link === INHERITED_MULTI_IF_ORPHAN;
        const label = `${parent} / ${link}`;

        await run(async pool => {
          await migrate(pool, inherited(link, parent));

          const shared = await insertTag(pool, "shared");
          await insertTag(pool, "other");
          const note = await insertLinked(pool, "note", shared, multi);
          const task = await insertLinked(pool, "task", shared, multi);

          await pool.query(`DELETE FROM note WHERE id = $1`, [note]);
          assertEquals(await tagNames(pool), ["other", "shared"], `${label}: still linked by the task`);

          await pool.query(`DELETE FROM task WHERE id = $1`, [task]);
          assertEquals(await tagNames(pool), ["other"], label);

          if (parent === "type Item") {
            /*** The concrete parent's own objects link through it too. ***/
            const again = await insertTag(pool, "again");
            const item = await insertLinked(pool, "item", again, multi);
            await pool.query(`DELETE FROM task WHERE id = $1`, [await insertLinked(pool, "task", again, multi)]);
            assertEquals(await tagNames(pool), ["again", "other"], `${label}: still linked by the item`);

            await pool.query(`DELETE FROM item WHERE id = $1`, [item]);
            assertEquals(await tagNames(pool), ["other"], label);
          }

          const applied = await migrationCount(pool);
          await migrate(pool, inherited(link, parent));
          assertEquals(await migrationCount(pool), applied, `${label}: migrating again is a no-op`);
        });
      }
    }
  }
});

Deno.test({
  name: "PG delete target if orphan: adding or dropping a subtype that inherits the link updates the other subtypes' check",
  ignore: !canRunPgTests(),
  fn: async () => {
    for (const link of [INHERITED_IF_ORPHAN, INHERITED_MULTI_IF_ORPHAN]) {
      const multi = link === INHERITED_MULTI_IF_ORPHAN;

      await run(async pool => {
        await migrate(pool, inherited(link, "abstract type Item", ["Note"]));
        await migrate(pool, inherited(link));

        const shared = await insertTag(pool, "shared");
        const note = await insertLinked(pool, "note", shared, multi);
        const task = await insertLinked(pool, "task", shared, multi);

        await pool.query(`DELETE FROM note WHERE id = $1`, [note]);
        assertEquals(await tagNames(pool), ["shared"], `${link}: the note's check sees the task type added later`);

        const applied = await migrationCount(pool);
        await migrate(pool, inherited(link));
        assertEquals(await migrationCount(pool), applied, `${link}: migrating again is a no-op`);

        await pool.query(`DELETE FROM task WHERE id = $1`, [task]);
        assertEquals(await tagNames(pool), [], link);

        /*** Once `Task` is dropped, the note's check no longer reads its table. ***/
        await migrate(pool, inherited(link, "abstract type Item", ["Note"]), true);
        const own = await insertTag(pool, "own");
        await pool.query(`DELETE FROM note WHERE id = $1`, [await insertLinked(pool, "note", own, multi)]);
        assertEquals(await tagNames(pool), [], `${link}: after dropping the task type`);
      });
    }
  }
});

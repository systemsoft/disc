/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: property defaults and index expressions are EdgeQL,
 * compiled into the DDL — a default into the column's DEFAULT (`['a', 'b']`,
 * `2 + 3`, a tuple, a cast, an enum value, json, a function call), an index
 * on an expression into a PostgreSQL expression index (`str_lower(.email)`
 * is `lower(email)`), alone, in a tuple with columns, named, or exclusive.
 * What PostgreSQL can't hold there — a default reading the object or running
 * a query, an index expression that isn't immutable — is a schema error.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { SQLCodeGenerator } from "../compiler/codegen.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { SchemaManager } from "./schema-manager.ts";

/*** The rows `edgeql` selects, each its first column. ***/
async function values(pool: ConnectionPool, schema: Schema, edgeql: string): Promise<unknown[]> {
  const result = new EdgeQLCompiler(schema, {}).compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw new Error(`Compilation failed for ${edgeql}: ${result.error.message}`);
  }
  return (await pool.query(new SQLCodeGenerator().generate(result.value))).rows.map(row => Object.values(row)[0]);
}

/*** The definition of each index on `table`, by name. ***/
async function indexDefinitions(pool: ConnectionPool, table: string): Promise<Map<string, string>> {
  const result = await pool.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1`, [table]);
  return new Map(result.rows.map(row => [row.indexname as string, row.indexdef as string]));
}

/*** A fresh manager per call, the way each `disc migrate` process starts from `disc_migrations`. ***/
async function withManager<T>(pool: ConnectionPool, fn: (manager: SchemaManager) => Promise<T>): Promise<T> {
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  try {
    return await fn(manager);
  } finally {
    await manager.close();
  }
}

/*** Applies `sdl`, returning the schema it leaves. ***/
async function apply(pool: ConnectionPool, sdl: string): Promise<Schema> {
  return await withManager(pool, async manager => {
    const applied = await manager.applySchema(sdl);
    assert(applied.ok, applied.ok ? "" : applied.error.message);
    const schema = manager.getSchema();
    assert(schema);
    return schema;
  });
}

/*** The message `applySchema(sdl)` fails with. ***/
async function applyError(pool: ConnectionPool, sdl: string): Promise<string> {
  return await withManager(pool, async manager => {
    const applied = await manager.applySchema(sdl);
    assert(!applied.ok, `expected ${sdl} to be rejected`);
    return applied.error.message;
  });
}

const DEFAULTS = `module default {
  scalar type Mood extending enum<Happy, Sad>;
  type DfItem {
    name: str;
    tags: array<str> { default := ['a', 'b']; };
    n: int64 { default := 2 + 3; };
    neg: int64 { default := -4; };
    pair: tuple<int64, str> { default := (1, 'x'); };
    named: tuple<a: int64, b: str> { default := (a := 1, b := 'x'); };
    code: int64 { default := <int64>'7'; };
    at: datetime { default := datetime_current(); };
    ref: uuid { default := disc_uuidv7(); };
    mood: Mood { default := Mood.Sad; };
    doc: json { default := to_json('{"a": 1}'); };
    counts: array<int64> { default := <array<int64>>[]; };
    label: str { default := 'x' ++ 'y'; };
    plain: str { default := 'it is'; };
    ratio: float64 { default := 1 / 4; };
  };
}`;

Deno.test({
  name: "PG SDL defaults: every default is EdgeQL compiled into the column's DEFAULT",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();
    try {
      await resetTestDatabase(pool);
      const schema = await apply(pool, DEFAULTS);
      await values(pool, schema, "insert DfItem { name := 'one' }");

      await t.step("an insert leaving them out gets each default's value", async () => {
        const [item] = await values(
          pool,
          schema,
          "select DfItem { tags, n, neg, pair, named, code, mood, doc, counts, label, plain, ratio }"
        );
        assertEquals(item, {
          code: 7,
          doc: { a: 1 },
          counts: [],
          label: "xy",
          mood: "Sad",
          n: 5,
          named: { a: 1, b: "x" },
          neg: -4,
          pair: [1, "x"],
          plain: "it is",
          ratio: 0.25,
          tags: ["a", "b"]
        });
      });

      await t.step("function-call defaults are evaluated per insert", async () => {
        const rows = (await pool.query("SELECT at, ref FROM df_item")).rows;
        assert(rows[0].at instanceof Date);
        assertEquals(typeof rows[0].ref, "string");
      });

      await t.step("re-applying the same schema migrates nothing", async () => {
        const again = await withManager(pool, manager => manager.applySchema(DEFAULTS));
        assert(again.ok, again.ok ? "" : again.error.message);
        assertEquals(again.value.length, 0);
      });

      await t.step("a changed default is compiled into SET DEFAULT", async () => {
        const changed = await apply(pool, DEFAULTS.replace("default := 2 + 3", "default := 10 * 3").replace("['a', 'b']", "['c']"));
        await values(pool, changed, "insert DfItem { name := 'two' }");
        assertEquals(await values(pool, changed, "select DfItem { n, tags } filter .name = 'two'"), [{ n: 30, tags: ["c"] }]);
      });

      await t.step("a default reading the object or running a query is a schema error", async () => {
        for (
          const [property, expected] of [
            ["b: int64 { default := .n + 1; }", "property 'b'"],
            ["c: int64 { default := (select count(DfItem)); }", "property 'c'"]
          ]
        ) {
          const message = await applyError(pool, DEFAULTS.replace("name: str;", `name: str;\n    ${property}`));
          assertStringIncludes(message, expected);
          assertStringIncludes(message, "default");
        }
      });
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

const INDEXES = `module default {
  type IxUser {
    required email: str;
    first: str;
    last: str;
    manager: IxUser;
    index on (str_lower(.email));
    index on ((.first, str_lower(.last)));
    index on ((.manager, str_upper(.first)));
    index ix_full_name on (.first ++ ' ' ++ .last);
    constraint exclusive on (str_lower(.email));
  };
}`;

Deno.test({
  name: "PG SDL indexes: an index on an expression is a PostgreSQL expression index",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();
    try {
      await resetTestDatabase(pool);
      const schema = await apply(pool, INDEXES);

      await t.step("each expression is compiled, alone or next to columns", async () => {
        const definitions = [...(await indexDefinitions(pool, "ix_user")).values()].join("\n");
        assertStringIncludes(definitions, "(lower(email))");
        assertStringIncludes(definitions, "(first, lower(last))");
        assertStringIncludes(definitions, "(manager_id, upper(first))");
        assertStringIncludes(definitions, "CREATE UNIQUE INDEX");
        assert((await indexDefinitions(pool, "ix_user")).has("ix_full_name"));
      });

      await t.step("an exclusive expression holds for its values", async () => {
        await values(pool, schema, "insert IxUser { email := 'Ada@example.com' }");
        await assertRejects(() => values(pool, schema, "insert IxUser { email := 'ada@EXAMPLE.com' }"));
      });

      await t.step("re-applying the same schema migrates nothing", async () => {
        const again = await withManager(pool, manager => manager.applySchema(INDEXES));
        assert(again.ok, again.ok ? "" : again.error.message);
        assertEquals(again.value.length, 0);
      });

      await t.step("a changed expression drops the old index and creates the new one; rollback restores it", async () => {
        await apply(pool, INDEXES.replace("index on (str_lower(.email));", "index on (str_upper(.email));"));
        let indexes = await indexDefinitions(pool, "ix_user");
        assertStringIncludes(indexes.get("idx_ix_user_str_upper_email") ?? "", "(upper(email))");
        assert(!indexes.has("idx_ix_user_str_lower_email"));

        const rolledBack = await withManager(pool, manager => manager.rollbackLastMigration());
        assert(rolledBack.ok, rolledBack.ok ? "" : rolledBack.error.message);
        indexes = await indexDefinitions(pool, "ix_user");
        assertStringIncludes(indexes.get("idx_ix_user_str_lower_email") ?? "", "(lower(email))");
        assert(!indexes.has("idx_ix_user_str_upper_email"));
      });

      await t.step("a missing expression index is recreated by the index backfill", async () => {
        await pool.query("DROP INDEX idx_ix_user_str_lower_email");
        await apply(pool, INDEXES);
        assert((await indexDefinitions(pool, "ix_user")).has("idx_ix_user_str_lower_email"));
      });

      await t.step("an expression that isn't immutable or reads a set is a schema error", async () => {
        for (const on of ["datetime_current()", "random()", "count(.email)"]) {
          const message = await applyError(pool, INDEXES.replace("index on (str_lower(.email));", `index on (${on});`));
          assertStringIncludes(message, "index on");
        }
        assertStringIncludes(
          await applyError(pool, INDEXES.replace("index on (str_lower(.email));", "index on (random());")),
          "index expressions must be immutable"
        );
      });
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: SDL `function`s, called from queries, shapes, filters, order
 * bys and computeds. A call is inlined (compiler/declared-functions.ts), so
 * migrating creates nothing in PostgreSQL and a change of a body takes effect
 * with the schema.
 *
 * Expected values are Gel 7.1's for the same schema and data.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const RUN_PG = canRunPgTests();

const FUNCTIONS = `
  function full_name(first: str, last: str) -> str using (first ++ ' ' ++ last);
  function adult(u: DfUser) -> optional bool using (u.age >= 18);
  function top_posts(n: int64) -> set of DfPost using (select DfPost order by .score desc limit n);
  function greet(name: optional str = 'world') -> str using ('hi ' ++ (name ?? 'x'));
  function dbl(x: int64) -> int64 using (x * 2);
  function dbl(x: str) -> str using (x ++ x);
  function quad(x: int64) -> int64 using (dbl(dbl(x)));
  function joined(a: str, named only sep: str = ',', named only b: str = 'B') -> str using (a ++ sep ++ b);
  function posts_by(u: DfUser) -> set of DfPost using (select DfPost filter .author = u);
  function titled(t: str) -> set of DfPost using (select DfPost filter .title = t);
  function mkpost(t: str) -> DfPost { volatility := 'Modifying'; using (insert DfPost { title := t }); };
`;

const SDL = `module default {
  type DfUser {
    required name: str;
    age: int64;
    label := full_name(.name, 'X');
    grown := adult(DfUser);
    top := top_posts(1);
    greeting: str { default := greet(); };
  }
  type DfPost {
    required title: str;
    score: int64;
    author: DfUser;
  }
  ${FUNCTIONS}
}`;

const TABLES = ["df_post", "df_user"];
const AL = "00000000-0000-7000-8000-0000000000d1";
const BO = "00000000-0000-7000-8000-0000000000d2";

type Pool = ReturnType<typeof makePool>;

async function dropAll(pool: Pool): Promise<void> {
  for (const t of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/*** Migrate, then: Al (30) and Bo (10); posts p1 (5, by Al), p2 (9, by Al), p3 (1). ***/
async function setup(pool: Pool): Promise<SchemaManager> {
  await dropAll(pool);
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  const applied = await manager.applySchema(SDL);
  assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
  await pool.query(`INSERT INTO df_user (id, name, age) VALUES ('${AL}', 'Al', 30), ('${BO}', 'Bo', 10)`);
  await pool.query(`INSERT INTO df_post (title, score, author_id) VALUES ('p1', 5, '${AL}'), ('p2', 9, '${AL}'), ('p3', 1, NULL)`);
  return manager;
}

/*** The query's results: each row's one column (an object's JSON, or a value). ***/
async function run(pool: Pool, schema: Schema, query: string, args: Record<string, unknown> = {}): Promise<unknown[]> {
  const ast = new EdgeQLParser(query).parse();
  const names = Object.keys(args);
  const compiled = new EdgeQLCompiler(schema, { enableAccessControl: false }).compile(ast, {
    parameterMap: new Map(names.map((name, index) => [name, index + 1]))
  });
  if (!compiled.ok) {
    throw compiled.error;
  }
  const res = await pool.query(new SQLCodeGenerator().generate(compiled.value), names.map(name => args[name]));
  // An int64 comes back as a number or a bigint depending on how it was computed.
  return res.rows.map(row => Object.values(row as Record<string, unknown>)[0]).map(value => typeof value === "bigint" ? Number(value) : value);
}

function pgTest(name: string, fn: (pool: Pool, schema: Schema, manager: SchemaManager) => Promise<void>): void {
  Deno.test({
    name: `PG declared functions: ${name}`,
    ignore: !RUN_PG,
    fn: async () => {
      const pool = makePool(await getTestDsn());
      await pool.initialize();
      try {
        const manager = await setup(pool);
        try {
          await fn(pool, manager.getSchema()!, manager);
        } finally {
          await manager.close();
        }
      } finally {
        await dropAll(pool);
        await pool.close();
      }
    }
  });
}

pgTest("scalar calls: positional, named-only and default arguments, overloads, nesting", async (pool, schema) => {
  assertEquals(await run(pool, schema, "select full_name('a', 'b')"), ["a b"]);
  assertEquals(await run(pool, schema, "select greet()"), ["hi world"]);
  assertEquals(await run(pool, schema, "select greet(<str>{})"), ["hi x"]);
  assertEquals(await run(pool, schema, "select greet('z')"), ["hi z"]);
  assertEquals(await run(pool, schema, "select joined('a')"), ["a,B"]);
  assertEquals(await run(pool, schema, "select joined('a', sep := '-')"), ["a-B"]);
  assertEquals(await run(pool, schema, "select joined('a', b := 'Q', sep := '+')"), ["a+Q"]);
  assertEquals(await run(pool, schema, "select dbl(3)"), [6]);
  assertEquals(await run(pool, schema, "select dbl('ab')"), ["abab"]);
  assertEquals(await run(pool, schema, "select dbl(<int16>3)"), [6]);
  assertEquals(await run(pool, schema, "select quad(3)"), [12]);
  assertEquals(await run(pool, schema, "select 1 + dbl(2) * 3"), [13]);
});

pgTest("an argument is a query parameter, and an empty one empties the call", async (pool, schema) => {
  assertEquals(await run(pool, schema, "select full_name(<str>$f, 'z')", { f: "x" }), ["x z"]);
  assertEquals(await run(pool, schema, "select full_name(<str>{}, 'b')"), []);
});

pgTest("a call over a set is one call per element", async (pool, schema) => {
  assertEquals(await run(pool, schema, "select full_name({'a', 'c'}, 'b')"), ["a b", "c b"]);
  assertEquals(await run(pool, schema, "select dbl({1, 2, 3})"), [2, 4, 6]);
  assertEquals(await run(pool, schema, "select sum(dbl({1, 2, 3}))"), [12]);
});

pgTest("in shapes, filters and order bys, with an object argument", async (pool, schema) => {
  assertEquals(await run(pool, schema, "select DfUser { name, a := adult(DfUser) } order by .name"), [
    { a: true, name: "Al" },
    { a: false, name: "Bo" }
  ]);
  assertEquals(await run(pool, schema, "select DfUser { name } filter adult(DfUser) order by .name"), [{ name: "Al" }]);
  assertEquals(await run(pool, schema, "select DfUser { name } order by full_name(.name, 'x') desc"), [{ name: "Bo" }, { name: "Al" }]);
  assertEquals(await run(pool, schema, "select DfUser { n := full_name(.name, .name) } filter full_name(.name, 'q') = 'Al q'"), [{ n: "Al Al" }]);
  assertEquals(await run(pool, schema, "with u := (select DfUser filter .name = 'Al') select adult(u)"), [true]);
});

pgTest("one returning objects takes a shape and is counted", async (pool, schema) => {
  assertEquals(await run(pool, schema, "select top_posts(2) { title }"), [{ title: "p2" }, { title: "p1" }]);
  assertEquals(await run(pool, schema, "select count(top_posts(2))"), [2]);
  assertEquals(await run(pool, schema, "select DfUser { name, n := count(posts_by(DfUser)) } order by .name"), [
    { n: 2, name: "Al" },
    { n: 0, name: "Bo" }
  ]);
});

pgTest("an argument read inside the body's own select is the caller's", async (pool, schema) => {
  await pool.query(`INSERT INTO df_post (title, score) VALUES ('Al', 0)`);
  assertEquals(await run(pool, schema, "select DfUser { name, n := count(titled(.name)) } order by .name"), [
    { n: 1, name: "Al" },
    { n: 0, name: "Bo" }
  ]);
  assertEquals(await run(pool, schema, "select DfUser { name, ps := titled(.name) { score } } order by .name"), [
    { name: "Al", ps: [{ score: 0 }] },
    { name: "Bo", ps: [] }
  ]);
});

pgTest("computeds calling them: a value, an object argument, a link", async (pool, schema) => {
  assertEquals(await run(pool, schema, "select DfUser { name, label, grown, top: { title } } order by .name"), [
    { grown: true, label: "Al X", name: "Al", top: [{ title: "p2" }] },
    { grown: false, label: "Bo X", name: "Bo", top: [{ title: "p2" }] }
  ]);
});

pgTest("a property's default calling one", async (pool, schema) => {
  assertEquals(await run(pool, schema, "select DfUser { greeting } order by .name"), [{ greeting: "hi world" }, { greeting: "hi world" }]);
});

pgTest("a modifying function inserts", async (pool, schema) => {
  assertEquals(await run(pool, schema, "select mkpost('new') { title }"), [{ title: "new" }]);
  assertEquals((await pool.query("SELECT count(*)::int AS n FROM df_post WHERE title = 'new'")).rows, [{ n: 1 }]);
});

pgTest("a migration changing only a function creates nothing, and the new body is what calls run", async (pool, _schema, manager) => {
  const changed = await manager.applySchema(SDL.replace("(x * 2)", "(x * 3)"));
  assertEquals(changed.ok, true, changed.ok ? "" : changed.error.message);
  assertEquals(await run(pool, manager.getSchema()!, "select dbl(3)"), [9]);
  // Nothing of it is in PostgreSQL.
  assertEquals((await pool.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('dbl', 'full_name', 'top_posts')")).rows, [{ n: 0 }]);
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: sets where SQL has one value (see
 * `compiler/set-semantics.test.ts` for the compiled SQL).
 *
 * - `with a := (select <scalars>) select a filter … order by …`
 * - `for u in T union <optional value>`: no element for an empty value
 * - element-wise functions over set arguments, and aggregates over them
 * - `select x := expr filter … order by …`
 * - operators and casts over sets (`{1, 2} + {10, 20}`, `User.name ++ '!'`),
 *   selected, as shape elements, as for bodies and in filters
 *
 * - comparisons of multi paths: one boolean per element selected, as shape
 *   elements and function arguments; any element in a filter
 *
 * Seed: users ann (visits 3, nicks {a1, a2}, tags [x, y], best Hello, posts
 * {Hello, World}) and bob (nothing optional set); post Hello has tags {t1},
 * World {t1, t2}.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { unwrapExactNumbers } from "../lib/exact-json.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import type * as ServerTypes from "../server/types.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";

const SDL = `module default {
  type SetTag {
    required name: str;
  };
  type SetPost {
    required title: str;
    multi tags: SetTag;
  };
  type SetUser {
    required name: str;
    visits: int64;
    tags: array<str>;
    multi nicks: str;
    best: SetPost;
    multi posts: SetPost;
  };
};`;

type Run = (query: string, variables?: Record<string, unknown>) => Promise<unknown[]>;

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `set_semantics_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

/*** Run `fn` against the seeded schema: `run` returns a query's data, `values` each row's one column, sorted (a set has no order). ***/
async function withHandler(fn: (run: Run, values: Run) => Promise<void>): Promise<void> {
  const dsn = await getTestDsn();
  const pool: ConnectionPool = makePool(dsn);
  await pool.initialize();

  try {
    await resetTestDatabase(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
    const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
    await manager.close();

    const run: Run = async (query, variables) => {
      const response = await handler.handleRequest({ query, variables }, makeContext());
      assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
      return unwrapExactNumbers(response.data) as unknown[];
    };
    const values: Run = async (query, variables) =>
      ((await run(query, variables)) as Record<string, unknown>[])
        .map(row => JSON.stringify(Object.values(row)[0]))
        .sort()
        .map(value => JSON.parse(value));

    await run("insert SetTag { name := 't1' }");
    await run("insert SetTag { name := 't2' }");
    await run("insert SetPost { title := 'Hello', tags := (select SetTag filter .name = 't1') }");
    await run("insert SetPost { title := 'World', tags := (select SetTag) }");
    await run(
      "insert SetUser { name := 'ann', visits := 3, tags := ['x', 'y'], nicks := {'a1', 'a2'}, " +
        "best := (select SetPost filter .title = 'Hello' limit 1), posts := (select SetPost) }"
    );
    await run("insert SetUser { name := 'bob' }");

    await fn(run, values);
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG with binding of a select of scalars: filter and order by the current element",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (run, values) => {
      const x = { x: [3, 1, 2] };
      assertEquals(await values("with a := (select array_unpack(<array<int64>>$x)) select a filter a > 1", x), [2, 3]);
      assertEquals(
        (await run("with a := (select array_unpack(<array<int64>>$x)) select a order by a desc", x)).map(row => Object.values(row as object)[0]),
        [3, 2, 1]
      );
      assertEquals(await values("with a := (select SetUser.name) select a filter a != 'ann'"), ["bob"]);
      // A path from a type binds its set, parenthesised or not.
      assertEquals(await values("with n := SetUser.name select n filter n != 'ann'"), ["bob"]);
      assertEquals(await run("with p := SetUser.posts select p { title } order by p.title desc"), [{ title: "World" }, { title: "Hello" }]);
      assertEquals(await values("with n := SetUser.name select str_upper(n)"), ["ANN", "BOB"]);
    });
  }
});

Deno.test({
  name: "PG for over objects: an empty optional value adds no element",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (_run, values) => {
      assertEquals(await values("for u in SetUser union u.visits"), [3]);
      assertEquals(await values("for u in SetUser union (select u.visits)"), [3]);
      assertEquals(await values("for u in SetUser union (u.visits + 1)"), [4]);
      assertEquals(await values("for u in SetUser union u.best.title"), ["Hello"]);
      assertEquals((await values("for u in SetUser union u.best")).length, 1);
      assertEquals(await values("for u in SetUser union u.nicks"), ["a1", "a2"]);
      assertEquals(await values("for u in SetUser union (select u.nicks)"), ["a1", "a2"]);
      // An array property is one value: the array.
      assertEquals(await values("for u in SetUser union u.tags"), [["x", "y"]]);
      assertEquals(await values("for u in SetUser union len(u.tags)"), [2]);
      assertEquals(await values("for u in SetUser union str_upper(u.nicks)"), ["A1", "A2"]);
    });
  }
});

Deno.test({
  name: "PG element-wise functions over a type's path apply to each value; aggregates aggregate the set",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (run, values) => {
      assertEquals(await values("select str_upper(SetUser.name)"), ["ANN", "BOB"]);
      assertEquals(await values("select len(SetUser.name)"), [3, 3]);
      assertEquals(await values("select len(SetUser.tags)"), [2]);
      assertEquals(await values("select count(SetUser.posts.title)"), [2]);
      assertEquals((await values("select array_agg(SetUser.name)")).map(names => (names as string[]).sort()), [["ann", "bob"]]);
      assertEquals(await values("select count(str_upper(SetUser.name))"), [2]);
      assertEquals(await values("select str_upper(SetUser.nicks)"), ["A1", "A2"]);
      assertEquals(
        await run("select SetUser { name, up := str_upper(.posts.title) } order by .name"),
        [{ name: "ann", up: ["HELLO", "WORLD"] }, { name: "bob", up: [] }]
      );
    });
  }
});

Deno.test({
  name: "PG element-wise functions over set literals: one element each, set arguments crossed",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (_run, values) => {
      assertEquals(await values("select str_upper({'a', 'b'})"), ["A", "B"]);
      assertEquals(await values("select str_repeat({'a', 'b'}, {1, 2})"), ["a", "aa", "b", "bb"]);
      assertEquals(await values("select count(str_upper({'a', 'b'}))"), [2]);
      assertEquals(await values("select str_upper(str_trim({' a', 'b '}))"), ["A", "B"]);
      // An array result is one element, not flattened.
      assertEquals(await values("select str_split({'a,b', 'c'}, ',')"), [["a", "b"], ["c"]]);
      assertEquals(await values("select str_upper(array_unpack(<array<str>>$x))", { x: ["p", "q"] }), ["P", "Q"]);
    });
  }
});

Deno.test({
  name: "PG named select: the name is the current element in the filter and order by",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (run, values) => {
      assertEquals(await run("select u := SetUser { name } filter u.name = 'ann'"), [{ name: "ann" }]);
      assertEquals(await run("select u := SetUser { name } order by u.name desc"), [{ name: "bob" }, { name: "ann" }]);
      assertEquals(await values("select n := 1 + 1"), [2]);
      assertEquals(await values("select a := array_unpack(<array<int64>>$x) filter a > 1", { x: [3, 1, 2] }), [2, 3]);
      assertEquals(await values("with k := 1 select n := k + 1"), [2]);
    });
  }
});

Deno.test({
  name: "PG operators over sets: applied to each element, set operands crossed",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (run, values) => {
      assertEquals(await values("select {1, 2} + 1"), [2, 3]);
      // Gel's order: the left operand outermost.
      assertEquals((await run("select {1, 2} + {10, 20}")).map(row => Object.values(row as object)[0]), [11, 21, 12, 22]);
      assertEquals(await values("select 'a' ++ {'x', 'y'}"), ["ax", "ay"]);
      assertEquals(await values("select SetUser.name ++ '!'"), ["ann!", "bob!"]);
      assertEquals(await values("select {1, 2} = 1"), [false, true]);
      assertEquals(await values("select not {true, false}"), [false, true]);
      assertEquals(await values("select -{1, 2}"), [-1, -2]);
      assertEquals(await values("select <str>{1, 2}"), ["1", "2"]);
      assertEquals(await values("select {1, 2} in {1}"), [false, true]);
      assertEquals(await values("select {1, 2} + <int64>{}"), []);
      assertEquals(await values("select ({1, 2} + 1) * {1, 10}"), [2, 20, 3, 30]);
      assertEquals(await values("select str_upper({'a', 'b'} ++ '!')"), ["A!", "B!"]);
      assertEquals(await values("select str_upper({'a', 'b'}) ++ '!'"), ["A!", "B!"]);
      assertEquals(await values("select count({1, 2} + {10, 20})"), [4]);
      // `/` of ints is float64 division, per element (float64 answers as text here, as `select 7 / 2` does).
      assertEquals((await values("select {7, 8} / 2")).map(Number), [3.5, 4]);
      assertEquals(await values("for x in {1, 2} union x + {10, 20}"), [11, 12, 21, 22]);
      assertEquals(await values("for u in SetUser union u.name ++ {'1', '2'}"), ["ann1", "ann2", "bob1", "bob2"]);
    });
  }
});

Deno.test({
  name: "PG set-valued computed shape elements are arrays",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async run => {
      assertEquals(
        await run("select SetUser { name, x := {1, 2}, y := {.name, 'z'}, z := .name ++ {'a', 'b'} } order by .name"),
        [
          { name: "ann", x: [1, 2], y: ["ann", "z"], z: ["anna", "annb"] },
          { name: "bob", x: [1, 2], y: ["bob", "z"], z: ["boba", "bobb"] }
        ]
      );
      assertEquals(
        await run("select SetUser { name, n := .nicks ++ '!', v := .visits + {1, 2}, w := .visits ?= {3, 4} } order by .name"),
        [{ n: ["a1!", "a2!"], name: "ann", v: [4, 5], w: [true, false] }, { n: [], name: "bob", v: [], w: [false, false] }]
      );
      assertEquals(await run("select SetUser { name, c := count(.nicks ++ '!') } order by .name"), [{ c: 2, name: "ann" }, { c: 0, name: "bob" }]);
    });
  }
});

Deno.test({
  name: "PG filter over a set keeps an object when any element is true",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async run => {
      const names = async (filter: string): Promise<unknown[]> =>
        ((await run(`select SetUser { name } filter ${filter} order by .name`)) as { name: string; }[]).map(user => user.name);
      assertEquals(await names("{3, 4} = .visits"), ["ann"]);
      // 4 != 3: some element is true.
      assertEquals(await names("{3, 4} != .visits"), ["ann"]);
      assertEquals(await names(".visits = {5, 6}"), []);
      assertEquals(await names(".name ++ {'x', 'y'} = 'bobx'"), ["bob"]);
      assertEquals(await names("not {true, false}"), ["ann", "bob"]);
      assertEquals(await names(".name = 'bob' and {3, 4} = .visits"), []);
      assertEquals(await names(".name = 'ann' and {3, 4} = .visits"), ["ann"]);
      // An empty operand has no elements, so none is true (SQL's `NULL or true` is true).
      assertEquals(await names(".visits = 1 or {true, false}"), ["ann"]);
      // A mutation's filter too.
      await run("update SetUser filter .name ++ {'x', 'y'} = 'boby' set { visits := 7 }");
      assertEquals(await names(".visits = 7"), ["bob"]);
    });
  }
});

Deno.test({
  name: "PG comparisons of multi paths: one boolean per element (Gel), any element in a filter",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async (run, values) => {
      /*** Each row's `b`, sorted (a set has no order). ***/
      const elements = async (query: string): Promise<unknown[]> => ((await run(query)) as { b: boolean[]; }[]).map(row => [...row.b].sort());
      assertEquals(await elements("select SetUser { b := .nicks = 'a1' } order by .name"), [[false, true], []]);
      assertEquals(await elements("select SetUser { b := 'a1' = .nicks } order by .name"), [[false, true], []]);
      assertEquals(await elements("select SetUser { b := .nicks in {'a1'} } order by .name"), [[false, true], []]);
      assertEquals(await elements("select SetUser { b := .posts.title = 'Hello' } order by .name"), [[false, true], []]);
      // A path's objects are distinct: t1, the tag of both posts, is one element.
      assertEquals(await elements("select SetUser { b := .posts.tags.name = 't2' } order by .name"), [[false, true], []]);
      assertEquals(await elements("select SetPost { b := .<posts[is SetUser].name = 'ann' } order by .title"), [[true], [true]]);
      assertEquals(await elements("select SetUser { b := (select .nicks = 'a1') } order by .name"), [[false, true], []]);
      // `in` a multi path is one boolean.
      assertEquals(await run("select SetUser { b := 'a1' in .nicks } order by .name"), [{ b: true }, { b: false }]);
      assertEquals(await run("select SetUser { c := count(.nicks = 'a1') } order by .name"), [{ c: 2 }, { c: 0 }]);
      assertEquals(await values("select SetUser.nicks = 'a1'"), [false, true]);
      assertEquals(await values("for u in SetUser union (u.posts.title = 'World')"), [false, true]);

      const names = async (filter: string): Promise<unknown[]> =>
        ((await run(`select SetUser { name } filter ${filter} order by .name`)) as { name: string; }[]).map(user => user.name);
      assertEquals(await names(".nicks = 'a1'"), ["ann"]);
      assertEquals(await names(".posts.title = 'World' and .nicks = 'a2'"), ["ann"]);
      assertEquals(await names(".posts.tags.name = 't2'"), ["ann"]);
      // Independent comparisons of one multi path (simple scoping): a nick of each.
      assertEquals(await names(".nicks = 'a1' and .nicks = 'a2'"), ["ann"]);

      // Under `not` and `or`, one boolean per element (Gel): `not` holds when some element does not match.
      assertEquals(await names("not (.nicks = 'a1')"), ["ann"]);
      assertEquals(await names("not (.nicks = 'zz')"), ["ann"]);
      assertEquals(await names("not (.posts.title = 'Hello')"), ["ann"]);
      assertEquals(await names("not (.posts.tags.name = 't1')"), ["ann"]);
      assertEquals(await names("not (.nicks = 'a1' and .nicks = 'a2')"), ["ann"]);
      assertEquals(await names(".nicks = 'a1' or .nicks = 'zz'"), ["ann"]);
      // bob has no posts: the `or` has no element to be true.
      assertEquals(await names(".posts.title = 'Nope' or .name = 'bob'"), []);

      // `any(…)` is one boolean: false for no element, and `not any(…)` is "none matches".
      assertEquals(await names("not any(.nicks = 'a1')"), ["bob"]);
      assertEquals(await names("not any(.posts.title = 'Hello')"), ["bob"]);
      assertEquals(await names("not any(.posts.tags.name = 't2')"), ["bob"]);
      assertEquals(await names("any(.posts.title = 'Nope') or .name = 'bob'"), ["bob"]);
      assertEquals(await run("select SetUser { b := any(.nicks = 'a1') } order by .name"), [{ b: true }, { b: false }]);
      // Of any other set of booleans too, as through a single link then a multi link.
      assertEquals(await names("any(.best.tags.name = 't1')"), ["ann"]);
      assertEquals(await names("not any(.best.tags.name = 't1')"), ["bob"]);
      assertEquals(await names("not any(.best.tags.name = 't2')"), ["ann", "bob"]);
      assertEquals(await names("any(.best.tags.name = 't2') or .name = 'bob'"), ["bob"]);
      assertEquals(await run("select SetUser { b := any(.best.tags.name = 't1') } order by .name"), [{ b: true }, { b: false }]);
      // `all(…)`: true for no element.
      assertEquals(await run("select SetUser { b := all(.nicks = 'a1') } order by .name"), [{ b: false }, { b: true }]);
      assertEquals(await names("all(.posts.tags.name = 't1')"), ["bob"]);

      // A mutation's filter too.
      await run("update SetUser filter not (.nicks = 'a1') set { visits := 9 }");
      assertEquals(await names(".visits = 9"), ["ann"]);
    });
  }
});

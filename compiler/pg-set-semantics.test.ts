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
 *
 * Seed: users ann (visits 3, nicks {a1, a2}, tags [x, y], best Hello, posts
 * {Hello, World}) and bob (nothing optional set).
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
  type SetPost {
    required title: str;
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

    await run("insert SetPost { title := 'Hello' }");
    await run("insert SetPost { title := 'World' }");
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

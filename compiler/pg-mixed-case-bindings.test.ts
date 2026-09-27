/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `with` bindings, `for` variables, named selects and
 * mutation bindings whose names have capital letters (see
 * `compiler/mixed-case-bindings.test.ts` for the compiled SQL). Each used to
 * fail: a capitalised name as "Type 'Foo' not found", a camelCase one as
 * "missing FROM-clause entry for table \"myRows_11\"" or a missing relation
 * (the CTE declared unquoted, read quoted).
 *
 * Seed: posts Hello, World; users ann (visits 3, posts {Hello, World}) and
 * bob.
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
  type McPost {
    required title: str;
  };
  type McUser {
    required name: str;
    visits: int64;
    multi posts: McPost;
  };
};`;

type Run = (query: string) => Promise<unknown>;

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `mixed_case_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

async function withHandler(fn: (run: Run) => Promise<void>): Promise<void> {
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

    const run: Run = async query => {
      const response = await handler.handleRequest({ query }, makeContext());
      assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
      return unwrapExactNumbers(response.data);
    };
    await run("insert McPost { title := 'Hello' }");
    await run("insert McPost { title := 'World' }");
    await run("insert McUser { name := 'ann', visits := 3, posts := (select McPost) }");
    await run("insert McUser { name := 'bob' }");

    await fn(run);
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG mixed-case with bindings, for variables and named selects",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async run => {
      assertEquals(await run("with Foo := (select McUser filter .name = 'ann') select Foo { name }"), [{ name: "ann" }]);
      assertEquals(await run("with myRows := McUser select myRows { name, n := count(.posts) } order by .name"), [
        { n: 2, name: "ann" },
        { n: 0, name: "bob" }
      ]);
      assertEquals(await run("with myRows := (select McUser) select myRows { name } filter .visits > 1"), [{ name: "ann" }]);
      assertEquals(await run("with Mine := (select McUser filter .name = 'ann') select Mine { name, posts: { title } order by .title }"), [
        { name: "ann", posts: [{ title: "Hello" }, { title: "World" }] }
      ]);
      assertEquals(await run("with Mine := (select McUser filter .name = 'ann') select count(Mine)"), [{ count: 1 }]);
      assertEquals(await run("with P := (select McPost filter .title = 'Hello') select McUser { name } filter P in .posts"), [{ name: "ann" }]);
      assertEquals(await run("with myVals := {1, 2, 3} select myVals filter myVals > 1 order by myVals"), [{ value: 2 }, { value: 3 }]);

      const perUser = (await run("for myUser in McUser union (select myUser { name, n := count(myUser.posts) })")) as { n: number; name: string; }[];
      assertEquals(perUser.sort((a, b) => a.name.localeCompare(b.name)), [{ n: 2, name: "ann" }, { n: 0, name: "bob" }]);
      assertEquals(((await run("for Xs in {1, 2} union (Xs + 1)")) as Record<string, number>[]).map(row => Object.values(row)[0]).sort(), [2, 3]);
      assertEquals(await run("select myUser := McUser { name } filter myUser.name = 'ann'"), [{ name: "ann" }]);
      assertEquals(await run("select Mine := McUser.name filter Mine = 'bob'"), [{ value: "bob" }]);
    });
  }
});

Deno.test({
  name: "PG mixed-case mutation bindings: insert, update and delete results, and a for over a capitalised variable",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async run => {
      assertEquals(await run("with NewPost := (insert McPost { title := 'New' }) select NewPost { title }"), [{ title: "New" }]);
      assertEquals(await run("with myUpdate := (update McUser filter .name = 'bob' set { visits := 1 }) select myUpdate { name, visits }"), [
        { name: "bob", visits: 1 }
      ]);
      assertEquals(await run("with Gone := (delete McPost filter .title = 'New') select Gone { title }"), [{ title: "New" }]);
      assertEquals(await run("with Mine := (select McUser filter .name = 'ann') update McUser filter .id = Mine.id set { visits := 4 }"), {
        id: ((await run("select McUser { id } filter .name = 'ann'")) as { id: string; }[])[0].id,
        name: "ann",
        visits: 4
      });
      await run("for Each in McUser union (update Each set { visits := 7 })");
      assertEquals(await run("select McUser { name, visits } order by .name"), [{ name: "ann", visits: 7 }, { name: "bob", visits: 7 }]);
    });
  }
});

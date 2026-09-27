/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: `group` through the HTTP handler, returning Gel 7.1's free
 * objects `{ key, grouping, elements }`: `key` holds the value of each `by`
 * key (by its name), `grouping` the names of the keys in `by` order, and
 * `elements` the group's objects in the shape given (all stored properties
 * without one, as `select` of a type gives them).
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type GroupRow {
    required name: str;
    k: str;
  };
};`;

interface Group {
  elements: Record<string, unknown>[];
  grouping: string[];
  key: Record<string, unknown>;
}

function makeContext(): Types.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `group_query_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

/*** Migrate SDL, insert a, b (k "x") and c (k "y"), hand `body` the groups a query returns, then drop the tables. ***/
async function withGroups(body: (group: (query: string) => Promise<Group[]>) => Promise<void>): Promise<void> {
  const dsn = await getTestDsn();
  const pool = makePool(dsn);
  await pool.initialize();
  const manager = new SchemaManager({ pool });
  await manager.initialize();
  try {
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, JSON.stringify(applied));
    const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema: manager.getSchema()! });
    const run = async (query: string): Promise<unknown> => {
      const res = await handler.handleRequest({ query }, makeContext());
      assertEquals(res.errors, undefined, `${query}: ${JSON.stringify(res.errors)}`);
      return res.data;
    };
    try {
      await run(`insert GroupRow { name := "a", k := "x" }`);
      await run(`insert GroupRow { name := "b", k := "x" }`);
      await run(`insert GroupRow { name := "c", k := "y" }`);
      await body(async query => {
        const groups = await run(query) as Group[];
        // Groups, and a group's elements, come in no set order.
        for (const group of groups) {
          group.elements.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        }
        return groups.sort((a, b) => JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)));
      });
    } finally {
      await handler.close();
    }
  } finally {
    await pool.query("DROP TABLE IF EXISTS group_row CASCADE");
    await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
    await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
    await pool.close();
  }
}

Deno.test({
  name: "PG group: `group T by .k` returns Gel's key, grouping and elements",
  ignore: !RUN_PG,
  fn: async () => {
    await withGroups(async group => {
      const groups = await group(`group GroupRow by .k`);
      assertEquals(groups.map(({ grouping, key }) => ({ grouping, key })), [
        { grouping: ["k"], key: { k: "x" } },
        { grouping: ["k"], key: { k: "y" } }
      ]);
      assertEquals(groups[0].elements.map(element => element.name), ["a", "b"]);
      assertEquals(Object.keys(groups[1].elements[0]).sort(), ["id", "k", "name"]);
    });
  }
});

Deno.test({
  name: "PG group: a shape is the elements' shape",
  ignore: !RUN_PG,
  fn: async () => {
    await withGroups(async group => {
      assertEquals(await group(`group GroupRow { name } by .k`), [
        { elements: [{ name: "a" }, { name: "b" }], grouping: ["k"], key: { k: "x" } },
        { elements: [{ name: "c" }], grouping: ["k"], key: { k: "y" } }
      ]);
    });
  }
});

Deno.test({
  name: "PG group: `using` binds keys by name; `grouping` lists the keys in `by` order",
  ignore: !RUN_PG,
  fn: async () => {
    await withGroups(async group => {
      assertEquals(await group(`group GroupRow { name } using kk := .k ++ "!" by kk`), [
        { elements: [{ name: "a" }, { name: "b" }], grouping: ["kk"], key: { kk: "x!" } },
        { elements: [{ name: "c" }], grouping: ["kk"], key: { kk: "y!" } }
      ]);
      assertEquals(await group(`group GroupRow { name } using n := len(.name) by n, .k`), [
        { elements: [{ name: "a" }, { name: "b" }], grouping: ["n", "k"], key: { k: "x", n: 1 } },
        { elements: [{ name: "c" }], grouping: ["n", "k"], key: { k: "y", n: 1 } }
      ]);
    });
  }
});

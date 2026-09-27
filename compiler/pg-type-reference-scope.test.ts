/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: type references and Gel's path scoping (see
 * `compiler/type-reference-scope.test.ts` for the compiled SQL).
 *
 * - Another type in a shape or filter is all of its objects:
 *   `select ScopeOrder { n := count(ScopeItem) }` counts every item.
 * - The subject of a select, update or delete is bound in its filter, order
 *   by and shape: `select ScopeItem.name filter ScopeItem.id in …` keeps the
 *   matching items, `update ScopeItem filter ScopeItem.name = 'a'` updates
 *   one item.
 * - A select of a path through links binds the path; naming its start there
 *   is Gel's "changes the interpretation" error.
 * - A computed select of several objects is an array.
 * - `in` a type's objects or a path's set, and multi-step paths from `with`
 *   bindings, `for` variables and mutation results in filters.
 *
 * Seed: items a (price 1), b (2), c (4); order o1 with items {a, b}, order
 * o2 with none.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { unwrapExactNumbers } from "../lib/exact-json.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import type * as ServerTypes from "../server/types.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";

const SDL = `module default {
  type ScopeItem {
    required name: str;
    price: int64;
  };
  type ScopeOrder {
    required code: str;
    multi items: ScopeItem;
  };
};`;

type Run = (query: string, variables?: Record<string, unknown>) => Promise<unknown>;

interface Handler {
  /** The query's error message. */
  fail: (query: string) => Promise<string>;
  /** The query's data. */
  run: Run;
  /** Each row's one column, sorted (a set has no order). */
  values: (query: string, variables?: Record<string, unknown>) => Promise<unknown[]>;
}

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `type_reference_scope_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

async function withHandler(fn: (handler: Handler) => Promise<void>): Promise<void> {
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
      return unwrapExactNumbers(response.data);
    };
    const fail = async (query: string): Promise<string> => {
      const response = await handler.handleRequest({ query }, makeContext());
      assertEquals(response.errors !== undefined, true, `${query} should fail`);
      return response.errors!.map(error => error.message).join("; ");
    };
    const values = async (query: string, variables?: Record<string, unknown>): Promise<unknown[]> =>
      ((await run(query, variables)) as Record<string, unknown>[])
        .map(row => JSON.stringify(Object.values(row)[0]))
        .sort()
        .map(value => JSON.parse(value));

    await run("insert ScopeItem { name := 'a', price := 1 }");
    await run("insert ScopeItem { name := 'b', price := 2 }");
    await run("insert ScopeItem { name := 'c', price := 4 }");
    await run("insert ScopeOrder { code := 'o1', items := (select ScopeItem filter .name in {'a', 'b'}) }");
    await run("insert ScopeOrder { code := 'o2' }");

    await fn({ fail, run, values });
  } finally {
    await resetTestDatabase(pool);
    await pool.close();
  }
}

Deno.test({
  name: "PG another type in a shape or a filter is all of its objects",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async ({ run, values }) => {
      // One order selected: `count(ScopeItem)` counted that one row (1).
      assertEquals(await run("select ScopeOrder { n := count(ScopeItem) } filter .code = 'o1'"), [{ n: 3 }]);
      // Two orders: `COUNT(*)` next to a column failed (GROUP BY).
      assertEquals(await run("select ScopeOrder { code, n := count(ScopeItem) } order by .code"), [{ code: "o1", n: 3 }, { code: "o2", n: 3 }]);
      assertEquals(await run("select ScopeOrder { code, s := sum(ScopeItem.price), e := exists ScopeItem } filter .code = 'o2'"), [{
        code: "o2",
        e: true,
        s: 7
      }]);
      // In a filter: `COUNT(*)` in WHERE failed.
      assertEquals(await run("select ScopeOrder { code } filter count(ScopeItem) = 3 order by .code"), [{ code: "o1" }, { code: "o2" }]);
      assertEquals(await values("select count(ScopeItem)"), [3]);
    });
  }
});

Deno.test({
  name: "PG a computed select of several objects is an array",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async ({ run }) => {
      const names = [{ name: "a" }, { name: "b" }, { name: "c" }];
      assertEquals(await run("select ScopeOrder { x := (select ScopeItem { name } order by .name) } filter .code = 'o1'"), [{ x: names }]);
      assertEquals(await run("select ScopeOrder { x := ScopeItem { name } order by .name } filter .code = 'o1'"), [{ x: names }]);
      assertEquals(((await run("select ScopeOrder { x := ScopeItem } filter .code = 'o1'")) as { x: unknown[]; }[])[0].x.length, 3);
      // At most one object: the object.
      assertEquals(await run("select ScopeOrder { x := (select ScopeItem { name } order by .name limit 1) } filter .code = 'o1'"), [{
        x: { name: "a" }
      }]);
    });
  }
});

Deno.test({
  name: "PG the subject named in its filter and order by is the current object",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async ({ run, values }) => {
      const items = (await run("select ScopeItem { id, name } order by .name")) as { id: string; name: string; }[];
      const ids = { a: items[0].id, c: items[2].id };
      // The filter was a test of whether any item matched: every name came back.
      assertEquals(await values("select ScopeItem.name filter ScopeItem.id in {<uuid>$a, <uuid>$c}", ids), ["a", "c"]);
      assertEquals(await values("select (select ScopeItem.name filter ScopeItem.id in {<uuid>$a, <uuid>$c})", ids), ["a", "c"]);
      assertEquals(await values("select ScopeItem.name filter ScopeItem.price > 1"), ["b", "c"]);
      assertEquals(await values("select ScopeItem { name } filter ScopeItem.name != 'a'"), ["b", "c"]);
      assertEquals(await run("select ScopeItem.name order by ScopeItem.price desc"), ["c", "b", "a"].map(name => ({ name })));
      // In the shape: `count(ScopeItem)` is the current item, `detached` all of them.
      assertEquals(await run("select ScopeItem { name, n := count(ScopeItem), m := count(detached ScopeItem) } filter .name = 'a'"), [{
        m: 3,
        n: 1,
        name: "a"
      }]);
      assertEquals(
        await run("select ScopeItem { x := (select detached ScopeItem { name } filter .name != ScopeItem.name order by .name) } filter .name = 'a'"),
        [{ x: [{ name: "b" }, { name: "c" }] }]
      );
    });
  }
});

Deno.test({
  name: "PG update and delete: the type named in the filter is the updated or deleted object",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async ({ run, values }) => {
      await run("update ScopeItem filter ScopeItem.name = 'a' set { price := ScopeItem.price + 10 }");
      assertEquals(await run("select ScopeItem { name, price } order by .name"), [
        { name: "a", price: 11 },
        { name: "b", price: 2 },
        { name: "c", price: 4 }
      ]);
      await run("delete ScopeItem filter ScopeItem.name = 'c'");
      assertEquals(await values("select ScopeItem.name"), ["a", "b"]);
    });
  }
});

Deno.test({
  name: "PG select of a path through links: the path is bound; naming its start is Gel's error",
  ignore: !canRunPgTests(),
  fn: async ({ step }) => {
    await withHandler(async ({ fail, run, values }) => {
      await step("the path in the filter, order by and shape is the current element", async () => {
        assertEquals(await values("select ScopeOrder.items.name filter ScopeOrder.items.price > 1"), ["b"]);
        assertEquals(await run("select ScopeOrder.items { name, n := ScopeOrder.items.price } order by ScopeOrder.items.name desc"), [
          { n: 2, name: "b" },
          { n: 1, name: "a" }
        ]);
      });
      await step("the start in the filter, order by or shape is an error, as in Gel", async () => {
        const message = "reference to 'ScopeOrder.code' changes the interpretation of 'ScopeOrder' elsewhere in the query";
        assertStringIncludes(await fail("select ScopeOrder.items.name filter ScopeOrder.code = 'o1'"), message);
        assertStringIncludes(await fail("select ScopeOrder.items { name } order by ScopeOrder.code"), message);
        assertStringIncludes(await fail("select ScopeOrder.items { name, c := ScopeOrder.code }"), message);
        assertStringIncludes(await fail("with o := ScopeOrder select o.items.name filter o.code = 'o1'"), "reference to 'o.code'");
      });
      await step("a backlink reaches each element's sources, detached every object", async () => {
        assertEquals(await run("select ScopeOrder.items { name, o := .<items[is ScopeOrder].code } order by .name"), [
          { name: "a", o: ["o1"] },
          { name: "b", o: ["o1"] }
        ]);
        assertEquals(await run("select ScopeOrder.items { name, c := count(detached ScopeOrder) } order by .name"), [
          { c: 2, name: "a" },
          { c: 2, name: "b" }
        ]);
        assertEquals(await values("for o in ScopeOrder union (select o.items.name filter o.code = 'o1')"), ["a", "b"]);
      });
    });
  }
});

Deno.test({
  name: "PG membership in a type's objects or a path's set",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async ({ run, values }) => {
      // A syntax error at `*` before.
      assertEquals(await values("for o in ScopeOrder union (select o.code filter o in ScopeOrder)"), ["o1", "o2"]);
      assertEquals(await run("with o := (select ScopeOrder filter .code = 'o1') select o.code filter o not in ScopeOrder"), []);
      assertEquals(await values("select ScopeItem { name } filter ScopeItem in ScopeItem"), ["a", "b", "c"]);
      assertEquals(await values("select ScopeOrder { code } filter .items.name in ScopeItem.name"), ["o1"]);
      // The bound subject is one object.
      assertEquals(await run("select ScopeOrder { code } filter ScopeOrder not in ScopeOrder"), []);
    });
  }
});

Deno.test({
  name: "PG multi-step paths from a with binding, a for variable or a mutation result in a filter",
  ignore: !canRunPgTests(),
  fn: async () => {
    await withHandler(async ({ run, values }) => {
      const o1 = "with o := (select ScopeOrder filter .code = 'o1') ";
      // Both were rejected at compile time before.
      assertEquals(await values(`${o1}select ScopeItem { name } filter .name in o.items.name`), ["a", "b"]);
      assertEquals(await values(`${o1}select ScopeItem { name } filter ScopeItem in o.items`), ["a", "b"]);
      assertEquals(await values(`${o1}select ScopeItem { name } filter .name not in o.items.name`), ["c"]);
      assertEquals(await values(`${o1}select ScopeItem { name } filter o.items.name = .name`), ["a", "b"]);
      assertEquals(await run("for o in ScopeOrder union (select o { code } filter o.items.name = 'a')"), [{ code: "o1" }]);
      assertEquals(await run("for o in ScopeOrder union (select o { code } filter 'b' in o.items.name)"), [{ code: "o1" }]);
      const m = "with m := (update ScopeOrder filter .code = 'o1' set { code := 'o1' }) ";
      assertEquals(await values(`${m}select ScopeItem { name } filter .name in m.items.name`), ["a", "b"]);
      assertEquals(await values(`${m}select ScopeItem { name } filter m.items.name = .name`), ["a", "b"]);
    });
  }
});

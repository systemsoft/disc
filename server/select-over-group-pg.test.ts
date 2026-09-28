/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: a select over a group
 * (`select (group T by …) { key: { … }, n := count(.elements) } filter … order by …`),
 * answered as Gel 7.1 answers the same queries. Each group is Gel's free
 * object: its shape reads `key`, `grouping` and `elements`, a computable
 * aggregates the group's elements (or is the set of their values), and the
 * filter and order by read the shape's computables. Also: groups of a select,
 * a `with` binding or a path, and grouping sets, cube and rollup.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDL = `
module default {
  type User {
    required name: str;
    active: bool;
    role: str;
    score: int64;
  };
  type Post {
    required title: str;
    author: User;
  };
}
`;

const SETUP = [
  "insert User { name := 'ann', active := true, role := 'admin', score := 3 }",
  "insert User { name := 'bob', active := true, role := 'dev', score := 4 }",
  "insert User { name := 'cat', active := false, role := 'dev', score := 5 }",
  "insert Post { title := 'p1', author := (select User filter .name = 'ann' limit 1) }",
  "insert Post { title := 'p2', author := (select User filter .name = 'bob' limit 1) }",
  "insert Post { title := 'p3', author := (select User filter .name = 'bob' limit 1) }"
];

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG select over a group: key, grouping, elements and aggregates of them, filtered, ordered and sliced",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 4, minConnections: 1 });
    await pool.initialize();
    await resetTestDatabase(pool);

    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);

    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 4, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, schema })
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (server as any).handleRequest(request, info)
    );

    async function post(query: string): Promise<Reply> {
      const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
        body: JSON.stringify({ query, variables: {} }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      return { body: await response.json(), status: response.status };
    }

    async function data(query: string): Promise<unknown> {
      const reply = await post(query);
      assertEquals(reply.status, 200, `${query}: ${JSON.stringify(reply.body)}`);
      assertEquals(reply.body.errors, undefined, `${query}: ${JSON.stringify(reply.body)}`);
      return reply.body.data;
    }

    try {
      for (const query of SETUP) {
        await data(query);
      }

      await t.step("the shape reads key, grouping and elements, and aggregates the elements", async () => {
        assertEquals(await data("select (group User by .role) { key: {role}, n := count(.elements) } order by .key.role"), [
          { key: { role: "admin" }, n: 1 },
          { key: { role: "dev" }, n: 2 }
        ]);
        assertEquals(
          await data("select (group User by .role) { key: {role}, total := sum(.elements.score), top := max(.elements.score) } order by .key.role"),
          [{ key: { role: "admin" }, top: 3, total: 3 }, { key: { role: "dev" }, top: 5, total: 9 }]
        );
        assertEquals(await data("select (group User by .role) { key: {role}, grouping } order by .key.role"), [
          { grouping: ["role"], key: { role: "admin" } },
          { grouping: ["role"], key: { role: "dev" } }
        ]);
        assertEquals(await data("select (group User using r := .role by r) { key: {r}, n := count(.elements) } order by .key.r"), [
          { key: { r: "admin" }, n: 1 },
          { key: { r: "dev" }, n: 2 }
        ]);
        assertEquals(await data("select (group User by .role, .active) { key: {role, active}, n := count(.elements) } order by .key.role then .key.active"), [
          { key: { active: true, role: "admin" }, n: 1 },
          { key: { active: false, role: "dev" }, n: 1 },
          { key: { active: true, role: "dev" }, n: 1 }
        ]);
      });

      await t.step("elements take the select's sub-shape, else the group's", async () => {
        const names = (rows: unknown) =>
          (rows as { elements: { name: string; }[]; key: unknown; }[]).map(row => ({
            elements: row.elements.map(element => element.name).sort(),
            key: row.key
          }));
        assertEquals(names(await data("select (group User by .role) { key: {role}, elements: { name } } order by .key.role")), [
          { elements: ["ann"], key: { role: "admin" } },
          { elements: ["bob", "cat"], key: { role: "dev" } }
        ]);
        assertEquals(names(await data("select (group User { name } by .role) { key: {role}, elements } order by .key.role")), [
          { elements: ["ann"], key: { role: "admin" } },
          { elements: ["bob", "cat"], key: { role: "dev" } }
        ]);
      });

      await t.step("filter, order by, offset and limit read the group and the shape's computables", async () => {
        assertEquals(await data("select (group User by .role) { key: {role}, n := count(.elements) } filter .n > 1"), [
          { key: { role: "dev" }, n: 2 }
        ]);
        assertEquals(await data("select (group User by .role) { key: {role}, n := count(.elements) } filter .key.role = 'dev'"), [
          { key: { role: "dev" }, n: 2 }
        ]);
        assertEquals(await data("select (group User by .role) { role := .key.role, n := count(.elements) } order by .n desc limit 1"), [
          { n: 2, role: "dev" }
        ]);
        assertEquals(await data("select (group User by .role) { key: {role}, total := sum(.elements.score) } order by .total desc"), [
          { key: { role: "dev" }, total: 9 },
          { key: { role: "admin" }, total: 3 }
        ]);
        assertEquals(await data("select (group User by .role) { key: {role}, n := count(.elements) } order by .key.role offset 1"), [
          { key: { role: "dev" }, n: 2 }
        ]);
        const plain = await data("select (group User by .role) filter .key.role = 'dev'") as { grouping: string[]; key: unknown; }[];
        assertEquals(plain.map(row => [row.key, row.grouping]), [[{ role: "dev" }, ["role"]]]);
      });

      await t.step("the outer filter and order by read the elements as a set: aggregates, in, exists, any of them", async () => {
        assertEquals(
          await data("select (group User by .role) { key: {role}, n := count(.elements) } filter count(.elements) > 1 order by max(.elements.score)"),
          [{ key: { role: "dev" }, n: 2 }]
        );
        assertEquals(await data("select (group User by .role) { key: {role} } order by min(.elements.name) desc"), [
          { key: { role: "dev" } },
          { key: { role: "admin" } }
        ]);
        assertEquals(await data("select (group User by .role) { key: {role} } filter 'ann' in .elements.name"), [{ key: { role: "admin" } }]);
        assertEquals(await data("select (group User by .role) { key: {role} } filter 'ann' not in .elements.name"), [{ key: { role: "dev" } }]);
        assertEquals(await data("select (group User by .role) { key: {role} } filter .elements.score > 4"), [{ key: { role: "dev" } }]);
        assertEquals(
          await data("select (group User by .role) { key: {role} } filter 'bob' in .elements.name or .key.role = 'admin' order by .key.role"),
          [{ key: { role: "admin" } }, { key: { role: "dev" } }]
        );
        assertEquals(
          await data(
            "select (group User by .role) { key: {role}, has := exists .elements.score, ann := 'ann' in .elements.name } order by exists .elements.score then .key.role"
          ),
          [{ ann: true, has: true, key: { role: "admin" } }, { ann: false, has: true, key: { role: "dev" } }]
        );
        const reply = await post("select (group User by .role) { key: {role} } order by .elements.name");
        assertStringIncludes(JSON.stringify(reply.body), "possibly more than one element returned by an expression where only singletons are allowed");
      });

      await t.step("a computable of the elements' values is each group's set of them", async () => {
        const sorted = (rows: unknown, field: string) =>
          (rows as Record<string, unknown>[]).map(row => ({ ...row, [field]: [...row[field] as string[]].sort() }));
        assertEquals(sorted(await data("select (group User by .role) { key: {role}, names := .elements.name } order by .key.role"), "names"), [
          { key: { role: "admin" }, names: ["ann"] },
          { key: { role: "dev" }, names: ["bob", "cat"] }
        ]);
        assertEquals(sorted(await data("select (group User by .role) { key: {role}, scores := .elements.score } filter count(.elements) > 1"), "scores"), [
          { key: { role: "dev" }, scores: [4, 5] }
        ]);
        assertEquals(
          sorted(
            await data("select (group User by .role) { key: {role}, names := array_agg(.elements.name), n := count(.elements) } order by .key.role"),
            "names"
          ),
          [{ key: { role: "admin" }, n: 1, names: ["ann"] }, { key: { role: "dev" }, n: 2, names: ["bob", "cat"] }]
        );
        assertEquals(sorted(await data("select (group User by .role) { key: {role}, e := .elements.name ++ '!' } order by .key.role"), "e"), [
          { e: ["ann!"], key: { role: "admin" } },
          { e: ["bob!", "cat!"], key: { role: "dev" } }
        ]);
        assertEquals(await data("select (group User by .role) { key: {role}, s := sum(.elements.score) + 1 } order by .key.role"), [
          { key: { role: "admin" }, s: 4 },
          { key: { role: "dev" }, s: 10 }
        ]);
      });

      await t.step("the elements' sub-shape takes a filter, an order by and a limit, as a select of them does", async () => {
        assertEquals(await data("select (group User by .role) { key: {role}, elements: { name } order by .name desc limit 1 } order by .key.role"), [
          { elements: [{ name: "ann" }], key: { role: "admin" } },
          { elements: [{ name: "cat" }], key: { role: "dev" } }
        ]);
        assertEquals(await data("select (group User by .role) { key: {role}, elements: { name } filter .score > 3 order by .name } order by .key.role"), [
          { elements: [], key: { role: "admin" } },
          { elements: [{ name: "bob" }, { name: "cat" }], key: { role: "dev" } }
        ]);
        assertEquals(await data("select (group User by .role) { key: {role}, elements: { name } order by .name offset 1 } order by .key.role"), [
          { elements: [], key: { role: "admin" } },
          { elements: [{ name: "cat" }], key: { role: "dev" } }
        ]);
        const names = (rows: unknown) =>
          (rows as { e: { name: string; }[]; key: unknown; }[]).map(row => ({ e: row.e.map(element => element.name).sort(), key: row.key }));
        assertEquals(names(await data("select (group User by .role) { key: {role}, e := .elements { name } } order by .key.role")), [
          { e: ["ann"], key: { role: "admin" } },
          { e: ["bob", "cat"], key: { role: "dev" } }
        ]);
        assertEquals(names(await data("select (group User by .role) { key: {role}, e := (select .elements { name } filter .score > 3) } order by .key.role")), [
          { e: [], key: { role: "admin" } },
          { e: ["bob", "cat"], key: { role: "dev" } }
        ]);
      });

      await t.step("a key without a sub-shape is Gel's empty free object", async () => {
        assertEquals(await data("select (group User by .role) { key } order by .key.role"), [{ key: {} }, { key: {} }]);
        assertEquals(await data("select (group User by .role) { key, n := count(.elements) } order by .key.role"), [
          { key: {}, n: 1 },
          { key: {}, n: 2 }
        ]);
      });

      await t.step("the grouped objects may be a select, a with binding or a path", async () => {
        const byRole = (rows: unknown): unknown[] => (rows as { key: { role: string; }; }[]).sort((a, b) => a.key.role.localeCompare(b.key.role));
        assertEquals(byRole(await data("group (select User filter .active) { name } by .role")), [
          { elements: [{ name: "ann" }], grouping: ["role"], key: { role: "admin" } },
          { elements: [{ name: "bob" }], grouping: ["role"], key: { role: "dev" } }
        ]);
        const groups = await data("with u := (select User filter .score > 3) group u { name } by .role") as { elements: { name: string; }[]; }[];
        assertEquals(groups.map((group): unknown => ({ ...group, elements: group.elements.map(element => element.name).sort() })), [
          { elements: ["bob", "cat"], grouping: ["role"], key: { role: "dev" } }
        ]);
        // A path's objects are distinct: bob, the author of two posts, is one element.
        assertEquals(byRole(await data("group Post.author { name } by .role")), [
          { elements: [{ name: "ann" }], grouping: ["role"], key: { role: "admin" } },
          { elements: [{ name: "bob" }], grouping: ["role"], key: { role: "dev" } }
        ]);
        assertEquals(await data("select (group (select User filter .score > 3) by .role) { key: {role}, n := count(.elements) } order by .key.role"), [
          { key: { role: "dev" }, n: 2 }
        ]);
      });

      await t.step("grouping sets, cube and rollup: a group per set of keys, the others null, `grouping` naming the set's", async () => {
        const counted = "{ key: {role, active}, grouping, n := count(.elements) } order by .key.role then .key.active";
        assertEquals(await data(`select (group User by cube(.role, .active)) ${counted}`), [
          { grouping: [], key: { active: null, role: null }, n: 3 },
          { grouping: ["active"], key: { active: false, role: null }, n: 1 },
          { grouping: ["active"], key: { active: true, role: null }, n: 2 },
          { grouping: ["role"], key: { active: null, role: "admin" }, n: 1 },
          { grouping: ["role", "active"], key: { active: true, role: "admin" }, n: 1 },
          { grouping: ["role"], key: { active: null, role: "dev" }, n: 2 },
          { grouping: ["role", "active"], key: { active: false, role: "dev" }, n: 1 },
          { grouping: ["role", "active"], key: { active: true, role: "dev" }, n: 1 }
        ]);
        assertEquals(await data(`select (group User by rollup(.role, .active)) ${counted}`), [
          { grouping: [], key: { active: null, role: null }, n: 3 },
          { grouping: ["role"], key: { active: null, role: "admin" }, n: 1 },
          { grouping: ["role", "active"], key: { active: true, role: "admin" }, n: 1 },
          { grouping: ["role"], key: { active: null, role: "dev" }, n: 2 },
          { grouping: ["role", "active"], key: { active: false, role: "dev" }, n: 1 },
          { grouping: ["role", "active"], key: { active: true, role: "dev" }, n: 1 }
        ]);
        assertEquals(await data(`select (group User by {.role, .active}) ${counted}`), [
          { grouping: ["active"], key: { active: false, role: null }, n: 1 },
          { grouping: ["active"], key: { active: true, role: null }, n: 2 },
          { grouping: ["role"], key: { active: null, role: "admin" }, n: 1 },
          { grouping: ["role"], key: { active: null, role: "dev" }, n: 2 }
        ]);
        assertEquals(await data(`select (group User by (.role, .active)) ${counted}`), [
          { grouping: ["role", "active"], key: { active: true, role: "admin" }, n: 1 },
          { grouping: ["role", "active"], key: { active: false, role: "dev" }, n: 1 },
          { grouping: ["role", "active"], key: { active: true, role: "dev" }, n: 1 }
        ]);
        assertEquals(
          await data(
            "select (group User by .role, {.active, .name}) { key: {role, active, name}, grouping, n := count(.elements) } " +
              "order by .key.role then .key.active then .key.name"
          ),
          [
            { grouping: ["role", "name"], key: { active: null, name: "ann", role: "admin" }, n: 1 },
            { grouping: ["role", "active"], key: { active: true, name: null, role: "admin" }, n: 1 },
            { grouping: ["role", "name"], key: { active: null, name: "bob", role: "dev" }, n: 1 },
            { grouping: ["role", "name"], key: { active: null, name: "cat", role: "dev" }, n: 1 },
            { grouping: ["role", "active"], key: { active: false, name: null, role: "dev" }, n: 1 },
            { grouping: ["role", "active"], key: { active: true, name: null, role: "dev" }, n: 1 }
          ]
        );
        assertEquals(await data("select (group User using r := .role by {r, .active}) { key: {r, active}, grouping } order by .key.r then .key.active"), [
          { grouping: ["active"], key: { active: false, r: null } },
          { grouping: ["active"], key: { active: true, r: null } },
          { grouping: ["r"], key: { active: null, r: "admin" } },
          { grouping: ["r"], key: { active: null, r: "dev" } }
        ]);
        const names = (rows: unknown): unknown[] => (rows as { names: string[]; }[]).map(row => ({ ...row, names: [...row.names].sort() }));
        assertEquals(names(await data("select (group User by cube(.role)) { key: {role}, grouping, names := .elements.name } order by .key.role")), [
          { grouping: [], key: { role: null }, names: ["ann", "bob", "cat"] },
          { grouping: ["role"], key: { role: "admin" }, names: ["ann"] },
          { grouping: ["role"], key: { role: "dev" }, names: ["bob", "cat"] }
        ]);
      });

      await t.step("a group has no other fields, as in Gel", async () => {
        const reply = await post("select (group User by .role) { role }");
        assertEquals(reply.body.data, undefined);
        assertStringIncludes(reply.body.errors?.[0].message ?? "", "object type 'std::FreeObject' has no link or property 'role'");
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

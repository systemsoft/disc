/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: a select over a group
 * (`select (group T by …) { key: { … }, n := count(.elements) } filter … order by …`),
 * answered as Gel 7.1 answers the same queries. Each group is Gel's free
 * object: its shape reads `key`, `grouping` and `elements`, a computable
 * aggregates the group's elements, and the filter and order by read the
 * shape's computables.
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
}
`;

const SETUP = [
  "insert User { name := 'ann', active := true, role := 'admin', score := 3 }",
  "insert User { name := 'bob', active := true, role := 'dev', score := 4 }",
  "insert User { name := 'cat', active := false, role := 'dev', score := 5 }"
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

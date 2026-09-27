/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: with bindings of objects and object casts,
 * answered as Gel 7.1 answers the same queries.
 *
 *   - `with n := assert_single((select T filter …))` binds one object: a
 *     path from it (`n.last`) is one value, and more than one object is
 *     Gel's CardinalityViolationError when run.
 *   - Comparing an object with a `with` binding of several objects compares
 *     it with each (`=`, `!=`, `?=`, `?!=`), as Gel does; `?=` and `?!=` read
 *     an empty binding as the empty set.
 *   - `<T><uuid>x` of an id no `T` has is Gel's CardinalityViolationError
 *     ("'default::T' with id '…' does not exist"), wherever the cast is: a
 *     filter, a select, an insert's or update's link.
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
    required name: str {
      constraint exclusive;
    };
    active: bool;
  };

  type Post {
    required title: str;
    author: User;
  };

  type Counter {
    required name: str;
    last: int64;
  };

  type Tracker {
    required label: str;
    number: int64;
    owner: User;
  };
}
`;

const SETUP = [
  "insert User { name := 'ann', active := true }",
  "insert User { name := 'bob', active := true }",
  "insert User { name := 'cat', active := false }",
  "insert Post { title := 'p1', author := (select User filter .name = 'ann') }",
  "insert Post { title := 'p2', author := (select User filter .name = 'bob') }",
  "insert Post { title := 'p3', author := (select User filter .name = 'cat') }",
  "insert Post { title := 'p4' }",
  "insert Counter { name := 'a', last := 5 }",
  "insert Counter { name := 'b', last := 9 }",
  "insert Tracker { label := 't' }"
];

const MISSING = "00000000-0000-0000-0000-000000000000";

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG object sets and casts: assert_single bindings, comparisons with several objects, casts of missing ids",
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

    async function post(query: string, variables: Record<string, unknown> = {}): Promise<Reply> {
      const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
        body: JSON.stringify({ query, variables }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      return { body: await response.json(), status: response.status };
    }

    async function data(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
      const reply = await post(query, variables);
      assertEquals(reply.status, 200, `${query}: ${JSON.stringify(reply.body)}`);
      assertEquals(reply.body.errors, undefined, `${query}: ${JSON.stringify(reply.body)}`);
      return reply.body.data;
    }

    async function errorOf(query: string, variables: Record<string, unknown> = {}): Promise<string> {
      const reply = await post(query, variables);
      assertEquals(reply.body.data, undefined, `${query}: ${JSON.stringify(reply.body)}`);
      return reply.body.errors?.[0].message ?? "";
    }

    async function titles(query: string, variables: Record<string, unknown> = {}): Promise<string[]> {
      const rows = await data(`${query} order by .title`, variables) as { title: string; }[];
      return rows.map(row => row.title);
    }

    try {
      for (const query of SETUP) {
        await data(query);
      }
      const ann = ((await data("select User { id } filter .name = 'ann'")) as { id: string; }[])[0].id;
      const p1 = ((await data("select Post { id } filter .title = 'p1'")) as { id: string; }[])[0].id;

      await t.step("with n := assert_single((select …)) is one object", async () => {
        const one = "with n := assert_single((select Counter filter .name = 'a'))";
        assertEquals(await data(`${one} select n.last`), [5]);
        assertEquals(await data(`${one} select n { name, last }`), [{ last: 5, name: "a" }]);
        await data(`${one} update Tracker set { number := n.last }`);
        assertEquals(await data("select Tracker { number }"), [{ number: 5 }]);
        await data("with n := assert_single((select User filter .name = 'ann')) update Tracker set { owner := n }");
        assertEquals(await data("select Tracker { owner: { name } }"), [{ owner: [{ name: "ann" }] }]);
        await data(`with n := assert_single((select Counter filter .name = 'b')) insert Tracker { label := 'u', number := n.last }`);
        assertEquals(await data("select Tracker { number } filter .label = 'u'"), [{ number: 9 }]);

        // None: the path is empty.
        await data("with n := assert_single((select Counter filter .name = 'zzz')) update Tracker filter .label = 't' set { number := n.last }");
        assertEquals(await data("select Tracker { number } filter .label = 't'"), [{ number: null }]);

        // More than one fails when run, as in Gel.
        const several = "assert_single violation: more than one element returned by an expression";
        assertStringIncludes(await errorOf("with n := assert_single((select Counter)) select n.last"), several);
        assertStringIncludes(await errorOf("with n := assert_single((select Counter filter .last > 0)) update Tracker set { number := n.last }"), several);
      });

      await t.step("an object compared with a with binding of several objects is compared with each", async () => {
        const active = "with us := (select User filter .active) select Post { title } filter";
        assertEquals(await titles(`${active} .author = us`), ["p1", "p2"]);
        assertEquals(await titles(`${active} us = .author`), ["p1", "p2"]);
        assertEquals(await titles(`${active} .author in us`), ["p1", "p2"]);
        assertEquals(await titles(`${active} .author ?= us`), ["p1", "p2"]);
        assertEquals(await titles(`${active} .author != us`), ["p1", "p2", "p3"]);
        assertEquals(await titles(`${active} .author not in us`), ["p3"]);
        assertEquals(await titles(`${active} .author ?!= us`), ["p1", "p2", "p3", "p4"]);
        assertEquals(await titles(`${active} .author = us and .title != 'p1'`), ["p2"]);
        assertEquals(await titles(`${active} not (.author = us)`), ["p1", "p2", "p3"]);

        // `?=` and `?!=` read an empty binding as the empty set.
        const none = "with us := (select User filter .name = 'zzz') select Post { title } filter";
        assertEquals(await titles(`${none} .author ?= us`), ["p4"]);
        assertEquals(await titles(`${none} .author ?!= us`), ["p1", "p2", "p3"]);
        assertEquals(await titles(`${none} .author = us`), []);
        assertEquals(await titles(`${none} .author != us`), []);

        // A binding of one object compares as one value.
        assertEquals(await titles("with u := (select User filter .name = 'bob') select Post { title } filter .author = u"), ["p2"]);
      });

      await t.step("an object cast of a missing id is a CardinalityViolationError, as in Gel", async () => {
        const missing = `'default::User' with id '${MISSING}' does not exist`;
        assertEquals(await titles("select Post { title } filter .author = <User><uuid>$u", { u: ann }), ["p1"]);
        assertStringIncludes(await errorOf("select Post { title } filter .author = <User><uuid>$u", { u: MISSING }), missing);
        assertStringIncludes(await errorOf("select Post { title } filter .author ?= <User><uuid>$u", { u: MISSING }), missing);
        assertStringIncludes(await errorOf("select Post { title } filter .author in <User><uuid>$u", { u: MISSING }), missing);
        assertStringIncludes(await errorOf("select count(<User><uuid>$u)", { u: MISSING }), missing);
        // An id of another type's object is no User's.
        assertStringIncludes(
          await errorOf("select Post { title } filter .author = <User><uuid>$u", { u: p1 }),
          `'default::User' with id '${p1}' does not exist`
        );

        // Assigned to a link: the insert or update is refused, nothing written.
        assertStringIncludes(await errorOf("insert Post { title := 'px', author := <User><uuid>$u }", { u: MISSING }), missing);
        assertStringIncludes(await errorOf("update Tracker set { owner := <User><uuid>$u }", { u: MISSING }), missing);
        assertEquals(await data("select Post { title } filter .title = 'px'"), []);
        await data("insert Post { title := 'py', author := <User><uuid>$u }", { u: ann });
        assertEquals(await data("select Post { author: { name } } filter .title = 'py'"), [{ author: [{ name: "ann" }] }]);

        // The empty set casts to the empty set.
        await data("insert Post { title := 'pz', author := <User><uuid>{} }");
        assertEquals(await data("select Post { author } filter .title = 'pz'"), [{ author: null }]);
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

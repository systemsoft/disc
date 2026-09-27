/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: objects as values, answered as Gel 7.1 answers
 * the same queries (Disc's result shapes aside: a single link with a
 * sub-shape is `[{…}]` or null, without one its id; a multi link an array,
 * or its ids).
 *
 *   - Comparing objects compares their identity: `.author = (select User …)`,
 *     `.tags = (select Tag …)`, `in (select …)`, `?=`, a `with` name.
 *   - An inline computable of objects reads as a stored link does, one or
 *     several as Gel infers it.
 *   - A path from a `with` binding of possibly several objects as a single
 *     value is a compile error; of at most one, it is the object's value.
 *   - A shape on `(select …)` and `(with … select …)`.
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
  type Tag {
    required name: str {
      constraint exclusive;
    };
  };

  type User {
    required name: str;
    required email: str {
      constraint exclusive;
    };
    best_friend: User;
    multi friends: User;
  };

  type Post {
    required title: str;
    required author: User;
    multi tags: Tag;
    number: int64;
  };

  type Counter {
    required name: str {
      constraint exclusive;
    };
    required last: int64;
  };
}
`;

const SETUP = [
  "insert Tag { name := 'a' }",
  "insert Tag { name := 'b' }",
  "insert User { name := 'ann', email := 'ann@x' }",
  "insert User { name := 'bob', email := 'bob@x', best_friend := (select detached User filter .email = 'ann@x'), " +
  "friends := (select detached User filter .email = 'ann@x') }",
  "insert Post { title := 'p1', author := (select User filter .email = 'ann@x'), tags := (select Tag filter .name = 'a') }",
  "insert Post { title := 'p2', author := (select User filter .email = 'bob@x'), tags := (select Tag) }",
  "insert Counter { name := 'c1', last := 1 }",
  "insert Counter { name := 'c2', last := 5 }"
];

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG object values: compared by identity, computables read as links, singleton with-bindings, shapes on (select …)",
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

    async function titles(filter: string, variables: Record<string, unknown> = {}): Promise<string[]> {
      const rows = await data(`select Post { title } filter ${filter} order by .title`, variables) as { title: string; }[];
      return rows.map(row => row.title);
    }

    async function ids(query: string): Promise<Record<string, string>> {
      const rows = await data(query) as { id: string; name: string; }[];
      return Object.fromEntries(rows.map(row => [row.name, row.id]));
    }

    try {
      for (const query of SETUP) {
        await data(query);
      }
      const users = await ids("select User { id, name }");
      const tags = await ids("select Tag { id, name }");

      await t.step("comparing objects compares ids: single and multi links, in, ?=, with names", async () => {
        assertEquals(await titles(".author = (select User filter .email = <str>$e)", { e: "ann@x" }), ["p1"]);
        assertEquals(await titles("(select User filter .email = 'ann@x') = .author"), ["p1"]);
        assertEquals(await titles(".author != (select User filter .email = 'ann@x')"), ["p2"]);
        assertEquals(await titles(".tags = (select Tag filter .name = 'b')"), ["p2"]);
        assertEquals(await titles(".tags = (select Tag filter .name = 'a')"), ["p1", "p2"]);
        assertEquals(await titles(".author in (select User filter .name = 'bob')"), ["p2"]);
        assertEquals(await titles(".author not in (select User filter .name = 'ann')"), ["p2"]);
        assertEquals(await titles(".tags in (select Tag filter .name = 'b')"), ["p2"]);
        assertEquals(await titles(".author ?= (select User filter .email = 'ann@x')"), ["p1"]);
        assertEquals(await titles(".author ?= (select User filter .email = 'zzz')"), []);
        assertEquals(await titles(".author.best_friend = (select User filter .email = 'ann@x')"), ["p2"]);
        assertEquals(await data("with u := (select User filter .email = 'bob@x') select Post { title } filter .author = u"), [{ title: "p2" }]);
        assertEquals(await data("with t := (select Tag filter .name = 'b') select Post { title } filter .tags = t"), [{ title: "p2" }]);
      });

      await t.step("an inline computable of objects reads as a stored link: one or several, with a sub-shape or its ids", async () => {
        const shaped = (expr: string) => data(`select Post { title, a := ${expr} } order by .title`);
        assertEquals(await shaped(".author"), [{ a: users.ann, title: "p1" }, { a: users.bob, title: "p2" }]);
        assertEquals(await shaped(".author { name }"), [{ a: [{ name: "ann" }], title: "p1" }, { a: [{ name: "bob" }], title: "p2" }]);
        assertEquals(await shaped(".author.best_friend"), [{ a: null, title: "p1" }, { a: users.ann, title: "p2" }]);
        assertEquals(await shaped(".author.best_friend { name }"), [{ a: null, title: "p1" }, { a: [{ name: "ann" }], title: "p2" }]);
        assertEquals(await shaped("(select User filter .email = 'ann@x' limit 1)"), [{ a: users.ann, title: "p1" }, { a: users.ann, title: "p2" }]);
        assertEquals(await shaped("(select Tag filter .name = 'b')"), [{ a: tags.b, title: "p1" }, { a: tags.b, title: "p2" }]);
        assertEquals(await shaped("(select detached User filter .email = 'zzz')"), [{ a: null, title: "p1" }, { a: null, title: "p2" }]);
        assertEquals(await shaped("(select detached User filter .email = 'ann@x') { name }"), [
          { a: [{ name: "ann" }], title: "p1" },
          { a: [{ name: "ann" }], title: "p2" }
        ]);
        assertEquals(await shaped("(select detached User filter .email = 'zzz') { name }"), [{ a: null, title: "p1" }, { a: null, title: "p2" }]);
        assertEquals(await shaped("assert_single((select detached User filter .name = 'ann'))"), [
          { a: users.ann, title: "p1" },
          { a: users.ann, title: "p2" }
        ]);
        assertEquals(await shaped(".tags"), [{ a: [tags.a], title: "p1" }, { a: [tags.a, tags.b], title: "p2" }]);
        assertEquals(await shaped(".tags { name }"), [{ a: [{ name: "a" }], title: "p1" }, { a: [{ name: "a" }, { name: "b" }], title: "p2" }]);
        assertEquals(await shaped(".author.friends"), [{ a: null, title: "p1" }, { a: [users.ann], title: "p2" }]);
        assertEquals(await shaped(".author.friends { name }"), [{ a: [], title: "p1" }, { a: [{ name: "ann" }], title: "p2" }]);
        const everyone = await shaped("(select detached User order by .name) { name }") as { a: unknown; }[];
        assertEquals(everyone[0].a, [{ name: "ann" }, { name: "bob" }]);

        const bound = "with u := (select User filter .email = 'ann@x') select Post { title, a := u, b := u { name } } order by .title";
        assertEquals(await data(bound), [{ a: users.ann, b: [{ name: "ann" }], title: "p1" }, { a: users.ann, b: [{ name: "ann" }], title: "p2" }]);

        // More than one object for assert_single fails when run, as in Gel.
        const reply = await post("select Post { a := assert_single((select detached User)) }");
        assertEquals(reply.body.data, undefined, JSON.stringify(reply.body));
      });

      await t.step("a path from a with binding of possibly several objects as a single value is refused; of one, is its value", async () => {
        const author = "author := (select User filter .email = 'ann@x')";
        const refused = await post(`with n := (select Counter) insert Post { title := 'x', ${author}, number := n.last }`);
        assertEquals(refused.body.data, undefined);
        assertStringIncludes(
          refused.body.errors?.[0].message ?? "",
          "possibly more than one element returned by an expression for a property 'number' declared as 'single'"
        );
        const updating = await post(`with n := (update Counter set { last := .last + 1 }) insert Post { title := 'x', ${author}, number := n.last }`);
        assertStringIncludes(updating.body.errors?.[0].message ?? "", "declared as 'single'");
        // Refused before running: nothing was updated.
        assertEquals(await data("select Counter { name, last } order by .name"), [{ last: 1, name: "c1" }, { last: 5, name: "c2" }]);

        const selected = await data(`with n := (select Counter filter .name = 'c2') insert Post { title := 'x3', ${author}, number := n.last }`);
        assertEquals((selected as { number: number; }).number, 5);
        const updated = await data(
          `with n := (update Counter filter .name = 'c1' set { last := .last + 1 }) insert Post { title := 'x7', ${author}, number := n.last }`
        );
        assertEquals((updated as { number: number; }).number, 2);
        const most = await data(`with n := (select Counter) insert Post { title := 'x8', ${author}, number := max(n.last) }`);
        assertEquals((most as { number: number; }).number, 5);
        assertEquals(await data("with n := (select Counter filter .name = 'c1') select Post { k := n.last } filter .title = 'p1'"), [{ k: 2 }]);
      });

      await t.step("a shape on (select …) and on (with … select …)", async () => {
        assertEquals(await data("select (with x := 'ann@x' select User filter .email = x) { name }"), [{ name: "ann" }]);
        assertEquals(await data("select (with x := <str>$e select User filter .email != x) { name, email } order by .name", { e: "ann@x" }), [
          { email: "bob@x", name: "bob" }
        ]);
        assertEquals(await data("select (with x := 'bob@x' select User filter .email = x) { name, best_friend: { name } }"), [
          { best_friend: [{ name: "ann" }], name: "bob" }
        ]);
        assertEquals(await data("select (with t := (select Tag filter .name = 'b') select Post filter t in .tags) { title }"), [{ title: "p2" }]);
        assertEquals(await data("with y := 'ann@x' select (with x := y select User { email } filter .email = x) { name }"), [{ name: "ann" }]);
        assertEquals(await data("select (with u := (select User filter .name = 'bob') select u.best_friend) { name }"), [{ name: "ann" }]);
        assertEquals(await data("select (select User order by .name limit 1) { name } filter .name != 'zzz'"), [{ name: "ann" }]);
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

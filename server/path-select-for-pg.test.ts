/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: path selects, computed paths, backlink
 * sub-shapes and `for` loops over objects answer on `/query` like any shaped
 * select — one object (or value) per row.
 *
 * Every read runs twice with the same query text, so the second run is a
 * compiled-query cache hit.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDL = `module default {
  type HttpPost {
    required title: str;
    author: HttpUser;
  }
  type HttpUser {
    required name: str;
    multi posts: HttpPost;
  }
  type HttpPerson {
    required name: str;
    manager: HttpPerson;
  }
}`;

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG paths and for loops over HTTP: /query answers the objects, on a cache miss and on a cache hit",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
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
    await pool.query(`
      WITH ann AS (INSERT INTO http_user (id, name) VALUES (gen_random_uuid(), 'ann') RETURNING id),
           bob AS (INSERT INTO http_user (id, name) VALUES (gen_random_uuid(), 'bob') RETURNING id),
           hello AS (INSERT INTO http_post (id, title, author_id) SELECT gen_random_uuid(), 'Hello', id FROM ann RETURNING id),
           world AS (INSERT INTO http_post (id, title, author_id) SELECT gen_random_uuid(), 'World', id FROM ann RETURNING id)
      INSERT INTO http_user_posts (source_id, target_id)
        SELECT ann.id, hello.id FROM ann, hello
        UNION ALL SELECT ann.id, world.id FROM ann, world
        UNION ALL SELECT bob.id, world.id FROM bob, world`);
    await pool.query(`
      WITH ann AS (INSERT INTO http_person (id, name) VALUES (gen_random_uuid(), 'Ann') RETURNING id)
      INSERT INTO http_person (id, name, manager_id)
        SELECT gen_random_uuid(), 'Bob', id FROM ann UNION ALL SELECT gen_random_uuid(), 'Dee', id FROM ann`);

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
        body: JSON.stringify({ query }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      return { body: await response.json(), status: response.status };
    }

    /*** The answered rows: a shaped select's objects, else one `{ column: value }` per row. ***/
    async function answer(query: string): Promise<unknown[]> {
      const reply = await post(query);
      assertEquals(reply.status, 200, JSON.stringify(reply.body));
      return reply.body.data as unknown[];
    }

    /*** Each answered row's one value. ***/
    async function values(query: string): Promise<unknown[]> {
      return (await answer(query)).map(row => Object.values(row as Record<string, unknown>)[0]);
    }

    try {
      for (const round of ["cache miss", "cache hit"]) {
        // World is linked from ann and bob, and comes back once.
        assertEquals(await answer("select HttpUser.posts { title } order by .title"), [{ title: "Hello" }, { title: "World" }], round);
        assertEquals(await values("select count(HttpUser.posts)"), [2], round);
        assertEquals(
          await answer("select HttpUser { name, titles := .posts.title } filter .name = 'bob'"),
          [{ name: "bob", titles: ["World"] }],
          round
        );
        assertEquals(
          await answer("select HttpPerson { name, reports_to_me := .<manager[is HttpPerson] { name } order by .name } filter .name = 'Ann'"),
          [{ name: "Ann", reports_to_me: [{ name: "Bob" }, { name: "Dee" }] }],
          round
        );
        assertEquals(await answer("for x in (select HttpUser filter .name = 'ann') union (select x { name })"), [{ name: "ann" }], round);
        assertEquals(await values("for x in (select HttpUser filter .name = 'bob') union x.name"), ["bob"], round);
      }

      const inserted = await post("for x in (select HttpUser filter .name = 'bob') union (insert HttpPost { author := x, title := x.name ++ '!' })");
      assertEquals(inserted.status, 200, JSON.stringify(inserted.body));
      assertEquals(await answer("select HttpPost { title, author: { name } } filter .title = 'bob!'"), [{ author: [{ name: "bob" }], title: "bob!" }]);
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

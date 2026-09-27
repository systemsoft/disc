/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP with access policies on: a bare object type
 * assigned to a link is the set of all its objects the caller can see
 * (compiler/bare-type-link-values.test.ts has the compiled forms).
 *
 * `insert Post { tags := Tag }`, `set { tags := Tag }`, `tags += Tag` and
 * `tags -= Tag` link (or unlink) every tag Tag's select policy shows, the
 * hidden one never. A single link can't hold a set, so `author := User` is
 * Gel's cardinality error and writes nothing.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDL = `module default {
  type Tag {
    required name: str;
    visible: bool;
    access policy see {
      allow all;
      using (.visible ?= true);
    };
  }
  type Person {
    required name: str;
  }
  type Post {
    required title: str;
    author: Person;
    multi tags: Tag;
  }
}`;

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG bare type link values: a type assigned to a link is the objects its policies show",
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

    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 4, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, enableAccessPolicies: true, schema })
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

    async function data(query: string): Promise<unknown> {
      const reply = await post(query);
      assertEquals(reply.status, 200, JSON.stringify(reply.body));
      return reply.body.data;
    }

    /*** The names of the tags linked to the post titled `title`, read past the policy. ***/
    async function linked(title: string): Promise<string[]> {
      const result = await pool.query(
        `SELECT t.name FROM post_tags AS j JOIN tag AS t ON t.id = j.target_id JOIN post AS p ON p.id = j.source_id WHERE p.title = '${title}' ORDER BY t.name`
      );
      return result.rows.map(row => String(row["name"]));
    }

    try {
      // Seeded past the policy: `hidden` can't be selected.
      await pool.query("INSERT INTO tag (name, visible) VALUES ('a', true), ('b', true), ('hidden', false)");
      await pool.query("INSERT INTO person (name) VALUES ('ann'), ('bob')");

      await data("insert Post { title := 'p1', tags := Tag }");
      assertEquals(await linked("p1"), ["a", "b"]);

      await data("insert Post { title := 'p2' }");
      await data("update Post filter .title = 'p2' set { tags += Tag }");
      assertEquals(await linked("p2"), ["a", "b"]);
      await data("update Post filter .title = 'p2' set { tags -= Tag }");
      assertEquals(await linked("p2"), []);
      await data("update Post filter .title = 'p2' set { tags := Tag }");
      assertEquals(await linked("p2"), ["a", "b"]);

      // A hidden tag linked past the policy is not a tag `-= Tag` can see, so it stays.
      await pool.query(
        "INSERT INTO post_tags (source_id, target_id) SELECT p.id, t.id FROM post AS p, tag AS t WHERE p.title = 'p2' AND t.name = 'hidden'"
      );
      await data("update Post filter .title = 'p2' set { tags -= Tag }");
      assertEquals(await linked("p2"), ["hidden"]);

      /*** A single link can't hold every person. ***/
      for (const query of ["insert Post { title := 'p3', author := Person }", "update Post filter .title = 'p1' set { author := Person }"]) {
        const reply = await post(query);
        const error = reply.body.errors?.[0];
        assert(error, `${query} should fail, answered ${JSON.stringify(reply.body)}`);
        assertStringIncludes(error.message, "possibly more than one element returned by an expression for a link 'author' declared as 'single'", query);
      }
      assertEquals((await pool.query("SELECT count(*)::int AS n FROM post WHERE title = 'p3' OR author_id IS NOT NULL")).rows[0]["n"], 0);
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

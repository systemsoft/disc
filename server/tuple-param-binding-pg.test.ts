/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: binding tuple / array-of-tuple query parameters.
 *
 * Tuple and array-of-tuple types compile to `jsonb` casts (`CAST($n AS
 * jsonb)`). The JSON wire value for such a parameter must be serialized to
 * JSON text before binding — otherwise deno-postgres encodes a JS array as a
 * PG array literal (`{a,b}`) and the jsonb cast fails with
 * `invalid input syntax for type json`.
 *
 * Mirrors the reproduction cases from the codegen-cast bug report: named-tuple
 * casts must parse, and tuple / array-of-tuple params must round-trip.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import * as Types from "./types.ts";

const RUN_PG = canRunPgTests();

function makeContext(): Types.QueryContext {
  return {
    session: {
      sessionId: `tuple_bind_${Date.now()}`,
      database: "disc_test",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {}
    },
    auth: { roles: [], permissions: [] },
    requestId: `req_${Date.now()}`,
    startedAt: new Date()
  };
}

Deno.test({
  name: "PG tuple binding: named-tuple cast param round-trips",
  ignore: !RUN_PG,
  fn: async () => {
    const handler = new EdgeQLProtocolHandler({ databaseUrl: await getTestDsn() });
    try {
      const res = await handler.handleRequest(
        { query: "select <tuple<name: str, url: str>>$c", variables: { c: { name: "x", url: "y" } } },
        makeContext()
      );
      assertEquals(res.errors, undefined);
      const row = (res.data as unknown[])[0] as Record<string, unknown>;
      assertEquals(Object.values(row)[0], { name: "x", url: "y" });
    } finally {
      await handler.close();
    }
  }
});

Deno.test({
  name: "PG tuple binding: array-of-tuple cast param round-trips",
  ignore: !RUN_PG,
  fn: async () => {
    const handler = new EdgeQLProtocolHandler({ databaseUrl: await getTestDsn() });
    try {
      const links = [
        { title: "Home", url: "https://a" },
        { title: "Docs", url: "https://b" }
      ];
      const res = await handler.handleRequest(
        { query: "select <array<tuple<title: str, url: str>>>$links", variables: { links } },
        makeContext()
      );
      assertEquals(res.errors, undefined);
      const row = (res.data as unknown[])[0] as Record<string, unknown>;
      assertEquals(Object.values(row)[0], links);
    } finally {
      await handler.close();
    }
  }
});

Deno.test({
  name: "PG tuple binding: array<str> param still round-trips (regression)",
  ignore: !RUN_PG,
  fn: async () => {
    const handler = new EdgeQLProtocolHandler({ databaseUrl: await getTestDsn() });
    try {
      const res = await handler.handleRequest(
        { query: "select <array<str>>$a", variables: { a: ["one", "two"] } },
        makeContext()
      );
      assertEquals(res.errors, undefined);
      const row = (res.data as unknown[])[0] as Record<string, unknown>;
      assertEquals(Object.values(row)[0], ["one", "two"]);
    } finally {
      await handler.close();
    }
  }
});

// ---------------------------------------------------------------------------
// Full insert round-trip through a migrated schema — the realistic flow the
// codegen-generated client uses: `field := <cast>$field` over real columns,
// covering a tuple, a tuple containing an enum member, an array-of-tuple, and
// an array<str>.
// ---------------------------------------------------------------------------

// Arrow form (`name -> Type`) mirrors the real Nickel schema — the form whose
// collection params were dropped, producing unbindable `<tuple>` casts.
const VIDEO_SDL = `module default {
  scalar type PFPShape extending enum<circle, square>;
  type Vid {
    required title -> str;
    captions -> array<str>;
    client -> tuple<name: str, url: str>;
    links -> array<tuple<title: str, url: str>>;
    pfp -> tuple<path: str, shape: PFPShape, source: str>;
  };
};`;

Deno.test({
  name: "PG tuple binding: insert with tuple/enum-tuple/array-of-tuple round-trips",
  ignore: !RUN_PG,
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    const manager = new SchemaManager({ pool });
    await manager.initialize();

    try {
      const applied = await manager.applySchema(VIDEO_SDL);
      assertEquals(applied.ok, true, JSON.stringify(applied));
      const schema = manager.getSchema()!;

      const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema });
      try {
        const insertRes = await handler.handleRequest(
          {
            query: "insert Vid { title := <str>$title, captions := <array<str>>$captions, " +
              "client := <tuple<name: str, url: str>>$client, " +
              "links := <array<tuple<title: str, url: str>>>$links, " +
              "pfp := <tuple<path: str, shape: PFPShape, source: str>>$pfp }",
            variables: {
              title: "Intro",
              captions: ["en", "fr"],
              client: { name: "Acme", url: "https://acme" },
              links: [
                { title: "Home", url: "https://h" },
                { title: "Docs", url: "https://d" }
              ],
              pfp: { path: "/a.png", shape: "circle", source: "upload" }
            }
          },
          makeContext()
        );
        assertEquals(insertRes.errors, undefined, JSON.stringify(insertRes.errors));

        const selectRes = await handler.handleRequest(
          { query: "select Vid { title, captions, client, links, pfp }" },
          makeContext()
        );
        assertEquals(selectRes.errors, undefined, JSON.stringify(selectRes.errors));
        const row = (selectRes.data as Record<string, unknown>[])[0];
        assertEquals(row.title, "Intro");
        assertEquals(row.captions, ["en", "fr"]);
        assertEquals(row.client, { name: "Acme", url: "https://acme" });
        assertEquals(row.links, [
          { title: "Home", url: "https://h" },
          { title: "Docs", url: "https://d" }
        ]);
        assertEquals(row.pfp, { path: "/a.png", shape: "circle", source: "upload" });
      } finally {
        await handler.close();
      }
    } finally {
      await pool.query("DROP TABLE IF EXISTS \"Vid\" CASCADE");
      await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
      await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
      await pool.close();
    }
  }
});

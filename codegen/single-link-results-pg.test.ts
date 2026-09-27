/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: what a single link selected with a sub-shape
 * arrives as, which the declared result types (`single-link-results.test.ts`,
 * `sdk/schema-types.test.ts`) must match. Unlike Gel, which returns the linked
 * object itself, Disc returns a one-element array of rows:
 *
 * - a required single link: `[{ … }]`;
 * - an optional one: `[{ … }]` when set, `null` when empty (never `[]`);
 * - nested in a single link, and inside a multi link's rows, the same;
 * - an inline computed single link (`a := .author { name }`): `[{ … }]`;
 * - a backlink (multi): an array, `[]` when empty.
 *
 * Without a sub-shape a single link is its target's id (a string), and the
 * `{ * }` splat carries no links at all.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { DiscClient } from "../sdk/client.ts";
import { createQueryBuilder } from "../sdk/query-builder.ts";
import { defineSchema, t } from "../sdk/schema-types.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import { HttpServer } from "../server/http.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { emitTypeScript } from "./emit-typescript.ts";
import { schemaToIR } from "./schema-to-ir.ts";

const SDK_URL = new URL("../sdk/mod.ts", import.meta.url).href;

const SDL = `module default {
  type SlUser {
    required name: str;
    manager: SlUser;
    posts_by := .<author[is SlPost];
  };
  type SlTag {
    required label: str;
    owner: SlUser;
  };
  type SlPost {
    required title: str;
    required author: SlUser;
    editor: SlUser;
    multi tags: SlTag;
  };
};`;

type Row = Record<string, unknown> & { id: string; };

interface Builder {
  filter(filter: Record<string, unknown>): Promise<Row[]>;
  select(shape?: string): Promise<Row[]>;
}

interface GeneratedClient {
  slpost: Builder;
}

/** Generate the typed client into a temp directory and import it, with its SDK import pointed at this repo's `sdk/`. */
async function withGeneratedClient(schema: Schema, baseUrl: string, fn: (client: GeneratedClient) => Promise<void>): Promise<void> {
  const outputDir = await Deno.makeTempDir({ prefix: "disc-single-link-client-" });

  try {
    const files = emitTypeScript(schemaToIR(schema), {
      formatOutput: false,
      includeClient: true,
      includeMutations: true,
      includeQueryBuilders: true,
      outputDir,
      schemaSource: "single-link-results-pg.test.ts",
      sdkImportBase: SDK_URL,
      target: "client"
    });

    for (const file of files)
      await Deno.writeTextFile(file.path, file.content);

    const generated = await import(new URL(`file://${outputDir}/client.ts`).href) as {
      DiscClient: new(config: { baseUrl: string; }) => GeneratedClient;
    };

    await fn(new generated.DiscClient({ baseUrl }));
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
}

const typedSchema = defineSchema({
  SlPost: {
    author: t.single("SlUser"),
    editor: t.optional(t.single("SlUser")),
    tags: t.multi("SlTag"),
    title: t.str()
  },
  SlTag: {
    label: t.str(),
    owner: t.optional(t.single("SlUser"))
  },
  SlUser: {
    manager: t.optional(t.single("SlUser")),
    name: t.str()
  }
});

Deno.test({
  name: "PG single links arrive as one-element arrays (null when an optional one is empty)",
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
    const baseUrl = `http://127.0.0.1:${listener.addr.port}`;
    const client = new DiscClient({ baseUrl });

    try {
      await client.query(`insert SlUser { name := "boss" }`);
      await client.query(`insert SlUser { name := "ann", manager := (select SlUser filter .name = "boss" limit 1) }`);
      await client.query(`insert SlTag { label := "t1", owner := (select SlUser filter .name = "ann" limit 1) }`);
      await client.query(`insert SlTag { label := "t2" }`);
      await client.query(`insert SlPost { title := "p1", author := (select SlUser filter .name = "ann" limit 1), tags := (select SlTag) }`);
      const [ann] = await client.query<{ id: string; }[]>(`select SlUser { id } filter .name = "ann"`);

      await t.step("raw query: required, optional set and empty, nested, inside a multi link", async () => {
        assertEquals(await client.query(`select SlPost { title, author: { name }, editor: { name } }`), [
          { author: [{ name: "ann" }], editor: null, title: "p1" }
        ]);
        assertEquals(await client.query(`select SlPost { author: { name, manager: { name } } }`), [
          { author: [{ manager: [{ name: "boss" }], name: "ann" }] }
        ]);
        assertEquals(await client.query(`select SlPost { tags: { label, owner: { name } } order by .label }`), [
          { tags: [{ label: "t1", owner: [{ name: "ann" }] }, { label: "t2", owner: null }] }
        ]);
      });

      await t.step("raw query: inline computed single link and backlinks", async () => {
        assertEquals(await client.query(`select SlPost { a := .author { name } }`), [{ a: [{ name: "ann" }] }]);
        assertEquals(await client.query(`select SlUser { name, posts_by: { title } } order by .name`), [
          { name: "ann", posts_by: [{ title: "p1" }] },
          { name: "boss", posts_by: [] }
        ]);
      });

      await t.step("raw query: a bare single link is the target id; the splat carries no links", async () => {
        assertEquals(await client.query(`select SlPost { author, editor }`), [{ author: ann.id, editor: null }]);
        const [splat] = await client.query<Record<string, unknown>[]>(`select SlPost { * }`);
        assertEquals(Object.keys(splat).sort(), ["id", "title"]);
      });

      await t.step("generated client: select and filter return the same arrays", async () => {
        await withGeneratedClient(schema, baseUrl, async generated => {
          const [row] = await generated.slpost.select("{ author: { name, manager: { name } }, editor: { name } }");
          assertEquals(row.author, [{ manager: [{ name: "boss" }], name: "ann" }]);
          assertEquals(row.editor, null);

          const [filtered] = await generated.slpost.filter({ select: { author: { name: true }, editor: { name: true } }, title: "p1" });
          assertEquals(filtered as Record<string, unknown>, { author: [{ name: "ann" }], editor: null });
        });
      });

      await t.step("typed query builder: rows match the declared one-element arrays", async () => {
        const qb = createQueryBuilder(client, typedSchema);
        const [row] = await qb.SlPost.select({ author: { manager: { name: true }, name: true }, editor: { name: true }, tags: { owner: { name: true } } });
        assertEquals(row.author[0].name, "ann");
        assertEquals(row.author[0].manager?.[0].name, "boss");
        assertEquals(row.editor, null);
        assertEquals(row.tags.map(tag => tag.owner?.[0].name ?? null).sort(), ["ann", null]);
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

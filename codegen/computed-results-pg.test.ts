/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: schema computeds that are not a path — `count(…)`, `++`,
 * a comparison, `array_agg(…)`, an element-wise call over a multi property,
 * `max(…)` — and single computed links (declared `single`, a select by an
 * exclusive property, `assert_single`), selected, then revived
 * by the generated TypeScript client's type info into the types codegen
 * declares for them (`computed-results.test.ts`): `n_posts` a `bigint`,
 * `last_seen` a `Date`, `up` a `string[]`.
 *
 * Expected values are Gel 7.1's for the same schema and data (but for a
 * single link, a one-element array — a pinned divergence).
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { reviveTyped, type TypeInfo } from "../sdk/mod.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import type * as ServerTypes from "../server/types.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { emitTypeScript } from "./emit-typescript.ts";
import { schemaToIR } from "./schema-to-ir.ts";

const SDL = `module default {
  type CvPerson {
    required name: str;
    nick: str;
    age: int64;
    multi tags: str;
    n_posts := count(.<author[is CvPost]);
    full := .nick ++ ' ' ++ .name;
    is_old := .age > 60;
    tags_up := array_agg(str_upper(.tags));
    up := str_upper(.tags);
    last_seen := max(.<author[is CvPost].created);
    single first_post := (select .<author[is CvPost] order by .title limit 1);
    featured := (select CvPost filter .title = 'p1');
    single only := assert_single((select .<author[is CvPost] filter .title = 'p2'));
  };
  type CvPost {
    required title: str {
      constraint exclusive;
    };
    required author: CvPerson;
    created: datetime;
  };
};`;

const SDK_URL = new URL("../sdk/mod.ts", import.meta.url).href;

function makeContext(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: `req_${Date.now()}`,
    session: {
      createdAt: new Date(),
      database: "disc_test",
      lastActivity: new Date(),
      sessionId: `computed_results_${Date.now()}`,
      variables: {}
    },
    startedAt: new Date()
  };
}

/*** The `_typeInfo` of the generated `CvPerson` query builder. ***/
async function generatedPersonTypeInfo(schema: Schema): Promise<TypeInfo> {
  const outputDir = await Deno.makeTempDir({ prefix: "disc-computed-results-client-" });
  try {
    const files = emitTypeScript(schemaToIR(schema), {
      formatOutput: false,
      includeClient: true,
      includeMutations: true,
      includeQueryBuilders: true,
      outputDir,
      schemaSource: "./dbschema/default.disc",
      sdkImportBase: SDK_URL,
      target: "client"
    });
    for (const file of files) {
      await Deno.writeTextFile(file.path, file.content);
    }
    const queries = await import(new URL(`file://${outputDir}/queries.ts`).href) as { CvPersonQueryBuilder: { _typeInfo: TypeInfo; }; };
    return queries.CvPersonQueryBuilder._typeInfo;
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
}

Deno.test({
  name: "PG computed results: non-path scalar computeds and a declared-single computed link, revived as codegen types them",
  ignore: !canRunPgTests(),
  fn: async () => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    try {
      await resetTestDatabase(pool);
      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema(SDL);
      assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
      const schema = manager.getSchema()!;
      await manager.close();
      const handler = new EdgeQLProtocolHandler({ databaseUrl: dsn, schema });
      const run = async (query: string): Promise<Record<string, unknown>[]> => {
        const response = await handler.handleRequest({ query }, makeContext());
        assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
        return response.data as Record<string, unknown>[];
      };
      try {
        await run(`insert CvPerson { name := 'ann', nick := 'a', age := 70, tags := {'x', 'y'} }`);
        await run(`insert CvPerson { name := 'bob' }`);
        for (const [title, day] of [["p2", "02"], ["p1", "01"]]) {
          await run(
            `insert CvPost { title := '${title}', author := (select CvPerson filter .name = 'ann' limit 1), ` +
              `created := <datetime>'2026-01-${day}T00:00:00Z' }`
          );
        }

        const rows = await run(
          "select CvPerson { name, n_posts, full, is_old, tags_up, up, last_seen, first_post: { title } } order by .name"
        );
        // Each row's fields in the order selected (Gel 7.1's values; a datetime as an instant).
        const fields = (
          row: Record<string, unknown>
        ) => [
          row.name,
          row.n_posts,
          row.full,
          row.is_old,
          row.tags_up,
          row.up,
          row.last_seen && new Date(row.last_seen as string).toISOString(),
          row.first_post
        ];
        assertEquals(rows.map(fields), [
          ["ann", 2, "a ann", true, ["X", "Y"], ["X", "Y"], "2026-01-02T00:00:00.000Z", [{ title: "p1" }]],
          ["bob", 0, null, null, [], [], null, null]
        ]);

        // A select of a type's objects by an exclusive property, and
        // `assert_single`, are single computed links.
        assertEquals(
          await run("select CvPerson { name, featured: { title }, only: { title }, ft := .featured.title, ot := .only.title } order by .name"),
          [
            { featured: [{ title: "p1" }], ft: "p1", name: "ann", only: [{ title: "p2" }], ot: "p2" },
            { featured: [{ title: "p1" }], ft: "p1", name: "bob", only: null, ot: null }
          ]
        );
        assertEquals(await run("select CvPerson { name } filter .only.title = 'p2'"), [{ name: "ann" }]);
        const ids = await run("select CvPerson { name, featured, only } order by .name");
        assertEquals(typeof ids[0].featured, "string");
        assertEquals(typeof ids[0].only, "string");
        assertEquals(ids[1].only, null);

        // Revived by the generated client's type info: an int64 is a bigint, a datetime a Date.
        const revived = reviveTyped(rows, await generatedPersonTypeInfo(schema));
        assertEquals(revived[0].n_posts, 2n);
        assertEquals(revived[1].n_posts, 0n);
        assertEquals(revived[0].last_seen, new Date("2026-01-02T00:00:00Z"));
        assertEquals(revived[0].up, ["X", "Y"]);
        assertEquals(revived[0].tags_up, ["X", "Y"]);
      } finally {
        await handler.close();
      }
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * What a query answers with is decided by the query, not by words in its SQL
 * (D4), and is the same on a compiled-query cache hit as on the miss (D14).
 *
 *   - `select (insert|update|delete …) { … }` and the with-form answer with the
 *     row set as-is: `[]` when nothing matched. All three emit
 *     `WITH … <mutation> … SELECT`, the SQL shape junction-backed multi-link
 *     writes have too, so the SQL text cannot tell them apart.
 *   - A bare mutation keeps its response: the row (keyed by property names, on
 *     every run), `{ updated: 0 }`, `{ deleted: n }`, `{ success: true }`.
 *
 * Every case runs twice; the second run is a cache hit and has no query AST.
 *
 * No PostgreSQL: a scripted pool plays the database.
 */

import { assert, assertEquals } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import * as Types from "./types.ts";

const SDL = `
module default {
  type Tag {
    required name: str;
  }

  type Post {
    createdAt: datetime;
    required title: str;
    multi tags -> Tag;
  }
}
`;

interface Scripted {
  rowCount: number;
  rows: Record<string, unknown>[];
}

let cachedSchema: Schema | undefined;

async function testSchema(): Promise<Schema> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(SDL);
    if (!parsed.ok) {
      throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
    }
    cachedSchema = manager.modulesToSchema(parsed.value);
  }
  return cachedSchema;
}

function scriptedPool(result: Scripted, statements: string[]): ConnectionPool {
  return {
    close: () => Promise.resolve(),
    initialize: () => Promise.resolve(),
    query: (sql: string) => {
      statements.push(sql);
      return Promise.resolve({ rowCount: result.rowCount, rows: result.rows.map(row => ({ ...row })) });
    }
  } as unknown as ConnectionPool;
}

function makeContext(): Types.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: "mutation_result_shape",
    session: {
      createdAt: new Date(),
      database: "test_db",
      lastActivity: new Date(),
      sessionId: "mutation_result_shape",
      variables: {}
    },
    startedAt: new Date()
  };
}

interface Run {
  data: unknown[];
  statements: string[];
}

/*** Runs `query` twice on one handler: a cache miss, then a cache hit. Returns both `data` values. ***/
async function runTwice(query: string, result: Scripted): Promise<Run> {
  const statements: string[] = [];
  const handler = new EdgeQLProtocolHandler({ connectionPool: scriptedPool(result, statements), schema: await testSchema() });
  const data: unknown[] = [];

  for (const expectHit of [false, true]) {
    const response = await handler.handleRequest({ query }, makeContext());

    assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
    assertEquals(response.extensions?.cacheHit, expectHit, `${query}: run ${expectHit ? 2 : 1} cacheHit`);
    data.push(response.data);
  }

  return { data, statements };
}

const NOTHING: Scripted = { rowCount: 0, rows: [] };

/*** A `RETURNING *` row as the driver hands it over: keyed by column name (`createdAt` is stored as `created_at`). ***/
const POST_ROW: Record<string, unknown> = { ["created_at"]: "2026-09-21T00:00:00Z", id: "a", title: "t" };

const SELECT_OVER_MUTATION = [
  "select (update Post filter .title = 'stale' set { title := 'new' }) { id }",
  "select (delete Post filter .title = 'stale') { id }",
  "select (insert Post { title := 'taken' } unless conflict) { id }",
  "with m := (update Post filter .title = 'stale' set { title := 'new' }) select m { id }",
  "with m := (delete Post filter .title = 'stale') select m { id }",
  "with m := (insert Post { title := 'taken' } unless conflict) select m { id }",
  "with m := (update Post filter .title = 'stale' set { title := 'new' }) select m"
];

for (const query of SELECT_OVER_MUTATION) {
  Deno.test(`result shape - nothing matched answers [] on the miss and on the hit: ${query}`, async () => {
    const { data, statements } = await runTwice(query, NOTHING);

    assert(statements[0].trimStart().startsWith("WITH "), statements[0]);
    assertEquals(data, [[], []]);
  });
}

Deno.test("result shape - a select over a mutation answers with every affected row, unwrapped, on both runs", async () => {
  const rows = [{ jsonb_build_object: { id: "a" } }, { jsonb_build_object: { id: "b" } }];

  for (const query of SELECT_OVER_MUTATION.slice(0, 6)) {
    const { data } = await runTwice(query, { rowCount: 2, rows });

    assertEquals(data, [[{ id: "a" }, { id: "b" }], [{ id: "a" }, { id: "b" }]], query);
  }
});

Deno.test("result shape - a bare insert answers with the same keys on the first and on the repeated call", async () => {
  const { data } = await runTwice("insert Post { title := 't' }", { rowCount: 1, rows: [POST_ROW] });
  const [first, second] = data as Record<string, unknown>[];

  assertEquals(Object.keys(first).sort(), ["createdAt", "id", "title"]);
  assertEquals(Object.keys(second).sort(), Object.keys(first).sort());
  assertEquals(second, first);
});

Deno.test("result shape - a bare update answers with the same keys on both runs, and { updated: 0 } when nothing matched", async () => {
  const matched = await runTwice("update Post filter .title = 'x' set { title := 't' }", { rowCount: 1, rows: [POST_ROW] });
  const expected = { createdAt: "2026-09-21T00:00:00Z", id: "a", title: "t" };

  assertEquals(matched.data, [expected, expected]);

  const stale = await runTwice("update Post filter .title = 'x' set { title := 't' }", NOTHING);
  assertEquals(stale.data, [{ updated: 0 }, { updated: 0 }]);
});

Deno.test("result shape - a bare delete keeps { deleted: n } and a swallowed insert keeps { success: true }", async () => {
  const deleted = await runTwice("delete Post filter .title = 'x'", { rowCount: 3, rows: [{ id: "a" }, { id: "b" }, { id: "c" }] });
  assertEquals(deleted.data, [{ deleted: 3 }, { deleted: 3 }]);

  const swallowed = await runTwice("insert Post { title := 'taken' } unless conflict", NOTHING);
  assertEquals(swallowed.data, [{ success: true }, { success: true }]);
});

Deno.test("result shape - a junction-backed multi-link write keeps its single-row response on both runs", async () => {
  const expected = { createdAt: "2026-09-21T00:00:00Z", id: "a", title: "t" };
  const writes = [
    "insert Post { title := 't', tags := (select Tag filter .name = 'a') }",
    "update Post filter .title = 't' set { tags += (select Tag filter .name = 'b') }"
  ];

  for (const query of writes) {
    const matched = await runTwice(query, { rowCount: 1, rows: [POST_ROW] });

    assert(matched.statements[0].trimStart().startsWith("WITH "), matched.statements[0]);
    assertEquals(matched.data, [expected, expected], query);

    const nothing = await runTwice(query, NOTHING);
    assertEquals(nothing.data, [{ success: true }, { success: true }], query);
  }
});

// The simple handler has no compiler and no cache: it emits one plain
// SELECT/INSERT/UPDATE/DELETE per query and never a CTE. Its response shape
// follows the query kind the same way.
Deno.test("result shape - simple handler: a select answers with the row set, [] when empty; a bare update keeps { updated: 0 }", async () => {
  const statements: string[] = [];
  const handler = new SimpleEdgeQLProtocolHandler({ connectionPool: scriptedPool(NOTHING, statements), schema: await testSchema() });

  for (let run = 0; run < 2; run++) {
    const selected = await handler.handleRequest({ query: "select Post { title }" }, makeContext());
    assertEquals(selected.errors, undefined);
    assertEquals(selected.data, []);

    const updated = await handler.handleRequest({ query: "update Post filter .title = 'x' set { title := 't' }" }, makeContext());
    assertEquals(updated.errors, undefined);
    assertEquals(updated.data, { updated: 0 });
  }
});

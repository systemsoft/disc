/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The compiled-query, parse and EXPLAIN caches are keyed by the query text
 * (S14). They used to be keyed by `hashString`, Java's 32-bit `String.hashCode`,
 * under which `"Aa"` and `"BB"` collide — and so do any two query texts that
 * differ only by that substitution. The second query was then served the
 * first one's SQL and parameter names. On a server without auth every
 * caller shares one key space, so one client could poison a popular query
 * for the others.
 *
 * No PostgreSQL: a scripted pool records the SQL the handler runs.
 */

import { assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { hashString } from "../lib/query-cache.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import type { QueryContext } from "./types.ts";

/** Two query texts that collide under the old 32-bit key. */
const FIRST = "select 'Aa'";
const SECOND = "select 'BB'";

function recordingPool(statements: string[]): ConnectionPool {
  return {
    close: () => Promise.resolve(),
    initialize: () => Promise.resolve(),
    query: (sql: string) => {
      statements.push(sql);
      return Promise.resolve({ rowCount: 1, rows: [{ "?column?": "x" }] });
    }
  } as unknown as ConnectionPool;
}

function makeContext(): QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: "cache_key_collision",
    session: { createdAt: new Date(), database: "test_db", lastActivity: new Date(), sessionId: "cache_key_collision", variables: {} },
    startedAt: new Date()
  };
}

Deno.test("cache keys - the two texts really collide under hashString", () => {
  assertEquals(hashString(FIRST), hashString(SECOND));
});

Deno.test("cache keys - colliding query texts compile to their own SQL", async () => {
  const statements: string[] = [];
  const handler = new EdgeQLProtocolHandler({ connectionPool: recordingPool(statements) });

  const first = await handler.handleRequest({ query: FIRST }, makeContext());
  const second = await handler.handleRequest({ query: SECOND }, makeContext());

  assertEquals(first.errors, undefined, JSON.stringify(first.errors));
  assertEquals(second.errors, undefined, JSON.stringify(second.errors));
  assertEquals(first.extensions?.cacheHit, false);
  assertEquals(second.extensions?.cacheHit, false, "a different text is never a cache hit");
  assertStringIncludes(statements[0], "'Aa'");
  assertStringIncludes(statements[1], "'BB'");
  assertNotEquals(first.extensions?.queryHash, second.extensions?.queryHash);

  // And the same text is still a hit.
  const repeat = await handler.handleRequest({ query: SECOND }, makeContext());
  assertEquals(repeat.extensions?.cacheHit, true);
  assertEquals(repeat.extensions?.queryHash, second.extensions?.queryHash);
});

Deno.test("cache keys - the reported queryHash is the SHA-256 hex digest of the text", async () => {
  const handler = new EdgeQLProtocolHandler({ connectionPool: recordingPool([]) });
  const response = await handler.handleRequest({ query: FIRST }, makeContext());
  assertEquals(response.extensions?.queryHash, await sha256Hex(FIRST));
});

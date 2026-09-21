/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `executeBinaryQuery` — the entry point the Gel binary listener uses — shares
 * one compiler (and so one access context) with the HTTP path, and has no
 * request context of its own. It must not compile under whatever context the
 * last HTTP caller left behind, and it must honor read-only mode.
 *
 * No PostgreSQL: a recording pool captures the SQL.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import type { AuthContext, QueryContext } from "./types.ts";

const SDL = `
type Note {
  required title: str;
}
type Doc {
  required owner_id: str;
  required title: str;
  access policy owner_only {
    allow all;
    using (.owner_id = global current_user);
  }
}
`;

const USER_A = "aaaaaaaa-0000-0000-0000-000000000001";

async function makeHandler(options: { readOnly?: boolean; } = {}): Promise<{ handler: EdgeQLProtocolHandler; statements: string[]; }> {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL(SDL);
  if (!parsed.ok) {
    throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
  }

  const statements: string[] = [];
  const pool = {
    close: () => Promise.resolve(),
    initialize: () => Promise.resolve(),
    query: (sql: string) => {
      statements.push(sql.replace(/\s+/g, " "));
      return Promise.resolve({ rowCount: 0, rows: [] });
    }
  } as unknown as ConnectionPool;

  const handler = new EdgeQLProtocolHandler({
    connectionPool: pool,
    enableAccessPolicies: true,
    readOnly: options.readOnly,
    schema: manager.modulesToSchema(parsed.value)
  });
  return { handler, statements };
}

function makeContext(auth: Partial<AuthContext>, bypass = false): QueryContext {
  return {
    auth: { permissions: [], roles: [], ...auth },
    bypassAccessPolicies: bypass,
    requestId: "binary_query_context",
    session: {
      createdAt: new Date(),
      database: "test",
      lastActivity: new Date(),
      sessionId: "binary_query_context",
      variables: {}
    },
    startedAt: new Date()
  };
}

Deno.test("executeBinaryQuery - does not inherit a bypass from the previous HTTP caller", async () => {
  const { handler, statements } = await makeHandler();

  await handler.handleRequest({ query: "select Doc { title }" }, makeContext({ roles: ["admin"], userId: USER_A }, true));
  assert(!statements.at(-1)!.includes("WHERE"), `precondition: the admin's query is unfiltered: ${statements.at(-1)}`);

  await handler.executeBinaryQuery("select Doc { owner_id, title }", {});
  assert(statements.at(-1)!.includes("WHERE"), `the binary query ran without the select policy: ${statements.at(-1)}`);

  // An anonymous caller has no `global current_user`, so the owner policy allows it no write at all.
  const executed = statements.length;
  await assertRejects(() => handler.executeBinaryQuery("update Doc set { title := 'taken' }", {}), Error, "UPDATE not allowed on Doc");
  assertEquals(statements.length, executed, "the denied update must not reach the database");
});

Deno.test("executeBinaryQuery - does not run as the previous HTTP caller", async () => {
  const { handler, statements } = await makeHandler();

  await handler.handleRequest({ query: "select Doc { title }" }, makeContext({ userId: USER_A }));
  assert(statements.at(-1)!.includes(USER_A), `precondition: A's query is scoped to A: ${statements.at(-1)}`);

  await handler.executeBinaryQuery("select Doc { owner_id, title }", {});
  assert(!statements.at(-1)!.includes(USER_A), `the binary query was compiled as the last HTTP user: ${statements.at(-1)}`);
  assert(statements.at(-1)!.includes("WHERE"), `the binary query ran without the select policy: ${statements.at(-1)}`);
});

Deno.test("executeBinaryQuery - read-only mode rejects writes, nested ones included, before they reach the database", async () => {
  const { handler, statements } = await makeHandler({ readOnly: true });

  for (
    const write of [
      "insert Note { title := 't' }",
      "update Note set { title := 'y' }",
      "delete Note",
      "with u := (update Note set { title := 'y' }) select u"
    ]
  ) {
    await assertRejects(() => handler.executeBinaryQuery(write, {}), Error, "read-only mode", write);
  }
  assertEquals(statements, []);

  await handler.executeBinaryQuery("select Note { title }", {});
  assertEquals(statements.length, 1, "reads still run in read-only mode");
});

Deno.test("executeBinaryQuery - writes run when the server is not read-only", async () => {
  const { handler, statements } = await makeHandler();
  await handler.executeBinaryQuery("delete Note", {});
  assertEquals(statements.length, 1);
});

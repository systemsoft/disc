/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * The simple protocol handler (`DISC_PROTOCOL=simple`) writes a shape's names
 * and the request's variables into its SQL; each must stay inside its quotes.
 * A backtick-quoted EdgeQL name can hold any character but a backtick.
 */

import { assertEquals } from "@std/assert";
import { createTestSchema } from "../compiler/context.ts";
import { SimpleEdgeQLProtocolHandler, substituteVariables } from "./simple-edgeql-protocol.ts";
import type * as Types from "./types.ts";

function makeContext(): Types.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: "simple-test",
    session: { createdAt: new Date(), database: "disc", lastActivity: new Date(), sessionId: "simple-test", variables: {} },
    startedAt: new Date()
  };
}

/*** The SQL the handler runs for `query`. ***/
async function sqlOf(query: string, variables?: Record<string, unknown>): Promise<string> {
  const handler = new SimpleEdgeQLProtocolHandler({ dryRun: true, schema: createTestSchema() });
  const response = await handler.handleRequest({ query, variables }, makeContext());
  return (response.data as { sql: string; }).sql;
}

Deno.test("simple protocol: a shape's names are a quoted key and a quoted column", async () => {
  assertEquals(await sqlOf("select User { name }"), `SELECT jsonb_build_object('name', "name") FROM users`);
  assertEquals(
    await sqlOf("select User { `a'b\"c` }"),
    `SELECT jsonb_build_object('a''b"c', "a'b""c") FROM users`
  );
});

Deno.test("simple protocol: a variable is a string literal with its quotes doubled, whatever it holds", () => {
  // Only a number or boolean is written bare; anything else is quoted, and a
  // `$name` inside a value is not substituted again.
  assertEquals(
    substituteVariables("a = $a, b = $b, c = $c, d = $d, e = $e", { a: "x'y", b: 1.5, c: ["1) OR (1"], d: "$a", e: true }),
    `a = 'x''y', b = 1.5, c = '["1) OR (1"]', d = '$a', e = true`
  );
  assertEquals(substituteVariables("$ab = $a, $n", { a: "1", n: null }), "$ab = '1', NULL");
});

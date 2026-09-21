/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the server-wide read-only-mode gate.
 * Ports geldata/gel#5543 (gh/geldata#5524).
 */

import { assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { SimpleEdgeQLProtocolHandler } from "./simple-edgeql-protocol.ts";
import type { QueryContext } from "./types.ts";

function makeContext(): QueryContext {
  return {
    session: {
      id: "test-session",
      database: "test",
      module: "default",
      globals: {},
      config: {},
      aliases: {},
      transaction: null
    } as unknown as QueryContext["session"],
    auth: { roles: [], permissions: [] },
    requestId: "req-1",
    startedAt: new Date()
  };
}

Deno.test("readOnly=true — INSERT rejected with READ_ONLY_MODE", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    readOnly: true,
    dryRun: true
  });

  const result = await handler.handleRequest(
    { query: "INSERT User { name := 'alice' }" },
    makeContext()
  );

  assertEquals(result.errors?.length, 1);
  assertEquals(result.errors?.[0].extensions?.code, "READ_ONLY_MODE");
  assertEquals(result.errors?.[0].extensions?.queryKind, "InsertQuery");
});

Deno.test("readOnly=true — UPDATE rejected", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    readOnly: true,
    dryRun: true
  });

  const result = await handler.handleRequest(
    {
      query: "UPDATE User FILTER .id = <uuid>$id SET { name := 'bob' }",
      variables: { id: "00000000-0000-0000-0000-000000000000" }
    },
    makeContext()
  );

  assertEquals(result.errors?.[0].extensions?.code, "READ_ONLY_MODE");
});

Deno.test("readOnly=true — DELETE rejected", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    readOnly: true,
    dryRun: true
  });

  const result = await handler.handleRequest(
    {
      query: "DELETE User FILTER .id = <uuid>$id",
      variables: { id: "00000000-0000-0000-0000-000000000000" }
    },
    makeContext()
  );

  assertEquals(result.errors?.[0].extensions?.code, "READ_ONLY_MODE");
});

Deno.test("readOnly=true — SELECT proceeds (compiled, executed in dryRun)", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    readOnly: true,
    dryRun: true
  });

  const result = await handler.handleRequest(
    { query: "SELECT 1" },
    makeContext()
  );

  // Either errors are absent or none of them is the read-only-mode rejection.
  const hasReadOnlyError = (result.errors ?? []).some(
    e => e.extensions?.code === "READ_ONLY_MODE"
  );
  assertEquals(hasReadOnlyError, false);
});

Deno.test("readOnly=false — INSERT not rejected by the read-only gate (default behavior)", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({ dryRun: true });

  const result = await handler.handleRequest(
    { query: "INSERT User { name := 'alice' }" },
    makeContext()
  );

  // It may fail downstream for other reasons (no real DB in dryRun), but
  // not with the READ_ONLY_MODE code.
  const hasReadOnlyError = (result.errors ?? []).some(
    e => e.extensions?.code === "READ_ONLY_MODE"
  );
  assertEquals(hasReadOnlyError, false);
});

// Nested writes: a mutation bound in a `with` block (or wrapped in a select)
// is still a write and must not pass the gate on either handler.

const NESTED_WRITES = [
  "WITH u := (UPDATE User SET { name := 'bob' }) SELECT u",
  "WITH d := (DELETE User) SELECT d",
  "WITH i := (INSERT User { name := 'alice' }) SELECT i",
  "SELECT (UPDATE User SET { name := 'bob' }) { id }",
  "FOR n IN {'a'} UNION (WITH i := (INSERT User { name := n }) SELECT i)"
];

Deno.test("readOnly=true — nested writes rejected by the simple handler", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    readOnly: true,
    dryRun: true
  });

  for (const query of NESTED_WRITES) {
    const result = await handler.handleRequest({ query }, makeContext());
    assertEquals(result.errors?.[0].extensions?.code, "READ_ONLY_MODE", query);
  }
});

Deno.test("readOnly=true — nested writes rejected by the full handler", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL("type User { required name: str; }");
  if (!parsed.ok) {
    throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
  }

  const handler = new EdgeQLProtocolHandler({
    dryRun: true,
    readOnly: true,
    schema: manager.modulesToSchema(parsed.value)
  });

  for (const query of NESTED_WRITES) {
    const result = await handler.handleRequest({ query }, makeContext());
    assertEquals(result.errors?.[0].extensions?.code, "READ_ONLY_MODE", query);
  }
});

Deno.test("readOnly=true — with-bound SELECT still proceeds on the full handler", async () => {
  const manager = new SchemaManager({ dryRun: true });
  await manager.initialize();
  const parsed = manager.parseSDL("type User { required name: str; }");
  if (!parsed.ok) {
    throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
  }

  const handler = new EdgeQLProtocolHandler({
    dryRun: true,
    readOnly: true,
    schema: manager.modulesToSchema(parsed.value)
  });

  const result = await handler.handleRequest(
    { query: "WITH u := (SELECT User FILTER .name = 'bob') SELECT u" },
    makeContext()
  );

  const hasReadOnlyError = (result.errors ?? []).some(
    e => e.extensions?.code === "READ_ONLY_MODE"
  );
  assertEquals(hasReadOnlyError, false);
});

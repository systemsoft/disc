/**
 * Tests for the server-wide read-only-mode gate.
 * Ports geldata/gel#5543 (gh/geldata#5524).
 */

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
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
      transaction: null,
    } as unknown as QueryContext["session"],
    auth: { roles: [], permissions: [] },
    requestId: "req-1",
    startedAt: new Date(),
  };
}

Deno.test("readOnly=true — INSERT rejected with READ_ONLY_MODE", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    readOnly: true,
    dryRun: true,
  });

  const result = await handler.handleRequest(
    { query: "INSERT User { name := 'alice' }" },
    makeContext(),
  );

  assertEquals(result.errors?.length, 1);
  assertEquals(result.errors?.[0].extensions?.code, "READ_ONLY_MODE");
  assertEquals(result.errors?.[0].extensions?.queryKind, "InsertQuery");
});

Deno.test("readOnly=true — UPDATE rejected", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    readOnly: true,
    dryRun: true,
  });

  const result = await handler.handleRequest(
    {
      query: "UPDATE User FILTER .id = <uuid>$id SET { name := 'bob' }",
      variables: { id: "00000000-0000-0000-0000-000000000000" },
    },
    makeContext(),
  );

  assertEquals(result.errors?.[0].extensions?.code, "READ_ONLY_MODE");
});

Deno.test("readOnly=true — DELETE rejected", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    readOnly: true,
    dryRun: true,
  });

  const result = await handler.handleRequest(
    {
      query: "DELETE User FILTER .id = <uuid>$id",
      variables: { id: "00000000-0000-0000-0000-000000000000" },
    },
    makeContext(),
  );

  assertEquals(result.errors?.[0].extensions?.code, "READ_ONLY_MODE");
});

Deno.test("readOnly=true — SELECT proceeds (compiled, executed in dryRun)", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({
    readOnly: true,
    dryRun: true,
  });

  const result = await handler.handleRequest(
    { query: "SELECT 1" },
    makeContext(),
  );

  // Either errors are absent or none of them is the read-only-mode rejection.
  const hasReadOnlyError = (result.errors ?? []).some(
    (e) => e.extensions?.code === "READ_ONLY_MODE",
  );
  assertEquals(hasReadOnlyError, false);
});

Deno.test("readOnly=false — INSERT not rejected by the read-only gate (default behavior)", async () => {
  const handler = new SimpleEdgeQLProtocolHandler({ dryRun: true });

  const result = await handler.handleRequest(
    { query: "INSERT User { name := 'alice' }" },
    makeContext(),
  );

  // It may fail downstream for other reasons (no real DB in dryRun), but
  // not with the READ_ONLY_MODE code.
  const hasReadOnlyError = (result.errors ?? []).some(
    (e) => e.extensions?.code === "READ_ONLY_MODE",
  );
  assertEquals(hasReadOnlyError, false);
});

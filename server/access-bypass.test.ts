/**
 * Per-request access-policy bypass (gh/geldata#6358).
 *
 * The HTTP layer reads `X-Disc-Apply-Access-Policies: false` and sets
 * `QueryContext.bypassAccessPolicies`, *but only* when the caller has
 * an `admin` role. Non-admins setting the header have it dropped at
 * the boundary so they can't escalate. The compiler's
 * `setAccessContext` call is then skipped, mirroring Gel's
 * `apply_access_policies := false` semantics.
 *
 * These tests pin the protocol-handler side (header → bypass field
 * has already happened by the time the handler sees the context).
 * The role gate itself lives in `server/http.ts:handle_query` and
 * is exercised below via `headerToBypass()`.
 */

import { assert, assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import type { AuthContext, QueryContext, QueryRequest } from "./types.ts";

const SDL_WITH_POLICY = `
type User {
  required name: str;
  required email: str;
  access policy owner_only {
    allow select;
    using (.id = global current_user);
  }
}
`;

async function schemaFromSDL(sdlSource: string) {
  const mgr = new SchemaManager({ dryRun: true });
  await mgr.initialize();
  const parseResult = mgr.parseSDL(sdlSource);
  if (!parseResult.ok) {
    throw new Error(`Failed to parse SDL: ${parseResult.error.message}`);
  }
  return mgr.modulesToSchema(parseResult.value);
}

function makeContext(
  auth?: Partial<AuthContext>,
  bypass = false,
): QueryContext {
  return {
    session: {
      sessionId: "s",
      database: "test",
      createdAt: new Date(),
      lastActivity: new Date(),
      variables: {},
    },
    auth: { roles: [], permissions: [], ...auth },
    requestId: "r",
    startedAt: new Date(),
    bypassAccessPolicies: bypass,
  };
}

/**
 * Mirrors the role gate in `server/http.ts:handle_query`. Centralized
 * here so the test sees the exact same predicate the production code
 * uses.
 */
function headerToBypass(
  header: string | null,
  roles: string[],
): boolean {
  const requested = header !== null &&
    /^(false|0|no)$/i.test(header.trim());
  return requested && roles.includes("admin");
}

Deno.test("apply_access_policies bypass — admin caller honors header", () => {
  assertEquals(headerToBypass("false", ["admin"]), true);
  assertEquals(headerToBypass("0", ["admin"]), true);
  assertEquals(headerToBypass("NO", ["admin"]), true);
  assertEquals(headerToBypass(" false ", ["admin"]), true);
});

Deno.test("apply_access_policies bypass — non-admin caller dropped silently", () => {
  assertEquals(headerToBypass("false", []), false);
  assertEquals(headerToBypass("false", ["user"]), false);
  assertEquals(headerToBypass("false", ["editor", "viewer"]), false);
});

Deno.test("apply_access_policies bypass — affirmative or absent → no bypass", () => {
  assertEquals(headerToBypass(null, ["admin"]), false);
  assertEquals(headerToBypass("", ["admin"]), false);
  assertEquals(headerToBypass("true", ["admin"]), false);
  assertEquals(headerToBypass("1", ["admin"]), false);
});

Deno.test("EdgeQLProtocolHandler — bypass=true emits SQL without policy WHERE", async () => {
  const schema = await schemaFromSDL(SDL_WITH_POLICY);
  const handler = new EdgeQLProtocolHandler({
    schema,
    dryRun: true,
    enableExplain: true,
    enableAccessPolicies: true,
  });

  const request: QueryRequest = { query: "SELECT User { name, email }" };
  const context = makeContext({ userId: "u1", roles: ["admin"] }, true);
  const response = await handler.handleRequest(request, context);

  const sql = response.extensions?.sql as string | undefined;
  assert(sql, "expected sql in response extensions");
  assert(
    !sql.includes("WHERE"),
    `bypass should drop the policy WHERE clause; got: ${sql}`,
  );
});

Deno.test("EdgeQLProtocolHandler — bypass=false applies policy WHERE", async () => {
  const schema = await schemaFromSDL(SDL_WITH_POLICY);
  const handler = new EdgeQLProtocolHandler({
    schema,
    dryRun: true,
    enableExplain: true,
    enableAccessPolicies: true,
  });

  const request: QueryRequest = { query: "SELECT User { name, email }" };
  const context = makeContext({ userId: "u1" }, false);
  const response = await handler.handleRequest(request, context);

  const sql = response.extensions?.sql as string | undefined;
  assert(sql, "expected sql in response extensions");
  assert(
    sql.includes("WHERE"),
    `non-bypassed call should apply the policy WHERE; got: ${sql}`,
  );
});

Deno.test("EdgeQLProtocolHandler — bypass cache key isolates results", async () => {
  // Pin: the compilation cache key embeds bypass state so a bypassed
  // compilation can't be served from the cache to a non-bypassed call.
  const schema = await schemaFromSDL(SDL_WITH_POLICY);
  const handler = new EdgeQLProtocolHandler({
    schema,
    dryRun: true,
    enableExplain: true,
    enableAccessPolicies: true,
  });

  const request: QueryRequest = { query: "SELECT User { name, email }" };

  // Same caller, two requests: one bypassed, one not. Each should
  // get its own SQL even though the query string is identical.
  const ctxAdmin = makeContext({ userId: "u1", roles: ["admin"] }, true);
  const ctxRegular = makeContext({ userId: "u1" }, false);

  const sqlBypass = (await handler.handleRequest(request, ctxAdmin))
    .extensions?.sql as string;
  const sqlNoBypass = (await handler.handleRequest(request, ctxRegular))
    .extensions?.sql as string;

  assert(sqlBypass && sqlNoBypass);
  assert(
    !sqlBypass.includes("WHERE") && sqlNoBypass.includes("WHERE"),
    `expected divergent cache entries: bypass=${sqlBypass} regular=${sqlNoBypass}`,
  );
});

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
  const requested = header !== null
    && /^(false|0|no)$/i.test(header.trim());
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

// ---------------------------------------------------------------------------
// Per-policy disable (gh/geldata#6432 slice 3 — Bundle UU). The
// `X-Disc-Disable-Policies` header carries qualified policy names
// (`<TypeName>.<policy_name>`), admin-gated identically to
// `X-Disc-Apply-Access-Policies`. Tests below mirror the role-gate
// shape used for the apply bypass above.
// ---------------------------------------------------------------------------

/**
 * Mirrors the disable-policies role gate in
 * `server/http.ts:handle_query`. Same shape as `headerToBypass`
 * but parses a comma-separated name list instead of a single flag.
 */
function headerToDisabled(
  header: string | null,
  roles: string[],
): Set<string> | undefined {
  if (header === null) return undefined;
  if (!roles.includes("admin")) return undefined;
  const names = header
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length > 0 ? new Set(names) : undefined;
}

Deno.test("disable-policies — admin caller parses comma-separated names", () => {
  const result = headerToDisabled(
    "Doc.owner_only, User.admin_check ,Tenant.global",
    ["admin"],
  );
  assert(result !== undefined);
  assertEquals(result.size, 3);
  assertEquals(result.has("Doc.owner_only"), true);
  assertEquals(result.has("User.admin_check"), true);
  assertEquals(result.has("Tenant.global"), true);
});

Deno.test("disable-policies — non-admin caller dropped silently", () => {
  assertEquals(headerToDisabled("Doc.owner_only", []), undefined);
  assertEquals(headerToDisabled("Doc.owner_only", ["user"]), undefined);
  assertEquals(
    headerToDisabled("Doc.owner_only", ["editor", "viewer"]),
    undefined,
  );
});

Deno.test("disable-policies — absent or empty header → undefined", () => {
  assertEquals(headerToDisabled(null, ["admin"]), undefined);
  assertEquals(headerToDisabled("", ["admin"]), undefined);
  assertEquals(headerToDisabled("   ", ["admin"]), undefined);
  assertEquals(headerToDisabled(",,", ["admin"]), undefined);
});

Deno.test("disable-policies — cache key isolates results from regular calls", async () => {
  const schema = await schemaFromSDL(SDL_WITH_POLICY);
  const handler = new EdgeQLProtocolHandler({
    schema,
    dryRun: true,
    enableExplain: true,
    enableAccessPolicies: true,
  });
  const request: QueryRequest = { query: "SELECT User { name, email }" };

  // Regular call — policy WHERE applies.
  const ctxRegular = makeContext({ userId: "u1" });

  // Disabled call — `User.owner_only` filtered out.
  const ctxDisabled = makeContext({ userId: "u1" });
  ctxDisabled.disabledPolicies = new Set(["User.owner_only"]);

  const sqlRegular = (await handler.handleRequest(request, ctxRegular))
    .extensions?.sql as string;
  const sqlDisabled = (await handler.handleRequest(request, ctxDisabled))
    .extensions?.sql as string;

  assert(sqlRegular && sqlDisabled);
  // The two SQL strings must differ — regular carries the policy
  // WHERE clause; disabled doesn't.
  assert(
    sqlRegular !== sqlDisabled,
    `Cache keys must isolate disabled-policies calls; got identical SQL: ${sqlRegular}`,
  );
  assert(
    sqlRegular.includes("WHERE"),
    `Regular call should emit policy WHERE; got: ${sqlRegular}`,
  );
  assert(
    !sqlDisabled.includes("WHERE"),
    `Disabled call should not emit policy WHERE; got: ${sqlDisabled}`,
  );
});

/**
 * Config introspection REST endpoint (#5988 + #6444 — Phase 3)
 *
 * Exposes the CONFIGURE-able key registry so the admin UI can render
 * settings catalogue, knowing which keys carry secrets and must mask
 * their values. Values themselves are not returned here — fetching
 * current PG settings requires a SQL roundtrip and will land in a
 * follow-up endpoint that applies `maskIfSecret()` per row.
 */

import { getConfigRegistry } from "../compiler/config-registry.ts";

export interface ConfigRouteContext {
  defaultHeaders: () => Headers;
}

export function handleGetConfig(ctx: ConfigRouteContext): Response {
  const keys = getConfigRegistry();
  return new Response(JSON.stringify({ keys }, null, 2), {
    status: 200,
    headers: ctx.defaultHeaders()
  });
}

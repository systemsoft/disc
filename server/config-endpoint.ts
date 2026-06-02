/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Config introspection REST endpoint (#5988 + #6444 — Phase 3 + 4)
 *
 * Exposes the CONFIGURE-able key registry so the admin UI can render the
 * settings catalogue, knowing which keys carry secrets and must mask
 * their values.
 *
 * Phase 4 (this file): each key now also carries its live `currentValue`,
 * read from PostgreSQL via the injected `fetchCurrentValues` roundtrip
 * (`SELECT current_setting(name) FROM pg_settings`). Values are passed
 * through `maskIfSecret()` so secret keys never leave the server — the
 * masking contract is enforced here, not in the browser. When no pool is
 * configured (dry-run mode) the fetcher is omitted and every key reports
 * `currentValue: null`.
 *
 * Phase 5 (this file): `handleSetConfig` accepts `{ name, value }` and
 * persists it via the injected `setValue` writer (`ALTER SYSTEM SET` +
 * reload). Unknown keys are rejected (400) and secret keys refused (403)
 * so the edit surface honors the same registry contract as the reader.
 */

import {
  getConfigRegistry,
  lookupConfigKey,
  maskIfSecret,
  type ConfigKeyDef
} from "../compiler/config-registry.ts";

/** A registry key augmented with its live (or masked/absent) value. */
export interface ConfigKeyWithValue extends ConfigKeyDef {
  /**
   * Live PostgreSQL value for this key. `null` when the key is secret
   * (masked server-side), when no pool is configured, or when PostgreSQL
   * does not expose a setting under `pgName`.
   */
  currentValue: string | null;
}

export interface ConfigRouteContext {
  defaultHeaders: () => Headers;
  /**
   * Resolve live PG setting values keyed by GUC name (`pgName`). Omitted
   * in dry-run / no-pool mode, in which case every `currentValue` is null.
   */
  fetchCurrentValues?: (
    pgNames: string[]
  ) => Promise<Map<string, string | null>>;
}

export async function handleGetConfig(
  ctx: ConfigRouteContext
): Promise<Response> {
  const registry = getConfigRegistry();

  let values = new Map<string, string | null>();
  if (ctx.fetchCurrentValues) {
    try {
      values = await ctx.fetchCurrentValues(registry.map(k => k.pgName));
    } catch {
      // A failed value roundtrip must not blank the whole catalogue: the
      // UI still renders metadata and shows "(unavailable)" per key.
      values = new Map();
    }
  }

  const keys: ConfigKeyWithValue[] = registry.map(k => ({
    ...k,
    // maskIfSecret fail-closes: secret keys (and unknown keys) collapse to
    // null, so a secret value is never serialized over the wire.
    currentValue: maskIfSecret(
      k.name,
      values.get(k.pgName) ?? null
    ) as string | null
  }));

  return new Response(JSON.stringify({ keys }, null, 2), {
    status: 200,
    headers: ctx.defaultHeaders()
  });
}

export interface ConfigWriteRouteContext {
  defaultHeaders: () => Headers;
  /**
   * Persist `value` for the given GUC name and return the now-live value
   * plus whether a restart is still required. Throws when no pool is
   * configured or PostgreSQL rejects the value.
   */
  setValue: (
    pgName: string,
    value: string
  ) => Promise<{ value: string | null; pendingRestart: boolean; }>;
}

/** Largest accepted config value; guards against abusive payloads. */
const MAX_CONFIG_VALUE_LENGTH = 1024;

/**
 * Handle `POST /config` — persist a single setting. `body` is the parsed
 * request JSON: `{ name: string, value: string }` where `name` is the
 * EdgeQL key (not the PG GUC name). Validation mirrors the registry
 * contract: unknown keys 400, secret keys 403. PostgreSQL value-rejection
 * (e.g. an out-of-range or malformed value) surfaces as 400.
 */
export async function handleSetConfig(
  body: unknown,
  ctx: ConfigWriteRouteContext
): Promise<Response> {
  const headers = ctx.defaultHeaders();
  const fail = (status: number, message: string): Response => new Response(JSON.stringify({ error: message }), { status, headers });

  if (typeof body !== "object" || body === null) {
    return fail(400, "Request body must be a JSON object");
  }
  const { name, value } = body as { name?: unknown; value?: unknown; };
  if (typeof name !== "string" || name.length === 0) {
    return fail(400, "Field 'name' (string) is required");
  }
  if (typeof value !== "string") {
    return fail(400, "Field 'value' (string) is required");
  }
  if (value.length > MAX_CONFIG_VALUE_LENGTH) {
    return fail(
      400,
      `Value exceeds maximum length of ${MAX_CONFIG_VALUE_LENGTH}`
    );
  }

  const def = lookupConfigKey(name);
  if (!def) {
    return fail(400, `Unknown configuration key: ${name}`);
  }
  if (def.secret) {
    return fail(
      403,
      `Configuration key '${name}' is secret and cannot be edited here`
    );
  }

  try {
    const result = await ctx.setValue(def.pgName, value);
    return new Response(
      JSON.stringify(
        {
          name: def.name,
          currentValue: result.value,
          pendingRestart: result.pendingRestart
        },
        null,
        2
      ),
      { status: 200, headers }
    );
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : String(err));
  }
}

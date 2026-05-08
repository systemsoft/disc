/**
 * Migration history REST endpoint.
 *
 * GET /migrations — returns the applied-migration history as JSON,
 * sourced from the live `disc_migrations` table via MigrationTracker.
 * Used by the admin UI's migrations page; analogous to the schema
 * introspection endpoints in `schema-endpoint.ts`.
 */

import type { MigrationHistoryEntry } from "../migration/types.ts";

/** A function that returns the current migration history. */
export type MigrationsProvider = () => Promise<MigrationHistoryEntry[]>;

export interface MigrationsRouteContext {
  migrationsProvider: MigrationsProvider;
  defaultHeaders: () => Headers;
}

/**
 * Handle GET /migrations — returns the applied migration history.
 * Returns 503 if the provider throws (typically: tracker not yet
 * initialized because no schema has been applied).
 */
export async function handleGetMigrations(
  ctx: MigrationsRouteContext
): Promise<Response> {
  try {
    const history = await ctx.migrationsProvider();
    return new Response(JSON.stringify({ migrations: history }, null, 2), {
      status: 200,
      headers: ctx.defaultHeaders()
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({
        error: "Migration history unavailable",
        details: message
      }),
      {
        status: 503,
        headers: ctx.defaultHeaders()
      }
    );
  }
}

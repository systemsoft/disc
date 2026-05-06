/**
 * Live data-watch SSE endpoint (Bundle L — Disc-original feature #3c).
 *
 * `GET /admin/data-watch?tables=users,posts` — server-sent event
 * stream that fires `invalidate` events whenever any of the named
 * tables receive an INSERT/UPDATE/DELETE.
 *
 * Wire pattern:
 *   1. Client opens an EventSource subscribed to a comma-separated
 *      list of table names (lowercased PG names — same form the
 *      schema browser shows).
 *   2. Server immediately emits `ready` with the resolved table set
 *      so the client knows what it's watching.
 *   3. On each batched mutation, server emits `invalidate` with the
 *      affected subset.
 *   4. Heartbeats every 30 seconds keep the connection through any
 *      proxies (`X-Accel-Buffering: no` already disables buffering
 *      at the response level).
 *
 * Uses `DataWatchRegistry` for fanout; this module is a thin SSE
 * shim around the registry.
 *
 * Auth: gated by the standard `requireAuth` flow up in `server/http.ts`
 * (same as the schema-watch endpoint). Unauthenticated callers in
 * permissive mode can still connect — same default as Bundle K — but
 * production deploys should pair `enable_data_watch=true` with
 * `require_auth=true`.
 */

import { DataWatchRegistry } from "./data-watch-registry.ts";
import { formatSseEvent } from "./schema-watch.ts";
import { getLogger } from "../../lib/logger.ts";

const log = getLogger("admin/data-watch");

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_TABLES_PER_SUB = 100;

export interface DataWatchOptions {
  /** The shared registry — owned by the server, not per-request. */
  registry: DataWatchRegistry;
  /** The request URL (parsed to read `?tables=...`). */
  url: URL;
}

/**
 * Build the SSE Response. Returns a 400 if no `tables` param is
 * supplied — without it the subscription has nothing to do.
 */
export function handleDataWatch(options: DataWatchOptions): Response {
  const { registry, url } = options;

  const tablesParam = url.searchParams.get("tables");
  if (!tablesParam) {
    return new Response(
      JSON.stringify({
        error:
          "Missing required `tables` query parameter (comma-separated PG table names)",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const requestedTables = tablesParam
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (requestedTables.length === 0) {
    return new Response(
      JSON.stringify({ error: "`tables` must include at least one name" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  if (requestedTables.length > MAX_TABLES_PER_SUB) {
    return new Response(
      JSON.stringify({
        error:
          `Too many tables (${requestedTables.length} > ${MAX_TABLES_PER_SUB})`,
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const tableSet = new Set<string>(requestedTables);
  const subId = `dw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const encoder = new TextEncoder();
  let heartbeatTimer: number | undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Comment frame on connection — same as schema-watch.
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Initial `ready` event tells the client what it's actually
      // subscribed to (so any client-side mismatch surfaces fast).
      controller.enqueue(encoder.encode(formatSseEvent({
        event: "ready",
        data: { tables: requestedTables, subscriptionId: subId },
      })));

      registry.subscribe({
        id: subId,
        tables: tableSet,
        onInvalidate: (affectedTables) => {
          try {
            controller.enqueue(encoder.encode(formatSseEvent({
              event: "invalidate",
              data: { tables: affectedTables, at: Date.now() },
            })));
          } catch (err) {
            // Stream already closed — best-effort.
            log.debug("data-watch: invalidate enqueue failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        },
      });

      // Heartbeat: comment frame every 30s.
      heartbeatTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          // already closed
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      // Client disconnected — deregister + stop heartbeat.
      registry.unsubscribe(subId);
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    },
  });

  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  return new Response(stream, { status: 200, headers });
}

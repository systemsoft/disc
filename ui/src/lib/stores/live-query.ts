/**
 * Live query store (Bundle L — Disc-original feature #3c).
 *
 * Wraps a normal `/query` call with an `/admin/data-watch` SSE
 * subscription so the result auto-refetches when the underlying
 * tables change. The pattern is "invalidate-then-refetch" (à la SWR /
 * React Query) — the server tells the client *that* something
 * changed, and the client re-runs the query through the same pipeline
 * that ran it the first time. Access policies, read-only mode, and
 * the auth gate compose without any extra work.
 *
 * Usage:
 *
 *   const { store, refetch, close } = liveQuery({
 *     edgeql: 'select User { name }',
 *     tables: ['users'],
 *   });
 *   $: ({ data, status, error } = $store);
 *
 *   onDestroy(close);   // tear down the EventSource
 *
 * Status states:
 *   - "idle"        before initial fetch
 *   - "loading"     awaiting first response
 *   - "ready"       data available
 *   - "refetching"  invalidate fired, refetch in flight (data still
 *                   shows the previous snapshot for stable UX)
 *   - "error"       last fetch failed
 */

import { type Readable, writable } from "svelte/store";
import { discAPI } from "../api/client";

export type LiveQueryStatus =
  | "idle"
  | "loading"
  | "ready"
  | "refetching"
  | "error";

export interface LiveQueryState<T = unknown> {
  data: T | null;
  status: LiveQueryStatus;
  error: string | null;
  /** Wall-clock timestamp (ms) of the last successful refresh. */
  lastUpdatedAt: number | null;
  /**
   * Most recent invalidate-event tables. Useful for UI affordances
   * like "5 changes in `users`, refetching…".
   */
  lastInvalidatedTables: string[];
}

export interface LiveQueryOptions {
  /** EdgeQL query string. */
  edgeql: string;
  /** Variables for the EdgeQL query, if any. */
  variables?: Record<string, unknown>;
  /**
   * The set of PG table names this query depends on. Subscribers to
   * `/admin/data-watch` filter incoming invalidation events by this
   * set, so passing only the tables the query actually touches keeps
   * refetches tight.
   */
  tables: string[];
  /**
   * Override the API base URL (mainly for tests). Defaults to the
   * `discAPI`-resolved one.
   */
  baseUrl?: string;
}

export interface LiveQueryHandle<T = unknown> {
  store: Readable<LiveQueryState<T>>;
  refetch: () => Promise<void>;
  close: () => void;
}

/**
 * Open a live-query subscription. Caller is responsible for calling
 * `close()` when the component unmounts (an unclosed handle leaks an
 * EventSource and a poll subscription).
 */
export function liveQuery<T = unknown>(
  options: LiveQueryOptions
): LiveQueryHandle<T> {
  const initial: LiveQueryState<T> = {
    data: null,
    status: "idle",
    error: null,
    lastUpdatedAt: null,
    lastInvalidatedTables: []
  };
  const store = writable<LiveQueryState<T>>(initial);

  let eventSource: EventSource | null = null;
  let closed = false;
  // Track the in-flight fetch so we can ignore stale refetches if a
  // newer one fires in the middle of an old one's response.
  let inFlightToken = 0;

  async function runFetch(reason: "initial" | "refetch") {
    const token = ++inFlightToken;
    store.update(s => ({
      ...s,
      status: reason === "initial" ? "loading" : "refetching",
      error: null
    }));
    try {
      const result = await discAPI.executeQuery(
        options.edgeql,
        options.variables
      );
      if (closed || token !== inFlightToken)
        return;
      if (result.error) {
        store.update(s => ({
          ...s,
          status: "error",
          error: result.error ?? "Query failed"
        }));
        return;
      }
      store.update(s => ({
        ...s,
        data: (result.data as unknown as T) ?? null,
        status: "ready",
        error: null,
        lastUpdatedAt: Date.now()
      }));
    } catch (err) {
      if (closed || token !== inFlightToken)
        return;
      const message = err instanceof Error ? err.message : String(err);
      store.update(s => ({ ...s, status: "error", error: message }));
    }
  }

  function openEventSource() {
    if (closed)
      return;
    const params = new URLSearchParams({
      tables: options.tables.join(",")
    });
    const url = `${options.baseUrl ?? ""}/admin/data-watch?${params}`;
    eventSource = new EventSource(url);
    eventSource.addEventListener("ready", () => {
      // No-op — initial fetch is kicked off below.
    });
    eventSource.addEventListener("invalidate", event => {
      try {
        const payload = JSON.parse(
          (event as MessageEvent).data
        ) as { tables?: string[]; };
        store.update(s => ({
          ...s,
          lastInvalidatedTables: payload.tables ?? []
        }));
      } catch {
        // payload not JSON — fall through to refetch anyway
      }
      void runFetch("refetch");
    });
    eventSource.addEventListener("error", () => {
      // EventSource auto-reconnects on transient errors. Surface a
      // soft signal but don't tear down — wait for `close()`.
      store.update(s => ({
        ...s,
        error: s.error ?? "Live connection lost; reconnecting…"
      }));
    });
  }

  // Kick off in parallel: initial fetch + subscribe.
  void runFetch("initial");
  openEventSource();

  return {
    store,
    refetch: () => runFetch("refetch"),
    close: () => {
      if (closed)
        return;
      closed = true;
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    }
  };
}

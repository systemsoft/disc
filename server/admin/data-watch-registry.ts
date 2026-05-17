/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * DataWatchRegistry — Bundle L (Disc-original feature #3c).
 *
 * Server-side subscription registry for live data invalidations. Each
 * SSE client registers an interest in a set of tables; the registry
 * polls `disc_change_log` (~250ms) for new rows and fans an
 * `invalidate` event out to every subscriber whose interested-tables
 * set intersects the current poll's affected tables.
 *
 * Single channel, single polling connection: scales linearly with the
 * number of mutations (not subscribers). Each subscriber is a Map
 * entry pointing at a callback — fanout is O(subscribers per poll).
 *
 * Debounce: when one mutation triggers many `invalidate` events on the
 * same subscription, we coalesce them in a 250ms window so the client
 * doesn't refetch on every keystroke during a bulk import. This is
 * separate from the poll cadence: the poll happens on its own clock,
 * the debounce filters bursts at the subscriber boundary.
 */

import { ConnectionPool } from "../../lib/connection-pool.ts";
import { getLogger } from "../../lib/logger.ts";
import { CHANGE_LOG_TABLE, pruneChangeLog } from "./data-watch-ddl.ts";

const log = getLogger("admin/data-watch-registry");

/** Interval at which we poll the change-log. */
const DEFAULT_POLL_INTERVAL_MS = 250;

/** How long a single subscription waits before coalescing invalidations. */
const DEFAULT_INVALIDATE_DEBOUNCE_MS = 250;

/** How often we prune old log rows (1 hour lookback). */
const DEFAULT_PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export interface DataWatchSubscriber {
  /** Stable id used to deregister. */
  id: string;
  /** Set of tables this subscriber cares about (lowercased PG names). */
  tables: Set<string>;
  /** Called when one or more interested tables changed. */
  onInvalidate: (affectedTables: string[]) => void;
}

export interface DataWatchRegistryOptions {
  /** Pool to query the change-log through. */
  pool: ConnectionPool;
  /** Override the poll interval (ms). Defaults to 250. */
  pollIntervalMs?: number;
  /** Override the per-subscriber debounce (ms). Defaults to 250. */
  invalidateDebounceMs?: number;
  /** Override the prune interval (ms). Defaults to 5 minutes. */
  pruneIntervalMs?: number;
  /** Lookback window for pruning, in seconds. Defaults to 1 hour. */
  pruneLookbackSeconds?: number;
}

/**
 * In-memory subscription registry + polling loop.
 *
 * Lifecycle: callers construct it once at server start, call `start()`
 * to kick off polling, register subscribers via `subscribe()` /
 * `unsubscribe()`, and call `stop()` on shutdown.
 *
 * Multiple instances are not expected and not isolated — the change-log
 * table is global. If you need to run multiple servers against one
 * Postgres they'll all see each other's invalidations, which is the
 * correct behavior (a write from server A should invalidate caches on
 * server B too).
 */
export class DataWatchRegistry {
  private pool: ConnectionPool;
  private pollIntervalMs: number;
  private invalidateDebounceMs: number;
  private pruneIntervalMs: number;
  private pruneLookbackSeconds: number;

  private subscribers = new Map<string, DataWatchSubscriber>();
  private debounceTimers = new Map<string, number>();
  private pendingInvalidations = new Map<string, Set<string>>();

  /** Cursor: rows newer than this id have not yet been processed. */
  private lastSeenId = 0;
  private pollTimer?: number;
  private pruneTimer?: number;
  private polling = false;
  private stopped = false;

  constructor(options: DataWatchRegistryOptions) {
    this.pool = options.pool;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.invalidateDebounceMs = options.invalidateDebounceMs ??
      DEFAULT_INVALIDATE_DEBOUNCE_MS;
    this.pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
    this.pruneLookbackSeconds = options.pruneLookbackSeconds ?? 3600;
  }

  /**
   * Initialize the polling cursor and start the background loop.
   *
   * The cursor is set to the current MAX(id) so we don't replay
   * history at boot — subscribers only see invalidations that happen
   * after they connect.
   */
  async start(): Promise<void> {
    if (this.pollTimer !== undefined) {
      return; // already started
    }
    this.stopped = false;

    try {
      const result = await this.pool.query(
        `SELECT COALESCE(MAX(id), 0)::bigint AS cur FROM ${CHANGE_LOG_TABLE}`
      );
      // Defensive: row may be missing in test mocks. Treat absence
      // as cursor 0 (replay nothing — same outcome as a fresh DB).
      const cur = result.rows[0]?.cur;
      this.lastSeenId = cur === undefined || cur === null ? 0 : Number(cur);
    } catch (err) {
      // Table missing → bootstrap not run yet. The registry can still
      // start; the next successful poll (after bootstrap) will pick
      // up invalidations.
      log.warn("data-watch: failed to read initial cursor", {
        error: err instanceof Error ? err.message : String(err)
      });
    }

    this.pollTimer = setInterval(
      () => void this.pollOnce(),
      this.pollIntervalMs
    );
    this.pruneTimer = setInterval(
      () => void this.runPrune(),
      this.pruneIntervalMs
    );
  }

  /** Stop the polling + prune loops; clear all subscribers + debounce timers. */
  stop(): void {
    this.stopped = true;
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    for (const id of this.debounceTimers.values()) {
      clearTimeout(id);
    }
    this.debounceTimers.clear();
    this.pendingInvalidations.clear();
    this.subscribers.clear();
  }

  /** Register a subscriber. Returns the (caller-supplied) id for symmetry. */
  subscribe(subscriber: DataWatchSubscriber): string {
    this.subscribers.set(subscriber.id, subscriber);
    return subscriber.id;
  }

  /** Deregister a subscriber and cancel any pending debounce timer. */
  unsubscribe(id: string): void {
    this.subscribers.delete(id);
    const timer = this.debounceTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.debounceTimers.delete(id);
    }
    this.pendingInvalidations.delete(id);
  }

  /** Number of currently-registered subscribers. Exposed for tests + /stats. */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Run a single poll. Public so tests can drive it deterministically
   * without waiting for setInterval. Skips its own body if already
   * polling (no-op overlap protection).
   */
  async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) {
      return;
    }
    this.polling = true;
    try {
      const result = await this.pool.query(
        `SELECT id, table_name FROM ${CHANGE_LOG_TABLE}
         WHERE id > $1 ORDER BY id LIMIT 1000`,
        [String(this.lastSeenId)]
      );
      if (result.rows.length === 0) {
        return;
      }

      // Collect distinct affected tables across this poll.
      const affected = new Set<string>();
      let maxId = this.lastSeenId;
      for (
        const row of result.rows as Array<
          { id: number | string; table_name: string; }
        >
      ) {
        affected.add(row.table_name);
        const idNum = Number(row.id);
        if (idNum > maxId) {
          maxId = idNum;
        }
      }
      this.lastSeenId = maxId;

      // Fan out: for each subscriber whose interested-tables intersect
      // `affected`, schedule a debounced invalidate.
      for (const sub of this.subscribers.values()) {
        const intersect: string[] = [];
        for (const t of affected) {
          if (sub.tables.has(t)) {
            intersect.push(t);
          }
        }
        if (intersect.length > 0) {
          this.scheduleInvalidate(sub.id, intersect);
        }
      }
    } catch (err) {
      // Don't blow up the timer; just log.
      log.warn("data-watch: poll failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      this.polling = false;
    }
  }

  /**
   * Buffer an invalidation for a subscriber and schedule a coalesced
   * delivery. Repeated calls within the debounce window union the
   * affected-tables sets and reset the timer.
   */
  private scheduleInvalidate(subId: string, tables: string[]): void {
    let pending = this.pendingInvalidations.get(subId);
    if (!pending) {
      pending = new Set();
      this.pendingInvalidations.set(subId, pending);
    }
    for (const t of tables) {
      pending.add(t);
    }

    const existing = this.debounceTimers.get(subId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(subId);
      const sub = this.subscribers.get(subId);
      const buf = this.pendingInvalidations.get(subId);
      this.pendingInvalidations.delete(subId);
      if (sub && buf && buf.size > 0) {
        try {
          sub.onInvalidate([...buf]);
        } catch (err) {
          log.warn("data-watch: subscriber callback threw", {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      }
    }, this.invalidateDebounceMs);
    this.debounceTimers.set(subId, timer);
  }

  private async runPrune(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await pruneChangeLog(this.pool, this.pruneLookbackSeconds);
    } catch (err) {
      log.warn("data-watch: prune failed", {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
}

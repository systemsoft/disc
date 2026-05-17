/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Live schema-watch SSE endpoint (Bundle K — Disc-original feature #3a).
 *
 * Streams a structured diff between the running server's applied
 * schema and whatever's currently on disk in the project's `.disc`
 * file. The admin UI subscribes via Server-Sent Events and re-renders
 * each time the file changes.
 *
 * Picked SSE over WebSockets because the channel is one-way
 * (server → client) and a plain `EventSource` in the browser is
 * substantially simpler than an in-house WS message protocol.
 *
 * The watch loop coalesces `Deno.watchFs` events with a 250ms
 * debounce — a single editor save typically fires 3–4 raw events.
 */

import { getLogger } from "../../lib/logger.ts";
import { computeSchemaDiff, type SchemaDiffSummary } from "./schema-diff.ts";

const log = getLogger("admin/schema-watch");

const DEFAULT_DEBOUNCE_MS = 250;

export interface SchemaWatchOptions {
  /** Path to the SDL file to watch (e.g. `./dbschema/default.disc`). */
  schemaFilePath: string;
  /**
   * Provider that returns the SDL the running server believes is
   * applied. In production this is the source the server booted from
   * (cached in `DiscServer`); in tests it's whatever we want to diff
   * against.
   */
  appliedSdlProvider: () => string;
  /**
   * When `false`, the SSE stream emits the initial snapshot and then
   * closes. Used by unit tests to avoid spawning the watch loop.
   * Defaults to `true`.
   */
  runWatchLoop?: boolean;
  /** Coalesce filesystem events for this many milliseconds. Defaults to 250. */
  debounceMs?: number;
}

export interface SseFrame<T = unknown> {
  event: string;
  data: T;
  id?: string;
}

/**
 * Format a single SSE frame. Spec: each line prefixed with a field
 * name + colon, terminated by a blank line. Multi-line `data` fields
 * are emitted as multiple `data:` lines (we JSON-stringify the payload
 * which is single-line, so one is enough).
 */
export function formatSseEvent(frame: SseFrame): string {
  let out = "";
  if (frame.id) {
    out += `id: ${frame.id}\n`;
  }
  out += `event: ${frame.event}\n`;
  out += `data: ${JSON.stringify(frame.data)}\n`;
  out += "\n";
  return out;
}

interface WatchContext {
  schemaFilePath: string;
  appliedSdlProvider: () => string;
  debounceMs: number;
}

async function readOnDiskSdl(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}

async function emitDiff(
  ctx: WatchContext,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  eventName: string
): Promise<SchemaDiffSummary | null> {
  const onDiskSdl = await readOnDiskSdl(ctx.schemaFilePath);
  if (onDiskSdl === null) {
    controller.enqueue(encoder.encode(formatSseEvent({
      event: "error",
      data: { message: `Schema file not found: ${ctx.schemaFilePath}` }
    })));
    return null;
  }

  const appliedSdl = ctx.appliedSdlProvider();
  const diff = computeSchemaDiff(appliedSdl, onDiskSdl);
  controller.enqueue(encoder.encode(formatSseEvent({
    event: eventName,
    data: diff,
    id: String(Date.now())
  })));
  return diff;
}

/**
 * Build the SSE Response. The handler creates a ReadableStream and
 * (when `runWatchLoop` is true) starts a Deno.watchFs loop in the
 * background. The stream cancel callback aborts the loop.
 */
export function handleSchemaWatch(options: SchemaWatchOptions): Response {
  const ctx: WatchContext = {
    schemaFilePath: options.schemaFilePath,
    appliedSdlProvider: options.appliedSdlProvider,
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  };
  const runLoop = options.runWatchLoop ?? true;
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let watcher: Deno.FsWatcher | undefined;
  let debounceTimer: number | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Comment frame on connection — keeps long-lived proxies happy.
      controller.enqueue(encoder.encode(": connected\n\n"));

      // Initial snapshot.
      try {
        await emitDiff(ctx, controller, encoder, "snapshot");
      } catch (err) {
        log.warn("schema-watch: initial snapshot failed", {
          error: err instanceof Error ? err.message : String(err)
        });
      }

      if (!runLoop) {
        controller.close();
        return;
      }

      // Watch the *directory* containing the SDL file. Watching the
      // file directly works on macOS but is unreliable on Linux when
      // editors save via rename — the watched inode disappears and no
      // further events arrive.
      const dir = ctx.schemaFilePath.includes("/") ?
        ctx.schemaFilePath.slice(0, ctx.schemaFilePath.lastIndexOf("/")) :
        ".";

      try {
        watcher = Deno.watchFs([dir], { recursive: false });
      } catch (err) {
        controller.enqueue(encoder.encode(formatSseEvent({
          event: "error",
          data: {
            message: `watch failed: ${err instanceof Error ? err.message : String(err)}`
          }
        })));
        controller.close();
        return;
      }

      const enqueueDelta = async () => {
        try {
          await emitDiff(ctx, controller, encoder, "delta");
        } catch (err) {
          log.warn("schema-watch: delta emission failed", {
            error: err instanceof Error ? err.message : String(err)
          });
        }
      };

      const debounceDelta = () => {
        if (debounceTimer !== undefined) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(enqueueDelta, ctx.debounceMs);
      };

      // Run the watch loop without blocking `start`.
      (async () => {
        try {
          for await (const event of watcher!) {
            if (abortController.signal.aborted) {
              break;
            }
            // Filter for our SDL file and any peer .disc files in the dir.
            const matchedPath = event.paths.find(p => p === ctx.schemaFilePath || p.endsWith(".disc"));
            if (!matchedPath) {
              continue;
            }
            debounceDelta();
          }
        } catch (err) {
          if (!abortController.signal.aborted) {
            log.warn("schema-watch: watch loop terminated", {
              error: err instanceof Error ? err.message : String(err)
            });
          }
        } finally {
          if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer);
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      })();
    },
    cancel() {
      // Client disconnected — stop the watcher.
      abortController.abort();
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // already closed
        }
      }
    }
  });

  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Disable proxy buffering so events flush immediately.
    "X-Accel-Buffering": "no"
  });

  return new Response(stream, { status: 200, headers });
}

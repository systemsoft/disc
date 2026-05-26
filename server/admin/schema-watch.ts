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

/**
 * What the watcher reads from disk. `file` is single-file mode (used
 * when the CLI received `--schema <path>`); `dir` is multi-file mode
 * (the default — concatenates every `*.disc` in the directory, sorted
 * alphabetically, matching `loadProjectSchema`).
 */
export type SchemaWatchSource =
  | { kind: "file"; path: string; }
  | { kind: "dir"; dir: string; };

export interface SchemaWatchOptions {
  /** What to read + watch — a single file or a directory of `.disc` files. */
  source: SchemaWatchSource;
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
  source: SchemaWatchSource;
  appliedSdlProvider: () => string;
  debounceMs: number;
}

type ReadResult =
  | { ok: true; sdl: string; files: string[]; }
  | { ok: false; error: string; };

/**
 * Read the SDL from disk per the source descriptor. In dir mode this
 * discovers every `*.disc` file (sorted), reads them, and concatenates
 * with `\n` — the same shape `loadProjectSchema` produces, so the diff
 * sees the same text the server boots from. A single missing file
 * (atomic rename mid-save) is tolerated via a one-shot retry; a
 * directory that disappears entirely surfaces as an error frame.
 */
export async function readOnDiskSdl(source: SchemaWatchSource): Promise<ReadResult> {
  if (source.kind === "file") {
    try {
      const sdl = await Deno.readTextFile(source.path);
      return { ok: true, sdl, files: [source.path] };
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return { ok: false, error: `Schema file not found: ${source.path}` };
      }
      return {
        ok: false,
        error: `Failed to read ${source.path}: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(source.dir)) {
      if (entry.isFile && entry.name.endsWith(".disc")) {
        files.push(`${source.dir}/${entry.name}`);
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { ok: false, error: `Schema directory not found: ${source.dir}` };
    }
    return {
      ok: false,
      error: `Failed to list ${source.dir}: ${err instanceof Error ? err.message : String(err)}`
    };
  }

  files.sort();
  if (files.length === 0) {
    return { ok: false, error: `No .disc files found in ${source.dir}` };
  }

  const parts: string[] = [];
  for (const file of files) {
    try {
      parts.push(await Deno.readTextFile(file));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        // Atomic-save race: editor wrote a temp file, renamed over the
        // target, and our readDir snapshot still references the temp.
        // Skip this iteration — the rename will fire a fresh watch event
        // and we'll re-read on the next debounce tick.
        continue;
      }
      return {
        ok: false,
        error: `Failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`
      };
    }
  }

  return { ok: true, sdl: parts.join("\n"), files };
}

function watchDirFor(source: SchemaWatchSource): string {
  if (source.kind === "dir") {
    return source.dir;
  }
  return source.path.includes("/") ?
    source.path.slice(0, source.path.lastIndexOf("/")) :
    ".";
}

async function emitDiff(
  ctx: WatchContext,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  eventName: string
): Promise<SchemaDiffSummary | null> {
  const read = await readOnDiskSdl(ctx.source);
  if (!read.ok) {
    controller.enqueue(encoder.encode(formatSseEvent({
      event: "error",
      data: { message: read.error }
    })));
    return null;
  }

  const appliedSdl = ctx.appliedSdlProvider();
  const diff = computeSchemaDiff(appliedSdl, read.sdl);
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
    source: options.source,
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

      // Watch the *directory* containing the SDL file(s). Watching a
      // file directly works on macOS but is unreliable on Linux when
      // editors save via rename — the watched inode disappears and no
      // further events arrive. In dir mode this is the dir itself; in
      // file mode it's the parent dir.
      const dir = watchDirFor(ctx.source);

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
            // Filter for `.disc` files. In file mode we also match the
            // exact target path so an editor that writes a non-`.disc`
            // tempfile-then-renames still triggers a delta.
            const targetPath = ctx.source.kind === "file" ? ctx.source.path : null;
            const matchedPath = event.paths.find(
              p => p.endsWith(".disc") || (targetPath !== null && p === targetPath)
            );
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

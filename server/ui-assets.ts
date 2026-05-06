/**
 * UI asset request handler — Bundle I Phase 1.
 *
 * Serves the SvelteKit static build under the `/ui` path prefix. In a
 * compiled binary the asset bytes come from the `--include ui/build`
 * embed, accessed via `Deno.readFile(new URL(..., import.meta.url))`.
 * In development the same URL resolution falls back to the on-disk
 * path under `<repo>/ui/build/`.
 *
 * Only files in the static manifest (`UI_ASSET_SET`) are served. Unknown
 * paths return 404 if the request looks like a static asset (has a `.`
 * extension) or fall through to the SPA shell (`index.html`) otherwise,
 * so client-side router routes like `/ui/data/User` work.
 */

import { UI_ASSET_SET } from "./ui-asset-manifest.ts";

const UI_BASE_PATH = "/ui";
const INDEX_PATH = "index.html";

/**
 * Map of file extension → MIME type. Mirrors the existing
 * `ui/server-integration.ts` table; kept here so the new handler is
 * self-contained and the legacy filesystem-only handler can be retired
 * once callers have migrated.
 */
const CONTENT_TYPES: Record<string, string> = {
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * Resolve the MIME type for a UI asset by file extension.
 * Falls back to `application/octet-stream` for unknown extensions.
 */
export function getUiContentType(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * Read a UI asset by its manifest path (e.g. `index.html`,
 * `_app/version.json`). Returns the raw bytes or null when the file is
 * missing on disk (which shouldn't happen at runtime but is possible
 * during development if `ui/build/` was deleted).
 */
async function readUiAsset(relPath: string): Promise<Uint8Array | null> {
  // The build dir lives one directory above this file: server/ → ui/build.
  const url = new URL(`../ui/build/${relPath}`, import.meta.url);
  try {
    return await Deno.readFile(url);
  } catch {
    return null;
  }
}

export interface UiAssetHandler {
  (request: Request): Promise<Response | null>;
}

/**
 * Build a `/ui/...` route handler. Returns `null` for any request
 * outside the UI base path so the caller can chain it before its own
 * dispatcher.
 */
export function createUiAssetHandler(): UiAssetHandler {
  return async (request) => {
    const url = new URL(request.url);
    if (
      url.pathname !== UI_BASE_PATH && !url.pathname.startsWith(`${UI_BASE_PATH}/`)
    ) {
      return null;
    }

    // Strip `/ui` prefix and any leading slash. Empty path → index.
    let rel = url.pathname.slice(UI_BASE_PATH.length).replace(/^\/+/, "");
    if (rel === "") rel = INDEX_PATH;

    // Reject path traversal up front. The manifest set already excludes
    // anything containing `..`, but keeping this check makes intent
    // clear and protects against future manifest mistakes.
    if (rel.includes("..")) {
      return new Response("Not Found", { status: 404 });
    }

    const isKnown = UI_ASSET_SET.has(rel);
    let bytes: Uint8Array | null = null;
    let servedRel = rel;

    if (isKnown) {
      bytes = await readUiAsset(rel);
    }

    // SPA fallback: anything without a file extension that wasn't found
    // gets routed to index.html so client-side routers handle the path.
    if (!bytes && !rel.includes(".")) {
      bytes = await readUiAsset(INDEX_PATH);
      servedRel = INDEX_PATH;
    }

    if (!bytes) {
      return new Response("Not Found", { status: 404 });
    }

    const headers: HeadersInit = {
      "content-type": getUiContentType(servedRel),
      // SvelteKit fingerprints `_app/` assets so they're safe to cache
      // for a year. Everything else (notably `index.html`) is volatile.
      "cache-control": servedRel.startsWith("_app/") ? "public, max-age=31536000, immutable" : "no-cache",
    };

    // Wrap in a fresh Uint8Array<ArrayBuffer> view: Deno.readFile may
    // return Uint8Array<ArrayBufferLike> (which TypeScript narrows to
    // include SharedArrayBuffer), but Response only accepts the strict
    // ArrayBuffer-backed view. The .slice() copies into a regular
    // ArrayBuffer.
    const body = bytes.slice().buffer as ArrayBuffer;
    return new Response(body, { status: 200, headers });
  };
}

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Embedded Disc SDK extractor.
 *
 * The compiled `disc` binary embeds the SDK source files (sdk/*.ts,
 * minus `*.test.ts`) via `deno compile --include`. When `disc codegen`
 * writes a generated client, that client imports from `./sdk/mod.ts` —
 * a path that only resolves if the SDK files actually live next to the
 * generated output. This extractor materializes them at codegen time so
 * downstream projects don’t need a separate `jsr add` / `npm install`.
 *
 * Idempotency: a marker file (`.disc-sdk-marker`) holds two lines — the
 * disc binary version that wrote the SDK, and a SHA-256 over the embedded
 * SDK bytes. Re-extracting happens when the marker is missing, the version
 * differs, OR the content hash differs. The hash is what makes an SDK fix
 * shipped *within the same version* visible to an already-materialized
 * client — keying on the version alone silently stranded such changes.
 * Legacy single-line markers (version only) have no hash, so they always
 * re-extract once, which heals projects generated before this change.
 */

/*** NATIVE ------------------------------------------- ***/

import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";

const MARKER_FILE = ".disc-sdk-marker";

/*** EXPORT ------------------------------------------- ***/

export interface EmbeddedSdkEntry {
  /**
   * POSIX mode bits to set on the extracted file. Always `0o644` for
   * SDK sources — they’re read at runtime, never executed.
   */
  mode: number;
  /**
   * Path relative to the target directory (e.g. `client.ts`,
   * `mod.ts`). All entries are flat under `sdk/`; the SDK has no
   * subdirectories.
   */
  relPath: string;
  /**
   * Source URL to read from. In the compiled binary this resolves
   * through Deno’s embedded asset table; in development it’s a normal
   * `file://` URL pointing at the on-disk SDK source.
   */
  sourceUrl: URL;
}

export interface ExtractSdkResult {
  alreadyExtracted: boolean;
  extracted: number;
  targetDir: string;
}

/**
 * Extract every entry into `targetDir`, setting mode `0o644` on each
 * file. Returns counts so callers can log "first run" vs "no-op".
 *
 * Idempotency: we skip work only when the marker's version AND content
 * hash both match. A mismatch (binary upgraded, or the SDK changed within
 * the same version) triggers a re-extract so generated clients always
 * pair with the SDK that ships in the binary.
 *
 * Uses the manifest from `./embedded-sdk-manifest.ts`; importing it
 * lazily here keeps the test surface narrow (callers pass their own
 * entries to test, the production caller relies on the auto-generated
 * manifest via `extractEmbeddedSdk`).
 */
export async function extractEmbeddedSdk(targetDir: string, version: string): Promise<ExtractSdkResult> {
  const { EMBEDDED_SDK_MANIFEST } = await import("./embedded-sdk-manifest.ts");
  return await extractEmbeddedSdkWithEntries(targetDir, version, EMBEDDED_SDK_MANIFEST);
}

/**
 * Lower-level extractor used by tests so they can pass synthetic
 * manifest entries without writing files in the repo. The production
 * `extractEmbeddedSdk` wraps this and supplies `EMBEDDED_SDK_MANIFEST`.
 */
export async function extractEmbeddedSdkWithEntries(
  targetDir: string,
  version: string,
  entries: readonly EmbeddedSdkEntry[]
): Promise<ExtractSdkResult> {
  /*** Read every source up front so we can hash the embedded content before deciding whether to
       write. The reads are the bulk of the work either way; skipping only avoids the writes. ***/
  const files: Array<{ bytes: Uint8Array; mode: number; relPath: string; }> = [];
  for (const entry of entries) {
    files.push({
      bytes: await Deno.readFile(entry.sourceUrl),
      mode: entry.mode,
      relPath: entry.relPath
    });
  }

  const contentHash = await hashSdkContent(files);
  const marker = await readMarker(targetDir);

  /*** Skip only when BOTH the version and the embedded content are unchanged. Version alone was too
       coarse (same-version SDK fixes never reached the client); content alone would let a version
       bump skip a refresh of byte-identical files, which the upgrade flow relied on. ***/
  if (marker.version === version && marker.hash === contentHash) {
    return {
      alreadyExtracted: true,
      extracted: 0,
      targetDir
    };
  }

  await ensureDir(targetDir);
  let extracted = 0;

  for (const file of files) {
    const dest = join(targetDir, file.relPath);
    await ensureDir(dirname(dest));

    await Deno.writeFile(dest, file.bytes, { mode: file.mode });

    /*** Re-chmod after write because writeFile’s mode arg is honored only on creation; existing
         files keep their old mode. Belt-and-suspenders. ***/
    try {
      await Deno.chmod(dest, file.mode);
    } catch {
      /*** Some platforms (Windows) don’t support chmod — best-effort. ***/
    }

    extracted++;
  }

  /*** Marker file is the last write, so a partial extract that crashed halfway through won’t trick
       the next run into trusting the dir. Line 1 is the version (human-readable), line 2 the
       content hash (the actual change-detection key). ***/
  await Deno.writeTextFile(join(targetDir, MARKER_FILE), `${version}\n${contentHash}\n`);

  return {
    alreadyExtracted: false,
    extracted,
    targetDir
  };
}

/*** HELPER ------------------------------------------- ***/

interface MarkerData {
  /** SHA-256 over the embedded SDK bytes, or `null` for legacy/absent markers. */
  hash: string | null;
  /** Disc binary version that wrote the SDK, or `null` if the marker is missing. */
  version: string | null;
}

/**
 * Read the marker file. Line 1 is the version, line 2 (added alongside
 * content hashing) is the SHA-256 of the embedded SDK. Legacy markers
 * have only the version line, so `hash` comes back `null` — which forces
 * a one-time re-extract. Returns both fields `null` when the marker is
 * missing or unreadable.
 */
async function readMarker(targetDir: string): Promise<MarkerData> {
  try {
    const raw = await Deno.readTextFile(join(targetDir, MARKER_FILE));
    const lines = raw.split("\n").map(line => line.trim());
    const version = lines[0] && lines[0].length > 0 ? lines[0] : null;
    const hash = lines[1] && lines[1].length > 0 ? lines[1] : null;

    return { hash, version };
  } catch {
    return { hash: null, version: null };
  }
}

/**
 * SHA-256 over the embedded SDK content. Entries are sorted by `relPath`
 * and each contributes `relPath:length:` framing plus its bytes, so the
 * digest is stable across runs and sensitive to a file moving, growing,
 * or changing content.
 */
async function hashSdkContent(
  files: ReadonlyArray<{ bytes: Uint8Array; relPath: string; }>
): Promise<string> {
  const sorted = [...files].sort((a, b) => a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const file of sorted) {
    parts.push(encoder.encode(`${file.relPath}:${file.bytes.length}:`));
    parts.push(file.bytes);
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }

  const digest = await crypto.subtle.digest("SHA-256", buffer);

  return Array
    .from(new Uint8Array(digest))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

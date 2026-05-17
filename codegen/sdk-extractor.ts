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
 * Idempotency: a marker file (`.disc-sdk-marker`) holds the disc binary
 * version that wrote the SDK. Re-extracting only happens when the
 * marker is missing OR contains a different version — that’s how a user
 * upgrading their `disc` binary picks up the new SDK on the next run.
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
 * Idempotency: when the marker file is present AND its version matches
 * `version`, we skip work entirely. Mismatched marker (e.g. user
 * upgraded the `disc` binary) triggers a re-extract so generated
 * clients always pair with the SDK that ships in the binary.
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
  const existingVersion = await readMarkerVersion(targetDir);

  if (existingVersion !== null && existingVersion === version) {
    return {
      alreadyExtracted: true,
      extracted: 0,
      targetDir
    };
  }

  await ensureDir(targetDir);
  let extracted = 0;

  for (const entry of entries) {
    const dest = join(targetDir, entry.relPath);
    await ensureDir(dirname(dest));

    const bytes = await Deno.readFile(entry.sourceUrl);
    await Deno.writeFile(dest, bytes, { mode: entry.mode });

    /*** Re-chmod after write because writeFile’s mode arg is honored only on creation; existing
         files keep their old mode. Belt-and-suspenders. ***/
    try {
      await Deno.chmod(dest, entry.mode);
    } catch {
      /*** Some platforms (Windows) don’t support chmod — best-effort. ***/
    }

    extracted++;
  }

  /*** Marker file is the last write, so a partial extract that crashed halfway through won’t trick
       the next run into trusting the dir. ***/
  await Deno.writeTextFile(join(targetDir, MARKER_FILE), `${version}\n`);

  return {
    alreadyExtracted: false,
    extracted,
    targetDir
  };
}

/*** HELPER ------------------------------------------- ***/

/**
 * Read the marker file and return the version string it contains, or
 * `null` if the marker is missing / unreadable. The marker format is a
 * single line with the disc binary version (e.g. `2026.05.07`).
 */
async function readMarkerVersion(targetDir: string): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(join(targetDir, MARKER_FILE));
    const trimmed = raw.trim();

    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Embedded PostgreSQL runtime accessor — Bundle I Phase 2.
 *
 * Bridges the auto-generated `embedded-pg-manifest.ts` (a list of
 * `(sourceUrl, relPath, mode)` entries pointing at PG distribution
 * files baked into the binary via `deno compile --include`) with the
 * existing `PostgresInstance.pgBinDir` plumbing.
 *
 * Workflow:
 * 1. `resolveEmbeddedPgBinDir(...)` checks whether the manifest has any
 *    entries (an empty manifest = the binary was built without
 *    `--bundle-pg`, so the runtime falls back to the network downloader).
 * 2. If non-empty, extract under `<discHome>/embedded-postgres/<version>/`
 *    on first run; subsequent runs short-circuit on the marker file.
 * 3. Return the absolute `bin/` path. Callers pass this to
 *    `manager.createInstance({ pgBinDir })` so `PostgresInstance.init()`
 *    skips `PostgresBinaryDownloader`.
 */

import { join } from "@std/path";
import {
  extractEmbeddedPg,
  type EmbeddedPgEntry
} from "./embedded-extractor.ts";
import { logger } from "./logger.ts";

export interface ResolveEmbeddedOptions {
  /**
   * Override for the `~/.disc` base directory. Defaults to
   * `$DISC_HOME` or `$HOME/.disc`. The extracted distribution lands
   * under `<discHome>/embedded-postgres/<version>/`.
   */
  discHome?: string;
  /**
   * The manifest entries — for production callers this comes from
   * `embedded-pg-manifest.ts`; tests pass a synthetic list.
   */
  manifestEntries: readonly EmbeddedPgEntry[];
  /**
   * Distribution version (e.g. `16.4`). Used as the directory name so
   * upgrades don't clobber existing extractions.
   */
  version: string;
}

/**
 * Resolve `<discHome>` honoring the same precedence as
 * `lib/project-context.ts:discHome` — `$DISC_HOME` takes priority,
 * then `$HOME/.disc`, then a `/tmp` fallback. Duplicated here rather
 * than imported because `lib/project-context.ts` is sync-only and
 * we want to keep this module's surface minimal.
 */
function defaultDiscHome(): string {
  const explicit = Deno.env.get("DISC_HOME");
  if (explicit) {
    return explicit;
  }
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/tmp";
  return join(home, ".disc");
}

/**
 * Ensure the embedded PostgreSQL distribution is on disk and return
 * the absolute path to its `bin/` directory. Returns null when the
 * binary has no embedded PG (e.g. built with `DISC_BUILD_NO_BUNDLE_PG=1`),
 * signalling to the caller "fall back to the network downloader".
 */
export async function resolveEmbeddedPgBinDir(
  options: ResolveEmbeddedOptions
): Promise<string | null> {
  if (options.manifestEntries.length === 0) {
    return null;
  }

  const discHome = options.discHome ?? defaultDiscHome();
  const targetDir = join(discHome, "embedded-postgres", options.version);

  const result = await extractEmbeddedPg(targetDir, options.manifestEntries);
  if (!result.alreadyExtracted) {
    logger.info(
      `Extracted embedded PostgreSQL ${options.version} (${result.extracted} files) to ${targetDir}`
    );
  }

  return join(targetDir, "bin");
}

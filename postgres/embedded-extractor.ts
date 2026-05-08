/**
 * Embedded PostgreSQL extractor — Bundle I Phase 2.
 *
 * The compiled Disc binary embeds the platform-appropriate PostgreSQL
 * distribution via `deno compile --include`. PostgreSQL is a native
 * binary that has to live on a real filesystem with a real executable
 * bit before `pg_ctl` can fork it, so the runtime "extracts" the
 * embedded files to `~/.disc/embedded-postgres/<version>/` on first
 * start. After that the existing `PostgresInstance.pgBinDir` plumbing
 * uses it like any other on-disk PG.
 *
 * The extractor is idempotent: a marker file (`.disc-embedded-pg-marker`)
 * gets written after a successful pass, and subsequent calls short-circuit
 * unless it's missing.
 */

import { ensureDir } from "@std/fs";
import { dirname, join } from "@std/path";

const MARKER_FILE = ".disc-embedded-pg-marker";

export interface EmbeddedPgEntry {
  /**
   * Source URL to read from. In the compiled binary this resolves
   * through Deno's embedded asset table; in development it's a normal
   * `file://` URL.
   */
  sourceUrl: URL;
  /**
   * Path relative to the target directory (e.g. `bin/postgres`,
   * `lib/postgresql/llvmjit.so`).
   */
  relPath: string;
  /**
   * POSIX mode bits to set on the extracted file. Use `0o755` for
   * binaries in `bin/`, `0o644` for plain data.
   */
  mode: number;
}

export interface ExtractResult {
  alreadyExtracted: boolean;
  extracted: number;
  targetDir: string;
}

/**
 * Check whether `targetDir` has already been bootstrapped from an
 * embedded distribution. Looks for the marker file written at the end
 * of `extractEmbeddedPg`.
 */
export async function isEmbeddedPgExtracted(
  targetDir: string
): Promise<boolean> {
  try {
    await Deno.stat(join(targetDir, MARKER_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract every entry into `targetDir`, setting the requested mode on
 * each file. Returns counts so callers can log "first run" vs "no-op".
 *
 * Idempotency: when the marker file is present we skip work entirely.
 * If you need to force a re-extract (e.g. after upgrading the binary),
 * delete the target dir or its marker first.
 */
export async function extractEmbeddedPg(
  targetDir: string,
  entries: readonly EmbeddedPgEntry[]
): Promise<ExtractResult> {
  if (await isEmbeddedPgExtracted(targetDir)) {
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
    // Re-chmod after write because writeFile's mode arg is honored only
    // on creation; existing files keep their old mode. Belt-and-suspenders.
    try {
      await Deno.chmod(dest, entry.mode);
    } catch {
      // Some platforms (Windows) don't support chmod — best-effort.
    }
    extracted++;
  }

  // Marker file is the last write, so a partial extract that crashed
  // halfway through won't trick the next run into trusting the dir.
  await Deno.writeTextFile(
    join(targetDir, MARKER_FILE),
    `${new Date().toISOString()}\nentries=${entries.length}\n`
  );

  return {
    alreadyExtracted: false,
    extracted,
    targetDir
  };
}

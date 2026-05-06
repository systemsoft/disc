// deno-lint-ignore-file no-console
/**
 * CLI Build Command Implementation - Deno native compilation
 *
 * Wraps `deno compile` to produce self-contained binaries for Disc.
 * Supports cross-compilation to multiple platforms via --platform flag.
 *
 * Bundle I: every build also regenerates `server/ui-asset-manifest.ts`
 * from the contents of `ui/build/` so the runtime asset handler always
 * matches the embedded files.
 */

import { join, relative } from "@std/path";

export interface BuildOptions {
  platform?: string;
  output?: string;
  lite?: boolean;
}

/**
 * Mapping from user-friendly platform names to Deno compile --target values.
 */
const PLATFORM_MAP: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

/**
 * List of all available platforms for cross-compilation.
 */
export const AVAILABLE_PLATFORMS: string[] = Object.keys(PLATFORM_MAP).sort();

export class BuildCommand {
  /**
   * Map a user-friendly platform string to a Deno compile --target value.
   * Returns undefined if the platform is not recognized.
   */
  mapPlatform(platform: string): string | undefined {
    return PLATFORM_MAP[platform];
  }

  /**
   * Determine whether the given platform string requires cross-compilation.
   * Returns true if a --platform flag was provided (any explicit platform
   * is treated as a cross-compile target).
   */
  isCrossCompile(platform: string | undefined): boolean {
    return platform !== undefined;
  }

  /**
   * Resolve the output binary path.
   *
   * - If an explicit output path was provided, use it.
   * - If cross-compiling, append the platform suffix: "./disc-{platform}"
   * - Otherwise default to "./disc"
   */
  resolveOutputPath(
    output: string | undefined,
    platform: string | undefined,
  ): string {
    if (output) {
      return output;
    }

    if (platform) {
      return `./disc-${platform}`;
    }

    return "./disc";
  }

  /**
   * Validate the platform string. Throws an error with a helpful message
   * listing valid platforms if the platform is not recognized.
   */
  validatePlatform(platform: string): void {
    if (!PLATFORM_MAP[platform]) {
      throw new Error(
        `Invalid platform: "${platform}". Valid platforms: ${AVAILABLE_PLATFORMS.join(", ")}`,
      );
    }
  }

  /**
   * Build the argument list for `deno compile`. `embeddedPgPaths` is an
   * optional list of absolute file paths (typically PG distribution
   * files under `<DISC_HOME>/postgres/<version>/`) to bake into the
   * binary; pass `[]` when no PG should be embedded.
   */
  buildCompileArgs(
    options: BuildOptions,
    embeddedPgPaths: readonly string[] = [],
  ): string[] {
    const outputPath = this.resolveOutputPath(
      options.output,
      options.platform,
    );

    const args: string[] = [
      "compile",
      // Skip type-check during compile — `deno task check` is the gate
      // for that, and the `deno compile` typechecker disagrees with the
      // task runner on a few `Uint8Array<ArrayBufferLike>` corners.
      "--no-check",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--output",
      outputPath,
    ];

    // P2-35: bundle version.txt so VERSION resolution works at runtime.
    // Without --lite, also embed the built UI so `disc ui` can serve
    // assets without a separate deployment step. With --lite, skip the
    // UI entirely — produces a smaller binary for headless deployments.
    args.push("--include", "version.txt");
    if (!options.lite) {
      args.push("--include", "ui/build");
    }

    // Bundle I Phase 2: embed the PG distribution files. Each absolute
    // path becomes its own --include flag; the runtime resolves them
    // back via `Deno.readFile(new URL("file://..."))` — see
    // `postgres/embedded-pg.ts`.
    for (const p of embeddedPgPaths) {
      args.push("--include", p);
    }

    if (options.platform) {
      const denoTarget = this.mapPlatform(options.platform);
      if (denoTarget) {
        args.push("--target", denoTarget);
      }
    }

    args.push("cli/main.ts");

    return args;
  }

  /**
   * Execute the build command.
   *
   * 1. Validate platform if provided
   * 2. Determine output path
   * 3. Run deno compile
   * 4. Report binary size on success
   */
  async execute(options: BuildOptions): Promise<void> {
    // Validate platform if specified
    if (options.platform) {
      this.validatePlatform(options.platform);
    }

    const outputPath = this.resolveOutputPath(
      options.output,
      options.platform,
    );

    // Refresh the UI manifest before deno compile picks it up so the
    // runtime handler always matches the embedded build. Skip in --lite
    // mode where the UI isn't shipped.
    if (!options.lite) {
      try {
        const refreshed = await refreshUiManifest();
        if (refreshed.wrote) {
          console.log(`  Refreshed UI manifest: ${refreshed.path}`);
        }
      } catch (err) {
        console.warn(
          `  Skipped UI manifest refresh: ${(err as Error).message}`,
        );
      }
    }

    // Bundle I Phase 2: refresh the embedded-PG manifest from the local
    // PG distribution cache (set by `disc init` / `disc start`) and
    // collect the absolute paths to embed via --include.
    let embeddedPgPaths: string[] = [];
    if (!options.lite) {
      try {
        const refreshed = await refreshEmbeddedPgManifest();
        embeddedPgPaths = refreshed.includePaths;
        if (refreshed.wrote) {
          console.log(
            `  Refreshed embedded-PG manifest: ${refreshed.fileCount} files from ${refreshed.pgSourceDir}`,
          );
        } else if (refreshed.fileCount > 0) {
          console.log(
            `  Embedded-PG manifest unchanged: ${refreshed.fileCount} files`,
          );
        } else {
          console.log(
            `  No embedded PG (no cache at ${refreshed.pgSourceDir}); ` +
              `binary will download PG on first run`,
          );
        }
      } catch (err) {
        console.warn(
          `  Skipped embedded-PG manifest refresh: ${(err as Error).message}`,
        );
      }
    }

    const compileArgs = this.buildCompileArgs(options, embeddedPgPaths);

    console.log(`Building Disc binary...`);
    console.log(`  Output: ${outputPath}`);

    if (options.platform) {
      console.log(`  Platform: ${options.platform}`);
      console.log(
        `  Target: ${this.mapPlatform(options.platform)}`,
      );
    }

    if (options.lite) {
      console.log(`  Mode: lite (UI assets skipped)`);
    }

    console.log(`  Command: deno ${compileArgs.join(" ")}`);

    const command = new Deno.Command("deno", {
      args: compileArgs,
      stdout: "inherit",
      stderr: "inherit",
    });

    const result = await command.output();

    if (!result.success) {
      throw new Error(
        `Build failed with exit code ${result.code}`,
      );
    }

    // Report binary size
    try {
      const stat = await Deno.stat(outputPath);
      const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
      console.log(`\nBuild complete!`);
      console.log(`  Binary: ${outputPath} (${sizeMb} MB)`);
    } catch {
      // Cross-compiled binaries may not be stat-able on current platform
      console.log(`\nBuild complete!`);
      console.log(`  Binary: ${outputPath}`);
    }
  }
}

export const buildCommand = new BuildCommand();

/**
 * Walk a directory recursively and return every file path relative to
 * the input root, with POSIX-style separators. Sorted lexicographically
 * so the generated manifest is deterministic across runs.
 */
async function listBuildArtifacts(buildDir: string): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(full);
      } else if (entry.isFile) {
        out.push(relative(buildDir, full).split("\\").join("/"));
      }
    }
  }

  await walk(buildDir);
  out.sort();
  return out;
}

/**
 * Build the contents of `server/ui-asset-manifest.ts` from the files in
 * `<buildDir>`. Returns the generated TypeScript source as a string. The
 * caller is responsible for writing it to disk; tests can assert against
 * the raw output without touching the repository file.
 */
export async function generateUiManifest(buildDir: string): Promise<string> {
  const files = await listBuildArtifacts(buildDir);
  if (files.length === 0) {
    throw new Error(
      `No files under ${buildDir} — no UI build artifacts to embed. ` +
        `Run \`bash ui/build.sh\` before \`disc build\` (or pass --lite).`,
    );
  }

  const entries = files.map((p) => `  ${JSON.stringify(p)},`).join("\n");

  return `/**
 * UI asset manifest.
 *
 * Lists every file under \`ui/build/\` that is bundled into the binary via
 * \`deno compile --include ui/build\`. Auto-generated by \`cli/build.ts\`
 * before each \`disc build\` run; do not edit by hand. To refresh:
 *
 *   bash ui/build.sh && deno task cli build
 *
 * The manifest is checked in so callers don't need to run the build to
 * use the asset handler in tests / development.
 */

export const UI_ASSET_MANIFEST: readonly string[] = [
${entries}
];

export const UI_ASSET_SET: ReadonlySet<string> = new Set(UI_ASSET_MANIFEST);
`;
}

/**
 * Recursive directory walker shared by `generateEmbeddedPgManifest`.
 * Pulled out so the parent function stays at the top level (lint:
 * `no-inner-declarations`).
 */
async function walkPgSource(
  rootDir: string,
  dir: string,
  entries: { abs: string; rel: string; mode: number }[],
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory) {
      await walkPgSource(rootDir, full, entries);
      continue;
    }
    if (!entry.isFile) continue;
    const rel = relative(rootDir, full).split("\\").join("/");
    const mode = rel.startsWith("bin/") ? 0o755 : 0o644;
    entries.push({ abs: full, rel, mode });
  }
}

/**
 * Build the contents of `postgres/embedded-pg-manifest.ts` from the
 * on-disk PG distribution at `sourceDir` (typically
 * `<DISC_HOME>/postgres/<version>/`). When the directory is missing
 * we emit an empty manifest — the runtime falls back to the network
 * downloader, so the binary still works.
 *
 * `bin/*` files get mode 0o755 so PG's `pg_ctl` can fork them after
 * extraction; everything else gets 0o644.
 */
export async function generateEmbeddedPgManifest(options: {
  pgVersion: string;
  sourceDir: string;
}): Promise<string> {
  const entries: { abs: string; rel: string; mode: number }[] = [];

  let exists = false;
  try {
    const stat = await Deno.stat(options.sourceDir);
    exists = stat.isDirectory;
  } catch {
    exists = false;
  }

  if (exists) {
    await walkPgSource(options.sourceDir, options.sourceDir, entries);
    entries.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  const body = entries.length === 0 ? "[]" : `[\n${
    entries
      .map(
        (e) => `  { sourceUrl: new URL("file://${e.abs}"), relPath: ${JSON.stringify(e.rel)}, mode: 0o${e.mode.toString(8)} },`,
      )
      .join("\n")
  }\n]`;

  return `/**
 * Embedded PostgreSQL manifest.
 *
 * Auto-generated by \`cli/build.ts\` (do not edit by hand). Empty when
 * \`<DISC_HOME>/postgres/<version>/\` was absent at build time, in which
 * case the runtime falls back to the network downloader.
 *
 * Every \`sourceUrl\` here is an absolute \`file://\` URL — it's what
 * \`deno compile --include <abs path>\` baked into the binary. At runtime
 * \`Deno.readFile(sourceUrl)\` resolves through Deno's embedded asset
 * table and \`postgres/embedded-pg.ts\` writes the bytes to
 * \`<DISC_HOME>/embedded-postgres/<version>/\`.
 */

import type { EmbeddedPgEntry } from "./embedded-extractor.ts";

export const EMBEDDED_PG_VERSION = ${JSON.stringify(options.pgVersion)};
export const EMBEDDED_PG_MANIFEST: readonly EmbeddedPgEntry[] = ${body};
`;
}

/**
 * Regenerate `server/ui-asset-manifest.ts` from the on-disk UI build.
 * Skips silently when the build directory is missing — the caller
 * (`BuildCommand.execute`) has already decided whether the UI is in
 * scope (`!options.lite`).
 */
export async function refreshUiManifest(
  rootDir: string = Deno.cwd(),
): Promise<{ wrote: boolean; path: string }> {
  const buildDir = join(rootDir, "ui", "build");
  const manifestPath = join(rootDir, "server", "ui-asset-manifest.ts");

  try {
    const stat = await Deno.stat(buildDir);
    if (!stat.isDirectory) {
      return { wrote: false, path: manifestPath };
    }
  } catch {
    return { wrote: false, path: manifestPath };
  }

  const generated = await generateUiManifest(buildDir);

  // Only write when the contents differ — avoids touching the file
  // mtime on no-op builds, which keeps incremental tooling happy.
  let existing = "";
  try {
    existing = await Deno.readTextFile(manifestPath);
  } catch {
    // Missing — write fresh.
  }
  if (existing === generated) {
    return { wrote: false, path: manifestPath };
  }

  await Deno.writeTextFile(manifestPath, generated);
  return { wrote: true, path: manifestPath };
}

/**
 * Discover the home directory for the bundled PG distribution. Mirrors
 * `lib/project-context.ts:discHome` precedence: `$DISC_HOME`, then
 * `$HOME/.disc`. Returned as an absolute path.
 */
function defaultDiscHome(): string {
  const explicit = Deno.env.get("DISC_HOME");
  if (explicit) return explicit;
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/tmp";
  return join(home, ".disc");
}

export interface RefreshEmbeddedPgResult {
  fileCount: number;
  includePaths: string[];
  pgSourceDir: string;
  wrote: boolean;
}

/**
 * Regenerate `postgres/embedded-pg-manifest.ts` from the on-disk PG
 * distribution under `<DISC_HOME>/postgres/<version>/` and return the
 * absolute paths to feed into `deno compile --include`. When the source
 * dir is missing, returns an empty manifest + zero include paths — the
 * binary still builds, just without an embedded PG.
 *
 * Skipped when `DISC_BUILD_NO_BUNDLE_PG` is set (sets the manifest empty
 * even if a cache exists, so size-conscious builds opt out cleanly).
 */
export async function refreshEmbeddedPgManifest(
  rootDir: string = Deno.cwd(),
  pgVersion: string = "16.4",
): Promise<RefreshEmbeddedPgResult> {
  const manifestPath = join(rootDir, "postgres", "embedded-pg-manifest.ts");
  const optOut = Deno.env.get("DISC_BUILD_NO_BUNDLE_PG") === "1";
  const pgSourceDir = optOut ? join(defaultDiscHome(), "postgres", "__opt_out__") : join(defaultDiscHome(), "postgres", pgVersion);

  const generated = await generateEmbeddedPgManifest({
    pgVersion,
    sourceDir: pgSourceDir,
  });

  let existing = "";
  try {
    existing = await Deno.readTextFile(manifestPath);
  } catch {
    // Missing — write fresh.
  }

  const wrote = existing !== generated;
  if (wrote) {
    await Deno.writeTextFile(manifestPath, generated);
  }

  // Reparse the generated source to count entries + collect include
  // paths. The manifest body is small, so a regex is faster + simpler
  // than re-walking the source dir.
  const includePaths: string[] = [];
  const includeRegex = /new URL\("file:\/\/([^"]+)"\)/g;
  let match: RegExpExecArray | null;
  while ((match = includeRegex.exec(generated)) !== null) {
    includePaths.push(match[1]);
  }

  return {
    fileCount: includePaths.length,
    includePaths,
    pgSourceDir,
    wrote,
  };
}

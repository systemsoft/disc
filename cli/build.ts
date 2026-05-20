/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

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

/*** NATIVE ------------------------------------------- ***/

import { join, relative } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { PostgresBinaryDownloader } from "../postgres/downloader.ts";

/**
 * Mapping from user-friendly platform names to Deno compile --target values.
 */
const PLATFORM_MAP: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu"
};

/*** EXPORT ------------------------------------------- ***/

export interface BuildOptions {
  lite?: boolean;
  output?: string;
  platform?: string;
}

export interface RefreshEmbeddedPgResult {
  fileCount: number;
  includePaths: string[];
  pgSourceDir: string;
  wrote: boolean;
}

export interface RefreshEmbeddedSdkResult {
  fileCount: number;
  includePaths: string[];
  sdkSourceDir: string;
  wrote: boolean;
}

export class BuildCommand {
  /**
   * Gate the build when an explicit cross-compile target was requested
   * but PG staging didn’t produce a usable PG distribution. Without
   * this gate, the build silently produces a small binary without PG
   * embedded — operators who tagged a release expecting bundled PG
   * end up with broken artifacts.
   *
   * Three failure modes the gate catches, all observed post-v2026.05.07:
   *
   * 1. **Zero files** — staging failed entirely; manifest is empty.
   * 2. **`bin/postgres` missing** — partial extract: maybe `share/`
   *    landed but the actual postgres binary didn’t. The embedded PG
   *    is useless without it; the runtime would crash on first start.
   * 3. **File count below threshold** — partial extract: maybe just
   *    `bin/*` landed but `share/timezone/`, `share/extension/`, and
   *    `lib/` are missing. PG initdb crashes without timezone data.
   *    A real PG 16 distribution has 600+ files; the threshold below
   *    is set well under that to avoid false positives on minor
   *    distribution variations, but well over a "broken extract"
   *    count to catch real failures.
   *
   * Host builds (no `--platform`) keep the graceful-fallback behavior
   * — local dev without a PG cache is expected; the binary downloads
   * PG on first run.
   *
   * `--lite` and `DISC_BUILD_NO_BUNDLE_PG=1` are explicit opt-outs,
   * so they bypass the gate even with `--platform`.
   */
  assertEmbeddedPgPresent(options: { lite?: boolean; platform?: string; }, paths: readonly string[], pgSourceDir: string): void {
    if (!options.platform)
      return;

    if (options.lite)
      return;

    if (Deno.env.get("DISC_BUILD_NO_BUNDLE_PG") === "1")
      return;

    const opOutHint = `To opt out of PG embedding explicitly, set DISC_BUILD_NO_BUNDLE_PG=1 ` +
      `or pass --lite.`;

    if (paths.length === 0) {
      throw new Error(
        `Cross-compile build for ${options.platform} produced 0 embedded PG ` +
          `files (source dir: ${pgSourceDir}). This usually means PG staging ` +
          `silently failed — check the build log for ` +
          `"Skipped embedded-PG manifest refresh" or download/extract errors. ` +
          opOutHint
      );
    }

    const hasPostgresBinary = paths.some(p => p.endsWith("/bin/postgres"));

    if (!hasPostgresBinary) {
      throw new Error(
        `Cross-compile build for ${options.platform} produced an embedded PG ` +
          `distribution without bin/postgres (${paths.length} files at ` +
          `${pgSourceDir}). The runtime needs the postgres binary to start. ` +
          `This usually means the JAR → txz extract chain partially failed. ` +
          opOutHint
      );
    }

    /*** A real PG 16 distribution has 600+ files. 50 catches partial
    // extracts (e.g. only bin/ landed but share/ and lib/ are missing
    // — initdb fails without timezone data) without false-positiving
    // on minor distribution differences across platforms. ***/
    const MIN_PG_FILES = 50;

    if (paths.length < MIN_PG_FILES) {
      throw new Error(
        `Cross-compile build for ${options.platform} produced only ` +
          `${paths.length} embedded PG files (source dir: ${pgSourceDir}); ` +
          `a real PG 16 distribution has 600+ files. This is a partial ` +
          `extraction — the binary will fail at runtime when PG init can’t ` +
          `find timezone or extension data. ` +
          opOutHint
      );
    }
  }

  /**
   * Cross-compile gate for the embedded SDK, mirroring
   * `assertEmbeddedPgPresent`. A binary without the SDK still boots, but
   * `disc codegen` can’t materialize `dbschema/disc-client/sdk/` — the
   * generated `client.ts` import of `./sdk/mod.ts` will fail. Shipping a
   * release artifact in that state is a worse failure mode than failing
   * loud at build time.
   *
   * Host builds (no `--platform`) skip the gate so local dev without a
   * full SDK tree (e.g. partial checkouts) still produces a runnable
   * binary. `DISC_BUILD_NO_BUNDLE_SDK=1` is the explicit opt-out.
   */
  assertEmbeddedSdkPresent(options: { platform?: string; }, paths: readonly string[]): void {
    if (!options.platform)
      return;

    if (Deno.env.get("DISC_BUILD_NO_BUNDLE_SDK") === "1")
      return;

    const opOutHint = `To opt out of SDK embedding explicitly, set ` +
      `DISC_BUILD_NO_BUNDLE_SDK=1.`;

    if (paths.length === 0) {
      throw new Error(
        `Cross-compile build for ${options.platform} produced 0 embedded ` +
          `SDK files. This usually means the sdk/ directory was missing or ` +
          `the manifest refresh silently failed — check the build log for ` +
          `"Skipped embedded-SDK manifest refresh". ` +
          opOutHint
      );
    }

    const hasMod = paths.some(p => p.endsWith("/sdk/mod.ts"));

    if (!hasMod) {
      throw new Error(
        `Cross-compile build for ${options.platform} produced an embedded ` +
          `SDK without sdk/mod.ts (${paths.length} files). The generated ` +
          `client imports from ./sdk/mod.ts; without it codegen output is ` +
          `broken. ` +
          opOutHint
      );
    }

    /*** sdk/ ships 11 source files (auth, client, codecs, errors, mod, query-builder, schema-types,
         subscription, transaction, types, validation). 8 catches partial trees while leaving
         headroom for intentional reorganization. ***/
    const MIN_SDK_FILES = 8;

    if (paths.length < MIN_SDK_FILES) {
      throw new Error(
        `Cross-compile build for ${options.platform} produced only ` +
          `${paths.length} embedded SDK files; the SDK ships 11 sources. ` +
          `This is a partial tree — codegen output will fail to resolve ` +
          `imports at runtime. ` +
          opOutHint
      );
    }
  }

  /**
   * Build the argument list for `deno compile`. `embeddedPgPaths` is an
   * optional list of absolute file paths (typically PG distribution
   * files under `<DISC_HOME>/postgres/<version>/`) to bake into the
   * binary; pass `[]` when no PG should be embedded.
   *
   * `embeddedSdkPaths` is an optional list of absolute file paths to
   * the on-disk Disc SDK source files (`sdk/*.ts`, minus `*.test.ts`)
   * that `disc codegen` extracts at runtime so generated clients work
   * out of the box.
   */
  buildCompileArgs(options: BuildOptions, embeddedPgPaths: readonly string[] = [], embeddedSdkPaths: readonly string[] = []): string[] {
    const outputPath = this.resolveOutputPath(options.output, options.platform);

    const args: string[] = [
      "compile",
      /*** Skip type-check during compile — `deno task check` is the gate for that, and the
           `deno compile` typechecker disagrees with the task runner on a few
           `Uint8Array<ArrayBufferLike>` corners. ***/
      "--no-check",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--output",
      outputPath
    ];

    /*** P2-35: bundle version.txt so VERSION resolution works at runtime. Without --lite, also
         embed the built UI so `disc ui` can serve assets without a separate deployment step. With
         --lite, skip the UI entirely — produces a smaller binary for headless deployments. ***/
    args.push("--include", "version.txt");

    if (!options.lite)
      args.push("--include", "ui/build");

    /*** Bundle I Phase 2: embed the PG distribution files. Each absolute path becomes its own
         --include flag; the runtime resolves them back via `Deno.readFile(new URL("file://..."))`
         — see `postgres/embedded-pg.ts`. ***/
    for (const p of embeddedPgPaths) {
      args.push("--include", p);
    }

    /*** Embed the SDK source files so `disc codegen` can materialize them alongside generated
         client output (caddy-style — the binary ships everything). Same file://-URL embedding
         strategy as PG; the runtime extractor lives in `codegen/sdk-extractor.ts`. ***/
    for (const p of embeddedSdkPaths) {
      args.push("--include", p);
    }

    if (options.platform) {
      const denoTarget = this.mapPlatform(options.platform);

      if (denoTarget)
        args.push("--target", denoTarget);
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
    /*** Validate platform if specified ***/
    if (options.platform)
      this.validatePlatform(options.platform);

    const outputPath = this.resolveOutputPath(options.output, options.platform);

    /*** Refresh the UI manifest before deno compile picks it up so the runtime handler always
         matches the embedded build. Skip in --lite mode where the UI isn’t shipped. ***/
    if (!options.lite) {
      try {
        const refreshed = await refreshUiManifest();

        if (refreshed.wrote)
          console.log(`  Refreshed UI manifest: ${refreshed.path}`);
      } catch (err) {
        console.warn(`  Skipped UI manifest refresh: ${(err as Error).message}`);
      }
    }

    /*** Bundle I Phase 2: refresh the embedded-PG manifest from the local PG distribution cache
         (set by `disc init` / `disc start`) and collect the absolute paths to embed via --include.

         Bundle I follow-up (cross-platform): when `--platform` is set, the build machine’s
         `<DISC_HOME>/postgres/<version>/` cache only contains the host’s PG. We stage the TARGET
         platform’s PG into `dist/embedded-pg/<platform>/<version>/` and point the manifest there —
         the resulting binary embeds the right PG for its target. ***/
    let embeddedPgPaths: string[] = [];
    let embeddedPgSourceDir = "";

    if (!options.lite) {
      try {
        let pgSourceOverride: string | undefined;

        if (options.platform) {
          console.log(`  Staging PG for cross-compile target ${options.platform}…`);
          pgSourceOverride = await ensurePlatformPgStaging(Deno.cwd(), options.platform);
        }

        const refreshed = await refreshEmbeddedPgManifest(Deno.cwd(), "16.4", pgSourceOverride);
        embeddedPgPaths = refreshed.includePaths;
        embeddedPgSourceDir = refreshed.pgSourceDir;

        if (refreshed.wrote) {
          console.log(`  Refreshed embedded-PG manifest: ${refreshed.fileCount} files from ${refreshed.pgSourceDir}`);
        } else if (refreshed.fileCount > 0) {
          console.log(`  Embedded-PG manifest unchanged: ${refreshed.fileCount} files`);
        } else {
          console.log(
            `  No embedded PG (no cache at ${refreshed.pgSourceDir}); ` +
              `binary will download PG on first run`
          );
        }
      } catch (err) {
        /*** Cross-compile builds (--platform set) re-throw so a release tag never produces a
             stripped binary silently. Host builds log + continue (the binary downloads PG on
             first run). ***/
        if (options.platform)
          throw new Error(`PG staging failed for ${options.platform}: ${(err as Error).message}`, { cause: err });

        console.warn(`  Skipped embedded-PG manifest refresh: ${(err as Error).message}`);
      }
    }

    /*** Final gate: even when the staging+manifest call returned without throwing, an empty result
         on a cross-compile build is a release blocker — fail loud rather than ship a tiny
         no-PG artifact. ***/
    this.assertEmbeddedPgPresent(options, embeddedPgPaths, embeddedPgSourceDir);

    /*** Refresh the embedded-SDK manifest from `sdk/*.ts` (excluding tests) so the binary embeds
         the SDK alongside PG. Failures here are non-fatal — the binary still builds without an
         embedded SDK, it just means `disc codegen` won’t be able to materialize the SDK and
         downstream clients will need to supply it themselves. ***/
    let embeddedSdkPaths: string[] = [];

    try {
      const refreshed = await refreshEmbeddedSdkManifest(Deno.cwd());
      embeddedSdkPaths = refreshed.includePaths;

      if (refreshed.wrote)
        console.log(`  Refreshed embedded-SDK manifest: ${refreshed.fileCount} files`);
      else if (refreshed.fileCount > 0)
        console.log(`  Embedded-SDK manifest unchanged: ${refreshed.fileCount} files`);
      else
        console.log(`  No embedded SDK (no sources at sdk/); binary will skip SDK extraction during codegen`);
    } catch (err) {
      /*** Cross-compile builds (--platform set) re-throw so a release tag never produces a binary
           missing the SDK silently. Host builds log + continue (codegen will skip extraction
           at runtime). ***/
      if (options.platform)
        throw new Error(`SDK manifest refresh failed for ${options.platform}: ${(err as Error).message}`, { cause: err });

      console.warn(`  Skipped embedded-SDK manifest refresh: ${(err as Error).message}`);
    }

    /*** Final gate: parallel to assertEmbeddedPgPresent — even when refresh didn’t throw, an
         empty/partial result on a cross-compile build is a release blocker. ***/
    this.assertEmbeddedSdkPresent(options, embeddedSdkPaths);

    const compileArgs = this.buildCompileArgs(options, embeddedPgPaths, embeddedSdkPaths);
    console.log(`Building Disc binary…`);
    console.log(`  Output: ${outputPath}`);

    if (options.platform) {
      console.log(`  Platform: ${options.platform}`);
      console.log(`  Target: ${this.mapPlatform(options.platform)}`);
    }

    if (options.lite)
      console.log(`  Mode: lite (UI assets skipped)`);

    console.log(`  Command: deno ${compileArgs.join(" ")}`);

    const command = new Deno.Command("deno", {
      args: compileArgs,
      stderr: "inherit",
      stdout: "inherit"
    });

    const result = await command.output();

    if (!result.success)
      throw new Error(`Build failed with exit code ${result.code}`);

    /*** Report binary size ***/
    try {
      const stat = await Deno.stat(outputPath);
      const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
      console.log(`\nBuild complete!`);
      console.log(`  Binary: ${outputPath} (${sizeMb} MB)`);
    } catch {
      /*** Cross-compiled binaries may not be stat-able on current platform ***/
      console.log(`\nBuild complete!`);
      console.log(`  Binary: ${outputPath}`);
    }
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
   * Map a user-friendly platform string to a Deno compile --target value.
   * Returns undefined if the platform is not recognized.
   */
  mapPlatform(platform: string): string | undefined {
    return PLATFORM_MAP[platform];
  }

  /**
   * Resolve the output binary path.
   *
   * - If an explicit output path was provided, use it.
   * - If cross-compiling, append the platform suffix: "./disc-{platform}"
   * - Otherwise default to "./disc"
   */
  resolveOutputPath(output: string | undefined, platform: string | undefined): string {
    if (output)
      return output;

    if (platform)
      return `./disc-${platform}`;

    return "./disc";
  }

  /**
   * Validate the platform string. Throws an error with a helpful message
   * listing valid platforms if the platform is not recognized.
   */
  validatePlatform(platform: string): void {
    if (!PLATFORM_MAP[platform])
      throw new Error(`Invalid platform: "${platform}". Valid platforms: ${AVAILABLE_PLATFORMS.join(", ")}`);
  }
}

/**
 * List of all available platforms for cross-compilation.
 */
export const AVAILABLE_PLATFORMS: string[] = Object.keys(PLATFORM_MAP).sort();
export const buildCommand = new BuildCommand();

/**
 * Download the target platform’s PG into the per-platform staging dir
 * if it isn’t there already. No-op when the staging dir is already
 * populated (the downloader’s own short-circuit catches that), so
 * repeated builds across platforms in the same CI run don’t re-fetch.
 *
 * Returns the staging dir’s `<version>` subpath so the caller can pass
 * it to `refreshEmbeddedPgManifest(..., override)`.
 */
export async function ensurePlatformPgStaging(rootDir: string, platform: string, pgVersion: string = "16.4"): Promise<string> {
  const stagingBase = join(rootDir, "dist", "embedded-pg", platform);
  const downloader = new PostgresBinaryDownloader({ baseDir: stagingBase, platform });

  return await downloader.download(pgVersion);
}

/**
 * Build the contents of `postgres/embedded-pg-manifest.ts` from the
 * on-disk PG distribution at `sourceDir` (typically
 * `<DISC_HOME>/postgres/<version>/`). When the directory is missing
 * we emit an empty manifest — the runtime falls back to the network
 * downloader, so the binary still works.
 *
 * `bin/*` files get mode 0o755 so PG’s `pg_ctl` can fork them after
 * extraction; everything else gets 0o644.
 *
 * `manifestDir` is the directory the generated file will be written
 * to — needed so each entry’s URL can be expressed as
 * `import.meta.resolve("<rel-from-manifest-to-file>")`. Bare absolute
 * `file://` URLs miss Deno’s compiled-binary VFS at runtime; only URLs
 * derived from module resolution get remapped to the embedded asset
 * table.
 */
export async function generateEmbeddedPgManifest(options: { manifestDir: string; pgVersion: string; sourceDir: string; }): Promise<string> {
  const entries: { abs: string; mode: number; rel: string; }[] = [];
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

  /*** Fugly identation is to ensure generated files look good ***/
  const body = entries.length === 0 ? "[]" : `[\n${
    entries
      .map((e, i, arr) => {
        const relFromManifest = toPosixRel(relative(options.manifestDir, e.abs));

        if (arr[i + 1])
          return `  {
    mode: 0o${e.mode.toString(8)},
    relPath: ${JSON.stringify(e.rel)},
    sourceUrl: new URL(import.meta.resolve(${JSON.stringify(relFromManifest)}))
  },`;
        else
          return `  {
    mode: 0o${e.mode.toString(8)},
    relPath: ${JSON.stringify(e.rel)},
    sourceUrl: new URL(import.meta.resolve(${JSON.stringify(relFromManifest)}))
  }`;
      })
      .join("\n")
  }\n]`;

  return `/**
 * Embedded PostgreSQL manifest.
 *
 * Auto-generated by \`cli/build.ts\` (do not edit by hand). Empty when
 * \`<DISC_HOME>/postgres/<version>/\` was absent at build time, in which
 * case the runtime falls back to the network downloader.
 *
 * Every \`sourceUrl\` here is constructed from \`import.meta.resolve()\`
 * with a path relative to this manifest file. \`deno compile --include\`
 * bakes the file into the binary; at runtime
 * \`Deno.readFile(sourceUrl)\` hits Deno’s embedded VFS because the
 * resolution flows through the module graph rather than a bare absolute
 * \`file://\` URL (which would fall through to the real filesystem and
 * fail on a different machine than the one that built the binary).
 * \`postgres/embedded-pg.ts\` writes the bytes to
 * \`<DISC_HOME>/embedded-postgres/<version>/\`.
 */

/*** UTILITY ------------------------------------------ ***/

import type { EmbeddedPgEntry } from "./embedded-extractor.ts";

/*** EXPORT ------------------------------------------- ***/

export const EMBEDDED_PG_VERSION = ${JSON.stringify(options.pgVersion)};

export const EMBEDDED_PG_MANIFEST: readonly EmbeddedPgEntry[] = ${body};\n`;
}

/**
 * Build the contents of `codegen/embedded-sdk-manifest.ts` from the
 * on-disk SDK source at `sourceDir` (typically `<repo>/sdk/`). When the
 * directory is missing or empty we emit an empty manifest — the runtime
 * extractor short-circuits to a no-op marker write, so the binary still
 * builds.
 *
 * All entries get mode `0o644` (SDK sources are read at runtime, not
 * executed).
 *
 * `manifestDir` is the directory the generated file will be written
 * to — needed so each entry’s URL can be expressed as
 * `import.meta.resolve("<rel-from-manifest-to-file>")`. Bare absolute
 * `file://` URLs miss Deno’s compiled-binary VFS at runtime; only URLs
 * derived from module resolution get remapped to the embedded asset
 * table.
 */
export async function generateEmbeddedSdkManifest(options: { manifestDir: string; sourceDir: string; }): Promise<string> {
  const entries: { abs: string; rel: string; }[] = [];
  let exists = false;

  try {
    const stat = await Deno.stat(options.sourceDir);
    exists = stat.isDirectory;
  } catch {
    exists = false;
  }

  if (exists) {
    await walkSdkSource(options.sourceDir, options.sourceDir, entries);
    entries.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /*** Fugly identation is to ensure generated files look good ***/
  const body = entries.length === 0 ? "[]" : `[\n${
    entries
      .map((e, i, arr) => {
        const relFromManifest = toPosixRel(relative(options.manifestDir, e.abs));

        if (arr[i + 1])
          return `  { mode: 0o644, relPath: ${JSON.stringify(e.rel)}, sourceUrl: new URL(import.meta.resolve(${JSON.stringify(relFromManifest)})) },`;
        else
          return `  { mode: 0o644, relPath: ${JSON.stringify(e.rel)}, sourceUrl: new URL(import.meta.resolve(${JSON.stringify(relFromManifest)})) }`;
      })
      .join("\n")
  }\n]`;

  return `/**
 * Embedded Disc SDK manifest.
 *
 * Auto-generated by \`cli/build.ts\` (do not edit by hand). Empty when
 * \`<repo>/sdk/\` was absent at build time.
 *
 * Every \`sourceUrl\` here is constructed from \`import.meta.resolve()\`
 * with a path relative to this manifest file. \`deno compile --include\`
 * bakes the file into the binary; at runtime
 * \`Deno.readFile(sourceUrl)\` hits Deno’s embedded VFS because the
 * resolution flows through the module graph rather than a bare absolute
 * \`file://\` URL (which would fall through to the real filesystem and
 * fail on a different machine than the one that built the binary).
 * \`codegen/sdk-extractor.ts\` then writes the bytes alongside the
 * generated client output (\`<outputDir>/sdk/\`).
 */

/*** UTILITY ------------------------------------------ ***/

import type { EmbeddedSdkEntry } from "./sdk-extractor.ts";

/*** EXPORT ------------------------------------------- ***/

export const EMBEDDED_SDK_MANIFEST: readonly EmbeddedSdkEntry[] = ${body};\n`;
}

/**
 * Build the contents of `server/ui-asset-manifest.ts` from the files in
 * `<buildDir>`. Returns the generated TypeScript source as a string. The
 * caller is responsible for writing it to disk; tests can assert against
 * the raw output without touching the repository file.
 */
export async function generateUiManifest(buildDir: string): Promise<string> {
  const files = await listBuildArtifacts(buildDir);

  if (files.length === 0)
    throw new Error(`No files under ${buildDir} — no UI build artifacts to embed. Run \`bash ui/build.sh\` before \`disc build\` (or pass --lite).`);

  /*** Fugly identation is to ensure generated files look good ***/
  const entries = files
    .map((p, i, arr) => {
      if (arr[i + 1])
        return `  ${JSON.stringify(p)},`;
      else
        return `  ${JSON.stringify(p)}`;
    })
    .join("\n");

  return `/**
 * UI asset manifest.
 *
 * Lists every file under \`ui/build/\` that is bundled into the binary via
 * \`deno compile --include ui/build\`. Auto-generated by \`cli/build.ts\`
 * before each \`disc build\` run; do not edit by hand. To refresh:
 *
 *   bash ui/build.sh && deno task cli build
 *
 * The manifest is checked in so callers don’t need to run the build to
 * use the asset handler in tests / development.
 */

/*** EXPORT ------------------------------------------- ***/

export const UI_ASSET_MANIFEST: readonly string[] = [
${entries}
];

export const UI_ASSET_SET: ReadonlySet<string> = new Set(UI_ASSET_MANIFEST);\n`;
}

/**
 * Per-platform PG staging dir for cross-compilation. Bundle I shipped
 * single-platform binaries by walking `<DISC_HOME>/postgres/<version>/`,
 * but that dir only ever holds one platform’s PG (whichever the build
 * machine downloaded). For `disc build --platform <p>` to embed the
 * RIGHT PG, we stage the target platform’s distribution under
 * `dist/embedded-pg/<platform>/<version>/` and point the manifest
 * generator there.
 */
export function platformPgStagingDir(rootDir: string, platform: string, pgVersion: string): string {
  return join(rootDir, "dist", "embedded-pg", platform, pgVersion);
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
  pgSourceDirOverride?: string
): Promise<RefreshEmbeddedPgResult> {
  const manifestDir = join(rootDir, "postgres");
  const manifestPath = join(manifestDir, "embedded-pg-manifest.ts");
  const optOut = Deno.env.get("DISC_BUILD_NO_BUNDLE_PG") === "1";
  /*** Override wins over both opt-out and the default `<DISC_HOME>` path — cross-platform builds
       (Bundle I follow-up) supply a per-platform staging dir
       under `dist/embedded-pg/<platform>/<version>/`. ***/
  const pgSourceDir = pgSourceDirOverride ??
    (optOut ?
      join(defaultDiscHome(), "postgres", "__opt_out__") :
      join(defaultDiscHome(), "postgres", pgVersion));

  const generated = await generateEmbeddedPgManifest({ manifestDir, pgVersion, sourceDir: pgSourceDir });
  let existing = "";

  try {
    existing = await Deno.readTextFile(manifestPath);
  } catch {
    /*** Missing — write fresh. ***/
  }

  const wrote = existing !== generated;

  if (wrote)
    await Deno.writeTextFile(manifestPath, generated);

  /*** Walk the source dir directly for the include path list — the new manifest format embeds URLs
       via `import.meta.resolve(...)` rather than absolute `file://` literals, so a regex over the
       generated source no longer recovers the build-time absolute paths that
       `deno compile --include` needs. ***/
  const walked: { abs: string; rel: string; mode: number; }[] = [];
  let exists = false;

  try {
    const stat = await Deno.stat(pgSourceDir);
    exists = stat.isDirectory;
  } catch {
    exists = false;
  }

  if (exists) {
    await walkPgSource(pgSourceDir, pgSourceDir, walked);
    walked.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  const includePaths = walked.map(e => e.abs);

  return {
    fileCount: includePaths.length,
    includePaths,
    pgSourceDir,
    wrote
  };
}

/**
 * Regenerate `codegen/embedded-sdk-manifest.ts` from the on-disk SDK
 * source at `<rootDir>/sdk/` and return the absolute paths to feed into
 * `deno compile --include`. When the source dir is missing, returns an
 * empty manifest + zero include paths — the binary still builds, just
 * without an embedded SDK.
 */
export async function refreshEmbeddedSdkManifest(rootDir: string = Deno.cwd()): Promise<RefreshEmbeddedSdkResult> {
  const manifestDir = join(rootDir, "codegen");
  const manifestPath = join(manifestDir, "embedded-sdk-manifest.ts");
  const sdkSourceDir = join(rootDir, "sdk");
  const generated = await generateEmbeddedSdkManifest({ manifestDir, sourceDir: sdkSourceDir });
  let existing = "";

  try {
    existing = await Deno.readTextFile(manifestPath);
  } catch {
    /*** Missing — write fresh. ***/
  }

  const wrote = existing !== generated;

  if (wrote)
    await Deno.writeTextFile(manifestPath, generated);

  /*** Walk the source dir directly for the include path list — the new manifest format embeds URLs
       via `import.meta.resolve(...)` rather than absolute `file://` literals, so a regex over the
       generated source no longer recovers the build-time absolute paths that
       `deno compile --include` needs. ***/
  const walked: { abs: string; rel: string; }[] = [];
  let exists = false;

  try {
    const stat = await Deno.stat(sdkSourceDir);
    exists = stat.isDirectory;
  } catch {
    exists = false;
  }

  if (exists) {
    await walkSdkSource(sdkSourceDir, sdkSourceDir, walked);
    walked.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  const includePaths = walked.map(e => e.abs);

  return {
    fileCount: includePaths.length,
    includePaths,
    sdkSourceDir,
    wrote
  };
}

/**
 * Regenerate `server/ui-asset-manifest.ts` from the on-disk UI build.
 * Skips silently when the build directory is missing — the caller
 * (`BuildCommand.execute`) has already decided whether the UI is in
 * scope (`!options.lite`).
 */
export async function refreshUiManifest(rootDir: string = Deno.cwd()): Promise<{ path: string; wrote: boolean; }> {
  const buildDir = join(rootDir, "ui", "build");
  const manifestPath = join(rootDir, "server", "ui-asset-manifest.ts");

  try {
    const stat = await Deno.stat(buildDir);

    if (!stat.isDirectory)
      return { path: manifestPath, wrote: false };
  } catch {
    return { path: manifestPath, wrote: false };
  }

  const generated = await generateUiManifest(buildDir);
  /*** Only write when the contents differ — avoids touching the file mtime on no-op builds, which
       keeps incremental tooling happy. ***/
  let existing = "";

  try {
    existing = await Deno.readTextFile(manifestPath);
  } catch {
    /*** Missing — write fresh. ***/
  }

  if (existing === generated)
    return { path: manifestPath, wrote: false };

  await Deno.writeTextFile(manifestPath, generated);

  return { path: manifestPath, wrote: true };
}

/*** HELPER ------------------------------------------- ***/

/**
 * Discover the home directory for the bundled PG distribution. Mirrors
 * `lib/project-context.ts:discHome` precedence: `$DISC_HOME`, then
 * `$HOME/.disc`. Returned as an absolute path.
 */
function defaultDiscHome(): string {
  const explicit = Deno.env.get("DISC_HOME");

  if (explicit)
    return explicit;

  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/tmp";
  return join(home, ".disc");
}

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

      if (entry.isDirectory)
        await walk(full);
      else if (entry.isFile)
        out.push(relative(buildDir, full).split("\\").join("/"));
    }
  }

  await walk(buildDir);
  out.sort();

  return out;
}

/**
 * Normalize a path produced by `relative()` to POSIX separators and
 * ensure it starts with `./` or `../` so it’s a valid relative URL
 * for `import.meta.resolve()`. A path like `sdk/auth.ts` (sibling
 * directory) gets a leading `./` so URL resolution treats it as a
 * relative reference rather than an absolute one.
 */
function toPosixRel(p: string): string {
  const posix = p.split("\\").join("/");

  if (posix.startsWith("../") || posix === "..")
    return posix;

  if (posix.startsWith("./"))
    return posix;

  return `./${posix}`;
}

/**
 * Recursive directory walker shared by `generateEmbeddedPgManifest`.
 * Pulled out so the parent function stays at the top level (lint:
 * `no-inner-declarations`).
 */
async function walkPgSource(rootDir: string, dir: string, entries: { abs: string; mode: number; rel: string; }[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const full = join(dir, entry.name);

    if (entry.isDirectory) {
      await walkPgSource(rootDir, full, entries);
      continue;
    }

    if (!entry.isFile)
      continue;

    const rel = relative(rootDir, full).split("\\").join("/");
    const mode = rel.startsWith("bin/") ? 0o755 : 0o644;
    entries.push({ abs: full, mode, rel });
  }
}

/**
 * Recursive directory walker shared by `generateEmbeddedSdkManifest`.
 * Mirrors `walkPgSource` but skips test files. Pulled out to keep the
 * parent function at the top level (lint: `no-inner-declarations`).
 */
async function walkSdkSource(rootDir: string, dir: string, entries: { abs: string; rel: string; }[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const full = join(dir, entry.name);

    if (entry.isDirectory) {
      await walkSdkSource(rootDir, full, entries);
      continue;
    }

    if (!entry.isFile)
      continue;

    if (!entry.name.endsWith(".ts"))
      continue;

    if (entry.name.endsWith(".test.ts"))
      continue;

    const rel = relative(rootDir, full).split("\\").join("/");
    entries.push({ abs: full, rel });
  }
}

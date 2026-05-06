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
   * Build the argument list for `deno compile`.
   */
  buildCompileArgs(options: BuildOptions): string[] {
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

    const compileArgs = this.buildCompileArgs(options);

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

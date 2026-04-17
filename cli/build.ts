// deno-lint-ignore-file no-console
/**
 * CLI Build Command Implementation - Deno native compilation
 *
 * Wraps `deno compile` to produce self-contained binaries for Disc.
 * Supports cross-compilation to multiple platforms via --platform flag.
 */

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
        `Invalid platform: "${platform}". Valid platforms: ${
          AVAILABLE_PLATFORMS.join(", ")
        }`,
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

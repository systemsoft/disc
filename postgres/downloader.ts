/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { logger } from "./logger.ts";

export interface BinaryManifest {
  platform: string;
  url: string;
  version: string;
}

// Zonky publishes embedded-postgres binaries to Maven Central, not GitHub
// Releases (their `v*.0` tags ship zero assets). Each artifact is a `.jar`
// (a zip) containing a single nested `postgres-<platform>.txz`. We download
// the JAR, unzip to find the inner archive, then extract it normally.
// Native arm64 builds keep ARM Macs off Rosetta (P1-03).
const ZONKY_BASE = "https://repo1.maven.org/maven2/io/zonky/test/postgres";

function zonkyJar(platformSlug: string, version: string): string {
  const artifact = `embedded-postgres-binaries-${platformSlug}`;
  return `${ZONKY_BASE}/${artifact}/${version}/${artifact}-${version}.jar`;
}

// 18.4 is the default (latest Zonky publishes). 16.4 and 17.0 are kept
// for `disc pg upgrade` compatibility and existing on-disk instances —
// the data directory format is major-version-specific, so an instance
// initialized under 16/17 can't be swapped in place to 18.
const POSTGRES_VERSIONS = {
  "16.4": {
    "darwin-arm64": { url: zonkyJar("darwin-arm64v8", "16.4.0") },
    "darwin-x64": { url: zonkyJar("darwin-amd64", "16.4.0") },
    "linux-arm64": { url: zonkyJar("linux-arm64v8", "16.4.0") },
    "linux-x64": { url: zonkyJar("linux-amd64", "16.4.0") },
    "windows-x64": { url: zonkyJar("windows-amd64", "16.4.0") }
  },
  "17.0": {
    "darwin-arm64": { url: zonkyJar("darwin-arm64v8", "17.0.0") },
    "darwin-x64": { url: zonkyJar("darwin-amd64", "17.0.0") },
    "linux-arm64": { url: zonkyJar("linux-arm64v8", "17.0.0") },
    "linux-x64": { url: zonkyJar("linux-amd64", "17.0.0") },
    "windows-x64": { url: zonkyJar("windows-amd64", "17.0.0") }
  },
  "18.4": {
    "darwin-arm64": { url: zonkyJar("darwin-arm64v8", "18.4.0") },
    "darwin-x64": { url: zonkyJar("darwin-amd64", "18.4.0") },
    "linux-arm64": { url: zonkyJar("linux-arm64v8", "18.4.0") },
    "linux-x64": { url: zonkyJar("linux-amd64", "18.4.0") },
    "windows-x64": { url: zonkyJar("windows-amd64", "18.4.0") }
  }
};

export class PostgresBinaryDownloader {
  private baseDir: string;
  private platform: string;

  /**
   * `baseDir` defaults to `$DISC_PG_BINARY_DIR` if set, else
   * `<HOME>/.disc/postgres`. The env var is the offline-setup escape
   * hatch (gh/geldata#3406): operators in air-gapped environments can
   * pre-stage PG binaries under any directory and point Disc at them
   * without ever calling out to the network. Once `bin/postgres`
   * exists at `<baseDir>/<version>/bin/postgres`, `download()` skips
   * the fetch and returns the existing path.
   *
   * Pass an explicit directory (e.g. a per-platform staging dir under
   * `dist/`) when cross-compiling. `platform` defaults to the running
   * platform's detected slug; pass an explicit slug
   * (`darwin-arm64`/`darwin-x64`/`linux-arm64`/`linux-x64`/`windows-x64`)
   * when staging PG for a target other than the current host (Bundle I
   * follow-up: cross-platform reproducible builds).
   */
  constructor(
    baseDirOrOpts: string | { baseDir?: string; platform?: string; } = Deno.env.get("DISC_PG_BINARY_DIR") ??
      join(Deno.env.get("HOME")!, ".disc", "postgres")
  ) {
    const defaultBaseDir = Deno.env.get("DISC_PG_BINARY_DIR") ??
      join(Deno.env.get("HOME")!, ".disc", "postgres");
    if (typeof baseDirOrOpts === "string") {
      this.baseDir = baseDirOrOpts;
      this.platform = this.detectPlatform();
    } else {
      this.baseDir = baseDirOrOpts.baseDir ?? defaultBaseDir;
      this.platform = baseDirOrOpts.platform ?? this.detectPlatform();
    }
  }

  private detectPlatform(): string {
    const os = Deno.build.os;
    const arch = Deno.build.arch;

    if (os === "darwin") {
      return arch === "aarch64" ? "darwin-arm64" : "darwin-x64";
    } else if (os === "linux") {
      return arch === "aarch64" ? "linux-arm64" : "linux-x64";
    } else if (os === "windows") {
      // Only an x64 Windows PG is published (Zonky has no windows-arm64
      // build); Windows-on-ARM runs the x64 binary under emulation.
      return "windows-x64";
    }

    throw new Error(`Unsupported platform: ${os}-${arch}`);
  }

  // The postgres executable is `postgres.exe` on Windows, `postgres`
  // everywhere else. Used for the already-downloaded short-circuit and
  // nested-directory normalization so both work for a windows target.
  private postgresBinName(): string {
    return this.platform.startsWith("windows") ? "postgres.exe" : "postgres";
  }

  async download(version = "18.4"): Promise<string> {
    const versionDir = join(this.baseDir, version);
    const binPath = join(versionDir, "bin", this.postgresBinName());

    // Check if already downloaded
    try {
      await Deno.stat(binPath);
      logger.debug(`PostgreSQL ${version} already downloaded`);

      return versionDir;
    } catch {
      // Not downloaded yet, proceed
    }

    // Offline mode (gh/geldata#3406). When `DISC_OFFLINE=1` is set, a
    // missing binary is a hard error rather than a silent download —
    // gives air-gapped operators a clear failure with the path they
    // need to populate, and prevents an accidental network call in
    // sandboxed CI environments.
    const offline = Deno.env.get("DISC_OFFLINE") === "1" ||
      Deno.env.get("DISC_OFFLINE") === "true";
    if (offline) {
      throw new Error(
        `DISC_OFFLINE=1 set but PostgreSQL ${version} not staged at ${binPath}. ` +
          `Pre-stage a PG ${version} build for ${this.platform} under ` +
          `${this.baseDir} (or set DISC_PG_BINARY_DIR to its location), ` +
          `or unset DISC_OFFLINE to allow the download.`
      );
    }

    const manifest = this.getManifest(version);
    if (!manifest) {
      throw new Error(
        `No PostgreSQL binary available for ${this.platform} v${version}`
      );
    }

    logger.info(`Downloading PostgreSQL ${version} for ${this.platform}…`);
    logger.info(`Download URL: ${manifest.url}`);

    // Ensure directory exists
    await ensureDir(versionDir);

    // Download binary archive
    const response = await fetch(manifest.url);
    if (!response.ok) {
      throw new Error(`Failed to download PostgreSQL: ${response.statusText}`);
    }

    // Preserve the original file extension so extractArchive can detect the format
    const urlPath = new URL(manifest.url).pathname;
    const archiveExt = urlPath.endsWith(".txz") ?
      ".txz" :
      urlPath.endsWith(".tgz") ?
      ".tgz" :
      urlPath.endsWith(".tar.xz") ?
      ".tar.xz" :
      urlPath.endsWith(".tar.gz") ?
      ".tar.gz" :
      urlPath.endsWith(".zip") ?
      ".zip" :
      urlPath.endsWith(".jar") ?
      ".jar" :
      urlPath.endsWith(".tar") ?
      ".tar" :
      ".archive";
    const archivePath = join(versionDir, `postgres${archiveExt}`);
    const data = new Uint8Array(await response.arrayBuffer());
    await Deno.writeFile(archivePath, data);

    // Extract archive
    await this.extractArchive(archivePath, versionDir);

    // Cleanup archive
    await Deno.remove(archivePath);

    // Handle nested directory structure from some archives
    await this.normalizeDirectoryStructure(versionDir);

    // Make binaries executable
    await this.makeExecutable(versionDir);

    logger.info(
      `PostgreSQL ${version} downloaded successfully to ${versionDir}`
    );
    return versionDir;
  }

  private async normalizeDirectoryStructure(versionDir: string): Promise<void> {
    // Some archives extract to a nested directory like "pgsql/"
    // Check if this is the case and move contents up
    try {
      const entries = [];
      for await (const entry of Deno.readDir(versionDir)) {
        entries.push(entry);
      }

      // If there's only one directory and it contains postgres binaries, move its contents up
      if (entries.length === 1 && entries[0].isDirectory) {
        const nestedDir = join(versionDir, entries[0].name);
        const nestedBinPath = join(nestedDir, "bin", this.postgresBinName());

        try {
          await Deno.stat(nestedBinPath);
          // Found postgres binary in nested directory, move everything up
          logger.info(
            `Normalizing directory structure from ${entries[0].name}`
          );

          for await (const entry of Deno.readDir(nestedDir)) {
            const src = join(nestedDir, entry.name);
            const dest = join(versionDir, entry.name);
            await Deno.rename(src, dest);
          }

          // Remove the now-empty nested directory
          await Deno.remove(nestedDir);
        } catch {
          // Nested directory doesn't contain postgres binaries, leave as is
        }
      }
    } catch (error) {
      logger.warn(`Could not normalize directory structure: ${error}`);
    }
  }

  private getManifest(version: string): BinaryManifest | null {
    const versionManifests = POSTGRES_VERSIONS[version as keyof typeof POSTGRES_VERSIONS];
    if (!versionManifests) {
      return null;
    }

    const platformManifest = versionManifests[this.platform as keyof typeof versionManifests];
    if (!platformManifest) {
      return null;
    }

    return {
      ...platformManifest,
      platform: this.platform,
      version
    };
  }

  private async extractArchive(
    archivePath: string,
    targetDir: string
  ): Promise<void> {
    const filename = archivePath.toLowerCase();

    // Zonky's Maven JARs wrap the actual binary archive. Unzip into a
    // staging dir, find the inner postgres-*.txz, then recurse.
    if (filename.endsWith(".jar")) {
      const stagingDir = await Deno.makeTempDir({ prefix: "disc-jar-" });
      try {
        const unzip = await new Deno.Command("unzip", {
          args: ["-q", "-o", archivePath, "-d", stagingDir],
          stdout: "piped",
          stderr: "piped"
        })
          .output();
        if (!unzip.success) {
          const stderr = new TextDecoder().decode(unzip.stderr);
          throw new Error(`Failed to extract JAR: ${stderr}`);
        }

        let inner: string | null = null;
        for await (const entry of Deno.readDir(stagingDir)) {
          if (
            entry.isFile &&
            /\.(txz|tar\.xz|tgz|tar\.gz|tar)$/i.test(entry.name)
          ) {
            inner = join(stagingDir, entry.name);
            break;
          }
        }
        if (!inner) {
          throw new Error(`No inner archive found inside JAR: ${archivePath}`);
        }
        await this.extractArchive(inner, targetDir);
      } finally {
        await Deno.remove(stagingDir, { recursive: true });
      }
      return;
    }

    // Determine archive type and appropriate extraction command
    let extractCmd: Deno.Command;

    if (filename.endsWith(".zip")) {
      extractCmd = new Deno.Command("unzip", {
        args: ["-q", "-o", archivePath, "-d", targetDir],
        stdout: "piped",
        stderr: "piped"
      });
    } else if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) {
      extractCmd = new Deno.Command("tar", {
        args: ["-xzf", archivePath, "-C", targetDir],
        stdout: "piped",
        stderr: "piped"
      });
    } else if (filename.endsWith(".tar.xz") || filename.endsWith(".txz")) {
      extractCmd = new Deno.Command("tar", {
        args: ["-xJf", archivePath, "-C", targetDir],
        stdout: "piped",
        stderr: "piped"
      });
    } else if (filename.endsWith(".tar")) {
      extractCmd = new Deno.Command("tar", {
        args: ["-xf", archivePath, "-C", targetDir],
        stdout: "piped",
        stderr: "piped"
      });
    } else {
      throw new Error(`Unsupported archive format: ${archivePath}`);
    }

    logger.info(`Extracting archive…`);
    const output = await extractCmd.output();

    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`Failed to extract PostgreSQL archive: ${stderr}`);
    }

    logger.info("Archive extracted successfully");
  }

  private async makeExecutable(versionDir: string): Promise<void> {
    const binDir = join(versionDir, "bin");

    try {
      for await (const entry of Deno.readDir(binDir)) {
        if (entry.isFile) {
          await Deno.chmod(join(binDir, entry.name), 0o755);
        }
      }
    } catch (error) {
      logger.warn(`Warning: Could not set executable permissions: ${error}`);
    }
  }

  async ensurePostgres(version = "18.4"): Promise<string> {
    return await this.download(version);
  }
}

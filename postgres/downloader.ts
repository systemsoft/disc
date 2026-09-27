/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { sha256Hex } from "../lib/crypto.ts";
import { discHome } from "../lib/project-context.ts";
import { logger } from "./logger.ts";

export interface BinaryManifest {
  platform: string;
  sha256: string;
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
//
// Every JAR's SHA-256 is pinned: computed from the downloaded artifact and
// cross-checked against Maven Central's `<jar>.sha256` sidecar. A download
// that doesn't match is discarded before anything is written to disk.
const POSTGRES_VERSIONS = {
  "16.4": {
    "darwin-arm64": {
      sha256: "ad810a174664012341f1c9c1ff9667f61930d054f34bd650ceb2bc0c8796ccf9",
      url: zonkyJar("darwin-arm64v8", "16.4.0")
    },
    "darwin-x64": {
      sha256: "e9a4d0de025426978d39087e2dfad265cb22a70ad19aa388857e4dcf6cf55f25",
      url: zonkyJar("darwin-amd64", "16.4.0")
    },
    "linux-arm64": {
      sha256: "5a281952dd35191be97809ce657d6cb1a7b42a8d8ca6195125dd368d47eb8c42",
      url: zonkyJar("linux-arm64v8", "16.4.0")
    },
    "linux-x64": {
      sha256: "14a5cf546aee7d327a2f5b46be6c571f2f724a2b485c270d46f3e44a1ac3df18",
      url: zonkyJar("linux-amd64", "16.4.0")
    },
    "windows-x64": {
      sha256: "5748a1b03f3771cd7a6d8aa624975e2777f62525694bf63af9640deaa48cc87a",
      url: zonkyJar("windows-amd64", "16.4.0")
    }
  },
  "17.0": {
    "darwin-arm64": {
      sha256: "258cc7212623632e5073c58d466242c7f0be445f7eaeb29ec323d27b4bacb223",
      url: zonkyJar("darwin-arm64v8", "17.0.0")
    },
    "darwin-x64": {
      sha256: "02f07b924268145e15c66640d5b411d3c6dffb13a27cf3fe3d7f916df0eee71a",
      url: zonkyJar("darwin-amd64", "17.0.0")
    },
    "linux-arm64": {
      sha256: "5ef32d7fe417af5b52115c8f7a1b2d7148ae6b6f21b6144135c54ee80891752a",
      url: zonkyJar("linux-arm64v8", "17.0.0")
    },
    "linux-x64": {
      sha256: "6f54b880a46e1ab2dab3615259f5534a4710a1cbc0093a590e96c18b9fc7f157",
      url: zonkyJar("linux-amd64", "17.0.0")
    },
    "windows-x64": {
      sha256: "e860224b69f7db12160a47af6495075e7aa6a43aba7f1f32f50e995d3ca0785d",
      url: zonkyJar("windows-amd64", "17.0.0")
    }
  },
  "18.4": {
    "darwin-arm64": {
      sha256: "ab698c4486a795d2aa8a158b3a41e1201a77e7ff72a6255094cd5900080853c2",
      url: zonkyJar("darwin-arm64v8", "18.4.0")
    },
    "darwin-x64": {
      sha256: "68381ed1488edd337345c6c4bc6ae0c823832a4dd7af8b04656ee5c218c291b5",
      url: zonkyJar("darwin-amd64", "18.4.0")
    },
    "linux-arm64": {
      sha256: "a9ec284923b9a7d2db41509bfb88c3d0eeb9f4aa5e2b29ea0aac5e8dbaf4c335",
      url: zonkyJar("linux-arm64v8", "18.4.0")
    },
    "linux-x64": {
      sha256: "401d4e69baba9072d3772607710df0d47b39a7632c6b01b2a5f5d85a9514e212",
      url: zonkyJar("linux-amd64", "18.4.0")
    },
    "windows-x64": {
      sha256: "1f71b4d67eeee94034ffbea7a9fae68ab34ff1e31ac01837acb6f56984350ece",
      url: zonkyJar("windows-amd64", "18.4.0")
    }
  }
};

/**
 * Disc's platform slug for the running host (`darwin-arm64`, `darwin-x64`,
 * `linux-arm64`, `linux-x64`, `windows-x64`). Shared by the server-binary
 * downloader and the on-demand client-tools download (`client-tools.ts`).
 */
export function detectPgPlatform(): string {
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

/** PostgreSQL versions Disc can download (and `disc pg upgrade` can target), oldest first. */
export const SUPPORTED_POSTGRES_VERSIONS: readonly string[] = Object.keys(POSTGRES_VERSIONS);

export interface PostgresBinaryDownloaderOptions {
  baseDir?: string;
  /** Injected for tests. Default the global `fetch`. */
  fetch?: typeof fetch;
  platform?: string;
}

export class PostgresBinaryDownloader {
  private baseDir: string;
  private fetchFn: typeof fetch;
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
    baseDirOrOpts: string | PostgresBinaryDownloaderOptions = Deno.env.get("DISC_PG_BINARY_DIR") ??
      join(discHome(), "postgres")
  ) {
    const defaultBaseDir = Deno.env.get("DISC_PG_BINARY_DIR") ?? join(discHome(), "postgres");
    if (typeof baseDirOrOpts === "string") {
      this.baseDir = baseDirOrOpts;
      this.fetchFn = fetch;
      this.platform = this.detectPlatform();
    } else {
      this.baseDir = baseDirOrOpts.baseDir ?? defaultBaseDir;
      this.fetchFn = baseDirOrOpts.fetch ?? fetch;
      this.platform = baseDirOrOpts.platform ?? this.detectPlatform();
    }
  }

  /** The directory versions are cached under (`<baseDir>/<version>/`). */
  getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * Versions already on disk (`<baseDir>/<version>/bin/postgres` exists),
   * whether downloaded by Disc or pre-staged by an operator.
   */
  async cachedVersions(): Promise<string[]> {
    const versions: string[] = [];

    try {
      for await (const entry of Deno.readDir(this.baseDir)) {
        if (!entry.isDirectory)
          continue;

        try {
          if ((await Deno.stat(join(this.baseDir, entry.name, "bin", this.postgresBinName()))).isFile)
            versions.push(entry.name);
        } catch {
          // Not a PostgreSQL install (or a partial one) — skip.
        }
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound))
        throw err;
    }

    return versions;
  }

  private detectPlatform(): string {
    return detectPgPlatform();
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

    // Download binary archive
    const response = await this.fetchFn(manifest.url);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Failed to download PostgreSQL: ${response.statusText}`);
    }

    // Verify before anything touches the cache: a truncated or tampered
    // download must never be extracted where later runs would trust it.
    const data = new Uint8Array(await response.arrayBuffer());
    const actual = await sha256Hex(data);
    if (actual !== manifest.sha256) {
      throw new Error(
        `Checksum mismatch for ${manifest.url}: expected sha256 ${manifest.sha256}, got ${actual}. ` +
          `The download was discarded.`
      );
    }

    await ensureDir(versionDir);
    try {
      await this.install(data, manifest.url, versionDir);
    } catch (err) {
      // Don't leave a half-extracted version dir behind for the
      // already-downloaded short-circuit to trust on the next run.
      await Deno.remove(versionDir, { recursive: true }).catch(() => {});
      throw err;
    }

    logger.info(
      `PostgreSQL ${version} downloaded successfully to ${versionDir}`
    );
    return versionDir;
  }

  private async install(data: Uint8Array, url: string, versionDir: string): Promise<void> {
    // Preserve the original file extension so extractArchive can detect the format
    const urlPath = new URL(url).pathname;
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
    await Deno.writeFile(archivePath, data);

    // Extract archive, removing the downloaded archive even if extraction
    // throws so a failed download can't orphan a multi-hundred-MB file.
    try {
      await this.extractArchive(archivePath, versionDir);
    } finally {
      await Deno.remove(archivePath).catch(() => {});
    }

    // Handle nested directory structure from some archives
    await this.normalizeDirectoryStructure(versionDir);

    // Make binaries executable
    await this.makeExecutable(versionDir);
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

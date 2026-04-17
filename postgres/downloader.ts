import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { logger } from "./logger.ts";

export interface BinaryManifest {
  platform: string;
  url: string;
  version: string;
}

// P1-03: use zonkyio's embedded-postgres-binaries for darwin-arm64 — they
// ship a native ARM64 build. The EnterpriseDB "osx-binaries.zip" used
// previously for both Mac targets is x86_64 only, so ARM Macs ended up
// running PG under Rosetta. x86 Mac still uses EDB because zonky ships
// txz only for ARM on macOS.
const POSTGRES_VERSIONS = {
  "16.4": {
    "darwin-arm64": {
      url:
        "https://github.com/zonkyio/embedded-postgres-binaries/releases/download/v16.4.0/postgres-darwin-arm_64v8.txz",
    },
    "darwin-x64": {
      url:
        "https://get.enterprisedb.com/postgresql/postgresql-16.4-1-osx-binaries.zip",
    },
    "linux-arm64": {
      url:
        "https://github.com/zonkyio/embedded-postgres-binaries/releases/download/v16.4.0/postgres-linux-arm_64.txz",
    },
    "linux-x64": {
      url:
        "https://github.com/zonkyio/embedded-postgres-binaries/releases/download/v16.4.0/postgres-linux-x86_64.txz",
    },
  },
  "17.0": {
    "darwin-arm64": {
      url:
        "https://github.com/zonkyio/embedded-postgres-binaries/releases/download/v17.0.0/postgres-darwin-arm_64v8.txz",
    },
    "darwin-x64": {
      url:
        "https://get.enterprisedb.com/postgresql/postgresql-17.0-1-osx-binaries.zip",
    },
    "linux-arm64": {
      url:
        "https://github.com/zonkyio/embedded-postgres-binaries/releases/download/v17.0.0/postgres-linux-arm_64.txz",
    },
    "linux-x64": {
      url:
        "https://github.com/zonkyio/embedded-postgres-binaries/releases/download/v17.0.0/postgres-linux-x86_64.txz",
    },
  },
};

export class PostgresBinaryDownloader {
  private baseDir: string;
  private platform: string;

  constructor(baseDir = join(Deno.env.get("HOME")!, ".disc", "postgres")) {
    this.baseDir = baseDir;
    this.platform = this.detectPlatform();
  }

  private detectPlatform(): string {
    const os = Deno.build.os;
    const arch = Deno.build.arch;

    if (os === "darwin") {
      return arch === "aarch64" ? "darwin-arm64" : "darwin-x64";
    } else if (os === "linux") {
      return arch === "aarch64" ? "linux-arm64" : "linux-x64";
    } else if (os === "windows") {
      throw new Error("Windows support not yet implemented");
    }

    throw new Error(`Unsupported platform: ${os}-${arch}`);
  }

  async download(version = "16.4"): Promise<string> {
    const versionDir = join(this.baseDir, version);
    const binPath = join(versionDir, "bin", "postgres");

    // Check if already downloaded
    try {
      await Deno.stat(binPath);
      logger.info(`PostgreSQL ${version} already downloaded`);
      return versionDir;
    } catch {
      // Not downloaded yet, proceed
    }

    const manifest = this.getManifest(version);
    if (!manifest) {
      throw new Error(
        `No PostgreSQL binary available for ${this.platform} v${version}`,
      );
    }

    logger.info(`Downloading PostgreSQL ${version} for ${this.platform}...`);
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
    const archiveExt = urlPath.endsWith(".txz")
      ? ".txz"
      : urlPath.endsWith(".tgz")
        ? ".tgz"
        : urlPath.endsWith(".tar.xz")
          ? ".tar.xz"
          : urlPath.endsWith(".tar.gz")
            ? ".tar.gz"
            : urlPath.endsWith(".zip")
              ? ".zip"
              : urlPath.endsWith(".tar")
                ? ".tar"
                : ".archive";
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
      `PostgreSQL ${version} downloaded successfully to ${versionDir}`,
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
        const nestedBinPath = join(nestedDir, "bin", "postgres");

        try {
          await Deno.stat(nestedBinPath);
          // Found postgres binary in nested directory, move everything up
          logger.info(
            `Normalizing directory structure from ${entries[0].name}`,
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
    const versionManifests =
      POSTGRES_VERSIONS[version as keyof typeof POSTGRES_VERSIONS];
    if (!versionManifests) return null;

    const platformManifest =
      versionManifests[this.platform as keyof typeof versionManifests];
    if (!platformManifest) return null;

    return {
      ...platformManifest,
      platform: this.platform,
      version,
    };
  }

  private async extractArchive(
    archivePath: string,
    targetDir: string,
  ): Promise<void> {
    const filename = archivePath.toLowerCase();

    // Determine archive type and appropriate extraction command
    let extractCmd: Deno.Command;

    if (filename.endsWith(".zip")) {
      extractCmd = new Deno.Command("unzip", {
        args: ["-q", "-o", archivePath, "-d", targetDir],
        stdout: "piped",
        stderr: "piped",
      });
    } else if (filename.endsWith(".tar.gz") || filename.endsWith(".tgz")) {
      extractCmd = new Deno.Command("tar", {
        args: ["-xzf", archivePath, "-C", targetDir],
        stdout: "piped",
        stderr: "piped",
      });
    } else if (filename.endsWith(".tar.xz") || filename.endsWith(".txz")) {
      extractCmd = new Deno.Command("tar", {
        args: ["-xJf", archivePath, "-C", targetDir],
        stdout: "piped",
        stderr: "piped",
      });
    } else if (filename.endsWith(".tar")) {
      extractCmd = new Deno.Command("tar", {
        args: ["-xf", archivePath, "-C", targetDir],
        stdout: "piped",
        stderr: "piped",
      });
    } else {
      throw new Error(`Unsupported archive format: ${archivePath}`);
    }

    logger.info(`Extracting archive...`);
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

  async ensurePostgres(version = "16.4"): Promise<string> {
    return await this.download(version);
  }
}

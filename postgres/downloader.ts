import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { logger } from "./logger.ts";

export interface BinaryManifest {
  checksums: string; // Simplified for now, would be SHA256 hash
  platform: string;
  url: string;
  version: string;
}

const POSTGRES_VERSIONS = {
  "16.4": {
    "darwin-arm64": {
      checksums: "sha256:abc123def456...",
      url:
        "https://get.enterprisedb.com/postgresql/postgresql-16.4-1-osx-binaries.zip",
    },
    "darwin-x64": {
      checksums: "sha256:fed654cba321...",
      url:
        "https://get.enterprisedb.com/postgresql/postgresql-16.4-1-osx-binaries.zip",
    },
    "linux-arm64": {
      checksums: "sha256:789012def345...",
      url:
        "https://github.com/zonkyio/embedded-postgres-binaries/releases/download/v16.4.0/postgres-linux-arm64.tar.xz",
    },
    "linux-x64": {
      checksums: "sha256:456789abc012...",
      url:
        "https://github.com/zonkyio/embedded-postgres-binaries/releases/download/v16.4.0/postgres-linux-x86_64.tar.xz",
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

    // Ensure directory exists
    await ensureDir(versionDir);

    // Download binary archive
    const response = await fetch(manifest.url);
    if (!response.ok) {
      throw new Error(`Failed to download PostgreSQL: ${response.statusText}`);
    }

    const archivePath = join(versionDir, "postgres.archive");
    const buffer = await response.arrayBuffer();
    await Deno.writeFile(archivePath, new Uint8Array(buffer));

    // TODO: Verify checksum - would compute SHA256 and compare with manifest
    logger.info("Skipping checksum verification (not implemented yet)...");
    // In production, compare with manifest.checksums

    // Extract archive
    await this.extractArchive(archivePath, versionDir);

    // Cleanup archive
    await Deno.remove(archivePath);

    // Make binaries executable
    await this.makeExecutable(versionDir);

    logger.info(
      `PostgreSQL ${version} downloaded successfully to ${versionDir}`,
    );
    return versionDir;
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
    const ext = archivePath.endsWith(".zip") ? "zip" : "tar";

    if (ext === "zip") {
      const cmd = new Deno.Command("unzip", {
        args: ["-q", archivePath, "-d", targetDir],
      });
      const output = await cmd.output();
      if (!output.success) {
        throw new Error("Failed to extract PostgreSQL archive");
      }
    } else {
      const cmd = new Deno.Command("tar", {
        args: ["-xf", archivePath, "-C", targetDir],
      });
      const output = await cmd.output();
      if (!output.success) {
        throw new Error("Failed to extract PostgreSQL archive");
      }
    }
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

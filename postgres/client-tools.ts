/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * On-demand PostgreSQL client tools (pg_dump, pg_dumpall, pg_restore, psql).
 *
 * The bundled server comes from Zonky's embedded-postgres builds, which ship
 * only `initdb`, `pg_ctl` and `postgres`. `disc db dump|restore` and
 * `disc pg upgrade` need the client utilities, so on first use we download a
 * full PostgreSQL build from theseus-rs/postgresql-binaries, verify it against
 * a SHA-256 pinned below, and cache it under
 * `<DISC_HOME>/postgres-client/<release>/`. Nothing here is embedded in
 * compiled Disc binaries — the download happens at runtime on every install.
 */

/*** NATIVE ------------------------------------------- ***/

import { ensureDir } from "@std/fs";
import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { sha256Hex } from "../lib/crypto.ts";
import { discHome } from "../lib/project-context.ts";
import { detectPgPlatform } from "./downloader.ts";
import { logger } from "./logger.ts";

/*** PROGRAM ------------------------------------------ ***/

export interface ClientToolsManifest {
  platform: string;
  /** theseus-rs release tag: `<pg major>.<pg minor>.<package revision>`. */
  release: string;
  serverMajor: string;
  sha256: string;
  url: string;
}

const THESEUS_BASE = "https://github.com/theseus-rs/postgresql-binaries/releases/download";

/**
 * Rust target triple per Disc platform slug. Linux uses the glibc builds (the
 * musl builds need the musl loader); Windows is x64-only, as for the server.
 */
const TARGET_TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "windows-x64": "x86_64-pc-windows-msvc"
};

/**
 * One client build per bundled server major, at the same PostgreSQL version as
 * the Zonky server (16.4, 17.0, 18.4). The release tag's last component is
 * theseus's package revision; we take the latest revision of each version.
 * SHA-256 values are pinned from the release's `<asset>.sha256` files (and,
 * for 18.4.0, cross-checked against GitHub's asset digests) so a compromised
 * or truncated download is rejected rather than trusted.
 */
const CLIENT_TOOLS_RELEASES: Record<string, { release: string; sha256: Record<string, string>; }> = {
  "16": {
    release: "16.4.1",
    sha256: {
      "darwin-arm64": "fee852f5749794be9266052d231adbe2469bca6fbde9c8fa352bb6186ab5042e",
      "darwin-x64": "6de992b9be6fd4a4f7aa68f99fe03eb74615576158b3fed4248e6777a2c989bb",
      "linux-arm64": "ab85b8ced033df593e6c41ae658993380c38584225ef46c2ef2fea49593f65a4",
      "linux-x64": "1c9a41e89e5d920f259baf973b37a564791a6c8f6495fa6c5c7ef0a5fc0e122c",
      "windows-x64": "404b429f7189a8a7acec71e478faf9ffc9b49ec428865d258ccbc196b4356950"
    }
  },
  "17": {
    release: "17.0.1",
    sha256: {
      "darwin-arm64": "fc09627627c7b1321601f450ef7102bf79c5c7b73d8124bf0568924ea33a9ea7",
      "darwin-x64": "ba631d1dff05643c5f1884b3e9c5bdff88d9db52cf7996a2b2d47cc9a952048f",
      "linux-arm64": "eb4bb4b434ba5d74e310eb33025f107c9ac48f7434d3c3672ffb430c8017b528",
      "linux-x64": "62ddba74736ab2d77c2670ce2400cda315adc1d2a87f0407bbea992c3c1a0c87",
      "windows-x64": "1ac066282d2d17ebc809215ff87f742f7a262c6dd4d398fb1c799b3706872ed7"
    }
  },
  "18": {
    release: "18.4.0",
    sha256: {
      "darwin-arm64": "1b68828f524b638a24918e258b173d0f16773547a0d3b83d9ba74473b61649f2",
      "darwin-x64": "cbc38067a795d10bbddc730e61c835df0b351c36a7bd2544d388790fcf50aa4d",
      "linux-arm64": "569984d426365c6ca3c197d2b3a999b73161ff1f3abc963824a8c3624620e5dd",
      "linux-x64": "65c06cf318b9a57525d842d658d6d18cd461d12b3a89b57d6d8ed7cccbe2db53",
      "windows-x64": "4099dcf71c74bed82736e17928d07591df0efee8f802449533b9557d99ae7988"
    }
  }
};

const ESCAPE_HATCH = "Or pass --pg-bin-dir pointing at a PostgreSQL bin directory (same or newer major version " +
  "as the server) that contains pg_dump, pg_restore and psql.";

/*** EXPORT ------------------------------------------- ***/

/**
 * Resolve the client build for a server version (`"16.4"`, or a bare major
 * such as `"16"` from `PG_VERSION`) on `platform`. Picks the same major when
 * published, else the oldest newer one — pg_dump reads older servers but not
 * newer ones, so a server newer than every build returns null.
 */
export function clientToolsManifest(serverVersion: string, platform: string): ClientToolsManifest | null {
  const serverMajor = parseInt(serverVersion.split(".")[0], 10);
  const triple = TARGET_TRIPLES[platform];

  if (Number.isNaN(serverMajor) || !triple)
    return null;

  const major = Object
    .keys(CLIENT_TOOLS_RELEASES)
    .map(Number)
    .sort((a, b) => a - b)
    .find(candidate => candidate >= serverMajor);

  if (major === undefined)
    return null;

  const { release, sha256 } = CLIENT_TOOLS_RELEASES[String(major)];

  return {
    platform,
    release,
    serverMajor: String(major),
    sha256: sha256[platform],
    url: `${THESEUS_BASE}/${release}/postgresql-${release}-${triple}.tar.gz`
  };
}

/** Path of PostgreSQL executable `tool` in `binDir` (`.exe` on Windows). */
export function pgToolPath(binDir: string, tool: string, os: string = Deno.build.os): string {
  return join(binDir, os === "windows" ? `${tool}.exe` : tool);
}

/** The server version recorded in a data directory's `PG_VERSION` (e.g. `"16"`), or null. */
export async function readDataDirVersion(dataDir: string): Promise<string | null> {
  try {
    return (await Deno.readTextFile(join(dataDir, "PG_VERSION"))).trim();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound)
      return null;

    throw err;
  }
}

export interface PostgresClientToolsOptions {
  /** Cache root. Default `<DISC_HOME>/postgres-client`. */
  baseDir?: string;
  /** Injected for tests. Default the global `fetch`. */
  fetch?: typeof fetch;
  /** Platform slug. Default the running host's. */
  platform?: string;
}

export class PostgresClientTools {
  private baseDir: string;
  private fetchFn: typeof fetch;
  private platform: string;

  constructor(options: PostgresClientToolsOptions = {}) {
    this.baseDir = options.baseDir ?? join(discHome(), "postgres-client");
    this.fetchFn = options.fetch ?? fetch;
    this.platform = options.platform ?? detectPgPlatform();
  }

  /**
   * Return the bin directory of client tools able to talk to a server of
   * `serverVersion`, downloading and verifying them on first use.
   */
  async ensure(serverVersion: string): Promise<string> {
    const manifest = clientToolsManifest(serverVersion, this.platform);

    if (!manifest) {
      throw new Error(
        `No PostgreSQL client tools are available for server version ${serverVersion} on ${this.platform} ` +
          `(published: ${Object.keys(CLIENT_TOOLS_RELEASES).join(", ")}). ${ESCAPE_HATCH}`
      );
    }

    const binDir = join(this.baseDir, manifest.release, "bin");

    if (await this.isInstalled(binDir)) {
      logger.debug(`PostgreSQL client tools ${manifest.release} already downloaded`);
      return binDir;
    }

    return await this.install(manifest);
  }

  /*** PRIVATE ------------------------------------------ ***/

  /**
   * Download, verify and unpack `manifest` into `<baseDir>/<release>/`.
   * Extraction happens in a staging dir that is renamed into place, so an
   * interrupted or failed install never leaves a half-populated cache.
   */
  private async install(manifest: ClientToolsManifest): Promise<string> {
    const releaseDir = join(this.baseDir, manifest.release);
    const binDir = join(releaseDir, "bin");
    const offline = Deno.env.get("DISC_OFFLINE") === "1" || Deno.env.get("DISC_OFFLINE") === "true";

    if (offline) {
      throw new Error(
        `DISC_OFFLINE=1 set but PostgreSQL client tools ${manifest.release} are not staged at ${releaseDir}. ` +
          `Extract ${manifest.url} there (so ${pgToolPath(binDir, "pg_dump", this.os())} exists), ` +
          `or unset DISC_OFFLINE to allow the download. ${ESCAPE_HATCH}`
      );
    }

    logger.info(`Downloading PostgreSQL client tools ${manifest.release} for ${this.platform}…`);
    logger.info(`Download URL: ${manifest.url}`);

    let response: Response;

    try {
      response = await this.fetchFn(manifest.url);
    } catch (err) {
      throw new Error(
        `Could not download PostgreSQL client tools from ${manifest.url}: ${(err as Error).message}. ` +
          `Check your network connection. ${ESCAPE_HATCH}`
      );
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Could not download PostgreSQL client tools from ${manifest.url}: HTTP ${response.status} ${response.statusText}. ${ESCAPE_HATCH}`
      );
    }

    const data = new Uint8Array(await response.arrayBuffer());
    const actual = await sha256Hex(data);

    if (actual !== manifest.sha256) {
      throw new Error(
        `Checksum mismatch for ${manifest.url}: expected sha256 ${manifest.sha256}, got ${actual}. ` +
          `The download was discarded.`
      );
    }

    await ensureDir(this.baseDir);
    const stagingDir = await Deno.makeTempDir({ dir: this.baseDir, prefix: `.staging-${manifest.release}-` });

    try {
      const archivePath = join(stagingDir, "client-tools.tar.gz");
      await Deno.writeFile(archivePath, data);

      /*** `tar` ships with macOS, Linux and Windows 10+ (bsdtar). ***/
      const extract = await new Deno.Command("tar", {
        args: ["-xzf", archivePath, "-C", stagingDir],
        stderr: "piped",
        stdout: "piped"
      })
        .output();

      if (!extract.success)
        throw new Error(`Failed to extract PostgreSQL client tools: ${new TextDecoder().decode(extract.stderr)}`);

      /*** Releases unpack to a single `postgresql-<release>-<triple>/` directory. ***/
      const extractedRoot = await this.findExtractedRoot(stagingDir);

      try {
        await Deno.rename(extractedRoot, releaseDir);
      } catch (err) {
        /*** A concurrent install won the race — its copy is equivalent. ***/
        if (!(await this.isInstalled(binDir)))
          throw err;
      }
    } finally {
      await Deno.remove(stagingDir, { recursive: true }).catch(() => {});
    }

    logger.info(`PostgreSQL client tools ${manifest.release} downloaded to ${releaseDir}`);
    return binDir;
  }

  private async findExtractedRoot(stagingDir: string): Promise<string> {
    for await (const entry of Deno.readDir(stagingDir)) {
      if (!entry.isDirectory)
        continue;

      const candidate = join(stagingDir, entry.name);

      if (await this.isInstalled(join(candidate, "bin")))
        return candidate;
    }

    throw new Error(`PostgreSQL client tools archive has no bin/${pgToolPath("", "pg_dump", this.os())}`);
  }

  private async isInstalled(binDir: string): Promise<boolean> {
    try {
      return (await Deno.stat(pgToolPath(binDir, "pg_dump", this.os()))).isFile;
    } catch {
      return false;
    }
  }

  private os(): string {
    return this.platform.startsWith("windows") ? "windows" : "posix";
  }
}

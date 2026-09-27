/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

// deno-lint-ignore-file no-console
/**
 * CLI PgUpgrade Command Implementation - PostgreSQL version upgrade functionality
 *
 * Handles upgrading the bundled PostgreSQL instance from one version to another
 * using a pg_dumpall/psql restore strategy with automatic backup and rollback
 * (see `PostgresManager.upgradeInstance`).
 */

/*** NATIVE ------------------------------------------- ***/

import { join } from "@std/path";

/*** UTILITY ------------------------------------------ ***/

import { resolveProjectContext } from "../lib/project-context.ts";
import { PostgresClientTools } from "../postgres/client-tools.ts";
import { PostgresBinaryDownloader, SUPPORTED_POSTGRES_VERSIONS } from "../postgres/downloader.ts";
import { compareVersions } from "../postgres/instance-version.ts";
import { PostgresManager } from "../postgres/mod.ts";

/*** EXPORT ------------------------------------------- ***/

export interface PgUpgradeOptions {
  backup?: boolean;
  dryRun?: boolean;
  project?: string;
  targetVersion: string;
}

/** Collaborators, injectable for tests. Defaults are built per run, from the environment at that time. */
export interface PgUpgradeDependencies {
  clientTools?: PostgresClientTools;
  downloader?: PostgresBinaryDownloader;
  postgresManager?: PostgresManager;
}

export class PgUpgradeCommand {
  private deps: PgUpgradeDependencies;

  constructor(deps: PgUpgradeDependencies = {}) {
    this.deps = deps;
  }

  /**
   * Execute the PostgreSQL upgrade process.
   *
   * Steps:
   *   1. Validate target version
   *   2. Discover and locate the current instance (its version comes from the data dir)
   *   3. Compare versions to ensure upgrade direction
   *   4. Print upgrade plan
   *   5. If not dry-run, fetch the target server + client tools and upgrade (rolled back on failure)
   */
  async execute(options: PgUpgradeOptions): Promise<void> {
    const project = options.project || this.currentProjectName();
    const targetVersion = options.targetVersion;
    const backup = options.backup !== false; /*** default true ***/
    const dryRun = options.dryRun || false;
    /*** Validate target version ***/
    const availableVersions = this.getAvailableVersions();

    if (!availableVersions.includes(targetVersion))
      throw new Error(`Unknown PostgreSQL version: ${targetVersion}. Available versions: ${availableVersions.join(", ")}`);

    const postgresManager = this.deps.postgresManager ?? new PostgresManager();

    /*** Discover existing instances ***/
    await postgresManager.discoverInstances();

    /*** Get current instance ***/
    const instance = postgresManager.getInstance(project);

    if (!instance)
      throw new Error(`No PostgreSQL instance found for project "${project}". Run "disc init" first.`);

    /*** The version the instance actually runs (data dir major + recorded exact version) ***/
    const currentVersion = instance.getVersion();

    if (this.compareVersions(currentVersion, targetVersion) >= 0)
      throw new Error(`Target version ${targetVersion} is not newer than current version ${currentVersion}`);

    const instanceDir = postgresManager.getInstanceDir(project);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = backup ? join(instanceDir, `backup-${currentVersion}-${timestamp}.tar.gz`) : undefined;

    /*** Print upgrade plan ***/
    console.log("PostgreSQL Upgrade Plan:");
    console.log(`  Project: ${project}`);
    console.log(`  Current version: ${currentVersion}`);
    console.log(`  Target version: ${targetVersion}`);
    console.log(`  Strategy: pg_dumpall + psql restore into a new data directory`);
    console.log(`  Backup: ${backupPath ?? "no"}`);

    /*** Dry run stops here ***/
    if (dryRun) {
      console.log("\nDry run complete. No changes were made.");
      return;
    }

    /*** Everything that can fail without touching the instance happens first. ***/
    console.log(`\nResolving PostgreSQL ${targetVersion} server binaries…`);
    const downloader = this.deps.downloader ?? new PostgresBinaryDownloader();
    const serverBinDir = join(await downloader.ensurePostgres(targetVersion), "bin");

    /*** pg_dumpall/psql come from the TARGET version's client tools: the bundled server builds
         ship no client utilities, and PostgreSQL recommends dumping with the newer version's
         pg_dumpall when upgrading (it reads older servers). ***/
    console.log(`Resolving PostgreSQL ${targetVersion} client tools…`);
    const clientTools = this.deps.clientTools ?? new PostgresClientTools();
    const clientBinDir = await clientTools.ensure(targetVersion);

    try {
      await postgresManager.upgradeInstance(project, targetVersion, {
        backupPath,
        clientBinDir,
        onProgress: (_step, message) => console.log(`\n${message}`),
        serverBinDir
      });
    } catch (error) {
      console.error(`\n${(error as Error).message}`);
      throw error;
    }

    /*** Prune old upgrade backups (keep the most recent few) ***/
    if (backupPath) {
      await this.pruneOldBackups(instanceDir);
      console.log(`\nBackup of the PostgreSQL ${currentVersion} data directory: ${backupPath}`);
    }

    console.log(`\nPostgreSQL upgraded successfully from ${currentVersion} to ${targetVersion}.`);
  }

  /*** PRIVATE ------------------------------------------ ***/

  /**
   * Remove old `backup-*.tar.gz` upgrade artifacts, keeping the most recent
   * `keep` by modification time. Each upgrade writes a timestamped tarball
   * that is never otherwise reaped, so without this they accumulate
   * unboundedly (potentially GB-scale each) across repeated upgrades.
   */
  private async pruneOldBackups(instanceDir: string, keep = 3): Promise<void> {
    const backups: { path: string; mtime: number; }[] = [];

    for await (const entry of Deno.readDir(instanceDir)) {
      if (
        !entry.isFile ||
        !entry.name.startsWith("backup-") ||
        !entry.name.endsWith(".tar.gz")
      ) {
        continue;
      }
      const path = join(instanceDir, entry.name);
      try {
        const stat = await Deno.stat(path);
        backups.push({ path, mtime: stat.mtime?.getTime() ?? 0 });
      } catch {
        /*** Race with another reaper; skip. ***/
      }
    }

    /*** Newest first; drop everything past `keep`. ***/
    backups.sort((a, b) => b.mtime - a.mtime);
    for (const stale of backups.slice(keep)) {
      try {
        await Deno.remove(stale.path);
        console.log(`Removed old backup ${stale.path}`);
      } catch {
        /*** Best-effort; leave it if removal fails. ***/
      }
    }
  }

  /**
   * Compare two semver-style version strings.
   * Returns -1 if a < b, 0 if a === b, 1 if a > b.
   */
  private compareVersions(current: string, target: string): number {
    return compareVersions(current, target);
  }

  /**
   * The project's instance name from disc.toml, else the current directory's name.
   */
  private currentProjectName(): string {
    const ctx = resolveProjectContext();

    if (ctx)
      return ctx.instanceName;

    const parts = Deno.cwd().split("/");

    return parts[parts.length - 1];
  }

  /**
   * Return the list of known PostgreSQL versions available for download.
   */
  private getAvailableVersions(): string[] {
    return [...SUPPORTED_POSTGRES_VERSIONS];
  }
}

export const pgUpgradeCommand = new PgUpgradeCommand();

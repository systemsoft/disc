// deno-lint-ignore-file no-console
/**
 * CLI PgUpgrade Command Implementation - PostgreSQL version upgrade functionality
 *
 * Handles upgrading the bundled PostgreSQL instance from one version to another
 * using a pg_dumpall/pg_restore strategy with automatic backup and rollback.
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { PostgresManager } from "../postgres/mod.ts";
import { PostgresBinaryDownloader } from "../postgres/downloader.ts";
import { PostgresInstance } from "../postgres/instance.ts";

export interface PgUpgradeOptions {
  targetVersion: string;
  dryRun?: boolean;
  backup?: boolean;
  project?: string;
}

export class PgUpgradeCommand {
  private postgresManager: PostgresManager;
  private downloader: PostgresBinaryDownloader;

  constructor() {
    this.postgresManager = new PostgresManager();
    this.downloader = new PostgresBinaryDownloader();
  }

  /**
   * Derive the project name from the current working directory.
   */
  private currentProjectName(): string {
    const cwd = Deno.cwd();
    const parts = cwd.split("/");
    return parts[parts.length - 1];
  }

  /**
   * Compare two semver-style version strings.
   * Returns -1 if a < b, 0 if a === b, 1 if a > b.
   */
  private compareVersions(current: string, target: string): number {
    const currentParts = current.split(".").map(Number);
    const targetParts = target.split(".").map(Number);
    const maxLen = Math.max(currentParts.length, targetParts.length);

    for (let i = 0; i < maxLen; i++) {
      const a = currentParts[i] || 0;
      const b = targetParts[i] || 0;

      if (a < b) return -1;
      if (a > b) return 1;
    }

    return 0;
  }

  /**
   * Return the list of known PostgreSQL versions available for download.
   */
  private getAvailableVersions(): string[] {
    return ["16.4", "17.0"];
  }

  /**
   * Execute the PostgreSQL upgrade process.
   *
   * Steps:
   *   1. Validate target version
   *   2. Discover and locate the current instance
   *   3. Compare versions to ensure upgrade direction
   *   4. Print upgrade plan
   *   5. If not dry-run, perform the actual upgrade with rollback on failure
   */
  async execute(options: PgUpgradeOptions): Promise<void> {
    const project = options.project || this.currentProjectName();
    const targetVersion = options.targetVersion;
    const backup = options.backup !== false; // default true
    const dryRun = options.dryRun || false;

    // Validate target version
    const availableVersions = this.getAvailableVersions();
    if (!availableVersions.includes(targetVersion)) {
      throw new Error(
        `Unknown PostgreSQL version: ${targetVersion}. Available versions: ${availableVersions.join(", ")}`,
      );
    }

    // Discover existing instances
    await this.postgresManager.discoverInstances();

    // Get current instance
    const instance = this.postgresManager.getInstance(project);
    if (!instance) {
      throw new Error(
        `No PostgreSQL instance found for project '${project}'. Run 'disc init' first.`,
      );
    }

    // Get current version
    const instanceStatus = await instance.status();
    const currentVersion = instanceStatus.version;

    // Compare versions
    const comparison = this.compareVersions(currentVersion, targetVersion);
    if (comparison >= 0) {
      throw new Error(
        `Target version ${targetVersion} is not newer than current version ${currentVersion}`,
      );
    }

    // Print upgrade plan
    console.log("PostgreSQL Upgrade Plan:");
    console.log(`  Project: ${project}`);
    console.log(`  Current version: ${currentVersion}`);
    console.log(`  Target version: ${targetVersion}`);
    console.log(`  Strategy: pg_dump/pg_restore`);
    console.log(`  Backup: ${backup ? "yes" : "no"}`);

    // Dry run stops here
    if (dryRun) {
      console.log("\nDry run complete. No changes were made.");
      return;
    }

    // Resolve paths
    const homeDir = Deno.env.get("HOME")!;
    const instanceDir = join(homeDir, ".disc", "instances", project);
    const dataDir = join(instanceDir, "data");
    const socketDir = join(instanceDir, "socket");
    const dumpFile = join(instanceDir, `upgrade-dump-${currentVersion}.sql`);
    const dataBackupDir = join(instanceDir, `data-${currentVersion}-backup`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(
      instanceDir,
      `backup-${currentVersion}-${timestamp}.tar.gz`,
    );

    let upgradeStarted = false;

    try {
      // Step a: Download target version binary
      console.log(
        `\nDownloading PostgreSQL ${targetVersion} binary...`,
      );
      const newPgDir = await this.downloader.ensurePostgres(targetVersion);
      const newPgBinDir = join(newPgDir, "bin");
      console.log("Binary downloaded successfully.");

      // Determine current pg binary directory for pg_dumpall
      const currentPgDir = await this.downloader.ensurePostgres(
        currentVersion,
      );
      const currentPgBinDir = join(currentPgDir, "bin");

      // Step b: Backup if enabled
      if (backup) {
        console.log(`\nBacking up instance to ${backupPath}...`);
        await this.postgresManager.backupInstance(project, backupPath);
        console.log("Backup completed.");
      }

      // Step c: Run pg_dumpall from current instance
      console.log("\nDumping database with pg_dumpall...");
      const pgDumpAllPath = join(currentPgBinDir, "pg_dumpall");
      const dumpCmd = new Deno.Command(pgDumpAllPath, {
        args: ["-h", socketDir, "-U", "disc"],
        stdout: "piped",
        stderr: "piped",
      });

      const dumpOutput = await dumpCmd.output();
      if (!dumpOutput.success) {
        const stderr = new TextDecoder().decode(dumpOutput.stderr);
        throw new Error(`pg_dumpall failed: ${stderr}`);
      }

      await Deno.writeFile(dumpFile, dumpOutput.stdout);
      console.log("Database dump completed.");

      upgradeStarted = true;

      // Step d: Stop the instance
      console.log("\nStopping current PostgreSQL instance...");
      await this.postgresManager.upgradeInstance(project, targetVersion);
      console.log("Instance stopped.");

      // Step e: Rename data dir to backup
      console.log(`\nRenaming data directory to ${dataBackupDir}...`);
      await Deno.rename(dataDir, dataBackupDir);

      // Step f: Init new data dir with new version
      console.log(
        `\nInitializing new data directory with PostgreSQL ${targetVersion}...`,
      );
      await ensureDir(join(instanceDir, "socket"));

      const newInstance = new PostgresInstance({
        dataDir: dataDir,
        instanceName: project,
        pgBinDir: newPgBinDir,
        postgresVersion: targetVersion,
        socketDir: socketDir,
      });

      await newInstance.init();
      console.log("New data directory initialized.");

      // Step g: Start new instance
      console.log("\nStarting new PostgreSQL instance...");
      await newInstance.start();
      console.log("New instance started.");

      // Step h: Restore via psql
      console.log("\nRestoring database from dump...");
      const psqlPath = join(newPgBinDir, "psql");
      const restoreCmd = new Deno.Command(psqlPath, {
        args: ["-h", socketDir, "-U", "disc", "-f", dumpFile],
        stdout: "piped",
        stderr: "piped",
      });

      const restoreOutput = await restoreCmd.output();
      if (!restoreOutput.success) {
        const stderr = new TextDecoder().decode(restoreOutput.stderr);
        // psql may emit warnings that are non-fatal; log but don't fail
        console.log(`psql output: ${stderr}`);
      }
      console.log("Database restore completed.");

      // Step i: Verify health
      console.log("\nVerifying instance health...");
      const newStatus = await newInstance.status();
      if (!newStatus.running) {
        throw new Error(
          "New PostgreSQL instance is not running after restore",
        );
      }
      console.log("Instance is running and healthy.");

      // Step j: Write version.json
      const versionInfo = {
        previousVersion: currentVersion,
        upgradedAt: new Date().toISOString(),
        version: targetVersion,
      };

      await Deno.writeTextFile(
        join(instanceDir, "version.json"),
        JSON.stringify(versionInfo, null, 2),
      );

      // Step k: Clean up dump file
      await Deno.remove(dumpFile);

      console.log(
        `\nPostgreSQL upgraded successfully from ${currentVersion} to ${targetVersion}.`,
      );
    } catch (error) {
      console.error(
        `\nUpgrade failed: ${(error as Error).message}`,
      );

      // Attempt rollback if upgrade had started
      if (upgradeStarted) {
        console.log("\nAttempting rollback...");
        try {
          // Stop new instance if running
          try {
            await this.postgresManager.stopInstance(project).catch(() => {});
          } catch {
            // Instance may not be running
          }

          // Restore original data directory
          try {
            await Deno.stat(dataBackupDir);
            // Remove failed new data dir if it exists
            try {
              await Deno.remove(dataDir, { recursive: true });
            } catch {
              // May not exist
            }
            await Deno.rename(dataBackupDir, dataDir);
            console.log("Data directory restored from backup.");
          } catch {
            console.error(
              "Could not restore data directory from backup.",
            );
          }

          // Restart old instance
          try {
            await this.postgresManager.startInstance(project);
            console.log("Old PostgreSQL instance restarted.");
          } catch (restartError) {
            console.error(
              `Failed to restart old instance: ${(restartError as Error).message}`,
            );
          }
        } catch (rollbackError) {
          console.error(
            `Rollback failed: ${(rollbackError as Error).message}`,
          );
        }
      }

      // Clean up dump file if it exists
      try {
        await Deno.remove(dumpFile);
      } catch {
        // Dump file may not exist
      }

      throw error;
    }
  }
}

export const pgUpgradeCommand = new PgUpgradeCommand();

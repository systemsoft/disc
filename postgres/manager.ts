/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { discHome } from "../lib/project-context.ts";
import { pgToolPath, readDataDirVersion } from "./client-tools.ts";
import { PostgresBinaryDownloader, SUPPORTED_POSTGRES_VERSIONS } from "./downloader.ts";
import { extractedEmbeddedPgBinDirs } from "./embedded-pg.ts";
import {
  INSTANCE_VERSION_FILE,
  pgMajor,
  readInstanceVersionFile,
  resolveInstanceVersion,
  writeInstanceVersionFile,
  type InstanceVersionInfo
} from "./instance-version.ts";
import { PostgresInstance, PostgresInstanceOptions } from "./instance.ts";
import { logger } from "./logger.ts";
import { PostgresMonitor } from "./monitor.ts";

export interface ManagedInstance {
  instance: PostgresInstance;
  monitor?: PostgresMonitor;
  name: string;
}

/** Steps of `upgradeInstance`, reported through `onProgress` before each runs. */
export type UpgradeStep = "backup" | "dump" | "init" | "restore" | "start" | "switch" | "verify";

export interface UpgradeInstanceOptions {
  /** Write a tar.gz of the old data dir here (taken while stopped). Omit to skip. */
  backupPath?: string;
  /**
   * `bin/` with `pg_dumpall` and `psql` — the target version's client tools:
   * newer pg_dumpall reads older servers, and the bundled server has none.
   */
  clientBinDir: string;
  /** Called before each step. A throw aborts the upgrade, which is rolled back. */
  onProgress?: (step: UpgradeStep, message: string) => void | Promise<void>;
  /** `bin/` of the target version's server (`initdb`, `pg_ctl`, `postgres`). */
  serverBinDir: string;
}

export interface UpgradeResult {
  fromVersion: string;
  toVersion: string;
}

/** Per database, `schema.table` → exact row count. */
type ContentsSnapshot = Record<string, Record<string, string>>;

/*** Exact row counts of every user table in one round trip (query_to_xml runs a count per table). ***/
const ROW_COUNTS_SQL = `
  SELECT format('%I.%I', n.nspname, c.relname) AS name,
         (xpath('/row/n/text()', query_to_xml(
           format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, ''
         )))[1]::text AS rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\\_toast%'
    AND n.nspname NOT LIKE 'pg\\_temp%'
  ORDER BY 1`;

async function snapshotContents(instance: PostgresInstance): Promise<ContentsSnapshot> {
  const snapshot: ContentsSnapshot = {};
  const databases = await instance.query<{ datname: string; }>(
    "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
    "postgres"
  );

  for (const { datname } of databases) {
    const rows = await instance.query<{ name: string; rows: string; }>(ROW_COUNTS_SQL, datname);
    snapshot[datname] = Object.fromEntries(rows.map(row => [row.name, row.rows]));
  }

  return snapshot;
}

function assertSameContents(before: ContentsSnapshot, after: ContentsSnapshot): void {
  const differences: string[] = [];
  const beforeDbs = Object.keys(before);
  const afterDbs = Object.keys(after);

  for (const db of beforeDbs.filter(db => !afterDbs.includes(db)))
    differences.push(`database ${db} is missing`);

  for (const db of afterDbs.filter(db => !beforeDbs.includes(db)))
    differences.push(`unexpected database ${db}`);

  for (const db of beforeDbs.filter(db => afterDbs.includes(db))) {
    const tables = new Set([...Object.keys(before[db]), ...Object.keys(after[db])]);

    for (const table of tables) {
      if (before[db][table] !== after[db][table])
        differences.push(`${db}: ${table} had ${before[db][table] ?? "no"} rows, now ${after[db][table] ?? "missing"}`);
    }
  }

  if (differences.length > 0)
    throw new Error(`Restored data does not match the original: ${differences.slice(0, 10).join("; ")}`);
}

function connectionArgs(instance: PostgresInstance): string[] {
  const port = instance.getPort();
  const host = port === 0 ? instance.getSocketDir() : "localhost";

  return ["-h", host, "-p", String(port || 5432), "-U", "disc"];
}

async function runPgTool(binDir: string, tool: string, args: string[]): Promise<string> {
  const output = await new Deno.Command(pgToolPath(binDir, tool), { args, stderr: "piped", stdout: "null" }).output();
  const stderr = new TextDecoder().decode(output.stderr);

  if (!output.success)
    throw new Error(`${tool} failed: ${stderr.trim()}`);

  return stderr;
}

/**
 * Replay a pg_dumpall script. psql keeps going past errors, so its stderr is
 * checked instead: the one expected error is the connecting role (`disc`)
 * already existing — pg_dumpall always emits its CREATE ROLE.
 */
async function restoreDump(clientBinDir: string, instance: PostgresInstance, dumpFile: string): Promise<void> {
  const stderr = await runPgTool(clientBinDir, "psql", [
    "-X",
    "-q",
    ...connectionArgs(instance),
    "-d",
    "postgres",
    "-f",
    dumpFile
  ]);
  const errors = stderr
    .split("\n")
    .filter(line => /\b(ERROR|FATAL):/.test(line) && !/role "disc" already exists/.test(line));

  if (errors.length > 0)
    throw new Error(`Restoring the dump failed: ${errors.slice(0, 10).join("\n")}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound)
      return false;

    throw err;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Default directory under which managed instances are created.
 *
 * Derived from `discHome()` (`$DISC_HOME`, else `$HOME/.disc`) so it matches
 * the paths `resolveProjectContext()` builds. With `$DISC_HOME` unset this is
 * `$HOME/.disc/instances` — identical to the historical default.
 */
export function defaultInstancesDir(): string {
  return join(discHome(), "instances");
}

export class PostgresManager {
  private baseDir: string;
  private instances: Map<string, ManagedInstance> = new Map();

  constructor(baseDir = defaultInstancesDir()) {
    this.baseDir = baseDir;
  }

  async createInstance(
    name: string,
    options?: Partial<PostgresInstanceOptions>
  ): Promise<PostgresInstance> {
    if (this.instances.has(name)) {
      throw new Error(`Instance '${name}' already exists`);
    }

    const instanceDir = join(this.baseDir, name);
    await ensureDir(instanceDir);

    const instance = new PostgresInstance({
      dataDir: join(instanceDir, "data"),
      instanceName: name,
      socketDir: join(instanceDir, "socket"),
      ...options
    });
    const fresh = (await readDataDirVersion(instance.getDataDir())) === null;

    await instance.init();

    // Record the exact binaries a new data dir was initialized with, so a
    // later process recovering it from disk starts it with the same ones.
    if (fresh) {
      await writeInstanceVersionFile(instanceDir, {
        ...(options?.pgBinDir ? { binDir: options.pgBinDir } : {}),
        version: instance.getVersion()
      });
    }

    this.instances.set(name, {
      instance,
      name
    });

    return instance;
  }

  async startInstance(name: string, withMonitor = true): Promise<void> {
    const managed = this.instances.get(name);
    if (!managed) {
      // Try to recover an existing instance from disk
      const recovered = await this.recoverInstance(name);
      if (!recovered) {
        throw new Error(`Instance '${name}' not found`);
      }
    }

    const { instance } = this.instances.get(name)!;
    await instance.start();

    if (withMonitor) {
      const monitor = new PostgresMonitor(instance);
      await monitor.start();
      this.instances.get(name)!.monitor = monitor;
    }
  }

  async stopInstance(name: string): Promise<void> {
    const managed = this.instances.get(name);
    if (!managed) {
      throw new Error(`Instance '${name}' not found`);
    }

    if (managed.monitor) {
      managed.monitor.stop();
    }

    await managed.instance.stop();
  }

  async destroyInstance(name: string, removeData = false): Promise<void> {
    await this.stopInstance(name).catch(() => {
      // Instance might not be running
    });

    this.instances.delete(name);

    if (removeData) {
      const instanceDir = join(this.baseDir, name);
      await Deno.remove(instanceDir, { recursive: true });
      logger.info(`Removed all data for instance '${name}'`);
    }
  }

  getInstance(name: string): PostgresInstance | undefined {
    return this.instances.get(name)?.instance;
  }

  listInstances(): string[] {
    return Array.from(this.instances.keys());
  }

  async getInstanceStatus(name: string) {
    const managed = this.instances.get(name);
    if (!managed) {
      return null;
    }

    const status = await managed.instance.status();
    const healthStatus = managed.monitor?.getLastHealthStatus();

    return {
      ...status,
      health: healthStatus
    };
  }

  /** The directory holding instance `name` (`data/`, `socket/`, `logs/`, `version.json`). */
  getInstanceDir(name: string): string {
    return join(this.baseDir, name);
  }

  private async recoverInstance(name: string): Promise<boolean> {
    const instanceDir = join(this.baseDir, name);
    const dataDir = join(instanceDir, "data");

    try {
      await Deno.stat(dataDir);
    } catch {
      return false;
    }

    try {
      const { pgBinDir, version } = await this.resolveBinaries(instanceDir, dataDir);
      const instance = new PostgresInstance({
        dataDir,
        instanceName: name,
        pgBinDir,
        postgresVersion: version,
        socketDir: join(instanceDir, "socket")
      });

      // Resolve pgBinDir (needed by start/stop/status) without re-running
      // initdb — init() short-circuits on the existing PG_VERSION file.
      await instance.init();

      this.instances.set(name, {
        instance,
        name
      });

      return true;
    } catch (err) {
      logger.warn(`Could not recover PostgreSQL instance '${name}' from ${instanceDir}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * The binaries to run an existing data dir with. A data dir can only be
   * started by its own major version (`PG_VERSION`); `version.json` names
   * the exact version (and, for caller-supplied binaries, the directory).
   * Without it — instances created before it was recorded — the newest
   * cached binaries of that major are used, else the newest downloadable.
   */
  private async resolveBinaries(instanceDir: string, dataDir: string): Promise<{ pgBinDir?: string; version?: string; }> {
    const dataDirMajor = await readDataDirVersion(dataDir);

    /*** Never initialized (e.g. an interrupted create): init() runs initdb with the defaults. ***/
    if (dataDirMajor === null)
      return {};

    const recorded = await readInstanceVersionFile(instanceDir);

    if (
      recorded?.binDir && pgMajor(recorded.version) === dataDirMajor &&
      await isFile(pgToolPath(recorded.binDir, "postgres"))
    ) {
      return { pgBinDir: recorded.binDir, version: recorded.version };
    }

    const cached = await new PostgresBinaryDownloader().cachedVersions();
    const embedded = await extractedEmbeddedPgBinDirs();
    const version = resolveInstanceVersion({
      cached: [...cached, ...embedded.keys()],
      dataDirMajor,
      recorded: recorded?.version ?? null,
      supported: SUPPORTED_POSTGRES_VERSIONS
    });

    if (!version) {
      throw new Error(
        `${dataDir} is a PostgreSQL ${dataDirMajor} data directory, but no PostgreSQL ${dataDirMajor} binaries ` +
          `are cached or downloadable (supported: ${SUPPORTED_POSTGRES_VERSIONS.join(", ")})`
      );
    }

    /*** Download cache first (PostgresInstance's default); an embedded extraction avoids a download. ***/
    return { pgBinDir: cached.includes(version) ? undefined : embedded.get(version), version };
  }

  async discoverInstances(): Promise<void> {
    try {
      await ensureDir(this.baseDir);

      for await (const entry of Deno.readDir(this.baseDir)) {
        if (entry.isDirectory && !this.instances.has(entry.name)) {
          await this.recoverInstance(entry.name);
        }
      }
    } catch (error) {
      logger.error(`Failed to discover instances: ${error}`);
    }
  }

  /**
   * Move instance `name` to PostgreSQL `targetVersion` by dump and restore:
   *
   * 1. `pg_dumpall` the current server (started if needed) and record every
   *    database's per-table row counts; stop it.
   * 2. Optionally tar the old data dir to `backupPath`.
   * 3. `initdb` a staging data dir with the target binaries, start it,
   *    restore the dump with `psql`, and compare databases and row counts.
   * 4. Swap the staging dir into `data/`, record the new version in
   *    `version.json`, and restart the instance if it was running.
   *
   * The old data dir is only renamed (never modified) until the swap
   * succeeds. Any failure rolls back: the staging dir is removed, the old
   * data dir and `version.json` are put back, and the old server is
   * restarted if it was running. On success the old data dir is deleted.
   */
  async upgradeInstance(name: string, targetVersion: string, options: UpgradeInstanceOptions): Promise<UpgradeResult> {
    if (!this.instances.has(name) && !(await this.recoverInstance(name))) {
      throw new Error(`Instance '${name}' not found`);
    }

    const managed = this.instances.get(name)!;
    const oldInstance = managed.instance;
    const instanceDir = this.getInstanceDir(name);
    const dataDir = oldInstance.getDataDir();
    const fromVersion = oldInstance.getVersion();
    const stagingDataDir = join(instanceDir, `data-upgrade-${targetVersion}`);
    const oldDataDir = join(instanceDir, `data-${fromVersion}-pre-upgrade`);
    const dumpFile = join(instanceDir, `upgrade-${fromVersion}-to-${targetVersion}.sql`);
    const previousInfo = await readInstanceVersionFile(instanceDir);
    const wasRunning = (await oldInstance.status()).running;
    const progress = async (step: UpgradeStep, message: string): Promise<void> => {
      logger.debug(message);
      await options.onProgress?.(step, message);
    };

    if (await exists(oldDataDir)) {
      throw new Error(
        `${oldDataDir} already exists (left by an earlier upgrade). Check whether it is still needed, ` +
          `then move it away and retry.`
      );
    }

    /*** A staging dir can only be a leftover of an interrupted attempt — never live data. ***/
    await Deno.remove(stagingDataDir, { recursive: true }).catch(() => {});

    let staging: PostgresInstance | undefined;
    let upgraded: PostgresInstance | undefined;
    let switched = false;

    try {
      await progress("dump", `Dumping PostgreSQL ${fromVersion} with pg_dumpall…`);

      if (!wasRunning)
        await oldInstance.start();

      const before = await snapshotContents(oldInstance);
      await runPgTool(options.clientBinDir, "pg_dumpall", [...connectionArgs(oldInstance), "-f", dumpFile]);

      managed.monitor?.stop();
      managed.monitor = undefined;
      await oldInstance.stop();

      if (options.backupPath) {
        await progress("backup", `Backing up ${dataDir} to ${options.backupPath}…`);
        await this.tarDataDir(dataDir, options.backupPath);
      }

      await progress("init", `Initializing a PostgreSQL ${targetVersion} data directory…`);
      staging = new PostgresInstance({
        dataDir: stagingDataDir,
        instanceName: name,
        pgBinDir: options.serverBinDir,
        port: oldInstance.getPort(),
        postgresVersion: targetVersion,
        socketDir: oldInstance.getSocketDir()
      });
      await staging.init();
      await staging.start();

      await progress("restore", "Restoring the dump with psql…");
      /*** start() created an empty project database; the dump recreates it with its original settings. ***/
      await staging.query(`DROP DATABASE IF EXISTS "${name.replaceAll("\"", "\"\"")}"`, "postgres");
      await restoreDump(options.clientBinDir, staging, dumpFile);

      await progress("verify", "Verifying databases and row counts…");
      assertSameContents(before, await snapshotContents(staging));
      await staging.stop();

      await progress("switch", `Switching '${name}' to PostgreSQL ${targetVersion}…`);
      await Deno.rename(dataDir, oldDataDir);
      switched = true;
      await Deno.rename(stagingDataDir, dataDir);
      await writeInstanceVersionFile(instanceDir, {
        binDir: options.serverBinDir,
        previousVersion: fromVersion,
        upgradedAt: new Date().toISOString(),
        version: targetVersion
      });

      upgraded = new PostgresInstance({
        dataDir,
        instanceName: name,
        pgBinDir: options.serverBinDir,
        port: oldInstance.getPort(),
        postgresVersion: targetVersion,
        socketDir: oldInstance.getSocketDir()
      });
      await upgraded.init();

      if (wasRunning) {
        await progress("start", `Starting PostgreSQL ${targetVersion}…`);
        await upgraded.start();
      }
    } catch (err) {
      const rollbackErrors = await this.rollbackUpgrade({
        dataDir,
        instanceDir,
        oldDataDir,
        oldInstance,
        previousInfo,
        stagingDataDir,
        switched,
        upgraded,
        staging,
        wasRunning
      });
      const detail = rollbackErrors.length === 0 ?
        `the instance is still on PostgreSQL ${fromVersion}` :
        `rolling back also failed (${rollbackErrors.join("; ")}); the original data directory is at ` +
        `${(await exists(oldDataDir)) ? oldDataDir : dataDir}`;

      throw new Error(
        `Upgrading '${name}' to PostgreSQL ${targetVersion} failed and ${detail}: ${(err as Error).message}`,
        { cause: err }
      );
    } finally {
      await Deno.remove(dumpFile).catch(() => {});
    }

    managed.instance = upgraded;
    /*** Past the point of no return; `backupPath` (if requested) holds the copy. ***/
    await Deno.remove(oldDataDir, { recursive: true });

    return { fromVersion, toVersion: targetVersion };
  }

  /**
   * Undo a failed `upgradeInstance`. Returns the errors of steps that could
   * not be undone (empty when the instance is fully back as it was).
   */
  private async rollbackUpgrade(state: {
    dataDir: string;
    instanceDir: string;
    oldDataDir: string;
    oldInstance: PostgresInstance;
    previousInfo: InstanceVersionInfo | null;
    staging?: PostgresInstance;
    stagingDataDir: string;
    switched: boolean;
    upgraded?: PostgresInstance;
    wasRunning: boolean;
  }): Promise<string[]> {
    const errors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        errors.push(`${what}: ${(err as Error).message}`);
      }
    };

    await attempt("stop the new server", async () => {
      await state.staging?.stop();
      await state.upgraded?.stop();
    });

    if (state.switched) {
      /*** The original is safe at oldDataDir; dataDir is the restored copy, or absent. ***/
      await attempt("restore the original data directory", async () => {
        await Deno.remove(state.dataDir, { recursive: true }).catch(err => {
          if (!(err instanceof Deno.errors.NotFound))
            throw err;
        });
        await Deno.rename(state.oldDataDir, state.dataDir);
      });
      await attempt("restore version.json", async () => {
        if (state.previousInfo)
          await writeInstanceVersionFile(state.instanceDir, state.previousInfo);
        else
          await Deno.remove(join(state.instanceDir, INSTANCE_VERSION_FILE)).catch(() => {});
      });
    }

    await attempt("remove the staging data directory", async () => {
      await Deno.remove(state.stagingDataDir, { recursive: true }).catch(err => {
        if (!(err instanceof Deno.errors.NotFound))
          throw err;
      });
    });

    /*** Leave the old server as it was found: running, or stopped (it may have been started for the dump). ***/
    await attempt(
      state.wasRunning ? "restart the old server" : "stop the old server",
      () => state.wasRunning ? state.oldInstance.start() : state.oldInstance.stop()
    );

    return errors;
  }

  private async tarDataDir(dataDir: string, backupPath: string): Promise<void> {
    const output = await new Deno.Command("tar", {
      args: ["-czf", backupPath, "-C", dataDir, "."],
      stderr: "piped"
    })
      .output();

    if (!output.success) {
      throw new Error(`Backup of ${dataDir} to ${backupPath} failed: ${new TextDecoder().decode(output.stderr)}`);
    }
  }

  async backupInstance(name: string, backupPath: string): Promise<void> {
    const managed = this.instances.get(name);
    if (!managed) {
      throw new Error(`Instance '${name}' not found`);
    }

    const { instance } = managed;
    const dataDir = instance.getDataDir();

    // Stop the instance for consistent backup
    const wasRunning = (await instance.status()).running;
    if (wasRunning) {
      await instance.stop();
    }

    try {
      await this.tarDataDir(dataDir, backupPath);
      logger.info(`Instance '${name}' backed up to ${backupPath}`);
    } finally {
      if (wasRunning) {
        await instance.start();
      }
    }
  }

  async restoreInstance(name: string, backupPath: string): Promise<void> {
    // Ensure instance doesn't exist
    if (this.instances.has(name)) {
      throw new Error(`Instance '${name}' already exists`);
    }

    const instanceDir = join(this.baseDir, name);
    const dataDir = join(instanceDir, "data");

    await ensureDir(dataDir);

    // Extract backup
    const cmd = new Deno.Command("tar", {
      args: ["-xzf", backupPath, "-C", dataDir]
    });

    const output = await cmd.output();
    if (!output.success) {
      throw new Error("Restore failed");
    }

    // Recover the instance
    await this.recoverInstance(name);
    logger.info(`Instance '${name}' restored from ${backupPath}`);
  }
}

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { PostgresConfig } from "./config.ts";
import { PostgresBinaryDownloader } from "./downloader.ts";
import { logger } from "./logger.ts";

export interface PostgresInstanceOptions {
  dataDir: string;
  instanceName: string;
  /** Path to a directory containing PostgreSQL binaries (e.g. pg_ctl, initdb).
   *  When provided, Disc skips downloading PostgreSQL and uses these binaries instead. */
  pgBinDir?: string;
  port?: number;
  postgresVersion?: string;
  socketDir?: string;
}

export interface PostgresInstanceStatus {
  dataDir: string;
  pid?: number;
  port: number;
  running: boolean;
  socketPath: string;
  startedAt?: Date;
  version: string;
}

export class PostgresInstance {
  private config: PostgresConfig;
  private dataDir: string;
  private downloader: PostgresBinaryDownloader;
  private instanceName: string;
  private pgBinDir: string | null = null;
  private pid?: number;
  private port: number;
  private postgresVersion: string;
  private socketDir: string;
  private startedAt?: Date;

  constructor(options: PostgresInstanceOptions) {
    this.instanceName = options.instanceName;
    this.dataDir = options.dataDir;
    this.port = options.port || 0; // 0 means Unix socket only
    this.socketDir = options.socketDir || join(this.dataDir, "..", "socket");
    this.postgresVersion = options.postgresVersion || "16.4";
    this.downloader = new PostgresBinaryDownloader();
    this.config = new PostgresConfig();

    // When a pre-existing PG binary directory is provided, use it directly
    // and skip the download step during init().
    if (options.pgBinDir) {
      this.pgBinDir = options.pgBinDir;
    }
  }

  async init(): Promise<void> {
    logger.info(`Initializing PostgreSQL instance: ${this.instanceName}`);

    // When pgBinDir was provided via options, skip the download entirely.
    // Otherwise, download/verify the PostgreSQL binary as usual.
    if (!this.pgBinDir) {
      const pgDir = await this.downloader.ensurePostgres(this.postgresVersion);
      this.pgBinDir = join(pgDir, "bin");
    } else {
      logger.info(`Using pre-existing PostgreSQL binaries at ${this.pgBinDir}`);
    }

    // P2-02: if any of these paths already exists but is a regular
    // file instead of a directory, ensureDir's error message ("File
    // exists") is opaque — surface the concrete path and what we
    // expected so the user knows exactly what to fix.
    for (
      const [label, dir] of [
        ["data dir", this.dataDir],
        ["socket dir", this.socketDir],
        ["logs dir", join(this.dataDir, "..", "logs")]
      ] as const
    ) {
      try {
        const stat = await Deno.lstat(dir);
        if (!stat.isDirectory) {
          throw new Error(
            `PostgreSQL ${label} path exists but is not a directory: ${dir}. Remove or rename it and retry.`
          );
        }
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) {
          // Non-NotFound errors re-throw; NotFound just means ensureDir
          // will create it fresh below.
          throw err;
        }
      }
      await ensureDir(dir);
    }

    // Check if data directory is already initialized
    const pgVersionFile = join(this.dataDir, "PG_VERSION");
    try {
      await Deno.stat(pgVersionFile);
      logger.info("Data directory already initialized");
      return;
    } catch {
      // Not initialized, proceed with initdb
    }

    // Initialize the data directory with initdb
    await this.runInitDb();

    // Generate and write configuration
    const configContent = this.config.generate({
      dataDir: this.dataDir,
      port: this.port,
      socketDir: this.socketDir
    });

    const configPath = join(this.dataDir, "postgresql.conf");
    await Deno.writeTextFile(configPath, configContent);

    logger.info(`PostgreSQL instance initialized at ${this.dataDir}`);
  }

  private async runInitDb(): Promise<void> {
    const initdbPath = join(this.pgBinDir!, "initdb");

    const cmd = new Deno.Command(initdbPath, {
      args: [
        "-D",
        this.dataDir,
        "--encoding=UTF8",
        "--locale=en_US.UTF-8",
        "--username=disc",
        "--auth-local=trust",
        "--auth-host=trust"
      ],
      env: {
        ...Deno.env.toObject(),
        PGDATA: this.dataDir
      }
    });

    const output = await cmd.output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`initdb failed: ${stderr}`);
    }
  }

  async start(): Promise<void> {
    if (await this.isRunning()) {
      logger.info("PostgreSQL instance is already running");
      return;
    }

    if (!this.pgBinDir) {
      await this.init();
    }

    // P1-01: clean up stale Unix socket files from crashed / SIGKILL'd PG
    // instances. Postgres refuses to bind if a file with the socket name
    // already exists, so without this the user gets
    //     "could not create lock file: File exists"
    // and has to `rm ~/.disc/instances/<name>/socket/.s.PGSQL.5432*` manually.
    await this.cleanupStaleSocket();

    logger.info(`Starting PostgreSQL instance: ${this.instanceName}`);

    const pgCtlPath = join(this.pgBinDir!, "pg_ctl");
    const logsDir = join(this.dataDir, "..", "logs");
    await ensureDir(logsDir);
    const logFile = join(logsDir, "postgresql.log");

    const cmd = new Deno.Command(pgCtlPath, {
      args: [
        "start",
        "-D",
        this.dataDir,
        "-l",
        logFile,
        "-o",
        this.buildPostgresArgs(),
        "-w", // Wait for startup to complete
        "-t",
        "60" // 60 second timeout
      ],
      env: {
        ...Deno.env.toObject(),
        PGDATA: this.dataDir
      }
    });

    const output = await cmd.output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`Failed to start PostgreSQL: ${stderr}`);
    }

    // Get the PID
    const pidFile = join(this.dataDir, "postmaster.pid");
    const pidContent = await Deno.readTextFile(pidFile);
    this.pid = parseInt(pidContent.split("\n")[0]);
    this.startedAt = new Date();

    logger.info(`PostgreSQL started with PID ${this.pid}`);

    // Ensure the project database exists (initdb only creates the "disc" default db)
    await this.ensureDatabase();
  }

  /**
   * Create the project database if it doesn't already exist.
   * After initdb, only the superuser db ("disc"), "postgres", and templates exist.
   * The DSN references the instance name as the database, so we need to create it.
   *
   * Uses a direct libpq connection rather than the `createdb` CLI: zonky's
   * embedded-postgres builds (used on Linux + ARM Mac) ship only `postgres`,
   * `initdb`, and `pg_ctl` in `bin/` — no client utilities.
   */
  private async ensureDatabase(): Promise<void> {
    // P2-01: PG can take a moment after boot before catalogs are ready.
    // Retry the connect+CREATE on transient failures.
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const admin = new Client(this.adminClientConfig());
      try {
        await admin.connect();
        const exists = await admin.queryObject<{ exists: boolean; }>(
          `SELECT 1 AS exists FROM pg_database WHERE datname = $1`,
          [this.instanceName]
        );
        if (exists.rowCount && exists.rowCount > 0) {
          logger.info(`Database "${this.instanceName}" already exists`);
          return;
        }
        // Identifier is the instance name; assertSafeIdentifier is enforced
        // upstream (cli/init.ts validates the project name).
        await admin.queryArray(`CREATE DATABASE "${this.instanceName}"`);
        logger.info(`Created database "${this.instanceName}"`);
        return;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // "already exists" race when concurrent starts collide.
        if (/already exists/i.test(msg)) {
          logger.info(`Database "${this.instanceName}" already exists`);
          return;
        }
        const transient = /starting up|not yet accepting|could not connect|ECONNREFUSED/i
          .test(msg);
        if (!transient || attempt === 2)
          break;
        const delayMs = 150 * (attempt + 1);
        logger.info(
          `ensureDatabase transient failure (attempt ${attempt + 1}/3); retrying in ${delayMs}ms`
        );
        await new Promise(r => setTimeout(r, delayMs));
      } finally {
        try {
          await admin.end();
        } catch {
          // Already closed — ignore.
        }
      }
    }

    const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(
      `Failed to create database "${this.instanceName}": ${detail}`
    );
  }

  private adminClientConfig() {
    // Connect to the always-present `postgres` admin db. Use the unix socket
    // when port=0, TCP otherwise.
    if (this.port === 0) {
      return {
        database: "postgres",
        host_type: "socket" as const,
        hostname: this.socketDir,
        port: 5432,
        user: "disc"
      };
    }
    return {
      database: "postgres",
      host_type: "tcp" as const,
      hostname: "localhost",
      port: this.port,
      user: "disc"
    };
  }

  async stop(): Promise<void> {
    if (!await this.isRunning()) {
      logger.info("PostgreSQL instance is not running");
      return;
    }

    logger.info(`Stopping PostgreSQL instance: ${this.instanceName}`);

    const pgCtlPath = join(this.pgBinDir!, "pg_ctl");

    const cmd = new Deno.Command(pgCtlPath, {
      args: [
        "stop",
        "-D",
        this.dataDir,
        "-m",
        "fast", // Fast shutdown mode
        "-w", // Wait for shutdown to complete
        "-t",
        "60"
      ],
      env: {
        ...Deno.env.toObject(),
        PGDATA: this.dataDir
      }
    });

    const output = await cmd.output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      logger.error(`Warning: Failed to stop PostgreSQL cleanly: ${stderr}`);
      // Try force stop
      await this.forceStop();
    }

    this.pid = undefined;
    this.startedAt = undefined;
    logger.info("PostgreSQL stopped");
  }

  private async forceStop(): Promise<void> {
    if (!this.pid)
      return;

    try {
      Deno.kill(this.pid, "SIGTERM");
      await this.waitForShutdown(5000);
    } catch {
      // Process might already be dead
    }

    // If still running, force kill
    if (await this.isRunning() && this.pid) {
      try {
        Deno.kill(this.pid, "SIGKILL");
      } catch {
        // Process already dead
      }
    }
  }

  private async waitForShutdown(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (!await this.isRunning()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  async restart(): Promise<void> {
    logger.info(`Restarting PostgreSQL instance: ${this.instanceName}`);
    await this.stop();
    await this.start();
  }

  async status(): Promise<PostgresInstanceStatus> {
    const running = await this.isRunning();

    // P2-15: recover startedAt from postmaster.pid when the instance was
    // started by a previous process (our current run just discovered it).
    // PG writes the start time as a Unix timestamp on line 3 of the
    // postmaster.pid file.
    if (running && this.startedAt === undefined) {
      try {
        const pidContent = await Deno.readTextFile(
          join(this.dataDir, "postmaster.pid")
        );
        const lines = pidContent.split("\n");
        if (lines.length >= 3) {
          const epoch = parseInt(lines[2], 10);
          if (Number.isFinite(epoch) && epoch > 0) {
            this.startedAt = new Date(epoch * 1000);
          }
        }
      } catch {
        // Best-effort — leave startedAt undefined if we can't read it.
      }
    }

    return {
      dataDir: this.dataDir,
      pid: this.pid,
      port: this.port,
      running,
      socketPath: this.getSocketPath(),
      startedAt: this.startedAt,
      version: this.postgresVersion
    };
  }

  /**
   * Remove stale Unix-domain socket files left behind by a crashed PG.
   * Only runs when isRunning() already returned false, so there's no risk of
   * tearing down a live socket. (P1-01)
   */
  private async cleanupStaleSocket(): Promise<void> {
    try {
      for await (const entry of Deno.readDir(this.socketDir)) {
        if (entry.name.startsWith(".s.PGSQL.")) {
          await Deno.remove(join(this.socketDir, entry.name)).catch(() => {});
        }
      }
    } catch {
      // socketDir may not exist yet — ensureDir covers the happy path.
    }
  }

  private async isRunning(): Promise<boolean> {
    const pidFile = join(this.dataDir, "postmaster.pid");

    try {
      const pidContent = await Deno.readTextFile(pidFile);
      const pid = parseInt(pidContent.split("\n")[0]);

      // Check if process is actually running
      try {
        Deno.kill(pid, 0); // Signal 0 just checks if process exists
        this.pid = pid;
        return true;
      } catch {
        // Process doesn't exist, clean up stale PID file
        await Deno.remove(pidFile).catch(() => {});
        return false;
      }
    } catch {
      // PID file doesn't exist
      return false;
    }
  }

  private buildPostgresArgs(): string {
    const args: string[] = [];

    if (this.port === 0) {
      // Unix socket only — use default port for socket file name,
      // but disable TCP by setting listen_addresses to empty.
      args.push("-p 5432");
      args.push("-c listen_addresses=");
    } else {
      args.push(`-p ${this.port}`);
    }

    args.push(`-k ${this.socketDir}`);

    return args.join(" ");
  }

  dsn(): string {
    if (this.port === 0) {
      // Unix socket connection
      return `postgresql://disc@/${this.instanceName}?host=${this.socketDir}`;
    } else {
      // TCP connection
      return `postgresql://disc@localhost:${this.port}/${this.instanceName}`;
    }
  }

  getSocketPath(): string {
    return join(this.socketDir, `.s.PGSQL.${this.port || 5432}`);
  }

  getDataDir(): string {
    return this.dataDir;
  }

  getPort(): number {
    return this.port;
  }

  getPgBinDir(): string | null {
    return this.pgBinDir;
  }

  getSocketDir(): string {
    return this.socketDir;
  }
}

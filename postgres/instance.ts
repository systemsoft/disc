import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { PostgresBinaryDownloader } from "./downloader.ts";
import { PostgresConfig } from "./config.ts";
import { logger } from "./logger.ts";

export interface PostgresInstanceOptions {
  dataDir: string;
  instanceName: string;
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
  }

  async init(): Promise<void> {
    logger.info(`Initializing PostgreSQL instance: ${this.instanceName}`);

    // Ensure PostgreSQL binary is downloaded
    const pgDir = await this.downloader.ensurePostgres(this.postgresVersion);
    this.pgBinDir = join(pgDir, "bin");

    // Create necessary directories
    await ensureDir(this.dataDir);
    await ensureDir(this.socketDir);
    await ensureDir(join(this.dataDir, "..", "logs"));

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
      socketDir: this.socketDir,
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
        "--pwfile=/dev/null",
        "--auth-local=trust",
        "--auth-host=scram-sha-256",
      ],
      env: {
        ...Deno.env.toObject(),
        "PGDATA": this.dataDir,
      },
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

    logger.info(`Starting PostgreSQL instance: ${this.instanceName}`);

    const pgCtlPath = join(this.pgBinDir!, "pg_ctl");
    const logFile = join(this.dataDir, "..", "logs", "postgresql.log");

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
        "60", // 60 second timeout
      ],
      env: {
        ...Deno.env.toObject(),
        "PGDATA": this.dataDir,
      },
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
        "60",
      ],
      env: {
        ...Deno.env.toObject(),
        "PGDATA": this.dataDir,
      },
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
    if (!this.pid) return;

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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async restart(): Promise<void> {
    logger.info(`Restarting PostgreSQL instance: ${this.instanceName}`);
    await this.stop();
    await this.start();
  }

  async status(): Promise<PostgresInstanceStatus> {
    const running = await this.isRunning();

    return {
      dataDir: this.dataDir,
      pid: this.pid,
      port: this.port,
      running,
      socketPath: this.getSocketPath(),
      startedAt: this.startedAt,
      version: this.postgresVersion,
    };
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
      // Unix socket only
      args.push("-p 0");
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
}

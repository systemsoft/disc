import { join } from "@std/path";
import { PostgresInstance } from "./instance.ts";
import { logger } from "./logger.ts";

export interface MonitorOptions {
  autoRestart?: boolean;
  checkIntervalMs?: number;
  maxRestartAttempts?: number;
  restartDelayMs?: number;
  startupGraceMs?: number;
}

export interface HealthStatus {
  connections: number;
  healthy: boolean;
  lastCheck: Date;
  latencyMs?: number;
  uptime?: number;
  version?: string;
}

export class PostgresMonitor {
  private autoRestart: boolean;
  private checkInterval: number;
  private instance: PostgresInstance;
  private isFirstCheck = true;
  private isMonitoring = false;
  private lastHealthStatus?: HealthStatus;
  private maxRestartAttempts: number;
  private monitorHandle?: number;
  private restartAttempts = 0;
  private restartDelayMs: number;
  private startupGraceMs: number;

  constructor(instance: PostgresInstance, options: MonitorOptions = {}) {
    this.instance = instance;
    this.autoRestart = options.autoRestart ?? true;
    this.checkInterval = options.checkIntervalMs ?? 30000; // 30 seconds
    this.maxRestartAttempts = options.maxRestartAttempts ?? 3;
    this.restartDelayMs = options.restartDelayMs ?? 5000;
    this.startupGraceMs = options.startupGraceMs ?? 2000;
  }

  async start(): Promise<void> {
    if (this.isMonitoring) {
      logger.info("Monitor already running");
      return;
    }

    this.isMonitoring = true;
    this.isFirstCheck = true;
    logger.info("Starting PostgreSQL health monitor");

    // Startup grace period — let PG finish initializing before first check
    await new Promise((resolve) => setTimeout(resolve, this.startupGraceMs));

    // Initial health check
    await this.checkHealth();

    // Schedule periodic checks
    this.monitorHandle = setInterval(async () => {
      if (!this.isMonitoring) return;
      await this.checkHealth();
    }, this.checkInterval);
  }

  stop(): void {
    if (!this.isMonitoring) return;

    logger.info("Stopping PostgreSQL health monitor");
    this.isMonitoring = false;

    if (this.monitorHandle) {
      clearInterval(this.monitorHandle);
      this.monitorHandle = undefined;
    }
  }

  async checkHealth(): Promise<HealthStatus> {
    const startTime = Date.now();
    const status = await this.instance.status();

    if (!status.running) {
      this.lastHealthStatus = {
        connections: 0,
        healthy: false,
        lastCheck: new Date(),
      };

      if (this.autoRestart) {
        await this.handleUnhealthy();
      }

      return this.lastHealthStatus;
    }

    try {
      const pgBinDir = this.instance.getPgBinDir();

      if (!pgBinDir) {
        // No PG binaries available — instance reports running, trust process check
        this.lastHealthStatus = {
          connections: 0,
          healthy: true,
          lastCheck: new Date(),
          latencyMs: Date.now() - startTime,
        };
        this.restartAttempts = 0;
        this.isFirstCheck = false;
        return this.lastHealthStatus;
      }

      // Use pg_isready — works with Unix sockets natively
      const pgIsReady = join(pgBinDir, "pg_isready");
      const socketDir = this.instance.getSocketDir();
      const port = this.instance.getPort();

      // When port is 0, PG uses -p 5432 for the socket file name
      const effectivePort = port === 0 ? 5432 : port;

      const args: string[] = port === 0
        ? ["-h", socketDir, "-p", String(effectivePort), "-U", "disc", "-q"]
        : ["-h", "localhost", "-p", String(port), "-U", "disc", "-q"];

      const cmd = new Deno.Command(pgIsReady, { args });
      const output = await cmd.output();
      const latencyMs = Date.now() - startTime;

      if (output.success) {
        this.lastHealthStatus = {
          connections: 0,
          healthy: true,
          lastCheck: new Date(),
          latencyMs,
        };
        this.restartAttempts = 0;
        this.isFirstCheck = false;
        return this.lastHealthStatus;
      }

      // pg_isready returned non-zero: not accepting connections
      const stderr = new TextDecoder().decode(output.stderr).trim();
      throw new Error(
        `pg_isready: not accepting connections${stderr ? ` (${stderr})` : ""}`,
      );
    } catch (error) {
      // On the first check, don't count toward restart attempts —
      // PG may still be finishing startup even after pg_ctl -w returns.
      if (this.isFirstCheck) {
        logger.info(
          `First health check failed (startup grace): ${error}`,
        );
        this.isFirstCheck = false;
        this.lastHealthStatus = {
          connections: 0,
          healthy: false,
          lastCheck: new Date(),
          latencyMs: Date.now() - startTime,
        };
        return this.lastHealthStatus;
      }

      logger.error(`Health check failed: ${error}`);

      this.lastHealthStatus = {
        connections: 0,
        healthy: false,
        lastCheck: new Date(),
        latencyMs: Date.now() - startTime,
      };

      if (this.autoRestart) {
        await this.handleUnhealthy();
      }

      return this.lastHealthStatus;
    }
  }

  private async handleUnhealthy(): Promise<void> {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      logger.error(
        `PostgreSQL failed after ${this.maxRestartAttempts} restart attempts. Manual intervention required.`,
      );
      this.stop();
      return;
    }

    this.restartAttempts++;
    logger.info(
      `Attempting to restart PostgreSQL (attempt ${this.restartAttempts}/${this.maxRestartAttempts})`,
    );

    // Wait before restarting
    await new Promise((resolve) => setTimeout(resolve, this.restartDelayMs));

    try {
      await this.instance.restart();
      logger.info("PostgreSQL restarted successfully");
    } catch (error) {
      logger.error(`Failed to restart PostgreSQL: ${error}`);
    }
  }

  getLastHealthStatus(): HealthStatus | undefined {
    return this.lastHealthStatus;
  }

  async getMetrics(): Promise<Record<string, unknown>> {
    const status = await this.instance.status();
    if (!status.running) {
      return { error: "Instance not running" };
    }

    const pgBinDir = this.instance.getPgBinDir();
    if (!pgBinDir) {
      return { error: "PostgreSQL binaries not available" };
    }

    const psql = join(pgBinDir, "psql");
    const socketDir = this.instance.getSocketDir();
    const port = this.instance.getPort();
    const effectivePort = port === 0 ? 5432 : port;

    const connArgs = port === 0 ? ["-h", socketDir, "-p", String(effectivePort), "-U", "disc"] : ["-h", "localhost", "-p", String(port), "-U", "disc"];

    try {
      const query = `
        SELECT json_build_object(
          'database_size', pg_size_pretty(pg_database_size(current_database())),
          'connections_active', (SELECT count(*) FILTER (WHERE state = 'active') FROM pg_stat_activity WHERE datname = current_database()),
          'connections_idle', (SELECT count(*) FILTER (WHERE state = 'idle') FROM pg_stat_activity WHERE datname = current_database()),
          'connections_total', (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()),
          'table_count', (SELECT count(*) FROM pg_class WHERE relkind = 'r'),
          'tables_total_size', pg_size_pretty((SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::bigint FROM pg_class c WHERE c.relkind = 'r'))
        )::text;
      `;

      const cmd = new Deno.Command(psql, {
        args: [...connArgs, "-d", "disc", "-t", "-A", "-c", query],
      });

      const output = await cmd.output();
      if (!output.success) {
        const stderr = new TextDecoder().decode(output.stderr).trim();
        throw new Error(`psql query failed: ${stderr}`);
      }

      const jsonStr = new TextDecoder().decode(output.stdout).trim();
      const data = JSON.parse(jsonStr);

      return {
        connections: {
          active: data.connections_active,
          idle: data.connections_idle,
          total: data.connections_total,
        },
        database: {
          size: data.database_size,
        },
        tables: {
          count: data.table_count,
          totalSize: data.tables_total_size,
        },
      };
    } catch (error) {
      throw new Error(`Failed to get metrics: ${error}`);
    }
  }

  async performMaintenance(): Promise<void> {
    const pgBinDir = this.instance.getPgBinDir();
    if (!pgBinDir) {
      throw new Error("PostgreSQL binaries not available for maintenance");
    }

    const psql = join(pgBinDir, "psql");
    const socketDir = this.instance.getSocketDir();
    const port = this.instance.getPort();
    const effectivePort = port === 0 ? 5432 : port;

    const connArgs = port === 0 ? ["-h", socketDir, "-p", String(effectivePort), "-U", "disc"] : ["-h", "localhost", "-p", String(port), "-U", "disc"];

    logger.info("Running PostgreSQL maintenance tasks...");

    try {
      // ANALYZE
      const analyzeCmd = new Deno.Command(psql, {
        args: [...connArgs, "-c", "ANALYZE"],
      });
      const analyzeOutput = await analyzeCmd.output();
      if (!analyzeOutput.success) {
        const stderr = new TextDecoder().decode(analyzeOutput.stderr).trim();
        throw new Error(`ANALYZE failed: ${stderr}`);
      }

      // VACUUM
      const vacuumCmd = new Deno.Command(psql, {
        args: [...connArgs, "-c", "VACUUM"],
      });
      const vacuumOutput = await vacuumCmd.output();
      if (!vacuumOutput.success) {
        const stderr = new TextDecoder().decode(vacuumOutput.stderr).trim();
        throw new Error(`VACUUM failed: ${stderr}`);
      }

      logger.info("Maintenance tasks completed");
    } catch (error) {
      throw new Error(`Maintenance failed: ${error}`);
    }
  }

  isHealthy(): boolean {
    return this.lastHealthStatus?.healthy ?? false;
  }
}

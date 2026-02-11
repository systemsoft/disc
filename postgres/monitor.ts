import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { PostgresInstance } from "./instance.ts";
import { logger } from "./logger.ts";

export interface MonitorOptions {
  autoRestart?: boolean;
  checkIntervalMs?: number;
  maxRestartAttempts?: number;
  restartDelayMs?: number;
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
  private isMonitoring = false;
  private lastHealthStatus?: HealthStatus;
  private maxRestartAttempts: number;
  private monitorHandle?: number;
  private restartAttempts = 0;
  private restartDelayMs: number;

  constructor(instance: PostgresInstance, options: MonitorOptions = {}) {
    this.instance = instance;
    this.autoRestart = options.autoRestart ?? true;
    this.checkInterval = options.checkIntervalMs ?? 30000; // 30 seconds
    this.maxRestartAttempts = options.maxRestartAttempts ?? 3;
    this.restartDelayMs = options.restartDelayMs ?? 5000;
  }

  async start(): Promise<void> {
    if (this.isMonitoring) {
      logger.info("Monitor already running");
      return;
    }

    this.isMonitoring = true;
    logger.info("Starting PostgreSQL health monitor");

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
      // Attempt to connect and run a simple query
      const client = new Client(this.instance.dsn());
      await client.connect();

      const result = await client.queryObject<{
        connections: number;
        uptime: number;
        version: string;
      }>(`
        SELECT 
          (SELECT count(*) FROM pg_stat_activity)::int as connections,
          EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::int as uptime,
          version() as version
      `);

      await client.end();

      const latencyMs = Date.now() - startTime;

      this.lastHealthStatus = {
        connections: result.rows[0].connections,
        healthy: true,
        lastCheck: new Date(),
        latencyMs,
        uptime: result.rows[0].uptime,
        version: result.rows[0].version,
      };

      // Reset restart attempts on successful health check
      this.restartAttempts = 0;

      return this.lastHealthStatus;
    } catch (error) {
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

    const client = new Client(this.instance.dsn());
    try {
      await client.connect();

      const [dbSize, tableStats, connectionStats] = await Promise.all([
        client.queryObject<{ size: string }>(`
          SELECT pg_size_pretty(pg_database_size(current_database())) as size
        `),
        client.queryObject<{ count: number; total_size: string }>(`
          SELECT 
            COUNT(*)::int as count,
            pg_size_pretty(SUM(pg_total_relation_size(c.oid))::bigint) as total_size
          FROM pg_class c
          WHERE c.relkind = 'r'
        `),
        client.queryObject<{
          active: number;
          idle: number;
          total: number;
        }>(`
          SELECT
            COUNT(*) FILTER (WHERE state = 'active')::int as active,
            COUNT(*) FILTER (WHERE state = 'idle')::int as idle,
            COUNT(*)::int as total
          FROM pg_stat_activity
          WHERE datname = current_database()
        `),
      ]);

      await client.end();

      return {
        connections: connectionStats.rows[0],
        database: {
          size: dbSize.rows[0].size,
        },
        tables: {
          count: tableStats.rows[0].count,
          totalSize: tableStats.rows[0].total_size,
        },
      };
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }

  async performMaintenance(): Promise<void> {
    const client = new Client(this.instance.dsn());

    try {
      await client.connect();

      logger.info("Running PostgreSQL maintenance tasks...");

      // Analyze all tables to update statistics
      await client.queryArray("ANALYZE");

      // Clean up dead rows (VACUUM)
      await client.queryArray("VACUUM");

      // Reindex if needed (be careful with this in production)
      // await client.queryArray("REINDEX DATABASE disc");

      logger.info("Maintenance tasks completed");

      await client.end();
    } catch (error) {
      await client.end().catch(() => {});
      throw new Error(`Maintenance failed: ${error}`);
    }
  }

  isHealthy(): boolean {
    return this.lastHealthStatus?.healthy ?? false;
  }
}

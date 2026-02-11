import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { PostgresInstance, PostgresInstanceOptions } from "./instance.ts";
import { PostgresMonitor } from "./monitor.ts";
import { logger } from "./logger.ts";

export interface ManagedInstance {
  instance: PostgresInstance;
  monitor?: PostgresMonitor;
  name: string;
}

export class PostgresManager {
  private baseDir: string;
  private instances: Map<string, ManagedInstance> = new Map();

  constructor(baseDir = join(Deno.env.get("HOME")!, ".disc", "instances")) {
    this.baseDir = baseDir;
  }

  async createInstance(
    name: string,
    options?: Partial<PostgresInstanceOptions>,
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
      ...options,
    });

    await instance.init();

    this.instances.set(name, {
      instance,
      name,
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
      health: healthStatus,
    };
  }

  private async recoverInstance(name: string): Promise<boolean> {
    const instanceDir = join(this.baseDir, name);
    const dataDir = join(instanceDir, "data");

    try {
      await Deno.stat(dataDir);

      const instance = new PostgresInstance({
        dataDir,
        instanceName: name,
        socketDir: join(instanceDir, "socket"),
      });

      this.instances.set(name, {
        instance,
        name,
      });

      return true;
    } catch {
      return false;
    }
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

  upgradeInstance(name: string, _targetVersion: string): Promise<void> {
    const managed = this.instances.get(name);
    if (!managed) {
      throw new Error(`Instance '${name}' not found`);
    }

    // This would implement pg_upgrade logic
    // For now, throw not implemented
    throw new Error("PostgreSQL version upgrade not yet implemented");
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
      // Use pg_basebackup or tar for backup
      const cmd = new Deno.Command("tar", {
        args: ["-czf", backupPath, "-C", dataDir, "."],
      });

      const output = await cmd.output();
      if (!output.success) {
        throw new Error("Backup failed");
      }

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
      args: ["-xzf", backupPath, "-C", dataDir],
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

export { PostgresConfig } from "./config.ts";
export type { PostgresConfigOptions } from "./config.ts";

export { PostgresBinaryDownloader } from "./downloader.ts";
export type { BinaryManifest } from "./downloader.ts";

export { PostgresInstance } from "./instance.ts";
export type { PostgresInstanceOptions, PostgresInstanceStatus } from "./instance.ts";

export { PostgresManager } from "./manager.ts";
export type { ManagedInstance } from "./manager.ts";

export { PostgresMonitor } from "./monitor.ts";
export type { HealthStatus, MonitorOptions } from "./monitor.ts";

export { logger, PostgresLogger } from "./logger.ts";
export { LogLevel } from "./logger.ts";

// Import types needed for the interface and internal functions
import type { PostgresInstance as _PostgresInstance, PostgresInstanceOptions as _PostgresInstanceOptions } from "./instance.ts";
import { PostgresManager as _PostgresManager } from "./manager.ts";

// Main interface for the postgres module
export interface PostgresModule {
  createInstance(
    name: string,
    options?: _PostgresInstanceOptions
  ): Promise<_PostgresInstance>;
  destroyInstance(name: string): Promise<void>;
  getInstance(name: string): _PostgresInstance | undefined;
  listInstances(): string[];
  manager: _PostgresManager;
  startInstance(name: string): Promise<void>;
  stopInstance(name: string): Promise<void>;
}

// Default singleton manager for simple use cases
let defaultManager: _PostgresManager | null = null;

export function getDefaultManager(): _PostgresManager {
  if (!defaultManager) {
    defaultManager = new _PostgresManager();
  }
  return defaultManager;
}

// Convenience functions using the default manager
export async function createInstance(
  name: string,
  options?: Partial<_PostgresInstanceOptions>
): Promise<_PostgresInstance> {
  const manager = getDefaultManager();
  return await manager.createInstance(name, options);
}

export async function startInstance(
  name: string,
  withMonitor = true
): Promise<void> {
  const manager = getDefaultManager();
  return await manager.startInstance(name, withMonitor);
}

export async function stopInstance(name: string): Promise<void> {
  const manager = getDefaultManager();
  return await manager.stopInstance(name);
}

export function getInstance(name: string): _PostgresInstance | undefined {
  const manager = getDefaultManager();
  return manager.getInstance(name);
}

export function listInstances(): string[] {
  const manager = getDefaultManager();
  return manager.listInstances();
}

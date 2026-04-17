import type { ProjectContext } from "../lib/project-context.ts";
import type { PostgresInstance } from "./instance.ts";
import { PostgresManager } from "./manager.ts";

export interface EnsureResult {
  dsn: string;
  instance: PostgresInstance;
  wasStarted: boolean;
}

/**
 * Ensure a managed PostgreSQL instance is running for the given project context.
 *
 * Idempotent: if PostgreSQL is already running, returns immediately with
 * wasStarted = false. If stopped, starts it and returns wasStarted = true.
 * If no on-disk instance exists yet, creates and starts one.
 *
 * Throws if ctx.managed is false — callers should use ctx.backendDsn directly
 * for external PostgreSQL connections.
 */
export async function ensurePgRunning(
  ctx: ProjectContext,
  options: { withMonitor?: boolean } = {},
): Promise<EnsureResult> {
  if (!ctx.managed) {
    throw new Error(
      "Not a managed instance — use backendDsn directly",
    );
  }

  // P1-17: default to NO monitor so the CLI can return after `disc start`
  // instead of blocking the event loop. Foreground / serve paths still
  // pass withMonitor: true to get crash-restart behavior.
  const withMonitor = options.withMonitor ?? false;

  const manager = new PostgresManager();

  // Load any on-disk instances into manager memory before looking up.
  await manager.discoverInstances();

  let instance = manager.getInstance(ctx.instanceName);

  if (instance !== undefined) {
    const status = await instance.status();

    if (status.running) {
      return {
        dsn: instance.dsn(),
        instance,
        wasStarted: false,
      };
    }

    // Instance exists on disk but is not running — start it.
    await manager.startInstance(ctx.instanceName, withMonitor);
    instance = manager.getInstance(ctx.instanceName)!;

    return {
      dsn: instance.dsn(),
      instance,
      wasStarted: true,
    };
  }

  // No on-disk instance found — create a fresh one then start it.
  instance = await manager.createInstance(ctx.instanceName, {
    dataDir: ctx.dataDir,
    socketDir: ctx.socketDir,
  });

  await manager.startInstance(ctx.instanceName, withMonitor);
  instance = manager.getInstance(ctx.instanceName)!;

  return {
    dsn: instance.dsn(),
    instance,
    wasStarted: true,
  };
}

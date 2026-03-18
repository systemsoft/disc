/**
 * Extension registry for Disc database
 */

import type {
  CompilerHook,
  Extension,
  ExtensionContext,
  ExtensionMiddleware,
  ExtensionRoute,
} from "./types.ts";
import type { FunctionDef, TypeDef } from "../compiler/context.ts";
import { ExtensionDependencyError, ExtensionInitError } from "./errors.ts";
import { getLogger } from "../lib/logger.ts";

const log = getLogger("extension-registry");

export class ExtensionRegistry {
  private extensions: Map<string, Extension> = new Map();
  private initOrder: string[] = [];

  register(extension: Extension): void {
    const name = extension.metadata.name;
    if (this.extensions.has(name)) {
      throw new ExtensionInitError(
        name,
        `Extension "${name}" is already registered`,
      );
    }
    this.extensions.set(name, extension);
    log.info(`Registered extension: ${name} v${extension.metadata.version}`);
  }

  get(name: string): Extension | undefined {
    return this.extensions.get(name);
  }

  getAll(): Extension[] {
    return Array.from(this.extensions.values());
  }

  async initializeAll(context: ExtensionContext): Promise<void> {
    const sorted = this.topologicalSort();
    this.initOrder = sorted;

    for (const name of sorted) {
      const ext = this.extensions.get(name)!;
      log.info(`Initializing extension: ${name}`);
      try {
        const setup = ext.getDatabaseSetup();
        if (context.pool && setup.setupSql.length > 0) {
          for (const sql of setup.setupSql) {
            await context.pool.query(sql);
          }
        }
        await ext.initialize(context);
        log.info(`Extension initialized: ${name}`);
      } catch (error) {
        if (error instanceof ExtensionInitError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new ExtensionInitError(name, message);
      }
    }
  }

  async shutdownAll(): Promise<void> {
    const reversed = [...this.initOrder].reverse();
    for (const name of reversed) {
      const ext = this.extensions.get(name);
      if (ext) {
        log.info(`Shutting down extension: ${name}`);
        try {
          await ext.shutdown();
        } catch (error) {
          log.error(`Error shutting down extension ${name}: ${error}`);
        }
      }
    }
  }

  getAllFunctions(): FunctionDef[] {
    const functions: FunctionDef[] = [];
    for (const ext of this.extensions.values()) {
      functions.push(...ext.getFunctions());
    }
    return functions;
  }

  getAllTypes(): TypeDef[] {
    const types: TypeDef[] = [];
    for (const ext of this.extensions.values()) {
      types.push(...ext.getTypes());
    }
    return types;
  }

  getAllRoutes(): Map<string, ExtensionRoute[]> {
    const routes = new Map<string, ExtensionRoute[]>();
    for (const [name, ext] of this.extensions) {
      const extRoutes = ext.getRoutes();
      if (extRoutes.length > 0) {
        routes.set(name, extRoutes);
      }
    }
    return routes;
  }

  getAllMiddleware(): ExtensionMiddleware[] {
    const middleware: ExtensionMiddleware[] = [];
    for (const ext of this.extensions.values()) {
      middleware.push(...ext.getMiddleware());
    }
    return middleware.sort((a, b) => a.priority - b.priority);
  }

  getAllCompilerHooks(): CompilerHook[] {
    const hooks: CompilerHook[] = [];
    for (const ext of this.extensions.values()) {
      hooks.push(...ext.getCompilerHooks());
    }
    return hooks;
  }

  async getHealthStatus(): Promise<
    Map<string, { healthy: boolean; details?: string }>
  > {
    const status = new Map<string, { healthy: boolean; details?: string }>();
    for (const [name, ext] of this.extensions) {
      try {
        status.set(name, await ext.healthCheck());
      } catch (error) {
        status.set(name, {
          healthy: false,
          details: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return status;
  }

  get size(): number {
    return this.extensions.size;
  }

  private topologicalSort(): string[] {
    const visited = new Set<string>();
    const sorted: string[] = [];
    const visiting = new Set<string>();

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new ExtensionDependencyError(
          name,
          [`Circular dependency detected involving "${name}"`],
        );
      }

      visiting.add(name);

      const ext = this.extensions.get(name);
      if (!ext) return;

      const deps = ext.metadata.dependencies || [];
      const missing = deps.filter((d) => !this.extensions.has(d));
      if (missing.length > 0) {
        throw new ExtensionDependencyError(name, missing);
      }

      for (const dep of deps) {
        visit(dep);
      }

      visiting.delete(name);
      visited.add(name);
      sorted.push(name);
    };

    for (const name of this.extensions.keys()) {
      visit(name);
    }

    return sorted;
  }
}

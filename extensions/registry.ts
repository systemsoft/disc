/**
 * Extension registry for Disc database
 */

import type { FunctionDef, TypeDef } from "../compiler/context.ts";
import { getLogger } from "../lib/logger.ts";
import { ExtensionDependencyError, ExtensionInitError } from "./errors.ts";
import type { CompilerHook, Extension, ExtensionContext, ExtensionMiddleware, ExtensionRoute } from "./types.ts";

const log = getLogger("extension-registry");

export class ExtensionRegistry {
  private extensions: Map<string, Extension> = new Map();
  private initOrder: string[] = [];

  register(extension: Extension): void {
    const name = extension.metadata.name;
    if (this.extensions.has(name)) {
      throw new ExtensionInitError(
        name,
        `Extension "${name}" is already registered`
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

  /**
   * Initialize every registered extension in dependency-topological order.
   *
   * @param context      Shared initialization context (pool, logger, etc.)
   * @param options      Failure-handling policy:
   *   - `strict` (default) — stop at the first failure and re-throw.
   *   - `continue`         — log the failure, mark the extension failed,
   *     and proceed with the rest. Good for non-critical extensions
   *     (e.g. vector search missing pgvector) that shouldn't tank the
   *     whole server. (P1-39)
   *
   * Returns the names of extensions that failed to initialize (empty in
   * strict mode since the first failure throws).
   */
  async initializeAll(
    context: ExtensionContext,
    options: { onError?: "strict" | "continue"; } = {}
  ): Promise<string[]> {
    const onError = options.onError ?? "strict";
    const sorted = this.topologicalSort();
    this.initOrder = sorted;
    const failed: string[] = [];

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
        const message = error instanceof Error ? error.message : String(error);
        const initError = error instanceof ExtensionInitError ? error : new ExtensionInitError(name, message);
        if (onError === "strict") {
          throw initError;
        }
        log.error(`Extension failed to initialize (continuing): ${name}`, {
          error: message
        });
        failed.push(name);
      }
    }
    return failed;
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
    Map<string, { healthy: boolean; details?: string; }>
  > {
    const status = new Map<string, { healthy: boolean; details?: string; }>();
    for (const [name, ext] of this.extensions) {
      try {
        status.set(name, await ext.healthCheck());
      } catch (error) {
        status.set(name, {
          healthy: false,
          details: error instanceof Error ? error.message : String(error)
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
      if (visited.has(name))
        return;
      if (visiting.has(name)) {
        throw new ExtensionDependencyError(
          name,
          [`Circular dependency detected involving "${name}"`]
        );
      }

      visiting.add(name);

      const ext = this.extensions.get(name);
      if (!ext)
        return;

      const deps = ext.metadata.dependencies || [];
      const missing = deps.filter(d => !this.extensions.has(d));
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

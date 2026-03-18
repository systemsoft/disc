/**
 * Base extension class with empty defaults for Disc database
 */

import type {
  CompilerHook,
  Extension,
  ExtensionContext,
  ExtensionDatabaseSetup,
  ExtensionMetadata,
  ExtensionMiddleware,
  ExtensionRoute,
  ExtensionState,
} from "./types.ts";
import type { FunctionDef, TypeDef } from "../compiler/context.ts";

export abstract class BaseExtension implements Extension {
  abstract readonly metadata: ExtensionMetadata;
  private _state: ExtensionState = "uninitialized";

  get state(): ExtensionState {
    return this._state;
  }

  protected setState(state: ExtensionState): void {
    this._state = state;
  }

  initialize(_context: ExtensionContext): Promise<void> {
    this.setState("ready");
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.setState("shutdown");
    return Promise.resolve();
  }

  getFunctions(): FunctionDef[] {
    return [];
  }

  getTypes(): TypeDef[] {
    return [];
  }

  getRoutes(): ExtensionRoute[] {
    return [];
  }

  getMiddleware(): ExtensionMiddleware[] {
    return [];
  }

  getDatabaseSetup(): ExtensionDatabaseSetup {
    return { setupSql: [] };
  }

  getCompilerHooks(): CompilerHook[] {
    return [];
  }

  healthCheck(): Promise<{ healthy: boolean; details?: string }> {
    return Promise.resolve({ healthy: this._state === "ready" });
  }
}

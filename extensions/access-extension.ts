/**
 * AccessExtensionAdapter — wraps the existing access module as an Extension.
 *
 * The access module does not expose HTTP routes or its own database tables:
 * policies are derived from the SDL schema at compile time and injected into
 * SQL queries by AccessSQLInjector. This adapter exists so the extension
 * registry can track the access subsystem, report its health, and shut it
 * down cleanly alongside the rest of the server.
 */

import type { AccessEvaluator } from "../access/evaluator.ts";
import type { AccessSQLInjector } from "../access/sql-injector.ts";
import { BaseExtension } from "./base-extension.ts";
import type { ExtensionContext, ExtensionMetadata } from "./types.ts";

export interface AccessExtensionAdapterOptions {
  evaluator: AccessEvaluator;
  injector: AccessSQLInjector;
}

export class AccessExtensionAdapter extends BaseExtension {
  readonly metadata: ExtensionMetadata = {
    description: "Object-level access policies",
    name: "access",
    version: "1.0.0",
  };

  private evaluator: AccessEvaluator;
  private injector: AccessSQLInjector;

  constructor(options: AccessExtensionAdapterOptions) {
    super();
    this.evaluator = options.evaluator;
    this.injector = options.injector;
  }

  /**
   * Expose the evaluator so callers can register policies after construction.
   */
  getEvaluator(): AccessEvaluator {
    return this.evaluator;
  }

  /**
   * Expose the injector so callers can inject access conditions into queries.
   */
  getInjector(): AccessSQLInjector {
    return this.injector;
  }

  /**
   * Access policies come from the SDL schema — no DDL to run here.
   */
  override initialize(_context: ExtensionContext): Promise<void> {
    this.setState("ready");
    return Promise.resolve();
  }

  /**
   * The access module has no HTTP routes of its own.
   */
  override getRoutes() {
    return [];
  }

  /**
   * The access module has no middleware of its own; policy enforcement
   * is performed at query compile time via AccessSQLInjector.
   */
  override getMiddleware() {
    return [];
  }

  /**
   * No database tables to create — policies are held in memory.
   */
  override getDatabaseSetup() {
    return { setupSql: [] };
  }

  override healthCheck(): Promise<{ healthy: boolean; details?: string; }> {
    return Promise.resolve({ healthy: this.state === "ready" });
  }
}

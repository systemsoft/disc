/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Extension system types for Disc database
 */

import type { FunctionDef, TypeDef } from "../compiler/context.ts";
import type { Schema } from "../compiler/context.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import type { Logger } from "../lib/logger.ts";
import type { ServerConfig } from "../server/types.ts";

export type ExtensionState =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "error"
  | "shutdown";

export interface ExtensionMetadata {
  name: string;
  version: string;
  description?: string;
  dependencies?: string[];
}

/**
 * Auth context passed to extension route handlers when the request
 * carried a valid JWT (or when permissive mode populated one).
 * Structurally compatible with `auth/middleware.ts:AuthContext`
 * (which extends `TokenPayload`) but kept loose here so the
 * extensions layer doesn't need to import from `auth/`.
 * (gh/geldata#6345)
 */
export interface ExtensionAuthContext {
  userId: string;
  sub: string;
  email: string;
  username?: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  jti?: string;
}

export interface ExtensionRoute {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  handler: (
    request: Request,
    authContext?: ExtensionAuthContext
  ) => Response | Promise<Response>;
}

export interface ExtensionMiddleware {
  name: string;
  priority: number;
  handle: (
    request: Request,
    next: () => Promise<Response>
  ) => Promise<Response>;
}

export interface ExtensionDatabaseSetup {
  setupSql: string[];
  teardownSql?: string[];
}

export interface CompilerHook {
  name: string;
  transformFunctionCall?: (
    funcName: string,
    args: string[]
  ) => string | undefined;
}

export interface ExtensionConfig {
  name: string;
  enabled: boolean;
  options?: Record<string, unknown>;
}

export interface ExtensionContext {
  pool?: ConnectionPool;
  schema: Schema;
  config: ServerConfig;
  logger: Logger;
}

export interface Extension {
  readonly metadata: ExtensionMetadata;
  readonly state: ExtensionState;
  initialize(context: ExtensionContext): Promise<void>;
  shutdown(): Promise<void>;
  getFunctions(): FunctionDef[];
  getTypes(): TypeDef[];
  getRoutes(): ExtensionRoute[];
  getMiddleware(): ExtensionMiddleware[];
  getDatabaseSetup(): ExtensionDatabaseSetup;
  getCompilerHooks(): CompilerHook[];
  healthCheck(): Promise<{ healthy: boolean; details?: string; }>;
}

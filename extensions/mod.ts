/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Extension system for Disc database
 */

export type {
  CompilerHook,
  Extension,
  ExtensionConfig,
  ExtensionContext,
  ExtensionDatabaseSetup,
  ExtensionMetadata,
  ExtensionMiddleware,
  ExtensionRoute,
  ExtensionState
} from "./types.ts";

export { BaseExtension } from "./base-extension.ts";
export { createExtensionContext } from "./context.ts";
export { ExtensionRegistry } from "./registry.ts";

export {
  ExtensionConfigError,
  ExtensionDependencyError,
  ExtensionError,
  ExtensionInitError
} from "./errors.ts";

export { AccessExtensionAdapter } from "./access-extension.ts";
export type { AccessExtensionAdapterOptions } from "./access-extension.ts";

export { AuthExtensionAdapter } from "./auth-extension.ts";
export type { AuthExtensionAdapterOptions } from "./auth-extension.ts";

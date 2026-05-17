/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Extension error classes for Disc database
 */

import { DiscError } from "../lib/errors.ts";
import type { ErrorContext } from "../lib/errors.ts";

export class ExtensionError extends DiscError {
  readonly extensionName: string;

  constructor(extensionName: string, message: string, context?: ErrorContext) {
    super(`[${extensionName}] ${message}`, context);
    this.extensionName = extensionName;
  }
}

export class ExtensionInitError extends ExtensionError {
  constructor(extensionName: string, message: string, context?: ErrorContext) {
    super(extensionName, `Initialization failed: ${message}`, context);
  }
}

export class ExtensionDependencyError extends ExtensionError {
  readonly missingDependencies: string[];

  constructor(
    extensionName: string,
    missingDependencies: string[],
    context?: ErrorContext
  ) {
    super(
      extensionName,
      `Missing dependencies: ${missingDependencies.join(", ")}`,
      context
    );
    this.missingDependencies = missingDependencies;
  }
}

export class ExtensionConfigError extends ExtensionError {
  constructor(extensionName: string, message: string, context?: ErrorContext) {
    super(extensionName, `Configuration error: ${message}`, context);
  }
}

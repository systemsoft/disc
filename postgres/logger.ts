/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

import { getLogger } from "../lib/logger.ts";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

/**
 * Backward-compatible PostgresLogger that delegates to the structured logger.
 * Kept for the 11+ importers that reference `PostgresLogger` or `logger`.
 */
export class PostgresLogger {
  private inner;

  constructor(_prefix = "[postgres]", _level = LogLevel.INFO) {
    this.inner = getLogger("postgres");
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.inner.debug(message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.inner.info(message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.inner.warn(message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.inner.error(message, extra);
  }
}

export const logger = new PostgresLogger();

import { getLogger } from "../lib/logger.ts";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
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

  debug(message: string): void {
    this.inner.debug(message);
  }

  info(message: string): void {
    this.inner.info(message);
  }

  warn(message: string): void {
    this.inner.warn(message);
  }

  error(message: string): void {
    this.inner.error(message);
  }
}

export const logger = new PostgresLogger();

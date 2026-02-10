/**
 * Logging utilities for Disc
 */

import * as log from "@std/log";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  CRITICAL = 4,
}

export class Logger {
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  debug(message: string, ...args: unknown[]): void {
    log.debug(`[${this.name}] ${message}`, ...args);
  }

  info(message: string, ...args: unknown[]): void {
    log.info(`[${this.name}] ${message}`, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    log.warn(`[${this.name}] ${message}`, ...args);
  }

  error(message: string, ...args: unknown[]): void {
    log.error(`[${this.name}] ${message}`, ...args);
  }

  critical(message: string, ...args: unknown[]): void {
    log.critical(`[${this.name}] ${message}`, ...args);
  }
}

export function getLogger(name: string): Logger {
  return new Logger(name);
}

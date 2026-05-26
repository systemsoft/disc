/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/*** NATIVE ------------------------------------------- ***/

import { bgBrightRed, bgBrightYellow, gray, inverse } from "@std/fmt/colors";

/*** EXPORT ------------------------------------------- ***/

export type LogFormat = "json" | "text";
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface LogConfig {
  format: LogFormat;
  level: LogLevel;
  output?: (line: string) => void; /*** defaults to console.error (stderr) ***/
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  module: string;
  requestId?: string;
  timestamp: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

let globalConfig: LogConfig = {
  level: "INFO",
  format: "text"
};

export function configureLogging(config: Partial<LogConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

export class Logger {
  private extra: Record<string, unknown>;
  private module: string;

  constructor(module: string, extra: Record<string, unknown> = {}) {
    this.extra = extra;
    this.module = module;
  }

  child(extra: Record<string, unknown>): Logger {
    return new Logger(this.module, { ...this.extra, ...extra });
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log("DEBUG", message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.log("ERROR", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log("INFO", message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log("WARN", message, extra);
  }

  withRequest(requestId: string, clientIp?: string): Logger {
    return this.child({ requestId, ...(clientIp ? { clientIp } : {}) });
  }

  levelWithBackground(level: string) {
    if (level === "FAIL")
      return bgBrightRed(`[${level}]`);

    if (level === "WARN")
      return bgBrightYellow(`[${level}]`);

    return inverse(`[${level}]`);
  }

  private log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalConfig.level])
      return;

    const entry: LogEntry = {
      level,
      message,
      module: this.module,
      timestamp: new Date().toISOString(),
      ...this.extra,
      ...extra
    };

    // deno-lint-ignore no-console
    const output = globalConfig.output || console.error;

    if (globalConfig.format === "json") {
      output(JSON.stringify(entry));
    } else {
      /*** Text format: TIMESTAMP [LEVEL] [module] message key=value
           Quote values that would break logfmt parsing (spaces, equals, quotes). Previously
           `key=multi word` merged into adjacent pairs. ***/
      const kvPairs = Object
        .entries(entry)
        .filter(([k]) => !["timestamp", "level", "module", "message"].includes(k))
        .map(([k, v]) => `${k}=${formatLogValue(v)}`)
        .join(" ");

      let normalizedLevel = "";

      switch (level) {
        case "DEBUG": {
          normalizedLevel = "DBUG";
          break;
        }

        case "ERROR": {
          normalizedLevel = "FAIL";
          break;
        }

        case "INFO":
        case "WARN": {
          normalizedLevel = level;
          break;
        }
      }

      const line = `${gray(`${entry.timestamp}`)} ${this.levelWithBackground(`${normalizedLevel}`)} [${this.module}] ${message}${kvPairs ? " " + kvPairs : ""}`;
      output(line);
    }
  }
}

export function getLogger(module: string): Logger {
  return new Logger(module);
}

/**
 * Serialize a logfmt value. Bare tokens (no spaces/quotes/equals) are emitted
 * verbatim. Anything else gets JSON-string-quoted, which matches the logfmt
 * spec and keeps logs parseable by common tools (lnav, grafana loki, etc.).
 */
function formatLogValue(v: unknown): string {
  if (v === null || v === undefined)
    return String(v);

  if (typeof v === "number" || typeof v === "boolean")
    return String(v);

  const s = typeof v === "string" ? v : JSON.stringify(v);

  /*** Needs quoting if it contains whitespace, a literal quote, or an `=`. ***/
  if (/[\s"=]/.test(s))
    return JSON.stringify(s);

  return s;
}

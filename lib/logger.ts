export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogFormat = "json" | "text";

export interface LogConfig {
  level: LogLevel;
  format: LogFormat;
  output?: (line: string) => void; // defaults to console.error (stderr)
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  requestId?: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// Global config - defaults
let globalConfig: LogConfig = {
  level: "INFO",
  format: "json",
};

export function configureLogging(config: Partial<LogConfig>): void {
  globalConfig = { ...globalConfig, ...config };
}

export class Logger {
  private module: string;
  private extra: Record<string, unknown>;

  constructor(module: string, extra: Record<string, unknown> = {}) {
    this.module = module;
    this.extra = extra;
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this.log("DEBUG", message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this.log("INFO", message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this.log("WARN", message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this.log("ERROR", message, extra);
  }

  child(extra: Record<string, unknown>): Logger {
    return new Logger(this.module, { ...this.extra, ...extra });
  }

  withRequest(requestId: string, clientIp?: string): Logger {
    return this.child({ requestId, ...(clientIp ? { clientIp } : {}) });
  }

  private log(
    level: LogLevel,
    message: string,
    extra?: Record<string, unknown>,
  ): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[globalConfig.level]) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      ...this.extra,
      ...extra,
    };

    // deno-lint-ignore no-console
    const output = globalConfig.output || console.error;

    if (globalConfig.format === "json") {
      output(JSON.stringify(entry));
    } else {
      // Text format: TIMESTAMP [LEVEL] [module] message key=value
      // P1-42: quote values that would break logfmt parsing (spaces, equals,
      // quotes). Previously `key=multi word` merged into adjacent pairs.
      const kvPairs = Object.entries(entry)
        .filter(
          ([k]) => !["timestamp", "level", "module", "message"].includes(k),
        )
        .map(([k, v]) => `${k}=${formatLogValue(v)}`)
        .join(" ");
      const line = `${entry.timestamp} [${level}] [${this.module}] ${message}${kvPairs ? " " + kvPairs : ""}`;
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
  if (v === null || v === undefined) return String(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  // Needs quoting if it contains whitespace, a literal quote, or an `=`.
  if (/[\s"=]/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

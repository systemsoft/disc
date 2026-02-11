// deno-lint-ignore-file no-console

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export class PostgresLogger {
  private level: LogLevel;
  private prefix: string;

  constructor(prefix = "[postgres]", level = LogLevel.INFO) {
    this.prefix = prefix;
    this.level = level;
  }

  debug(message: string): void {
    if (this.level <= LogLevel.DEBUG) {
      this.output("DEBUG", message);
    }
  }

  info(message: string): void {
    if (this.level <= LogLevel.INFO) {
      this.output("INFO", message);
    }
  }

  warn(message: string): void {
    if (this.level <= LogLevel.WARN) {
      this.output("WARN", message);
    }
  }

  error(message: string): void {
    if (this.level <= LogLevel.ERROR) {
      this.output("ERROR", message);
    }
  }

  private output(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const formattedMessage =
      `${timestamp} ${this.prefix} [${level}] ${message}`;

    // In production, this would write to a file or send to a logging service
    // For now, we use console but it's centralized here
    if (level === "ERROR") {
      console.error(formattedMessage);
    } else if (level === "WARN") {
      console.warn(formattedMessage);
    } else {
      console.log(formattedMessage);
    }
  }
}

// Default logger instance
export const logger = new PostgresLogger();

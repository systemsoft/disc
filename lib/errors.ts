/**
 * Error classes for Disc database
 */

export interface SourceLocation {
  line: number;
  column: number;
  offset: number;
  file?: string;
}

export interface ErrorContext {
  source?: string;
  location?: SourceLocation;
  hint?: string;
}

export abstract class DiscError extends Error {
  context?: ErrorContext;

  constructor(message: string, context?: ErrorContext) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
  }

  formatError(): string {
    let output = `${this.name}: ${this.message}`;

    if (this.context?.location) {
      const loc = this.context.location;
      output += `\n  at ${loc.file || "<input>"}:${loc.line}:${loc.column}`;
    }

    if (this.context?.source && this.context?.location) {
      const lines = this.context.source.split("\n");
      const lineNum = this.context.location.line - 1;

      if (lines[lineNum]) {
        output += `\n\n${this.context.location.line} | ${lines[lineNum]}`;
        output += `\n${" ".repeat(String(this.context.location.line).length)} | ${" ".repeat(this.context.location.column - 1)}^`;
      }
    }

    if (this.context?.hint) {
      output += `\n\nHint: ${this.context.hint}`;
    }

    return output;
  }
}

export class SyntaxError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

export class SchemaError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

export class QueryError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

export class CompilationError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

export class ValidationError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

/**
 * URL appended to every `InternalError` message so users land on the
 * correct issue tracker when they hit a server-side bug.
 *
 * Internal errors are always bugs in Disc itself — even when they're
 * triggered by an unexpected PostgreSQL error code, the right fix is
 * for Disc to translate that code into a more specific error class.
 * Ports geldata/gel#930.
 */
export const INTERNAL_ERROR_ISSUE_URL = "https://github.com/systemsoft/disc/issues";

/**
 * Marker substring used to detect (and avoid duplicating) the
 * file-an-issue hint when an `InternalError` is constructed from a
 * message that was previously produced by another `InternalError`.
 */
const INTERNAL_ERROR_HINT_MARKER = "please file an issue at";

function appendInternalErrorHint(message: string): string {
  if (message.includes(INTERNAL_ERROR_HINT_MARKER)) {
    return message;
  }
  return `${message} (this is a bug — ${INTERNAL_ERROR_HINT_MARKER} ${INTERNAL_ERROR_ISSUE_URL})`;
}

export class InternalError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(appendInternalErrorHint(message), context);
  }
}

export class ConnectionError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

export class MigrationError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

export class DatabaseRegistryError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

export class DatabaseExecutionError extends DiscError {
  readonly sql: string;
  override readonly cause: Error;

  constructor(
    message: string,
    sql: string,
    cause: Error,
    context?: ErrorContext,
  ) {
    super(message, context);
    this.sql = sql;
    this.cause = cause;
  }

  override formatError(): string {
    let output = super.formatError();
    output += `\n\nSQL: ${this.sql}`;
    output += `\nCaused by: ${this.cause.message}`;
    return output;
  }
}

export class QueryTimeoutError extends DiscError {
  readonly sql: string;
  readonly timeoutMs: number;

  constructor(
    sql: string,
    timeoutMs: number,
    context?: ErrorContext,
  ) {
    super(
      `Query timed out after ${timeoutMs}ms`,
      context,
    );
    this.sql = sql;
    this.timeoutMs = timeoutMs;
  }

  override formatError(): string {
    let output = super.formatError();
    output += `\n\nSQL: ${this.sql}`;
    output += `\nTimeout: ${this.timeoutMs}ms`;
    return output;
  }
}

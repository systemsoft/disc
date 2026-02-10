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

export class InternalError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
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
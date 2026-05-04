/**
 * SDK Error Hierarchy — Client-side error classes
 */

import type { QueryError, StandardSchemaIssue } from "./types.ts";

/** Error codes that map to server-side error conditions */
export enum DiscErrorCode {
  /** Query syntax or execution error */
  QUERY_ERROR = "QUERY_ERROR",
  /** Network-level failure (fetch failed, DNS, etc.) */
  NETWORK_ERROR = "NETWORK_ERROR",
  /** Request exceeded configured timeout */
  TIMEOUT = "TIMEOUT",
  /** Authentication failure (401, invalid token, expired) */
  AUTH_ERROR = "AUTH_ERROR",
  /** Connection refused or server unreachable */
  CONNECTION_ERROR = "CONNECTION_ERROR",
  /** Transaction in invalid state */
  TRANSACTION_ERROR = "TRANSACTION_ERROR",
  /** Server returned unexpected response format */
  PROTOCOL_ERROR = "PROTOCOL_ERROR",
  /** Server returned 5xx */
  SERVER_ERROR = "SERVER_ERROR",
  /** Response data failed user-supplied runtime validation */
  VALIDATION_ERROR = "VALIDATION_ERROR",
}

/** Base error class for all SDK errors */
export class DiscClientError extends Error {
  readonly code: DiscErrorCode;

  constructor(message: string, code: DiscErrorCode) {
    super(message);
    this.name = "DiscClientError";
    this.code = code;
  }
}

/** Wraps one or more QueryError objects from the server response */
export class DiscQueryError extends DiscClientError {
  readonly errors: QueryError[];

  constructor(errors: QueryError[]) {
    const message = errors.length === 1
      ? errors[0].message
      : `${errors.length} query errors: ${errors[0].message}`;
    super(message, DiscErrorCode.QUERY_ERROR);
    this.name = "DiscQueryError";
    this.errors = errors;
  }
}

/** Network-level failure (fetch threw, DNS resolution failed, etc.) */
export class DiscNetworkError extends DiscClientError {
  override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message, DiscErrorCode.NETWORK_ERROR);
    this.name = "DiscNetworkError";
    this.cause = cause;
  }
}

/** Request exceeded the configured timeout */
export class DiscTimeoutError extends DiscClientError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`, DiscErrorCode.TIMEOUT);
    this.name = "DiscTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Authentication or authorization failure */
export class DiscAuthError extends DiscClientError {
  readonly statusCode: number;

  constructor(message: string, statusCode = 401) {
    super(message, DiscErrorCode.AUTH_ERROR);
    this.name = "DiscAuthError";
    this.statusCode = statusCode;
  }
}

/** Server is unreachable or connection was refused */
export class DiscConnectionError extends DiscClientError {
  override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message, DiscErrorCode.CONNECTION_ERROR);
    this.name = "DiscConnectionError";
    this.cause = cause;
  }
}

/** Transaction is in an invalid state for the requested operation */
export class DiscTransactionError extends DiscClientError {
  constructor(message: string) {
    super(message, DiscErrorCode.TRANSACTION_ERROR);
    this.name = "DiscTransactionError";
  }
}

/** Server returned an unexpected response format */
export class DiscProtocolError extends DiscClientError {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message, DiscErrorCode.PROTOCOL_ERROR);
    this.name = "DiscProtocolError";
    this.statusCode = statusCode;
  }
}

/**
 * Thrown when a user-supplied validator (passed via `query<T>(…, { validate })`)
 * rejects the server response. Preserves Standard Schema issues so callers can
 * surface field-level diagnostics. (P1-28)
 */
export class DiscValidationError extends DiscClientError {
  readonly issues: ReadonlyArray<StandardSchemaIssue>;
  override readonly cause?: Error;

  constructor(
    issues: ReadonlyArray<StandardSchemaIssue>,
    cause?: Error,
  ) {
    const summary = issues.length === 1
      ? issues[0].message
      : `${issues.length} validation issues: ${issues[0]?.message ?? ""}`;
    super(summary, DiscErrorCode.VALIDATION_ERROR);
    this.name = "DiscValidationError";
    this.issues = issues;
    this.cause = cause;
  }
}

/** Server returned a 5xx error */
export class DiscServerError extends DiscClientError {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message, DiscErrorCode.SERVER_ERROR);
    this.name = "DiscServerError";
    this.statusCode = statusCode;
  }
}

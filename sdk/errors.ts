/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

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
  VALIDATION_ERROR = "VALIDATION_ERROR"
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

/** A string field of the first error's `extensions`, when the server sent one. */
function firstExtension(errors: QueryError[], key: string): string | undefined {
  const value = errors[0]?.extensions?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Wraps one or more QueryError objects from the server response */
export class DiscQueryError extends DiscClientError {
  readonly errors: QueryError[];
  /**
   * PostgreSQL SQLSTATE of the statement that failed (`extensions.sqlState`),
   * when the error came from the database. Undefined for parse, compile and
   * validation errors, which never reach it.
   */
  readonly sqlState?: string;

  constructor(errors: QueryError[]) {
    const message = errors.length === 1 ?
      errors[0].message :
      `${errors.length} query errors: ${errors[0].message}`;
    super(message, DiscErrorCode.QUERY_ERROR);
    this.name = "DiscQueryError";
    this.errors = errors;
    this.sqlState = firstExtension(errors, "sqlState");
  }
}

/** An integrity constraint was violated (SQLSTATE class 23). */
export class ConstraintViolationError extends DiscQueryError {
  /** Name of the violated constraint or unique index (`extensions.constraint`). */
  readonly constraint?: string;
  /** Table the constraint belongs to (`extensions.table`). */
  readonly table?: string;
  /** PostgreSQL's detail line, e.g. the conflicting key (`extensions.detail`). */
  readonly detail?: string;

  constructor(errors: QueryError[]) {
    super(errors);
    this.name = "ConstraintViolationError";
    this.constraint = firstExtension(errors, "constraint");
    this.table = firstExtension(errors, "table");
    this.detail = firstExtension(errors, "detail");
  }
}

/** A unique constraint or `exclusive` index was violated (SQLSTATE 23505). */
export class UniqueViolationError extends ConstraintViolationError {
  constructor(errors: QueryError[]) {
    super(errors);
    this.name = "UniqueViolationError";
  }
}

/** A link points at a row that does not exist (SQLSTATE 23503). */
export class ForeignKeyViolationError extends ConstraintViolationError {
  constructor(errors: QueryError[]) {
    super(errors);
    this.name = "ForeignKeyViolationError";
  }
}

/** The transaction could not be serialized (SQLSTATE 40001); retry the whole transaction. */
export class SerializationFailureError extends DiscQueryError {
  constructor(errors: QueryError[]) {
    super(errors);
    this.name = "SerializationFailureError";
  }
}

/** PostgreSQL broke a deadlock by aborting this transaction (SQLSTATE 40P01); retry it. */
export class DeadlockError extends DiscQueryError {
  constructor(errors: QueryError[]) {
    super(errors);
    this.name = "DeadlockError";
  }
}

/**
 * The query error for a server `errors` envelope, typed by the SQLSTATE of
 * its first error: `UniqueViolationError` (23505), `ForeignKeyViolationError`
 * (23503), `ConstraintViolationError` (any other class 23),
 * `SerializationFailureError` (40001), `DeadlockError` (40P01), and a plain
 * `DiscQueryError` otherwise. Every result is an `instanceof DiscQueryError`.
 */
export function createQueryError(errors: QueryError[]): DiscQueryError {
  const sqlState = firstExtension(errors, "sqlState");

  if (sqlState === "23505") {
    return new UniqueViolationError(errors);
  }
  if (sqlState === "23503") {
    return new ForeignKeyViolationError(errors);
  }
  if (sqlState?.startsWith("23")) {
    return new ConstraintViolationError(errors);
  }
  if (sqlState === "40001") {
    return new SerializationFailureError(errors);
  }
  if (sqlState === "40P01") {
    return new DeadlockError(errors);
  }
  return new DiscQueryError(errors);
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
  /** The statement failure that put the transaction in the `failed` state, when that is why. */
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message, DiscErrorCode.TRANSACTION_ERROR);
    this.name = "DiscTransactionError";
    this.cause = cause;
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
    cause?: Error
  ) {
    const summary = issues.length === 1 ?
      issues[0].message :
      `${issues.length} validation issues: ${issues[0]?.message ?? ""}`;
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

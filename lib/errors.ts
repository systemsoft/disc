/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

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

/**
 * A query names a type, global or link property the schema does not have
 * (Gel's `InvalidReferenceError`).
 */
export class InvalidReferenceError extends CompilationError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

/**
 * A query passes a value the operation can't take, found while compiling it
 * (Gel's `InvalidValueError`): `datetime_get(dt, 'fortnight')`.
 */
export class InvalidValueError extends CompilationError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

/**
 * A CONFIGURE names a key Disc doesn't accept, or at a scope it can't take
 * (Gel's `ConfigurationError`): `configure session set archive_command := …`.
 */
export class ConfigurationError extends CompilationError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

/**
 * The caller may not run this kind of query (Gel's
 * `DisabledCapabilityError`): persistent CONFIGURE by a non-administrator.
 */
export class DisabledCapabilityError extends DiscError {
  constructor(message: string, context?: ErrorContext) {
    super(message, context);
  }
}

/**
 * A query of many results where the client expects one (`querySingle`,
 * `querySingleJSON`, `queryRequiredSingle`): Gel's
 * `ResultCardinalityMismatchError` (edb/server/compiler/compiler.py).
 */
export class ResultCardinalityMismatchError extends DiscError {
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
    context?: ErrorContext
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
    context?: ErrorContext
  ) {
    super(
      `Query timed out after ${timeoutMs}ms`,
      context
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

/**
 * COMMIT was requested on a transaction a failed statement had already
 * aborted. The server rolls it back instead; the id is no longer valid.
 */
export class TransactionAbortedError extends DiscError {
  readonly transactionId: string;

  constructor(transactionId: string, context?: ErrorContext) {
    super(
      `Transaction ${transactionId} was aborted by a failed statement and has been rolled back`,
      context
    );
    this.transactionId = transactionId;
  }
}

/**
 * The PostgreSQL error fields a client can act on, read from the driver's
 * error (deno-postgres keeps the server's ErrorResponse in `fields`) or from
 * a wrapper whose `cause` is that error. `sqlState` is the SQLSTATE
 * (`23505`, `40001`, …); the others are present when PostgreSQL sent them.
 * `hint` is only one Disc's own SQL raises (`RAISE … HINT`), which is Gel's
 * ("Please use ISO8601 format. …"); PostgreSQL's own hints are not Gel's.
 * Undefined when the error did not come from PostgreSQL.
 */
export interface PostgresErrorFields {
  constraint?: string;
  detail?: string;
  hint?: string;
  sqlState: string;
  table?: string;
}

export function postgresErrorFields(error: unknown): PostgresErrorFields | undefined {
  const own = (error as { fields?: unknown; } | undefined)?.fields;
  const fields = own ?? (error as { cause?: { fields?: unknown; }; } | undefined)?.cause?.fields;

  if (!fields || typeof fields !== "object") {
    return undefined;
  }

  const { code, constraint, detail, hint, routine, table } = fields as Record<string, unknown>;
  if (typeof code !== "string") {
    return undefined;
  }

  const out: PostgresErrorFields = { sqlState: code };
  if (typeof constraint === "string") {
    out.constraint = constraint;
  }
  if (typeof table === "string") {
    out.table = table;
  }
  if (typeof detail === "string") {
    out.detail = detail;
  }
  if (typeof hint === "string" && routine === "exec_stmt_raise") {
    out.hint = hint;
  }
  return out;
}

/**
 * PostgreSQL's names of the types Gel's are stored as, and the Gel type each
 * is, in the order of Gel's `base_type_name_map_r` (edb/pgsql/types.py): a
 * name comes before a shorter one it starts with.
 */
const PG_TYPE_GEL_NAMES = new Map<string, string>([
  ["character varying", "std::str"],
  ["character", "std::str"],
  ["text", "std::str"],
  ["numeric", "std::decimal"],
  ["int4", "std::int32"],
  ["integer", "std::int32"],
  ["bigint", "std::int64"],
  ["int8", "std::int64"],
  ["int2", "std::int16"],
  ["smallint", "std::int16"],
  ["boolean", "std::bool"],
  ["bool", "std::bool"],
  ["double precision", "std::float64"],
  ["float8", "std::float64"],
  ["real", "std::float32"],
  ["float4", "std::float32"],
  ["uuid", "std::uuid"],
  ["timestamp with time zone", "std::datetime"],
  ["timestamptz", "std::datetime"],
  ["interval", "std::duration"],
  ["bytea", "std::bytes"],
  ["jsonb", "std::json"],
  ["timestamp", "std::cal::local_datetime"],
  ["date", "std::cal::local_date"],
  ["time", "std::cal::local_time"],
  ["json", "std::pg::json"]
]);

const PG_TYPE_NAME = new RegExp([...PG_TYPE_GEL_NAMES.keys()].map(name => `\\b${name}\\b`).join("|"), "g");

/**
 * The SQLSTATEs of the errors whose message Gel words with its type names
 * (Gel's errormech `interpret_by_code`). Gel sends such an error with its
 * message and hint only, never PostgreSQL's detail.
 */
export const GEL_TYPE_NAMED_SQLSTATES = new Set(["22003", "22007", "22008", "22P02"]);

/*** PostgreSQL's message for a label that is not of the enum: `invalid input value for enum disc_enum_color: "Purple"`. ***/
const ENUM_VALUE_MESSAGE = /^invalid input value for enum "?([^":]+)"?:/;

/**
 * The message of `error` as Gel words it. A value PostgreSQL can't take —
 * `invalid input syntax for type bigint: "x"`, `value "99999" is out of
 * range for type smallint` — names PostgreSQL's types; Gel names its own
 * (`std::int64`, `std::int16`) in each PostgreSQL type name before the first
 * colon (errormech `translate_pgtype`), for an invalid text representation
 * (22P02), a number out of range (22003) or a bad date or time (22007,
 * 22008). An enum is named by its Gel name in `enumNames` (by PostgreSQL
 * type, `enumGelNames`), quoted: `invalid input value for enum
 * 'default::Color': "Purple"`. A message Disc's SQL raises itself (`RAISE`)
 * is Gel's already, and any other message is PostgreSQL's as is.
 */
export function gelErrorMessage(error: Error, enumNames?: ReadonlyMap<string, string>): string {
  const fields = (error as { fields?: { code?: unknown; routine?: unknown; }; }).fields;
  if (typeof fields?.code !== "string" || !GEL_TYPE_NAMED_SQLSTATES.has(fields.code) || fields.routine === "exec_stmt_raise") {
    return error.message;
  }
  const enumType = ENUM_VALUE_MESSAGE.exec(error.message)?.[1];
  const enumName = enumType === undefined ? undefined : enumNames?.get(enumType);
  if (enumName !== undefined) {
    return error.message.replace(ENUM_VALUE_MESSAGE, `invalid input value for enum '${enumName}':`);
  }
  const [leading, ...rest] = error.message.split(":");
  return [leading.replace(PG_TYPE_NAME, name => PG_TYPE_GEL_NAMES.get(name)!), ...rest].join(":");
}

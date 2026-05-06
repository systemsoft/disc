# Error Codes

> **Note:** This file is hand-maintained. When the error hierarchy in
> [`lib/errors.ts`](../lib/errors.ts) or the protocol code map in
> [`protocol/binary-server.ts`](../protocol/binary-server.ts) changes,
> update this document to match. Ports the request in
> [geldata/gel#6648](https://github.com/geldata/gel/issues/6648).

Disc surfaces errors in two layers:

1. **Disc error classes** — TypeScript subclasses of `DiscError` raised
   by the parser, compiler, runtime, and protocol layers. These are
   what your code catches when calling Disc as a library.
2. **Gel wire protocol error codes** — 32-bit numeric codes returned to
   clients over the binary protocol. Disc maps each error class to one
   of these codes for compatibility with the existing Gel client SDKs.

When you receive an error from a Disc client SDK, the `code` field is a
protocol code (column 2 below); the `name` field corresponds to a Disc
error class (column 1).

---

## Table of Contents

- [Disc Error Classes](#disc-error-classes)
- [Gel Protocol Error Codes](#gel-protocol-error-codes)
- [Class → Protocol Code Mapping](#class--protocol-code-mapping)

---

## Disc Error Classes

All errors inherit from the abstract base class `DiscError`. Every error
carries an optional `ErrorContext` (source snippet, source location,
hint) and renders a fully-formatted multi-line message via
`formatError()`.

| Class                    | Description                                                                                                                                                                                                                           | Notes                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `DiscError` (abstract)   | Base class for every Disc error. Holds `context: { source?, location?, hint? }` and provides `formatError()`.                                                                                                                         | Never thrown directly.                                                                                  |
| `SyntaxError`            | Parse-time syntax error — produced by the SDL or EdgeQL lexers/parsers when the input is structurally invalid.                                                                                                                        | Always carries `location`.                                                                              |
| `SchemaError`            | Schema validation error — references a type/link/constraint that doesn't exist or violates schema rules.                                                                                                                              | Raised during schema validation and migration.                                                          |
| `QueryError`             | EdgeQL semantic error — path resolution, type inference, or shape construction failure.                                                                                                                                               | The general-purpose query error.                                                                        |
| `CompilationError`       | EdgeQL → SQL compilation failure that isn't a user-facing schema or syntax problem.                                                                                                                                                   | Internal-ish; usually surfaces during query planning.                                                   |
| `ValidationError`        | Value-level validation failure (e.g. constraint, type cast).                                                                                                                                                                          | Maps to `InvalidValueError` on the wire.                                                                |
| `InternalError`          | A bug in Disc itself. The constructor automatically appends `(this is a bug — please file an issue at https://github.com/systemsoft/disc/issues)` to the message. The append is idempotent: re-wrapping doesn't duplicate the suffix. | Ports geldata/gel#930.                                                                                  |
| `ConnectionError`        | Failed to reach PostgreSQL, or the connection was lost mid-query.                                                                                                                                                                     | Maps to `AvailabilityError`.                                                                            |
| `MigrationError`         | Migration generation or application failure.                                                                                                                                                                                          | Carries the offending DDL when available.                                                               |
| `DatabaseRegistryError`  | A registry-level failure: branch not found, branch already exists, registry corrupted.                                                                                                                                                | Always non-recoverable — no automatic retry.                                                            |
| `DatabaseExecutionError` | A PostgreSQL error wrapped with the originating SQL. Has fields `sql: string` and `cause: Error`.                                                                                                                                     | The `cause.message` substring (`constraint`, `cardinality`) determines which protocol code is returned. |
| `QueryTimeoutError`      | Query exceeded its configured timeout. Has fields `sql: string` and `timeoutMs: number`. Message is always `"Query timed out after Nms"`.                                                                                             | Maps to `AvailabilityError`.                                                                            |

---

## Gel Protocol Error Codes

These are the 32-bit codes Disc returns to binary-protocol clients. They
match the Gel codes one-for-one so existing Gel SDKs work unchanged.
Defined in [`protocol/binary-server.ts`](../protocol/binary-server.ts)
as `GEL_ERROR_CODES`.

The high byte is the family; subsequent bytes narrow within the family.

### Server / protocol

| Code     | Hex          | Name                  |
| -------- | ------------ | --------------------- |
| 16777216 | `0x01000000` | `InternalServerError` |
| 50331648 | `0x03000000` | `ProtocolError`       |

### Query

| Code     | Hex          | Name                               |
| -------- | ------------ | ---------------------------------- |
| 67108864 | `0x04000000` | `QueryError`                       |
| 67174400 | `0x04010000` | `InvalidSyntaxError`               |
| 67174656 | `0x04010100` | `EdgeQLSyntaxError`                |
| 67174912 | `0x04010200` | `SchemaSyntaxError`                |
| 67239936 | `0x04020000` | `SchemaDefinitionError`            |
| 67240192 | `0x04020100` | `InvalidTypeError`                 |
| 67240448 | `0x04020200` | `InvalidTargetError`               |
| 67240449 | `0x04020201` | `InvalidLinkTargetError`           |
| 67305472 | `0x04030000` | `InvalidReferenceError`            |
| 67305728 | `0x04030100` | `UnknownModuleError`               |
| 67371008 | `0x04040000` | `InvalidConstraintDefinitionError` |

### Value / integrity

| Code     | Hex          | Name                        |
| -------- | ------------ | --------------------------- |
| 83951616 | `0x05010000` | `InvalidValueError`         |
| 83951617 | `0x05010001` | `DivisionByZeroError`       |
| 84082688 | `0x05030000` | `IntegrityError`            |
| 84082944 | `0x05030100` | `ConstraintViolationError`  |
| 84083200 | `0x05030200` | `CardinalityViolationError` |
| 84083456 | `0x05030300` | `MissingRequiredError`      |

### Auth, availability, access

| Code      | Hex          | Name                  |
| --------- | ------------ | --------------------- |
| 100663296 | `0x06000000` | `AuthenticationError` |
| 117440512 | `0x07000000` | `AvailabilityError`   |
| 134217728 | `0x08000000` | `AccessError`         |
| 134217984 | `0x08000100` | `AccessPolicyError`   |

---

## Class → Protocol Code Mapping

Performed by `mapErrorToGelCode()` in
[`protocol/binary-server.ts`](../protocol/binary-server.ts):

| Disc class                                                  | Gel code                                   |
| ----------------------------------------------------------- | ------------------------------------------ |
| `SyntaxError`                                               | `EdgeQLSyntaxError` (`0x04010100`)         |
| `SchemaError`                                               | `SchemaDefinitionError` (`0x04020000`)     |
| `CompilationError`                                          | `QueryError` (`0x04000000`)                |
| `QueryError`                                                | `QueryError` (`0x04000000`)                |
| `ValidationError`                                           | `InvalidValueError` (`0x05010000`)         |
| `DatabaseExecutionError` (message contains `"constraint"`)  | `ConstraintViolationError` (`0x05030100`)  |
| `DatabaseExecutionError` (message contains `"cardinality"`) | `CardinalityViolationError` (`0x05030200`) |
| `DatabaseExecutionError` (other)                            | `IntegrityError` (`0x05030000`)            |
| `QueryTimeoutError`                                         | `AvailabilityError` (`0x07000000`)         |
| `ConnectionError`                                           | `AvailabilityError` (`0x07000000`)         |
| `InternalError`                                             | `InternalServerError` (`0x01000000`)       |
| _Anything else_                                             | `InternalServerError` (`0x01000000`)       |

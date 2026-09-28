/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for the `lib/errors.ts` error hierarchy.
 *
 * Currently covers the file-an-issue hint that `InternalError` appends
 * to every message (ports geldata/gel#930).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  gelErrorMessage,
  INTERNAL_ERROR_ISSUE_URL,
  InternalError,
  QueryError
} from "./errors.ts";

Deno.test("InternalError appends file-an-issue hint to message", () => {
  const err = new InternalError("something broke");
  assertStringIncludes(err.message, "something broke");
  assertStringIncludes(err.message, "this is a bug");
  assertStringIncludes(err.message, "please file an issue at");
  assertStringIncludes(err.message, INTERNAL_ERROR_ISSUE_URL);
});

Deno.test("InternalError hint URL points to systemsoft/disc issues", () => {
  assertEquals(
    INTERNAL_ERROR_ISSUE_URL,
    "https://github.com/systemsoft/disc/issues"
  );
});

Deno.test("InternalError hint append is idempotent across re-wrapping", () => {
  const inner = new InternalError("bottom of the stack");
  const wrapped = new InternalError(inner.message);
  // The marker should appear exactly once even though we constructed
  // a second InternalError from the first one's message.
  const matches = wrapped.message.match(/please file an issue at/g);
  assertEquals(matches?.length, 1);
});

Deno.test("InternalError still inherits DiscError formatting", () => {
  const err = new InternalError("bad state", {
    location: { line: 3, column: 5, offset: 0, file: "x.esdl" }
  });
  const formatted = err.formatError();
  assertStringIncludes(formatted, "InternalError: bad state");
  assertStringIncludes(formatted, "please file an issue at");
  assertStringIncludes(formatted, "x.esdl:3:5");
});

Deno.test("Other DiscError subclasses do NOT get the issue hint", () => {
  const q = new QueryError("invalid path");
  assertEquals(q.message, "invalid path");
  assertEquals(q.message.includes("please file an issue"), false);
});

/*** A PostgreSQL error as the driver raises it: its fields, with the SQLSTATE in `code`. ***/
function pgError(message: string, code: string, routine = "scanint8"): Error {
  return Object.assign(new Error(message), { fields: { code, message, routine } });
}

Deno.test("gelErrorMessage names Gel's types before the first colon, as Gel's translate_pgtype does", () => {
  assertEquals(gelErrorMessage(pgError(`invalid input syntax for type bigint: "bigint"`, "22P02")), `invalid input syntax for type std::int64: "bigint"`);
  assertEquals(gelErrorMessage(pgError(`invalid input syntax for type double precision: "x"`, "22P02")), `invalid input syntax for type std::float64: "x"`);
  assertEquals(gelErrorMessage(pgError(`value "99999" is out of range for type smallint`, "22003")), `value "99999" is out of range for type std::int16`);
  assertEquals(gelErrorMessage(pgError("bigint out of range", "22003")), "std::int64 out of range");
  assertEquals(
    gelErrorMessage(pgError(`invalid input syntax for type timestamp with time zone: "x"`, "22007")),
    `invalid input syntax for type std::datetime: "x"`
  );
  assertEquals(
    gelErrorMessage(pgError(`date/time field value out of range: "2024-13-01"`, "22008")),
    `std::cal::local_date/std::cal::local_time field value out of range: "2024-13-01"`
  );
});

Deno.test("gelErrorMessage keeps other messages: another SQLSTATE, Disc's own RAISE, no PostgreSQL error", () => {
  assertEquals(gelErrorMessage(pgError(`column "date" does not exist`, "42703")), `column "date" does not exist`);
  assertEquals(
    gelErrorMessage(pgError("missing required time zone in format: 'HH24'", "22007", "exec_stmt_raise")),
    "missing required time zone in format: 'HH24'"
  );
  assertEquals(gelErrorMessage(new Error("invalid input syntax for type bigint: 1")), "invalid input syntax for type bigint: 1");
});

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

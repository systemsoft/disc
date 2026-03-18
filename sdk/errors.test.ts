import {
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "@std/assert";

import {
  DiscAuthError,
  DiscClientError,
  DiscConnectionError,
  DiscErrorCode,
  DiscNetworkError,
  DiscProtocolError,
  DiscQueryError,
  DiscServerError,
  DiscTimeoutError,
  DiscTransactionError,
} from "./errors.ts";

Deno.test("errors - DiscClientError base", () => {
  const err = new DiscClientError("test", DiscErrorCode.QUERY_ERROR);
  assertEquals(err.name, "DiscClientError");
  assertEquals(err.code, DiscErrorCode.QUERY_ERROR);
  assertEquals(err.message, "test");
  assertInstanceOf(err, Error);
});

Deno.test("errors - DiscQueryError single error", () => {
  const err = new DiscQueryError([{ message: "Syntax error at line 1" }]);
  assertEquals(err.name, "DiscQueryError");
  assertEquals(err.code, DiscErrorCode.QUERY_ERROR);
  assertEquals(err.errors.length, 1);
  assertEquals(err.message, "Syntax error at line 1");
  assertInstanceOf(err, DiscClientError);
});

Deno.test("errors - DiscQueryError multiple errors", () => {
  const err = new DiscQueryError([
    { message: "Error A" },
    { message: "Error B" },
  ]);
  assertStringIncludes(err.message, "2 query errors");
  assertStringIncludes(err.message, "Error A");
  assertEquals(err.errors.length, 2);
});

Deno.test("errors - DiscQueryError preserves locations and path", () => {
  const err = new DiscQueryError([{
    message: "Bad field",
    locations: [{ line: 3, column: 7 }],
    path: ["users", 0],
    extensions: { code: "UNKNOWN_FIELD" },
  }]);
  assertEquals(err.errors[0].locations?.[0].line, 3);
  assertEquals(err.errors[0].path?.[1], 0);
});

Deno.test("errors - DiscNetworkError with cause", () => {
  const cause = new TypeError("fetch failed");
  const err = new DiscNetworkError("Network failure", cause);
  assertEquals(err.name, "DiscNetworkError");
  assertEquals(err.code, DiscErrorCode.NETWORK_ERROR);
  assertEquals(err.cause, cause);
});

Deno.test("errors - DiscNetworkError without cause", () => {
  const err = new DiscNetworkError("Connection reset");
  assertEquals(err.cause, undefined);
});

Deno.test("errors - DiscTimeoutError", () => {
  const err = new DiscTimeoutError(5000);
  assertEquals(err.name, "DiscTimeoutError");
  assertEquals(err.code, DiscErrorCode.TIMEOUT);
  assertEquals(err.timeoutMs, 5000);
  assertStringIncludes(err.message, "5000ms");
});

Deno.test("errors - DiscAuthError default status", () => {
  const err = new DiscAuthError("Invalid token");
  assertEquals(err.name, "DiscAuthError");
  assertEquals(err.code, DiscErrorCode.AUTH_ERROR);
  assertEquals(err.statusCode, 401);
});

Deno.test("errors - DiscAuthError custom status", () => {
  const err = new DiscAuthError("Forbidden", 403);
  assertEquals(err.statusCode, 403);
});

Deno.test("errors - DiscConnectionError", () => {
  const cause = new Error("ECONNREFUSED");
  const err = new DiscConnectionError("Server unreachable", cause);
  assertEquals(err.name, "DiscConnectionError");
  assertEquals(err.code, DiscErrorCode.CONNECTION_ERROR);
  assertEquals(err.cause, cause);
});

Deno.test("errors - DiscTransactionError", () => {
  const err = new DiscTransactionError("Transaction already committed");
  assertEquals(err.name, "DiscTransactionError");
  assertEquals(err.code, DiscErrorCode.TRANSACTION_ERROR);
});

Deno.test("errors - DiscProtocolError", () => {
  const err = new DiscProtocolError("Unexpected response format", 502);
  assertEquals(err.name, "DiscProtocolError");
  assertEquals(err.code, DiscErrorCode.PROTOCOL_ERROR);
  assertEquals(err.statusCode, 502);
});

Deno.test("errors - DiscServerError", () => {
  const err = new DiscServerError("Internal server error", 500);
  assertEquals(err.name, "DiscServerError");
  assertEquals(err.code, DiscErrorCode.SERVER_ERROR);
  assertEquals(err.statusCode, 500);
});

Deno.test("errors - inheritance chain", () => {
  const err = new DiscQueryError([{ message: "test" }]);
  assertInstanceOf(err, DiscQueryError);
  assertInstanceOf(err, DiscClientError);
  assertInstanceOf(err, Error);
});

Deno.test("errors - DiscErrorCode enum values", () => {
  assertEquals(DiscErrorCode.QUERY_ERROR, "QUERY_ERROR");
  assertEquals(DiscErrorCode.NETWORK_ERROR, "NETWORK_ERROR");
  assertEquals(DiscErrorCode.TIMEOUT, "TIMEOUT");
  assertEquals(DiscErrorCode.AUTH_ERROR, "AUTH_ERROR");
  assertEquals(DiscErrorCode.CONNECTION_ERROR, "CONNECTION_ERROR");
  assertEquals(DiscErrorCode.TRANSACTION_ERROR, "TRANSACTION_ERROR");
  assertEquals(DiscErrorCode.PROTOCOL_ERROR, "PROTOCOL_ERROR");
  assertEquals(DiscErrorCode.SERVER_ERROR, "SERVER_ERROR");
});

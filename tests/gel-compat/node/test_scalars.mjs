/**
 * Scalar codec roundtrip tests + Cardinality.AT_MOST_ONE behaviour.
 *
 * Covers `SELECT <T>$x` roundtrips for the scalar codecs in
 * `protocol/scalar-codecs.ts`, plus the AT_MOST_ONE cardinality contract
 * where `querySingle` on an empty filter must return null rather than
 * throwing. Originally introduced with `{ skip: GAP_6 }` while disc's
 * typedesc/Data builder always emitted an Object shape; closed once
 * `buildDescriptors` started emitting CTYPE_BASE_SCALAR for bare-scalar
 * top-level SELECT expressions.
 */

import { createClient, InvalidArgumentError, InvalidValueError, QueryError } from "gel";
import assert from "node:assert/strict";
import { after, test } from "node:test";

const host = process.env.DISC_HOST ?? "127.0.0.1";
const port = parseInt(process.env.DISC_BINARY_PORT ?? "5656", 10);

const client = createClient({
  host,
  port,
  user: "disc",
  database: "main",
  tlsSecurity: "insecure"
});

after(async () => {
  await client.close();
});

test("str roundtrip", async () => {
  const out = await client.querySingle("SELECT <str>$x", { x: "hello-world" });
  assert.equal(out, "hello-world");
});

test("int32 roundtrip", async () => {
  const out = await client.querySingle("SELECT <int32>$x", { x: 2147483647 });
  assert.equal(out, 2147483647);
});

test("int64 roundtrip", async () => {
  // The upstream JS gel client's Int64Codec.encode rejects BigInt and
  // expects a `number` — values larger than 2^53 are out of range. Use
  // a value below MAX_SAFE_INTEGER so the codec accepts it; testing
  // BigInt-shaped int64 belongs in a `<bigint>$x` test, not `<int64>$x`.
  const value = 9007199254740991; // Number.MAX_SAFE_INTEGER
  const out = await client.querySingle("SELECT <int64>$x", { x: value });
  assert.equal(out, value);
});

test("bool roundtrip (true)", async () => {
  const out = await client.querySingle("SELECT <bool>$x", { x: true });
  assert.equal(out, true);
});

test("bool roundtrip (false)", async () => {
  const out = await client.querySingle("SELECT <bool>$x", { x: false });
  assert.equal(out, false);
});

test("float64 roundtrip", async () => {
  const out = await client.querySingle("SELECT <float64>$x", {
    x: 3.141592653589793
  });
  assert.ok(Math.abs(out - 3.141592653589793) < 1e-12);
});

test("uuid roundtrip", async () => {
  const u = "11111111-2222-3333-4444-555555555555";
  const out = await client.querySingle("SELECT <uuid>$x", { x: u });
  assert.equal(String(out).toLowerCase(), u);
});

test("datetime roundtrip", async () => {
  const when = new Date("2026-05-04T12:34:56.000Z");
  const out = await client.querySingle("SELECT <datetime>$x", { x: when });
  assert.equal(new Date(out).toISOString(), when.toISOString());
});

test("an invalid cast raises InvalidValueError naming Gel's type", async () => {
  await assert.rejects(
    client.querySingle("SELECT <int64>'x'"),
    error => error instanceof InvalidValueError && error.message.split("\n")[0] === "invalid input syntax for type std::int64: \"x\""
  );
});

// Gel 7.1's message and hint for a str it can't read as each type.
const DATETIME_HINT = "Please use ISO8601 format. Example: 2010-12-27T23:59:59-07:00. " +
  "Alternatively \"to_datetime\" function provides custom formatting options.";

test("a str that is no ISO 8601 datetime raises InvalidValueError with Gel's hint", async () => {
  await assert.rejects(
    client.querySingle("SELECT <datetime>'2024-01-01T00:00'"),
    error =>
      error instanceof InvalidValueError &&
      error.message.split("\n")[0] === "invalid input syntax for type std::datetime: '2024-01-01T00:00'" &&
      error.message.includes(`Hint: ${DATETIME_HINT}`)
  );
  await assert.rejects(
    client.querySingle("SELECT <duration>'1 month'"),
    error => error instanceof InvalidValueError && error.message.includes("Hint: Day, month and year units cannot be used for std::duration.")
  );
});

test("bool, enum and bytes casts of a str fail as Gel's do", async () => {
  await assert.rejects(
    client.querySingle("SELECT <bool>'t'"),
    error => error instanceof InvalidValueError && error.message.split("\n")[0] === "invalid input syntax for type std::bool: 't'"
  );
  await assert.rejects(
    client.querySingle("SELECT <Color>'Purple'"),
    error => error instanceof InvalidValueError && error.message.split("\n")[0] === "invalid input value for enum 'default::Color': \"Purple\""
  );
  await assert.rejects(
    client.querySingle("SELECT <bytes>'x'"),
    error => error instanceof QueryError && error.message.split("\n")[0] === "cannot cast 'std::str' to 'std::bytes'"
  );
});

test("gel-js does not encode an array of arrays argument, against Gel as here", async () => {
  await assert.rejects(
    client.querySingle("SELECT <array<array<int64>>>$p", { p: [[1, 2], [3]] }),
    error => error instanceof InvalidArgumentError && error.message.startsWith("only arrays of scalars or tuples are supported")
  );
});

test("Cardinality.AT_MOST_ONE: querySingle on empty filter returns null", async () => {
  const out = await client.querySingle(
    "SELECT Item FILTER .id = <uuid>$id",
    { id: "00000000-0000-0000-0000-000000000000" }
  );
  assert.equal(out, null);
});

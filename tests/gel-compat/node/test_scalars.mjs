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

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "gel";

const host = process.env.DISC_HOST ?? "127.0.0.1";
const port = parseInt(process.env.DISC_BINARY_PORT ?? "5656", 10);

const client = createClient({
  host,
  port,
  user: "disc",
  database: "main",
  tlsSecurity: "insecure",
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
    x: 3.141592653589793,
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

test("Cardinality.AT_MOST_ONE: querySingle on empty filter returns null", async () => {
  const out = await client.querySingle(
    "SELECT Item FILTER .id = <uuid>$id",
    { id: "00000000-0000-0000-0000-000000000000" },
  );
  assert.equal(out, null);
});

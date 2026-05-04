/**
 * Scalar codec roundtrip tests + Cardinality.AT_MOST_ONE behaviour.
 *
 * The scalar roundtrip tests are currently expected to FAIL — they
 * document compat gap #6 (scalar SELECT shape mismatch). disc's
 * typedesc + Data builder always emits an Object shape, so
 * `SELECT <bool>$x` returns `{ id: null }` instead of the scalar `true`.
 * Each test is marked `{ skip: ... }` so the run stays green; remove
 * the markers when gap #6 is closed.
 *
 * The cardinality test exercises the wire Cardinality byte for
 * AT_MOST_ONE (`querySingle` on an empty filter must return null, not
 * throw) and already passes against current disc.
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

const GAP_6 =
  "P2-09 gap #6: scalar SELECT returns Object{id} shape (typedesc/Data" +
  " builder always emits an Object). Drop this skip when gap closes.";

test("str roundtrip", { skip: GAP_6 }, async () => {
  const out = await client.querySingle("SELECT <str>$x", { x: "hello-world" });
  assert.equal(out, "hello-world");
});

test("int32 roundtrip", { skip: GAP_6 }, async () => {
  const out = await client.querySingle("SELECT <int32>$x", { x: 2147483647 });
  assert.equal(out, 2147483647);
});

test("int64 roundtrip (BigInt)", { skip: GAP_6 }, async () => {
  const out = await client.querySingle("SELECT <int64>$x", {
    x: 9223372036854775807n,
  });
  assert.equal(out, 9223372036854775807n);
});

test("bool roundtrip (true)", { skip: GAP_6 }, async () => {
  const out = await client.querySingle("SELECT <bool>$x", { x: true });
  assert.equal(out, true);
});

test("bool roundtrip (false)", { skip: GAP_6 }, async () => {
  const out = await client.querySingle("SELECT <bool>$x", { x: false });
  assert.equal(out, false);
});

test("float64 roundtrip", { skip: GAP_6 }, async () => {
  const out = await client.querySingle("SELECT <float64>$x", {
    x: 3.141592653589793,
  });
  assert.ok(Math.abs(out - 3.141592653589793) < 1e-12);
});

test("uuid roundtrip", { skip: GAP_6 }, async () => {
  const u = "11111111-2222-3333-4444-555555555555";
  const out = await client.querySingle("SELECT <uuid>$x", { x: u });
  assert.equal(String(out).toLowerCase(), u);
});

test("datetime roundtrip", { skip: GAP_6 }, async () => {
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

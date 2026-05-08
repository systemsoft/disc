/**
 * Compatibility smoke tests: upstream `gel` JS client against `disc serve`.
 *
 * Validates that disc's Gel binary wire protocol implementation accepts a
 * real client through the full handshake → query loop. Mirrors the Python
 * suite at tests/gel-compat/python/test_crud.py.
 *
 * The disc server must already be running on the host:port given by
 * DISC_HOST / DISC_BINARY_PORT (defaults: 127.0.0.1:5656). The runner
 * script at tests/gel-compat/run.sh handles that.
 */

import { createClient } from "gel";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

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

const insertItem = (name, count) =>
  client.querySingle(
    "INSERT Item { name := <str>$name, count := <int32>$count }",
    { name, count }
  );

test("INSERT returns an object with a uuid id", async () => {
  const item = await insertItem("alpha", 1);
  assert.ok(item);
  assert.ok(item.id);
  // Throws if not a valid uuid string
  assert.match(
    String(item.id),
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  );
});

test("SELECT { shape } FILTER .id roundtrips", async () => {
  const inserted = await insertItem("bravo", 2);
  const fetched = await client.querySingle(
    "SELECT Item { id, name, count } FILTER .id = <uuid>$id",
    { id: inserted.id }
  );
  assert.equal(fetched.name, "bravo");
  assert.equal(fetched.count, 2);
});

test("UPDATE then re-select reflects new value", async () => {
  const inserted = await insertItem("charlie", 3);
  await client.query(
    "UPDATE Item FILTER .id = <uuid>$id SET { count := <int32>$new }",
    { id: inserted.id, new: 99 }
  );
  const fetched = await client.querySingle(
    "SELECT Item { count } FILTER .id = <uuid>$id",
    { id: inserted.id }
  );
  assert.equal(fetched.count, 99);
});

test("SELECT (multi-row) returns at least the inserted set", async () => {
  const rows = await client.query("SELECT Item { id, name, count }");
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length >= 3);
});

test("DELETE removes the row", async () => {
  const inserted = await insertItem("delta", 4);
  await client.query(
    "DELETE Item FILTER .id = <uuid>$id",
    { id: inserted.id }
  );
  const fetched = await client.query(
    "SELECT Item { id } FILTER .id = <uuid>$id",
    { id: inserted.id }
  );
  assert.equal(fetched.length, 0);
});

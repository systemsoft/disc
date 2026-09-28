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

import { ConstraintViolationError, createClient, NoDataError, ResultCardinalityMismatchError } from "gel";
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

test("SELECT of a set literal returns one element per member", async () => {
  assert.deepEqual(await client.query("SELECT {1, 2, 2}"), [1, 2, 2]);
  assert.deepEqual(await client.query("SELECT {<str>$a, <str>$b}", { a: "x", b: "y" }), ["x", "y"]);
});

test("WITH … SELECT Type { shape } is described like the query without WITH", async () => {
  const name = `echo-${Date.now()}`;
  await insertItem(name, 5);
  const filtered = await client.query(
    "WITH n := <str>$n SELECT Item { name, count } FILTER .name = n",
    { n: name }
  );
  assert.deepEqual(filtered.map(r => [r.name, r.count]), [[name, 5]]);
  const aliased = await client.query(
    "WITH i := (SELECT Item FILTER .name = <str>$n) SELECT i { name }",
    { n: name }
  );
  assert.deepEqual(aliased.map(r => r.name), [name]);
});

test("querySingle of a scalar literal returns the value", async () => {
  assert.equal(await client.querySingle("SELECT 42"), 42);
});

test("count() is an int64", async () => {
  const total = await client.querySingle("SELECT count(Item)");
  assert.equal(typeof total, "number");
  assert.equal(total, (await client.query("SELECT Item")).length);
});

test("a path select returns the property's values", async () => {
  const name = `path-${Date.now()}`;
  await insertItem(name, 6);
  const names = await client.query("SELECT Item.name");
  assert.ok(names.every(n => typeof n === "string"));
  assert.ok(names.includes(name));
});

test("arrays decode as arrays", async () => {
  assert.deepEqual(await client.querySingle("SELECT [1, 2]"), [1, 2]);
  assert.deepEqual(await client.querySingle("SELECT <array<str>>$tags", { tags: ["a", "b"] }), ["a", "b"]);
  assert.deepEqual(await client.querySingle("SELECT array_agg({1, 2})"), [1, 2]);
});

test("tuples and named tuples decode as tuples", async () => {
  assert.deepEqual([...(await client.querySingle("SELECT (1, 'a')"))], [1, "a"]);
  const named = await client.querySingle("SELECT (a := 1, b := 'x')");
  assert.deepEqual([named.a, named.b], [1, "x"]);
  const pairs = await client.query("SELECT enumerate({'x', 'y'})");
  assert.deepEqual(pairs.map(pair => [...pair]), [[0, "x"], [1, "y"]]);
});

test("queryJSON returns the result as a JSON array", async () => {
  const name = `json-${Date.now()}-${Math.random()}`;
  await insertItem(name, 7);
  const text = await client.queryJSON(
    "SELECT Item { name, count } FILTER .name = <str>$name",
    { name }
  );
  assert.deepEqual(JSON.parse(text), [{ name, count: 7 }]);
  assert.equal(await client.queryJSON("SELECT Item { name } FILTER .name = 'nobody'"), "[]");
});

test("querySingleJSON returns one object, or null", async () => {
  const name = `json1-${Date.now()}-${Math.random()}`;
  await insertItem(name, 8);
  const one = "SELECT Item { name, count } FILTER .name = <str>$name LIMIT 1";
  assert.deepEqual(JSON.parse(await client.querySingleJSON(one, { name })), { name, count: 8 });
  assert.deepEqual(JSON.parse(await client.queryRequiredSingleJSON(one, { name })), { name, count: 8 });
  assert.equal(await client.querySingleJSON(one, { name: "nobody" }), "null");
});

test("group returns key, grouping and elements", async () => {
  const count = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);
  const names = [`grp-${Date.now()}-a`, `grp-${Date.now()}-b`];
  for (const name of names) {
    await insertItem(name, count);
  }
  const groups = await client.query("GROUP Item { name } BY .count");
  const [group] = groups.filter(g => g.key.count === count);
  assert.deepEqual(group.grouping, ["count"]);
  assert.deepEqual(group.elements.map(e => e.name).sort(), names);
});

test("nested shapes follow multi and single links", async () => {
  const [a, b] = [`book-${Date.now()}-a`, `book-${Date.now()}-b`];
  await client.query("INSERT Book { title := <str>$t, tags := {'x', 'y'} }", { t: a });
  await client.query("INSERT Book { title := <str>$t }", { t: b });
  const name = `author-${Date.now()}-${Math.random()}`;
  await client.query(
    `INSERT Author {
      name := <str>$name,
      books := (SELECT Book FILTER .title = <str>$a OR .title = <str>$b),
      best := (SELECT Book FILTER .title = <str>$a LIMIT 1)
    }`,
    { name, a, b }
  );
  const author = await client.querySingle(
    "SELECT Author { name, books: { title, tags }, best: { title } } FILTER .name = <str>$name",
    { name }
  );
  const books = [...author.books].sort((x, y) => x.title.localeCompare(y.title));
  assert.deepEqual(books.map(book => [book.title, [...book.tags].sort()]), [[a, ["x", "y"]], [b, []]]);
  assert.equal(author.best.title, a);

  // A link without a sub-shape is its objects' ids.
  const bare = await client.querySingle("SELECT Author { books, best } FILTER .name = <str>$name", { name });
  const best = await client.querySingle("SELECT Book { id } FILTER .title = <str>$a", { a });
  assert.equal(bare.best.id, best.id);
  assert.equal(bare.books.length, 2);
  assert.ok(bare.books.some(book => book.id === best.id));

  const nested = JSON.parse(
    await client.queryJSON(
      "SELECT Author { name, books: { title } } FILTER .name = <str>$name",
      { name }
    )
  );
  assert.deepEqual(nested[0].books.map(book => book.title).sort(), [a, b]);
});

test("an exclusive violation raises ConstraintViolationError", async () => {
  const code = `label-${Date.now()}-${Math.random()}`;
  await client.query("INSERT Label { code := <str>$code }", { code });
  await assert.rejects(
    client.query("INSERT Label { code := <str>$code }", { code }),
    ConstraintViolationError
  );
});

test("a shape without elements is its implicit id; the others have none", async () => {
  const inserted = await insertItem(`implicit-${Date.now()}`, 9);
  const bare = await client.querySingle("SELECT Item FILTER .id = <uuid>$id", { id: inserted.id });
  assert.deepEqual({ ...bare }, { id: inserted.id });
  const named = await client.querySingle("SELECT Item { name } FILTER .id = <uuid>$id", { id: inserted.id });
  assert.deepEqual(Object.keys(named), ["name"]);
});

test("link properties, splats and object group keys", async () => {
  const title = `member-${Date.now()}-${Math.random()}`;
  await client.query("INSERT Book { title := <str>$t }", { t: title });
  const team = await client.querySingle(
    `INSERT Team {
       name := <str>$name,
       members := (SELECT Book FILTER .title = <str>$t) { @role := 'lead' }
     }`,
    { name: `team-${Date.now()}`, t: title }
  );
  const fetched = await client.querySingle(
    "SELECT Team { members: { title, @role } } FILTER .id = <uuid>$id",
    { id: team.id }
  );
  assert.deepEqual(fetched.members.map(m => ({ ...m })), [{ title, "@role": "lead" }]);

  const splat = await client.querySingle("SELECT Book { * } FILTER .title = <str>$t", { t: title });
  assert.equal(splat.title, title);
  assert.deepEqual([...splat.tags], []);
  assert.ok(splat.id);

  await client.query(
    "INSERT Author { name := <str>$n, best := (SELECT Book FILTER .title = <str>$t LIMIT 1) }",
    { n: `keyed-${Date.now()}`, t: title }
  );
  const groups = await client.query("GROUP Author { name } USING b := .best BY b");
  assert.ok(groups.some(g => g.key.b && g.key.b.id));
});

test("execute runs without a result", async () => {
  assert.equal(await client.execute("UPDATE Item FILTER .name = 'nobody' SET { count := 0 }"), undefined);
});

test("single results of many elements raise ResultCardinalityMismatchError", async () => {
  await insertItem(`many-one-${Date.now()}`, 10);
  await insertItem(`many-two-${Date.now()}`, 10);
  await assert.rejects(client.querySingle("SELECT Item { name }"), ResultCardinalityMismatchError);
  await assert.rejects(client.querySingleJSON("SELECT Item { name }"), ResultCardinalityMismatchError);
  await assert.rejects(client.querySingle("SELECT {1, 2}"), ResultCardinalityMismatchError);
  await assert.rejects(
    client.queryRequiredSingle("SELECT Item { name } FILTER .name = 'nobody' LIMIT 1"),
    NoDataError
  );
});

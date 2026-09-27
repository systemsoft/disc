/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Binary-protocol output descriptions and values beyond flat shapes, as Gel
 * sends them (edb/server/compiler/sertypes.py, edb/server/compiler/compiler.py):
 *
 * - A link in a shape is a nested object shape (`{id}` without a sub-shape),
 *   and a multi link, multi property or computed set is a SET of its element
 *   type, encoded in Gel's array format.
 * - `group` answers free objects `{key, grouping, elements}`: `key` a free
 *   object of the key names, `grouping` a set of str, `elements` a set of the
 *   element shape.
 * - JSON output (`queryJSON`, `querySingleJSON`) is described as one
 *   `std::str` whatever the query, and sent as JSON text: the whole result as
 *   one array, or with an expected cardinality of one each object on its
 *   own; JSON_ELEMENTS sends one JSON value per element.
 *
 * The server runs against a stub executor answering the rows Disc's
 * executor produces for each query; tests/binary-protocol-client.ts decodes
 * the descriptors and values.
 */

import { assertEquals } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { Client, type Answer, type Described, type QueryOptions } from "../tests/binary-protocol-client.ts";
import { BinaryProtocolServer } from "./binary-server.ts";
import { Cardinality, OutputFormat } from "./enums.ts";

const property = (edgeqlType: string, required = false, multi = false) => ({ edgeqlType, multi, required, type: edgeqlType });

const schema = {
  scalars: new Map(),
  types: new Map([
    ["Author", {
      kind: "object",
      links: new Map([
        ["best", { multi: false, required: false, target: "Book" }],
        ["books", { multi: true, required: false, target: "Book" }]
      ]),
      properties: new Map([["id", property("uuid", true)], ["name", property("str", true)]])
    }],
    ["Book", {
      kind: "object",
      links: new Map(),
      properties: new Map([["id", property("uuid", true)], ["tags", property("str", false, true)], ["title", property("str", true)]])
    }]
  ])
} as unknown as Schema;

const ANN = "01a0e505-981b-7ae7-9e8e-34682b149a1d";
const B1 = "01a0e505-9816-7063-8257-cf611f47951b";
const B2 = "01a0e505-9818-75dd-8cd6-f0ed52e8a827";

/*** The rows Disc's executor answers for each query (single links with a sub-shape as one-element arrays). ***/
const ROWS: Record<string, Record<string, unknown>[]> = {
  "group Book by .title": [
    { elements: [{ id: B1, tags: ["x", "y"], title: "b1" }], grouping: ["title"], key: { title: "b1" } }
  ],
  "group Book { title } by .title": [
    { elements: [{ title: "b1" }], grouping: ["title"], key: { title: "b1" } },
    { elements: [{ title: "b2" }], grouping: ["title"], key: { title: "b2" } }
  ],
  "group Book { title } using n := len(.title) by n": [
    { elements: [{ title: "b1" }, { title: "b2" }], grouping: ["n"], key: { n: 2 } }
  ],
  "select Author { books, best }": [
    { best: B1, books: [B1, B2] },
    { best: null, books: [] }
  ],
  "select Author { name, books: { title, tags }, best: { title } }": [
    { best: [{ title: "b1" }], books: [{ tags: ["x", "y"], title: "b1" }, { tags: [], title: "b2" }], name: "ann" },
    { best: null, books: [], name: "bob" }
  ],
  "select Author { name, n := count(.books), titles := .books.title }": [
    { n: 2, name: "ann", titles: ["b1", "b2"] },
    { n: 0, name: "bob", titles: [] }
  ],
  "select Author { name } filter .id = <uuid>'01a0e505-981b-7ae7-9e8e-34682b149a1d'": [{ name: "ann" }],
  "select Author { name } order by .name": [{ name: "ann" }, { name: "bob" }],
  "select Author { name } filter false": [],
  "select Book { title, fans := .<best[is Author] { name } }": [{ fans: [{ name: "ann" }], title: "b1" }],
  "select Book { title, tags }": [
    { tags: ["x", "y"], title: "b1" },
    { tags: [], title: "b2" }
  ]
};

/*** Run `body` with a client connected to a server over the stub executor. ***/
async function withClient(body: (query: (text: string, options?: QueryOptions) => Promise<Answer>) => Promise<void>): Promise<void> {
  const server = new BinaryProtocolServer({
    executor: text => Promise.resolve({ rows: ROWS[text] ?? [], status: "SELECT" }),
    hostname: "127.0.0.1",
    port: 0,
    schema
  });
  server.start();
  const conn = await Deno.connect({ hostname: "127.0.0.1", port: server.port });
  try {
    const client = new Client(conn);
    await client.connect();
    await body((text, options) => client.query(text, [], options));
  } finally {
    conn.close();
    await server.stop();
  }
}

Deno.test("links in a shape are nested shapes; multi links, multi properties and computed sets are sets", async () => {
  await withClient(async query => {
    assertEquals(await query("select Author { name, books: { title, tags }, best: { title } }"), {
      cardinality: Cardinality.MANY,
      described: {
        fields: [
          { name: "name", type: "std::str" },
          { name: "books", type: "set<{title: std::str, tags: set<std::str>}>" },
          { name: "best", type: "{title: std::str}" }
        ],
        kind: "object"
      },
      values: [
        { best: { title: "b1" }, books: [{ tags: ["x", "y"], title: "b1" }, { tags: [], title: "b2" }], name: "ann" },
        { best: null, books: [], name: "bob" }
      ]
    });

    // A link without a sub-shape is its target's `{id}`.
    const bare = await query("select Author { books, best }");
    assertEquals(bare.described, {
      fields: [{ name: "books", type: "set<{id: std::uuid}>" }, { name: "best", type: "{id: std::uuid}" }],
      kind: "object"
    });
    assertEquals(bare.values, [
      { best: { id: B1 }, books: [{ id: B1 }, { id: B2 }] },
      { best: null, books: [] }
    ]);

    const tags = await query("select Book { title, tags }");
    assertEquals(tags.described, { fields: [{ name: "title", type: "std::str" }, { name: "tags", type: "set<std::str>" }], kind: "object" });
    assertEquals(tags.values, [{ tags: ["x", "y"], title: "b1" }, { tags: [], title: "b2" }]);

    const computed = await query("select Author { name, n := count(.books), titles := .books.title }");
    assertEquals(computed.described, {
      fields: [{ name: "name", type: "std::str" }, { name: "n", type: "std::int64" }, { name: "titles", type: "set<std::str>" }],
      kind: "object"
    });
    assertEquals(computed.values, [{ n: 2n, name: "ann", titles: ["b1", "b2"] }, { n: 0n, name: "bob", titles: [] }]);

    const backlink = await query("select Book { title, fans := .<best[is Author] { name } }");
    assertEquals(backlink.described, {
      fields: [{ name: "title", type: "std::str" }, { name: "fans", type: "set<{name: std::str}>" }],
      kind: "object"
    });
    assertEquals(backlink.values, [{ fans: [{ name: "ann" }], title: "b1" }]);
  });
});

Deno.test("group answers free objects of key, grouping and elements", async () => {
  await withClient(async query => {
    assertEquals(await query("group Book { title } by .title"), {
      cardinality: Cardinality.MANY,
      described: {
        fields: [
          { name: "key", type: "free{title: std::str}" },
          { name: "grouping", type: "set<std::str>" },
          { name: "elements", type: "set<{title: std::str}>" }
        ],
        kind: "object"
      },
      values: [
        { elements: [{ title: "b1" }], grouping: ["title"], key: { title: "b1" } },
        { elements: [{ title: "b2" }], grouping: ["title"], key: { title: "b2" } }
      ]
    });

    // Without a shape, each element is its `{id}`; a `using` key has its expression's type.
    const bare = await query("group Book by .title");
    assertEquals(bare.values, [{ elements: [{ id: B1 }], grouping: ["title"], key: { title: "b1" } }]);
    const using = await query("group Book { title } using n := len(.title) by n");
    assertEquals(using.described, {
      fields: [
        { name: "key", type: "free{n: std::int64}" },
        { name: "grouping", type: "set<std::str>" },
        { name: "elements", type: "set<{title: std::str}>" }
      ],
      kind: "object"
    });
    assertEquals(using.values, [{ elements: [{ title: "b1" }, { title: "b2" }], grouping: ["n"], key: { n: 2n } }]);
  });
});

Deno.test("JSON output is one std::str: the result as an array, or each object when one is expected", async () => {
  await withClient(async query => {
    const json = { outputFormat: OutputFormat.JSON };
    const str: Described = { kind: "scalar", type: "std::str" };

    const many = await query("select Author { name } order by .name", json);
    assertEquals(many.described, str);
    assertEquals(many.values.map(v => JSON.parse(v as string)), [[{ name: "ann" }, { name: "bob" }]]);

    const single = await query(`select Author { name } filter .id = <uuid>'${ANN}'`, { ...json, expectedCardinality: Cardinality.AT_MOST_ONE });
    assertEquals(single.described, str);
    assertEquals(single.values.map(v => JSON.parse(v as string)), [{ name: "ann" }]);

    // An empty result: `[]` for a set, nothing (the client's `null`) for one expected object.
    assertEquals((await query("select Author { name } filter false", json)).values, ["[]"]);
    assertEquals((await query("select Author { name } filter false", { ...json, expectedCardinality: Cardinality.AT_MOST_ONE })).values, []);

    const elements = await query("select Author { name } order by .name", { outputFormat: OutputFormat.JSON_ELEMENTS });
    assertEquals(elements.described, str);
    assertEquals(elements.values.map(v => JSON.parse(v as string)), [{ name: "ann" }, { name: "bob" }]);

    const group = await query("group Book { title } by .title", json);
    assertEquals(group.described, str);
    assertEquals(JSON.parse(group.values[0] as string), ROWS["group Book { title } by .title"]);

    // The same text in binary after JSON is described as its shape again.
    assertEquals((await query("select Author { name } order by .name")).described, { fields: [{ name: "name", type: "std::str" }], kind: "object" });
  });
});

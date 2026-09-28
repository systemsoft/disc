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
 * - A shape's `id`, `__tid__` and `__tname__` are implicit (flagged, hidden
 *   by the clients) when injected: `id` in a shape without elements, and in
 *   every object shape when the client sends INJECT_OUTPUT_OBJECT_IDS (the
 *   type id and name for INJECT_OUTPUT_TYPE_IDS / _NAMES). A link is flagged
 *   a link, a link property a link property, after the shape's pointers.
 * - Output format NONE is described as the null type id, with NO_RESULT.
 * - A single result (expected cardinality ONE or AT_MOST_ONE) of more than
 *   one element is a ResultCardinalityMismatchError.
 *
 * The server runs against a stub executor answering the rows Disc's
 * executor produces for each query; tests/binary-protocol-client.ts decodes
 * the descriptors and values.
 */

import { assertEquals } from "@std/assert";
import type { Schema } from "../compiler/context.ts";
import { Client, type Answer, type Described, type QueryOptions } from "../tests/binary-protocol-client.ts";
import { BinaryProtocolServer } from "./binary-server.ts";
import { Cardinality, CompilationFlag, OutputFormat } from "./enums.ts";

const property = (edgeqlType: string, required = false, multi = false) => ({ edgeqlType, multi, required, type: edgeqlType });

const schema = {
  scalars: new Map(),
  types: new Map([
    ["Author", {
      kind: "object",
      links: new Map([
        ["best", { multi: false, required: false, target: "Book" }],
        ["books", { multi: true, properties: new Map([["rank", property("int16")]]), required: false, target: "Book" }]
      ]),
      properties: new Map([["id", property("uuid", true)], ["name", property("str", true)]])
    }],
    ["Book", {
      kind: "object",
      links: new Map(),
      properties: new Map<string, object>([
        ["id", property("uuid", true)],
        ["tags", property("str", false, true)],
        ["title", property("str", true)],
        ["blurb", { ...property("str"), computed: true, computedExpr: ".title" }]
      ]),
      subtypes: ["Novel"]
    }],
    ["Novel", {
      kind: "object",
      links: new Map(),
      parentTypes: ["Book"],
      properties: new Map([
        ["id", property("uuid", true)],
        ["tags", property("str", false, true)],
        ["title", property("str", true)],
        ["pages", property("int32", true)]
      ])
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
  ],
  "select Author { name, books: { title }, best }": [{ best: B1, books: [{ id: B1, title: "b1" }], id: ANN, name: "ann" }],
  "select Author { name }": [{ id: ANN, name: "ann" }],
  "select Author { books: { @rank, title, @next := @rank + 1 } }": [{ books: [{ "@next": 2, "@rank": 1, title: "b1" }] }],
  "select Book { * }": [{ id: B1, tags: ["x"], title: "b1" }],
  "select Book { title, [is Novel].pages }": [{ pages: 300, title: "b1" }, { pages: null, title: "b2" }],
  "group Author using b := .best by b": [{ elements: [ANN], grouping: ["b"], key: { b: B1 } }]
};

/*** Run `body` with a client connected to a server over the stub executor. ***/
async function withClient(
  body: (query: (text: string, options?: QueryOptions) => Promise<Answer>, client: Client) => Promise<void>
): Promise<void> {
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
    await body((text, options) => client.query(text, [], options), client);
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
          { link: true, name: "books", type: "set<{title: std::str, tags: set<std::str>}>" },
          { link: true, name: "best", type: "{title: std::str}" }
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
      fields: [{ link: true, name: "books", type: "set<{implicit id: std::uuid}>" }, { link: true, name: "best", type: "{implicit id: std::uuid}" }],
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
      fields: [{ name: "title", type: "std::str" }, { link: true, name: "fans", type: "set<{name: std::str}>" }],
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
          { link: true, name: "key", type: "free{title: std::str}" },
          { name: "grouping", type: "set<std::str>" },
          { link: true, name: "elements", type: "set<{title: std::str}>" }
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
        { link: true, name: "key", type: "free{n: std::int64}" },
        { name: "grouping", type: "set<std::str>" },
        { link: true, name: "elements", type: "set<{title: std::str}>" }
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

Deno.test("objects carry an implicit id, type id and type name as the client asks, as in Gel", async () => {
  await withClient(async query => {
    const ids = { compilationFlags: CompilationFlag.INJECT_OUTPUT_OBJECT_IDS };
    const answer = await query("select Author { name, books: { title }, best }", ids);
    assertEquals(answer.described, {
      fields: [
        { implicit: true, name: "id", type: "std::uuid" },
        { name: "name", type: "std::str" },
        { link: true, name: "books", type: "set<{implicit id: std::uuid, title: std::str}>" },
        { link: true, name: "best", type: "{implicit id: std::uuid}" }
      ],
      kind: "object"
    });
    assertEquals(answer.values, [{ best: { id: B1 }, books: [{ id: B1, title: "b1" }], id: ANN, name: "ann" }]);

    // A selected `id` is not implicit.
    assertEquals((await query("select Author { id, name }", ids)).described, {
      fields: [{ name: "id", type: "std::uuid" }, { name: "name", type: "std::str" }],
      kind: "object"
    });
    // Without the flag, only a shape without elements has its implicit id.
    assertEquals((await query("select Author { name }")).described, { fields: [{ name: "name", type: "std::str" }], kind: "object" });
    const implicitId: Described = { fields: [{ implicit: true, name: "id", type: "std::uuid" }], kind: "object" };
    assertEquals((await query("select Author")).described, implicitId);
    assertEquals((await query("insert Author { name := 'x' }")).described, implicitId);

    // The type name and id come first: `__tname__`, `__tid__`, `id`.
    const all = CompilationFlag.INJECT_OUTPUT_OBJECT_IDS | CompilationFlag.INJECT_OUTPUT_TYPE_IDS | CompilationFlag.INJECT_OUTPUT_TYPE_NAMES;
    const typed = await query("select Author { name }", { compilationFlags: all });
    assertEquals(typed.described, {
      fields: [
        { implicit: true, name: "__tname__", type: "std::str" },
        { implicit: true, name: "__tid__", type: "std::uuid" },
        { implicit: true, name: "id", type: "std::uuid" },
        { name: "name", type: "std::str" }
      ],
      kind: "object"
    });
    const [row] = typed.values as Record<string, unknown>[];
    assertEquals([row.__tname__, row.id, row.name], ["default::Author", ANN, "ann"]);
    assertEquals(typeof row.__tid__, "string");

    // A free object has none; its objects do.
    assertEquals((await query("group Book { title } by .title", ids)).described, {
      fields: [
        { link: true, name: "key", type: "free{title: std::str}" },
        { name: "grouping", type: "set<std::str>" },
        { link: true, name: "elements", type: "set<{implicit id: std::uuid, title: std::str}>" }
      ],
      kind: "object"
    });
    // JSON has no implicit fields.
    assertEquals((await query("select Author { name }", { ...ids, outputFormat: OutputFormat.JSON })).described, { kind: "scalar", type: "std::str" });
  });
});

Deno.test("link properties, splats, type intersections and object group keys are described with their types", async () => {
  await withClient(async query => {
    // Link properties follow the shape's pointers, flagged, named `@name` by the clients.
    const props = await query("select Author { books: { @rank, title, @next := @rank + 1 } }");
    assertEquals(props.described, {
      fields: [{ link: true, name: "books", type: "set<{title: std::str, @rank: std::int16, @next: std::int64}>" }],
      kind: "object"
    });
    assertEquals(props.values, [{ books: [{ "@next": 2n, "@rank": 1, title: "b1" }] }]);

    // A splat is its type's stored properties, `id` first.
    const splat = await query("select Book { * }");
    assertEquals(splat.described, {
      fields: [{ name: "id", type: "std::uuid" }, { name: "tags", type: "set<std::str>" }, { name: "title", type: "std::str" }],
      kind: "object"
    });
    assertEquals(splat.values, [{ id: B1, tags: ["x"], title: "b1" }]);

    // `[is Novel].pages` is the subtype's property, empty on other objects.
    const novel = await query("select Book { title, [is Novel].pages }");
    assertEquals(novel.described, { fields: [{ name: "title", type: "std::str" }, { name: "pages", type: "std::int32" }], kind: "object" });
    assertEquals(novel.values, [{ pages: 300, title: "b1" }, { pages: null, title: "b2" }]);

    // A key of objects is their shape.
    const byBest = await query("group Author using b := .best by b");
    assertEquals(byBest.described, {
      fields: [
        { link: true, name: "key", type: "free{link b: {implicit id: std::uuid}}" },
        { name: "grouping", type: "set<std::str>" },
        { link: true, name: "elements", type: "set<{implicit id: std::uuid}>" }
      ],
      kind: "object"
    });
    assertEquals(byBest.values, [{ elements: [{ id: ANN }], grouping: ["b"], key: { b: { id: B1 } } }]);
  });
});

Deno.test("output format NONE is described as the null type id, with no result", async () => {
  await withClient(async query => {
    assertEquals(await query("select Author { name } order by .name", { outputFormat: OutputFormat.NONE }), {
      cardinality: Cardinality.NO_RESULT,
      described: { kind: "null" },
      values: []
    });
  });
});

Deno.test("a single result of more than one element is a ResultCardinalityMismatchError, as in Gel", async () => {
  await withClient(async (query, client) => {
    const mismatch = (cardinality: string) => [
      0x03030000,
      `the query has cardinality ${cardinality} which does not match the expected cardinality ONE`
    ];
    for (const expectedCardinality of [Cardinality.AT_MOST_ONE, Cardinality.ONE]) {
      // Known to be many when parsed, or found to be when run; in binary and JSON.
      for (const outputFormat of [OutputFormat.BINARY, OutputFormat.JSON]) {
        for (
          const [text, cardinality] of [
            ["select {1, 2}", "AT_LEAST_ONE"],
            ["update Book set { title := .title }", "MANY"],
            ["select Author { name } order by .name", "MANY"]
          ]
        ) {
          const error = await client.run(text, { expectedCardinality, outputFormat });
          assertEquals([error?.errorCode, error?.message], mismatch(cardinality), text);
        }
      }
    }
    // One element, or none, is a single result; the session goes on.
    const one = { expectedCardinality: Cardinality.AT_MOST_ONE };
    assertEquals(await client.run(`select Author { name } filter .id = <uuid>'${ANN}'`, one), undefined);
    assertEquals((await query("select Author { name } filter false", one)).values, []);
  });
});

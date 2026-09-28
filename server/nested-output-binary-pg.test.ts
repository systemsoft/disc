/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over the Gel binary protocol: what the executor answers
 * for nested shapes, `group`, bare mutations and JSON output is described
 * and encoded as Gel does (see protocol/nested-output.test.ts):
 *
 * - links are nested shapes (`{id}` without a sub-shape); multi links,
 *   multi properties and computed sets are sets of their element type;
 * - `group` answers free objects `{key, grouping, elements}`;
 * - a bare mutation answers the set of objects it wrote, each its `{id}`;
 * - JSON output is one std::str: the result as a JSON array, or each object
 *   when at most one is expected (`querySingleJSON`);
 * - implicit ids / type ids / type names as the client's compilation flags
 *   ask, link properties, splats, `[is T].p` and object group keys with
 *   their types, output format NONE as the null type id, and a single
 *   result of many elements refused (ResultCardinalityMismatchError).
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { BinaryProtocolServer } from "../protocol/binary-server.ts";
import { Cardinality, CompilationFlag, OutputFormat } from "../protocol/enums.ts";
import { Client, type Answer, type QueryOptions } from "../tests/binary-protocol-client.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";

const SDL = `module default {
  type NoBook { required title: str; multi tags: str; };
  type NoAuthor { required name: str; multi books: NoBook { rank: int16; }; best: NoBook; };
  abstract type NoShape { required label: str; };
  type NoCircle extending NoShape { required radius: float64; };
  type NoSquare extending NoShape { required side: int64; };
};`;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*** `value` with every uuid string replaced by "<id>", and sets (arrays of objects) sorted, so answers compare across runs. ***/
function masked(value: unknown): unknown {
  if (typeof value === "string") {
    return ID.test(value) ? "<id>" : value;
  }
  if (Array.isArray(value)) {
    return value.map(masked).sort((a, b) => Deno.inspect(a).localeCompare(Deno.inspect(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, masked(inner)]));
  }
  return value;
}

Deno.test({
  name: "PG nested shapes, group, bare mutations and JSON output over the binary protocol",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const pool = makePool(await getTestDsn());
    await pool.initialize();
    await resetTestDatabase(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assert(applied.ok, JSON.stringify(applied));
    const schema = manager.getSchema()!;
    await manager.close();

    const handler = new EdgeQLProtocolHandler({ connectionPool: pool, schema });
    for (
      const text of [
        `insert NoBook { title := "b1", tags := {"x", "y"} }`,
        `insert NoBook { title := "b2" }`,
        `insert NoAuthor {
          name := "ann",
          books := {
            (select NoBook filter .title = "b1") { @rank := 1 },
            (select NoBook filter .title = "b2") { @rank := 2 }
          },
          best := (select NoBook filter .title = "b1" limit 1)
        }`,
        `insert NoAuthor { name := "bob" }`,
        `insert NoCircle { label := "c", radius := 1.5 }`,
        `insert NoSquare { label := "s", side := 2 }`
      ]
    ) {
      await handler.executeBinaryQuery(text, {});
    }
    const server = new BinaryProtocolServer({ executor: handler.executeBinaryQuery.bind(handler), hostname: "127.0.0.1", port: 0, schema });
    server.start();
    const conn = await Deno.connect({ hostname: "127.0.0.1", port: server.port });
    const client = new Client(conn);
    await client.connect();
    const query = async (text: string, options?: QueryOptions): Promise<Answer> => {
      const answer = await client.query(text, [], options);
      return { ...answer, values: masked(answer.values) as unknown[] };
    };
    const json = async (text: string, options: QueryOptions = {}): Promise<unknown[]> =>
      (await query(text, { outputFormat: OutputFormat.JSON, ...options })).values.map(v => masked(JSON.parse(v as string)));

    try {
      await t.step("multi links, single links and multi properties nest as shapes and sets", async () => {
        const answer = await query("select NoAuthor { name, books: { title, tags }, best: { title } } order by .name");
        assertEquals(answer.described, {
          fields: [
            { name: "name", type: "std::str" },
            { link: true, name: "books", type: "set<{title: std::str, tags: set<std::str>}>" },
            { link: true, name: "best", type: "{title: std::str}" }
          ],
          kind: "object"
        });
        assertEquals(answer.values, [
          { best: { title: "b1" }, books: [{ tags: ["x", "y"], title: "b1" }, { tags: [], title: "b2" }], name: "ann" },
          { best: null, books: [], name: "bob" }
        ]);
        assertEquals((await query("select NoAuthor { name, books, best } filter .name = 'ann'")).values, [
          { best: { id: "<id>" }, books: [{ id: "<id>" }, { id: "<id>" }], name: "ann" }
        ]);
        assertEquals((await query("select NoAuthor { name, n := count(.books), titles := .books.title } order by .name")).values, [
          { n: 2n, name: "ann", titles: ["b1", "b2"] },
          { n: 0n, name: "bob", titles: [] }
        ]);
      });

      await t.step("group answers free objects of key, grouping and elements", async () => {
        const answer = await query("group NoBook { title } by .title");
        assertEquals(answer.described, {
          fields: [
            { link: true, name: "key", type: "free{title: std::str}" },
            { name: "grouping", type: "set<std::str>" },
            { link: true, name: "elements", type: "set<{title: std::str}>" }
          ],
          kind: "object"
        });
        assertEquals(answer.values, [
          { elements: [{ title: "b1" }], grouping: ["title"], key: { title: "b1" } },
          { elements: [{ title: "b2" }], grouping: ["title"], key: { title: "b2" } }
        ]);
        assertEquals((await query("group NoBook using n := len(.title) by n")).values, [
          { elements: [{ id: "<id>" }, { id: "<id>" }], grouping: ["n"], key: { n: 2n } }
        ]);
      });

      await t.step("a bare mutation answers the set of objects it wrote", async () => {
        const answer = await query("update NoBook set { title := .title }");
        assertEquals(answer.described, { fields: [{ implicit: true, name: "id", type: "std::uuid" }], kind: "object" });
        assertEquals(answer.values, [{ id: "<id>" }, { id: "<id>" }]);
        assertEquals((await query("update NoBook filter .title = 'none' set { title := .title }")).values, []);
      });

      await t.step("JSON output is the result as one JSON array, or each object when one is expected", async () => {
        const described = (await query("select NoAuthor { name } order by .name", { outputFormat: OutputFormat.JSON })).described;
        assertEquals(described, { kind: "scalar", type: "std::str" });
        assertEquals(await json("select NoAuthor { name, books: { title } } order by .name"), [[
          { books: [{ title: "b1" }, { title: "b2" }], name: "ann" },
          { books: [], name: "bob" }
        ]]);
        assertEquals(await json("select NoAuthor.name order by NoAuthor.name"), [["ann", "bob"]]);
        assertEquals(await json("select NoAuthor { name } filter .name = 'ann'", { expectedCardinality: Cardinality.AT_MOST_ONE }), [{ name: "ann" }]);
        assertEquals(await json("select NoAuthor { name } filter .name = 'nobody'", { expectedCardinality: Cardinality.AT_MOST_ONE }), []);
        assertEquals(await json("select NoAuthor { name } filter .name = 'nobody'"), [[]]);
        assertEquals(await json("group NoBook { title } by .title"), [[
          { elements: [{ title: "b1" }], grouping: ["title"], key: { title: "b1" } },
          { elements: [{ title: "b2" }], grouping: ["title"], key: { title: "b2" } }
        ]]);
        const elements = await query("select NoAuthor { name } order by .name", { outputFormat: OutputFormat.JSON_ELEMENTS });
        assertEquals(elements.values.map(v => JSON.parse(v as string)), [{ name: "ann" }, { name: "bob" }]);
      });

      await t.step("objects carry the implicit id, type id and type name the client asks for", async () => {
        const ids = { compilationFlags: CompilationFlag.INJECT_OUTPUT_OBJECT_IDS };
        const answer = await query("select NoAuthor { name, books: { title }, best } order by .name", ids);
        assertEquals(answer.described, {
          fields: [
            { implicit: true, name: "id", type: "std::uuid" },
            { name: "name", type: "std::str" },
            { link: true, name: "books", type: "set<{implicit id: std::uuid, title: std::str}>" },
            { link: true, name: "best", type: "{implicit id: std::uuid}" }
          ],
          kind: "object"
        });
        assertEquals(answer.values, [
          { best: { id: "<id>" }, books: [{ id: "<id>", title: "b1" }, { id: "<id>", title: "b2" }], id: "<id>", name: "ann" },
          { best: null, books: [], id: "<id>", name: "bob" }
        ]);
        const all = ids.compilationFlags | CompilationFlag.INJECT_OUTPUT_TYPE_IDS | CompilationFlag.INJECT_OUTPUT_TYPE_NAMES;
        const typed = await query("select NoAuthor { name } filter .name = 'ann'", { compilationFlags: all });
        assertEquals(
          typed.values.map(v => {
            const { __tid__, ...rest } = v as Record<string, unknown>;
            return { ...rest, __tid__: typeof __tid__ } as Record<string, unknown>;
          }),
          [{ __tid__: "string", __tname__: "default::NoAuthor", id: "<id>", name: "ann" }]
        );
      });

      await t.step("link properties, splats, type intersections and object group keys have their types", async () => {
        const props = await query("select NoAuthor { books: { title, @rank, @next := @rank + 1 } } filter .name = 'ann'");
        assertEquals(props.described, {
          fields: [{ link: true, name: "books", type: "set<{title: std::str, @rank: std::int16, @next: std::int64}>" }],
          kind: "object"
        });
        assertEquals(props.values, [{ books: [{ "@next": 2n, "@rank": 1, title: "b1" }, { "@next": 3n, "@rank": 2, title: "b2" }] }]);

        const splat = await query("select NoBook { * } filter .title = 'b1'");
        assertEquals(splat.described, {
          fields: [{ name: "id", type: "std::uuid" }, { name: "title", type: "std::str" }, { name: "tags", type: "set<std::str>" }],
          kind: "object"
        });
        assertEquals(splat.values, [{ id: "<id>", tags: ["x", "y"], title: "b1" }]);

        const shapes = await query("select NoShape { label, [is NoCircle].radius, [is NoSquare].side } order by .label");
        assertEquals(shapes.described, {
          fields: [{ name: "label", type: "std::str" }, { name: "radius", type: "std::float64" }, { name: "side", type: "std::int64" }],
          kind: "object"
        });
        assertEquals(shapes.values, [{ label: "c", radius: 1.5, side: null }, { label: "s", radius: null, side: 2n }]);

        const byBest = await query("group NoAuthor { name } using b := .best by b");
        assertEquals(
          byBest.described.kind === "object" ? byBest.described.fields[0] : undefined,
          { link: true, name: "key", type: "free{link b: {implicit id: std::uuid}}" }
        );
        assertEquals(byBest.values, [
          { elements: [{ name: "ann" }], grouping: ["b"], key: { b: { id: "<id>" } } },
          { elements: [{ name: "bob" }], grouping: ["b"], key: { b: null } }
        ]);
      });

      await t.step("output format NONE is the null type id with no result", async () => {
        assertEquals(await query("update NoBook set { title := .title }", { outputFormat: OutputFormat.NONE }), {
          cardinality: Cardinality.NO_RESULT,
          described: { kind: "null" },
          values: []
        });
      });

      await t.step("a single result of more than one element is a ResultCardinalityMismatchError", async () => {
        const one = { expectedCardinality: Cardinality.AT_MOST_ONE };
        for (const [text, cardinality] of [["select NoAuthor { name }", "MANY"], ["update NoBook set { title := .title }", "MANY"]]) {
          const error = await client.run(text, one);
          assertEquals(
            [error?.errorCode, error?.message],
            [0x03030000, `the query has cardinality ${cardinality} which does not match the expected cardinality ONE`]
          );
        }
        // One element is a single result; an update on `.id` writes one object at most.
        assertEquals((await query("select NoAuthor { name } filter .name = 'ann'", one)).values, [{ name: "ann" }]);
        const nobody = "<uuid>'00000000-0000-0000-0000-000000000000'";
        assertEquals((await query(`update NoAuthor filter .id = ${nobody} set { name := .name }`, one)).values, []);
        // The update refused above wrote nothing: it was refused when parsed.
        assertEquals((await client.run("update NoBook set { title := 'x' }", one))?.errorCode, 0x03030000);
        assertEquals((await query("select NoBook { title } order by .title")).values, [{ title: "b1" }, { title: "b2" }]);
      });
    } finally {
      conn.close();
      await server.stop();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

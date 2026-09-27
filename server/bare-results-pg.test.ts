/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: what a statement answers with, as Gel 7.1 does (JSON output).
 *
 * - A bare `insert`, `update` or `delete` (and a `for … union (insert …)`)
 *   answers with the set of objects it wrote, `[]` when none. Gel's objects
 *   carry only `id`; Disc's carry the stored row (`id`, stored properties,
 *   single links as ids), as its bare insert always has.
 * - A select of values — a path ending in a property (`select User.name`), a
 *   scalar expression (`select 1 + 1`, `select count(User)`,
 *   `select <str>datetime_current()`), a tuple, an array, a set literal —
 *   answers with the values themselves: `["ann"]`, not `[{"name": "ann"}]`.
 * - A select of objects (a type, a path ending in a link, a shape) answers
 *   with objects, as before.
 *
 * Each query runs twice over HTTP (the second a compiled-query cache hit),
 * and once through the binary executor, which marks a select of values so
 * its JSON output is bare too.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import type * as ServerTypes from "./types.ts";

const SDL = `module default {
  type BrUser { required name: str; age: int64; multi posts: BrPost; };
  type BrPost { required title: str; author: BrUser; t: tuple<a: int64, b: str>; };
};`;

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*** `value` with every uuid string replaced by "<id>", so answers compare across runs. ***/
function masked(value: unknown): unknown {
  if (typeof value === "string")
    return ID.test(value) ? "<id>" : value;
  if (Array.isArray(value))
    return value.map(masked);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, masked(inner)]));
  return value;
}

function context(): ServerTypes.QueryContext {
  return {
    auth: { permissions: [], roles: [] },
    requestId: "bare-results",
    session: { createdAt: new Date(), database: "disc_test", lastActivity: new Date(), sessionId: "bare-results", variables: {} },
    startedAt: new Date()
  };
}

Deno.test({
  name: "PG bare results: mutations answer the set they wrote, selects of values answer the values (Gel 7.1)",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = makePool(dsn);
    await pool.initialize();
    await resetTestDatabase(pool);

    try {
      const manager = new SchemaManager({ pool });
      await manager.initialize();
      const applied = await manager.applySchema(SDL);
      assert(applied.ok, JSON.stringify(applied));
      const handler = new EdgeQLProtocolHandler({ connectionPool: pool, schema: manager.getSchema()! });
      await manager.close();

      const http = async (query: string, variables?: Record<string, unknown>): Promise<unknown> => {
        const response = await handler.handleRequest({ query, variables }, context());
        assertEquals(response.errors, undefined, `${query}: ${JSON.stringify(response.errors)}`);
        return masked(response.data);
      };

      // Gel: `[{"id": …}]` for each; Disc keeps the stored row.
      await t.step("bare mutations answer the set of objects they wrote", async () => {
        assertEquals(await http(`insert BrUser { name := "ann", age := 30 }`), [{ age: 30, id: "<id>", name: "ann" }]);
        assertEquals(await http(`insert BrUser { name := "bob" }`), [{ age: null, id: "<id>", name: "bob" }]);
        assertEquals(
          await http(`insert BrPost { title := "p1", author := (select BrUser filter .name = "ann" limit 1), t := (a := 1, b := "x") }`),
          [{ author: "<id>", id: "<id>", t: { a: 1, b: "x" }, title: "p1" }]
        );
        await http(`insert BrPost { title := "p2", author := (select BrUser filter .name = "ann" limit 1), t := (a := 2, b := "y") }`);
        assertEquals(await http(`update BrUser filter .name = "ann" set { posts := (select BrPost) }`), [{ age: 30, id: "<id>", name: "ann" }]);
        // Gel: `[]`, where Disc answered `{"updated": 0}` and `{"deleted": 0}`.
        assertEquals(await http(`update BrUser filter .name = "nobody" set { age := 1 }`), []);
        assertEquals(await http(`delete BrUser filter .name = "nobody"`), []);
        // Gel: both objects, where Disc answered the first.
        assertEquals(await http(`update BrUser set { age := .age } `), [{ age: 30, id: "<id>", name: "ann" }, { age: null, id: "<id>", name: "bob" }]);
        assertEquals(await http(`for n in {"d", "e"} union (insert BrUser { name := n })`), [
          { age: null, id: "<id>", name: "d" },
          { age: null, id: "<id>", name: "e" }
        ]);
        assertEquals(await http(`for n in array_unpack(["f", "g"]) union (insert BrUser { name := n })`), [{ id: "<id>" }, { id: "<id>" }]);
        // Gel: the deleted objects, where Disc answered `{"deleted": 4}`.
        assertEquals((await http(`delete BrUser filter .name in {"d", "e", "f", "g"}`) as unknown[]).length, 4);
        // The with-form and a select of a mutation answer the stored row too, keyed by property names.
        const post = { author: "<id>", id: "<id>", t: null, title: "w1" };
        assertEquals(await http(`with r := (insert BrPost { title := "w1", author := (select BrUser filter .name = "ann" limit 1) }) select r`), [post]);
        assertEquals(await http(`with n := "w1" update BrPost filter .title = n set { title := n }`), [post]);
        assertEquals(await http(`select (delete BrPost filter .title = "w1")`), [post]);
        assertEquals(await http(`for n in {"w2"} union (insert BrPost { title := n, author := (select BrUser filter .name = "ann" limit 1) })`), [{
          ...post,
          title: "w2"
        }]);
        await http(`delete BrPost filter .title = "w2"`);
      });

      // [query, Gel 7.1's JSON answer]
      const selects: [string, unknown][] = [
        [`select BrUser.name order by BrUser.name`, ["ann", "bob"]],
        [`select BrUser.name order by BrUser.name desc`, ["bob", "ann"]],
        [`select BrPost.author.name`, ["ann"]],
        [`select distinct BrPost.author.name`, ["ann"]],
        [`select BrPost.t order by BrPost.t.a`, [{ a: 1, b: "x" }, { a: 2, b: "y" }]],
        [`select BrUser.age`, [30]],
        [`select <json>BrPost.author.name`, ["ann"]],
        [`select 1 + 1`, [2]],
        [`select count(BrUser)`, [2]],
        [`select <int64>$n`, [5]],
        [`select (1, 'a')`, [[1, "a"]]],
        [`select (a := 1, b := 'a')`, [{ a: 1, b: "a" }]],
        [`select [1, 2]`, [[1, 2]]],
        [`select {1, 2}`, [1, 2]],
        [`select 'x'`, ["x"]],
        [`with n := 2 select n * 3`, [6]],
        // A value that is a tuple, an array or a JSON object stays whole.
        [`select {(1, 'a'), (2, 'b')}`, [[1, "a"], [2, "b"]]],
        [`select array_unpack([(1, 'a'), (2, 'b')])`, [[1, "a"], [2, "b"]]],
        [`select array_agg({(1, 'a'), (2, 'b')})`, [[[1, "a"], [2, "b"]]]],
        [`for x in {1, 2} union (x, 'a')`, [[1, "a"], [2, "a"]]],
        [`select enumerate({'x', 'y'})`, [[0, "x"], [1, "y"]]],
        [`select <json>(a := 1, b := 'x')`, [{ a: 1, b: "x" }]],
        [`select to_json('{"a": 1}')`, [{ a: 1 }]],
        // `<json>` of objects is each object's JSON value; the shape is the operand's.
        [`select <json>BrUser { name } order by .name`, [{ name: "ann" }, { name: "bob" }]],
        [`select <json>(select BrUser { name } order by .name)`, [{ name: "ann" }, { name: "bob" }]],
        [`for x in {1, 2} union x + 10`, [11, 12]],
        // Objects: Gel answers `{"id": …}` without a shape; Disc the stored row, as before.
        [`select BrPost.author`, [{ age: 30, id: "<id>", name: "ann" }]],
        [`select BrUser.posts { title } order by .title`, [{ title: "p1" }, { title: "p2" }]],
        [`select BrUser { name } filter .name = "ann"`, [{ name: "ann" }]],
        [`with u := (select BrUser filter .name = "bob") select u { name }`, [{ name: "bob" }]],
        // Gel answers an empty multi link `[]`.
        [`select BrUser { posts } filter .name = "bob"`, [{ posts: [] }]],
        // An inline computable of objects without a shape too.
        [`select BrUser { x := .posts } filter .name = "bob"`, [{ x: [] }]],
        [`select BrUser { x := .<author[is BrPost] } filter .name = "bob"`, [{ x: [] }]]
      ];

      await t.step("selects over HTTP, on a cache miss and a cache hit", async () => {
        for (const round of ["cache miss", "cache hit"]) {
          const answers: [string, unknown][] = [];
          for (const [query] of selects)
            answers.push([query, await http(query, query.includes("$n") ? { n: 5 } : undefined)]);
          assertEquals(answers, selects, round);
        }
        const [now] = await http(`select <str>datetime_current()`) as unknown[];
        assertEquals(typeof now, "string");
      });

      await t.step("the binary executor marks a select of values, and returns each mutation's rows", async () => {
        const names = await handler.executeBinaryQuery(`select BrUser.name order by BrUser.name`, {});
        assertEquals({ rows: names.rows.map(row => Object.values(row)), values: names.values }, { rows: [["ann"], ["bob"]], values: true });
        const objects = await handler.executeBinaryQuery(`select BrUser { name } order by .name`, {});
        assertEquals({ rows: objects.rows, values: objects.values }, { rows: [{ name: "ann" }, { name: "bob" }], values: undefined });
        const deleted = await handler.executeBinaryQuery(`delete BrUser filter .name = "bob"`, {});
        assertEquals(masked(deleted.rows), [{ age: null, id: "<id>", name: "bob" }]);
      });
    } finally {
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

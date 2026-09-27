/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: a git forge's per-program issue numbering, as its
 * author wrote it. A `Numbering` row per program holds the last number handed
 * out; an upsert bumps it, and the new `Bug` takes the bumped value.
 *
 *   - An upsert whose `else` update is filtered out writes nothing and answers
 *     `[]`, as Gel 7.1 does — not a success object — so a caller can tell
 *     "updated" from "skipped". So does an insert swallowed by
 *     `unless conflict` without `else`.
 *   - `n.last`, where `n` is bound by `with` to an insert (or upsert), is the
 *     inserted object's value: in an insert's or update's values, a filter, a
 *     shape and a select, like `(select n.last)`.
 *   - `select (with … insert …) { shape }` is `with … select (insert …) { shape }`.
 *   - The one-statement "next number" query hands out distinct numbers, also
 *     to concurrent callers for the same program.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const SDL = `
module default {
  type Program {
    required name: str;
  }

  type User {
    required name: str;
  }
}

module collab {
  type Numbering {
    required program: default::Program {
      constraint exclusive;
    };
    required last: int64;
  };

  type Bug {
    required program: default::Program;
    required author: default::User;
    required number: int64;
    required title: str;
  };
}
`;

const PROGRAM_ID = "00000000-0000-0000-0000-0000000000d1";
const OTHER_PROGRAM_ID = "00000000-0000-0000-0000-0000000000d2";
const THIRD_PROGRAM_ID = "00000000-0000-0000-0000-0000000000d3";
const USER_ID = "aaaaaaaa-0000-0000-0000-0000000000d1";

const CAPPED_UPSERT = "insert collab::Numbering { program := <default::Program><uuid>$p, last := 1 } " +
  "unless conflict on .program else (update collab::Numbering filter .last < 3 set { last := .last + 1 })";

const NEXT_NUMBER_BUG = `select (
  with n := (insert collab::Numbering { program := <default::Program><uuid>$p, last := 1 }
             unless conflict on .program
             else (update collab::Numbering set { last := .last + 1 }))
  insert collab::Bug { program := <default::Program><uuid>$p, author := <default::User><uuid>$u, number := n.last, title := <str>$t }
) { number }`;

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

Deno.test({
  name: "PG numbering upsert: [] when nothing is written, with-bound insert paths, select (with … insert …) { … }",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 8, minConnections: 1 });
    await pool.initialize();
    await resetTestDatabase(pool);

    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);
    await pool.query("INSERT INTO program (id, name) VALUES ($1, 'forge'), ($2, 'other'), ($3, 'third')", [
      PROGRAM_ID,
      OTHER_PROGRAM_ID,
      THIRD_PROGRAM_ID
    ]);
    await pool.query("INSERT INTO \"user\" (id, name) VALUES ($1, 'ada')", [USER_ID]);

    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 8, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, schema })
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (server as any).handleRequest(request, info)
    );

    async function post(query: string, variables: Record<string, unknown> = {}): Promise<Reply> {
      const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
        body: JSON.stringify({ query, variables }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      return { body: await response.json(), status: response.status };
    }

    async function data(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
      const reply = await post(query, variables);
      assertEquals(reply.status, 200, `${query}: ${JSON.stringify(reply.body)}`);
      assertEquals(reply.body.errors, undefined, `${query}: ${JSON.stringify(reply.body)}`);
      return reply.body.data;
    }

    async function last(program: string): Promise<number[]> {
      const result = await pool.query("SELECT last FROM numbering WHERE program_id = $1", [program]);
      return (result.rows as { last: number | string; }[]).map(row => Number(row.last));
    }

    try {
      await t.step("an upsert whose else-update is filtered out answers [], on a cache miss and on a hit", async () => {
        for (const expected of [1, 2, 3]) {
          const row = await data(CAPPED_UPSERT, { p: PROGRAM_ID }) as Record<string, unknown>;
          assertEquals(Number(row.last), expected, JSON.stringify(row));
        }
        assertEquals(await data(CAPPED_UPSERT, { p: PROGRAM_ID }), []);
        assertEquals(await data(CAPPED_UPSERT, { p: PROGRAM_ID }), []);
        assertEquals(await last(PROGRAM_ID), [3]);
      });

      await t.step("an insert swallowed by `unless conflict` (no else) answers []", async () => {
        const query = "insert collab::Numbering { program := <default::Program><uuid>$p, last := 1 } unless conflict on .program";
        assertEquals(await data(query, { p: PROGRAM_ID }), []);
        assertEquals(await data(query, { p: PROGRAM_ID }), []);
        assertEquals(await last(PROGRAM_ID), [3]);
      });

      await t.step("a bare update or delete matching nothing keeps { updated: 0 } / { deleted: 0 }", async () => {
        assertEquals(await data("update collab::Numbering filter .last > 100 set { last := 0 }"), { updated: 0 });
        assertEquals(await data("delete collab::Numbering filter .last > 100"), { deleted: 0 });
      });

      await t.step("n.last of a with-bound upsert is its new value in an insert", async () => {
        const query = "with n := (insert collab::Numbering { last := 1, program := <default::Program><uuid>$p } " +
          "unless conflict on .program else (update collab::Numbering set { last := .last + 1 })) " +
          "insert collab::Bug { program := n.program, author := <default::User><uuid>$u, number := n.last, title := n.program.name }";
        const row = await data(query, { p: PROGRAM_ID, u: USER_ID }) as Record<string, unknown>;
        assertEquals(Number(row.number), 4);
        assertEquals(row.title, "forge");
        const stored = await pool.query("SELECT program_id FROM bug WHERE number = 4");
        assertEquals((stored.rows as { program_id: string; }[]).map(bug => bug.program_id), [PROGRAM_ID]);
        assertEquals(await last(PROGRAM_ID), [4]);
      });

      await t.step("n.last of a with-bound insert in an update's filter and values, a shape and a select", async () => {
        const updated = await data(
          "with n := (insert collab::Numbering { last := 4, program := <default::Program><uuid>$p }) " +
            "update collab::Bug filter .number = n.last set { title := 'bumped', number := n.last + 100 }",
          { p: OTHER_PROGRAM_ID }
        ) as Record<string, unknown>;
        assertEquals(updated.title, "bumped");
        assertEquals(Number(updated.number), 104);

        const shaped = await data(
          "with n := (insert collab::Bug { program := <default::Program><uuid>$p, author := <default::User><uuid>$u, number := 7, title := 'x' }) " +
            "select collab::Numbering { last, n_number := n.number, n_id := n.id, n_program := n.program.name } filter .program.name = 'other'",
          { p: THIRD_PROGRAM_ID, u: USER_ID }
        ) as Record<string, unknown>[];
        assertEquals(shaped.length, 1);
        assertEquals(Number(shaped[0].n_number), 7);
        assertEquals(shaped[0].n_program, "third");
        assertEquals(typeof shaped[0].n_id, "string");

        const selected = await data(
          "with n := (insert collab::Bug { program := <default::Program><uuid>$p, author := <default::User><uuid>$u, number := 8, title := 'y' }) " +
            "select n.program.name",
          { p: THIRD_PROGRAM_ID, u: USER_ID }
        );
        // A select of a path answers with rows keyed by the property's name.
        assertEquals(selected, [{ name: "third" }]);
      });

      await t.step("select (with … insert …) { number } answers [{ number }]", async () => {
        const first = await data(NEXT_NUMBER_BUG, { p: THIRD_PROGRAM_ID, t: "first", u: USER_ID });
        assertEquals(first, [{ number: 1 }]);
        const second = await data(NEXT_NUMBER_BUG, { p: THIRD_PROGRAM_ID, t: "second", u: USER_ID });
        assertEquals(second, [{ number: 2 }]);
        assertEquals(await last(THIRD_PROGRAM_ID), [2]);

        const updateForm = "select (with d := 10 update collab::Numbering filter .program.id = <uuid>$p set { last := .last + d }) { last }";
        assertEquals(await data(updateForm, { p: THIRD_PROGRAM_ID }), [{ last: 12 }]);
        const deleteForm = "select (with k := 999 delete collab::Bug filter .number = k) { number }";
        assertEquals(await data(deleteForm), []);
      });

      await t.step("20 concurrent callers for one program get the numbers 13…32, each once", async () => {
        const replies = await Promise.all(
          Array.from({ length: 20 }, (_, i) => data(NEXT_NUMBER_BUG, { p: THIRD_PROGRAM_ID, t: `race ${i}`, u: USER_ID }))
        );
        const numbers = replies
          .map(reply => {
            const rows = reply as { number: number; }[];
            assertEquals(rows.length, 1, JSON.stringify(reply));
            return Number(rows[0].number);
          })
          .sort((a, b) => a - b);
        assertEquals(numbers, Array.from({ length: 20 }, (_, i) => 13 + i));
        assertEquals(await last(THIRD_PROGRAM_ID), [32]);
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

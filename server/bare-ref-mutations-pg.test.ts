/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: the git-forge consumer's ref mutations as BARE
 * statements (Q1–Q3 of tests/git-forge-acceptance-pg.test.ts without the
 * `select (…) { id }` wrapper).
 *
 *   - update … filter .program.id = … and .name = … and .target = …  (CAS)
 *   - delete … with the same filter                                  (CAS delete)
 *   - insert … unless conflict on ((.program, .name))                (create-if-absent)
 *
 * A bare update answers with the row, or `{ updated: 0 }` when nothing
 * matched; a bare delete with `{ deleted: n }`; a bare insert with the row, or
 * `{ success: true }` when the conflict swallowed it. Those shapes are kept
 * for backward compatibility, so the assertions here lean on row counts and
 * the stored `target`.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SQLCodeGenerator } from "../compiler/codegen.ts";
import { EdgeQLCompiler } from "../compiler/compiler.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const FIXTURE_URL = new URL("../tests/fixtures/git-forge.disc", import.meta.url);
const PROGRAM_ID = "00000000-0000-0000-0000-0000000000e1";
const OTHER_PROGRAM_ID = "00000000-0000-0000-0000-0000000000e2";
const USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_USER_ID = "bbbbbbbb-0000-0000-0000-000000000002";

const BARE_Q1 = "update GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old set { target := <str>$new }";
const BARE_Q2 = "delete GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old";
const BARE_Q3 = "insert GitRef { program := <Program><uuid>$p, name := <str>$n, target := <str>$t } unless conflict on ((.program, .name))";
const BARE_Q3_SUBSELECT =
  "insert GitRef { program := (select Program filter .id = <uuid>$p), name := <str>$n, target := <str>$t } unless conflict on ((.program, .name))";

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
}

function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

Deno.test({
  name: "PG bare ref mutations: CAS update (20-way race), CAS delete, create-if-absent on ((.program, .name))",
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
    const applied = await manager.applySchema(await Deno.readTextFile(FIXTURE_URL));
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);
    await pool.query("INSERT INTO program (id, name) VALUES ($1, 'bare-ref'), ($2, 'bare-ref-other')", [PROGRAM_ID, OTHER_PROGRAM_ID]);

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

    async function post(query: string, variables: Record<string, unknown>): Promise<Reply> {
      const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
        body: JSON.stringify({ query, variables }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      return { body: await response.json(), status: response.status };
    }

    function ok(reply: Reply, label: string): Record<string, unknown> {
      assertEquals(reply.status, 200, `${label}: ${JSON.stringify(reply.body)}`);
      assertEquals(reply.body.errors, undefined, `${label}: ${JSON.stringify(reply.body)}`);
      return reply.body.data as Record<string, unknown>;
    }

    async function seedRef(program: string, name: string, target: string): Promise<void> {
      await pool.query("INSERT INTO git_ref (program_id, name, target) VALUES ($1, $2, $3)", [program, name, target]);
    }

    async function targets(program: string, name: string): Promise<string[]> {
      const result = await pool.query("SELECT target FROM git_ref WHERE program_id = $1 AND name = $2", [program, name]);
      return (result.rows as { target: string; }[]).map(row => row.target);
    }

    try {
      await t.step("bare Q1: matches on the current target, run twice (cache miss, cache hit)", async () => {
        await seedRef(PROGRAM_ID, "refs/heads/main", oid(1));

        const first = ok(await post(BARE_Q1, { n: "refs/heads/main", new: oid(2), old: oid(1), p: PROGRAM_ID }), "first");
        assertEquals(first.target, oid(2));
        const second = ok(await post(BARE_Q1, { n: "refs/heads/main", new: oid(3), old: oid(2), p: PROGRAM_ID }), "second");
        assertEquals(second.target, oid(3));

        assertEquals(await targets(PROGRAM_ID, "refs/heads/main"), [oid(3)]);
      });

      await t.step("bare Q1: a stale `old` updates nothing", async () => {
        const stale = ok(await post(BARE_Q1, { n: "refs/heads/main", new: oid(9), old: oid(1), p: PROGRAM_ID }), "stale");

        assertEquals(stale, { updated: 0 });
        assertEquals(await targets(PROGRAM_ID, "refs/heads/main"), [oid(3)]);
      });

      await t.step("bare Q1: the program is part of the predicate", async () => {
        await seedRef(OTHER_PROGRAM_ID, "refs/heads/main", oid(3));

        ok(await post(BARE_Q1, { n: "refs/heads/main", new: oid(4), old: oid(3), p: PROGRAM_ID }), "scoped");

        assertEquals(await targets(PROGRAM_ID, "refs/heads/main"), [oid(4)]);
        assertEquals(await targets(OTHER_PROGRAM_ID, "refs/heads/main"), [oid(3)], "the other program's ref of the same name must be untouched");
      });

      await t.step("bare Q1: 20 concurrent callers with the same `old` — exactly one update matches", async () => {
        await seedRef(PROGRAM_ID, "refs/heads/race", oid(100));

        const replies = await Promise.all(
          Array.from({ length: 20 }, (_, i) => post(BARE_Q1, { n: "refs/heads/race", new: oid(200 + i), old: oid(100), p: PROGRAM_ID }))
        );
        const results = replies.map((reply, i) => ok(reply, `caller ${i}`));
        const winners = results.filter(data => data.updated !== 0);
        const losers = results.filter(data => data.updated === 0);

        assertEquals(winners.length, 1, `expected exactly one winner, got: ${JSON.stringify(results)}`);
        assertEquals(losers.length, 19);
        assertEquals(await targets(PROGRAM_ID, "refs/heads/race"), [winners[0].target as string], "the stored target is the winner's");
      });

      await t.step("bare Q2: a stale `old` deletes nothing; the current one deletes the ref", async () => {
        await seedRef(PROGRAM_ID, "refs/heads/gone", oid(7));
        await seedRef(OTHER_PROGRAM_ID, "refs/heads/gone", oid(7));

        const stale = ok(await post(BARE_Q2, { n: "refs/heads/gone", old: oid(8), p: PROGRAM_ID }), "stale");
        assertEquals(stale, { deleted: 0 });
        assertEquals(await targets(PROGRAM_ID, "refs/heads/gone"), [oid(7)]);

        const current = ok(await post(BARE_Q2, { n: "refs/heads/gone", old: oid(7), p: PROGRAM_ID }), "current");
        assertEquals(current, { deleted: 1 });
        assertEquals(await targets(PROGRAM_ID, "refs/heads/gone"), []);
        assertEquals(await targets(OTHER_PROGRAM_ID, "refs/heads/gone"), [oid(7)], "the other program's ref must survive");
      });

      await t.step("bare Q3: inserts once, does nothing the second time, raises nothing", async () => {
        const created = ok(await post(BARE_Q3, { n: "refs/tags/v1", p: PROGRAM_ID, t: oid(11) }), "created");
        assertEquals(created.target, oid(11));

        ok(await post(BARE_Q3, { n: "refs/tags/v1", p: PROGRAM_ID, t: oid(12) }), "conflict");
        assertEquals(await targets(PROGRAM_ID, "refs/tags/v1"), [oid(11)], "the existing ref wins; no second row");

        // Same name under another program is not a conflict.
        ok(await post(BARE_Q3, { n: "refs/tags/v1", p: OTHER_PROGRAM_ID, t: oid(13) }), "other program");
        assertEquals(await targets(OTHER_PROGRAM_ID, "refs/tags/v1"), [oid(13)]);
      });

      await t.step("bare Q3: program := (select Program filter .id = <uuid>$p) behaves the same", async () => {
        ok(await post(BARE_Q3_SUBSELECT, { n: "refs/tags/v2", p: PROGRAM_ID, t: oid(21) }), "created");
        ok(await post(BARE_Q3_SUBSELECT, { n: "refs/tags/v2", p: PROGRAM_ID, t: oid(22) }), "conflict");

        assertEquals(await targets(PROGRAM_ID, "refs/tags/v2"), [oid(21)]);
      });

      // The policy predicate's columns are unqualified (`owner_id = E'…'`) while
      // the caller's filter and set expressions are qualified by the table.
      // Postgres must accept the mix, and the predicate must still scope rows.
      await t.step("access control on: the owner predicate is valid SQL beside table-qualified columns, and still scopes rows", async () => {
        const compiler = new EdgeQLCompiler(schema, {
          accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
          enableAccessControl: true
        });
        for (const typeDef of schema.types.values()) {
          for (const policy of typeDef.accessPolicies ?? []) {
            compiler.registerAccessPolicy(policy);
          }
        }
        compiler.setAccessContext({ userId: USER_ID });

        const compileAsUser = (edgeql: string): string => {
          const result = compiler.compile(new EdgeQLParser(edgeql).parse());
          if (!result.ok) {
            throw result.error;
          }
          return new SQLCodeGenerator().generate(result.value);
        };
        const titlesOf = async (owner: string): Promise<string[]> => {
          const result = await pool.query("SELECT title FROM doc WHERE owner_id = $1 ORDER BY title", [owner]);
          return (result.rows as { title: string; }[]).map(row => row.title);
        };

        await pool.query("INSERT INTO doc (owner_id, title) VALUES ($1, 'shared'), ($2, 'shared')", [USER_ID, OTHER_USER_ID]);

        const updateSql = compileAsUser("update Doc filter .title = <str>$t set { title := .title ++ '!' }");
        assertStringIncludes(updateSql, `owner_id = E'${USER_ID}'`);
        assertStringIncludes(updateSql, "doc.title");
        const updated = await pool.query(updateSql, ["shared"]);
        assertEquals(updated.rowCount, 1);
        assertEquals(await titlesOf(USER_ID), ["shared!"]);
        assertEquals(await titlesOf(OTHER_USER_ID), ["shared"], "another owner's row with the same title must be untouched");

        const deleteSql = compileAsUser("delete Doc filter .title like <str>$t");
        assertStringIncludes(deleteSql, `owner_id = E'${USER_ID}'`);
        const deleted = await pool.query(deleteSql, ["shared%"]);
        assertEquals(deleted.rowCount, 1);
        assertEquals(await titlesOf(USER_ID), []);
        assertEquals(await titlesOf(OTHER_USER_ID), ["shared"]);
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

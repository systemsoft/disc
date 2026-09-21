/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: the git-forge consumer's ref mutations exactly as
 * its contract writes them (Q1–Q3 of tests/git-forge-acceptance-pg.test.ts),
 * i.e. `select (insert|update|delete …) { id }`.
 *
 *   - The answer is the affected row set: `[{ id }]`, or `[]` when the
 *     compare-and-swap was stale or the insert hit its conflict target. Never
 *     `{ success: true }`, and the same for update, delete and insert.
 *   - Every response-shape step sends its query at least twice, so the later
 *     runs are compiled-query cache hits, where no query AST exists.
 *   - Only the requested fields come back.
 *   - A bare insert answers with the same keys on the first and on the repeated
 *     call (D14); a junction-backed multi-link write, whose SQL has the same
 *     `WITH … INSERT/UPDATE … SELECT` shape, keeps its single-row response.
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

/*** Appended to the fixture's `module default`: a junction-backed multi link, which the consumer's schema has none of. ***/
const MULTI_LINK_TYPES = `
  type Label {
    required name: str;
  }

  type Note {
    required title: str;
    multi labels -> Label;
  }
`;

const PROGRAM_ID = "00000000-0000-0000-0000-0000000000f1";
const OTHER_PROGRAM_ID = "00000000-0000-0000-0000-0000000000f2";
const USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER_USER_ID = "bbbbbbbb-0000-0000-0000-000000000002";

const Q1 = "select (update GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old set { target := <str>$new }) { id }";
const Q2 = "select (delete GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old) { id }";
const Q3 = "select (insert GitRef { program := <Program><uuid>$p, name := <str>$n, target := <str>$t } unless conflict on ((.program, .name))) { id }";
const Q3_SUBSELECT = "select (insert GitRef { program := (select Program filter .id = <uuid>$p), name := <str>$n, target := <str>$t } " +
  "unless conflict on ((.program, .name))) { id }";

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; extensions?: { cacheHit?: boolean; }; };
  status: number;
}

function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

Deno.test({
  name: "PG select over mutation: Q1–Q3 as written — row sets, [] when nothing matched, 20-way races, cache hits, D14",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 8, minConnections: 1 });
    await pool.initialize();
    await resetTestDatabase(pool);

    const fixture = await Deno.readTextFile(FIXTURE_URL);
    const sdl = fixture.replace(/\}\s*$/, `${MULTI_LINK_TYPES}}\n`);
    assert(sdl !== fixture, "the multi-link types must have been appended to the fixture's module");

    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(sdl);
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);
    await pool.query("INSERT INTO program (id, name) VALUES ($1, 'som'), ($2, 'som-other')", [PROGRAM_ID, OTHER_PROGRAM_ID]);

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

    function ok(reply: Reply, label: string): unknown {
      assertEquals(reply.status, 200, `${label}: ${JSON.stringify(reply.body)}`);
      assertEquals(reply.body.errors, undefined, `${label}: ${JSON.stringify(reply.body)}`);
      return reply.body.data;
    }

    function rowsOf(reply: Reply, label: string): Record<string, unknown>[] {
      const data = ok(reply, label);
      assert(Array.isArray(data), `${label}: expected a row set, got ${JSON.stringify(data)}`);
      return data as Record<string, unknown>[];
    }

    async function seedRef(program: string, name: string, target: string): Promise<string> {
      const result = await pool.query("INSERT INTO git_ref (program_id, name, target) VALUES ($1, $2, $3) RETURNING id", [program, name, target]);
      return (result.rows as { id: string; }[])[0].id;
    }

    async function targets(program: string, name: string): Promise<string[]> {
      const result = await pool.query("SELECT target FROM git_ref WHERE program_id = $1 AND name = $2", [program, name]);
      return (result.rows as { target: string; }[]).map(row => row.target);
    }

    try {
      await t.step("Q1: a matching `old` answers [{ id }], a stale one [] — each on a cache miss and on cache hits", async () => {
        const name = "refs/heads/main";
        const ref = await seedRef(PROGRAM_ID, name, oid(1));
        await seedRef(OTHER_PROGRAM_ID, name, oid(1));

        const first = await post(Q1, { n: name, new: oid(2), old: oid(1), p: PROGRAM_ID });
        assertEquals(rowsOf(first, "first"), [{ id: ref }]);
        assertEquals(first.body.extensions?.cacheHit, false);

        const second = await post(Q1, { n: name, new: oid(3), old: oid(2), p: PROGRAM_ID });
        assertEquals(rowsOf(second, "second"), [{ id: ref }]);
        assertEquals(second.body.extensions?.cacheHit, true);

        for (const run of ["stale, first", "stale, repeated"]) {
          assertEquals(rowsOf(await post(Q1, { n: name, new: oid(9), old: oid(1), p: PROGRAM_ID }), run), [], run);
        }

        assertEquals(await targets(PROGRAM_ID, name), [oid(3)]);
        assertEquals(await targets(OTHER_PROGRAM_ID, name), [oid(1)], "the other program's ref of the same name must be untouched");
      });

      await t.step("Q1: 20 concurrent callers with the same `old` — exactly one non-empty result", async () => {
        const name = "refs/heads/race";
        const ref = await seedRef(PROGRAM_ID, name, oid(100));

        const replies = await Promise.all(
          Array.from({ length: 20 }, (_, i) => post(Q1, { n: name, new: oid(200 + i), old: oid(100), p: PROGRAM_ID }))
        );
        const results = replies.map((reply, i) => ({ i, rows: rowsOf(reply, `caller ${i}`) }));
        const winners = results.filter(result => result.rows.length > 0);

        assertEquals(winners.length, 1, `expected exactly one winner, got: ${JSON.stringify(results)}`);
        assertEquals(winners[0].rows, [{ id: ref }]);
        assertEquals(await targets(PROGRAM_ID, name), [oid(200 + winners[0].i)], "the stored target is the winner's");
      });

      await t.step("Q2: a stale `old` answers [] twice and deletes nothing; of 20 callers with the current one, exactly one deletes", async () => {
        const name = "refs/heads/gone";
        const ref = await seedRef(PROGRAM_ID, name, oid(7));
        await seedRef(OTHER_PROGRAM_ID, name, oid(7));

        for (const run of ["stale, first", "stale, repeated"]) {
          assertEquals(rowsOf(await post(Q2, { n: name, old: oid(8), p: PROGRAM_ID }), run), [], run);
        }
        assertEquals(await targets(PROGRAM_ID, name), [oid(7)]);

        const replies = await Promise.all(Array.from({ length: 20 }, () => post(Q2, { n: name, old: oid(7), p: PROGRAM_ID })));
        const winners = replies.map((reply, i) => rowsOf(reply, `caller ${i}`)).filter(rows => rows.length > 0);

        assertEquals(winners, [[{ id: ref }]]);
        assertEquals(await targets(PROGRAM_ID, name), []);
        assertEquals(await targets(OTHER_PROGRAM_ID, name), [oid(7)], "the other program's ref must survive");
      });

      for (const [variant, query, name] of [["<Program><uuid>$p", Q3, "refs/tags/v1"], ["(select Program …)", Q3_SUBSELECT, "refs/tags/v2"]]) {
        await t.step(`Q3, program := ${variant}: [{ id }] once, then [] on conflict — twice`, async () => {
          const created = rowsOf(await post(query, { n: name, p: PROGRAM_ID, t: oid(11) }), "created");
          assertEquals(created.length, 1);
          assertEquals(Object.keys(created[0]), ["id"]);

          for (const run of ["conflict, first", "conflict, repeated"]) {
            assertEquals(rowsOf(await post(query, { n: name, p: PROGRAM_ID, t: oid(12) }), run), [], run);
          }
          assertEquals(await targets(PROGRAM_ID, name), [oid(11)], "the existing ref wins; no second row");

          // Same name under another program is not a conflict.
          assertEquals(rowsOf(await post(query, { n: name, p: OTHER_PROGRAM_ID, t: oid(13) }), "other program").length, 1);
        });
      }

      await t.step("only the requested fields come back, for both spellings, on both runs", async () => {
        await pool.query(
          "INSERT INTO git_object (program_id, object_id, object_type, size, content) VALUES ($1, $2, 'blob', 3, $3)",
          [PROGRAM_ID, oid(500), new Uint8Array([1, 2, 3])]
        );
        const forms = [
          "select (update GitObject filter .object_id = <str>$o set { size := <int64>$size }) { object_id, size }",
          "with u := (update GitObject filter .object_id = <str>$o set { size := <int64>$size }) select u { object_id, size }"
        ];

        for (const form of forms) {
          for (const size of [4, 5]) {
            assertEquals(rowsOf(await post(form, { o: oid(500), size }), form), [{ object_id: oid(500), size }], form);
          }
        }
      });

      await t.step("a nested link in the shape is read through the CTE row", async () => {
        await seedRef(PROGRAM_ID, "refs/heads/nested", oid(1));

        const rows = rowsOf(
          await post(
            "select (update GitRef filter .name = <str>$n set { target := <str>$new }) { name, program: { name } }",
            { n: "refs/heads/nested", new: oid(2) }
          ),
          "nested"
        );

        assertEquals(rows, [{ name: "refs/heads/nested", program: [{ name: "som" }] }]);
      });

      await t.step("D14: a bare insert answers with the same keys on the first and on the repeated call", async () => {
        const bare = "insert GitRef { program := <Program><uuid>$p, name := <str>$n, target := <str>$t }";
        const first = await post(bare, { n: "refs/heads/d14-a", p: PROGRAM_ID, t: oid(1) });
        const second = await post(bare, { n: "refs/heads/d14-b", p: PROGRAM_ID, t: oid(1) });

        assertEquals(second.body.extensions?.cacheHit, true);
        const firstKeys = Object.keys(ok(first, "first") as Record<string, unknown>).sort();
        assertEquals(firstKeys, ["id", "name", "peeled", "program", "target"]);
        assertEquals(Object.keys(ok(second, "second") as Record<string, unknown>).sort(), firstKeys);
      });

      await t.step("a junction-backed multi-link write keeps its single-row response on both runs", async () => {
        await pool.query("INSERT INTO label (name) VALUES ('a'), ('b')");
        const insert = "insert Note { title := <str>$t, labels := (select Label filter .name = <str>$l) }";
        const update = "update Note filter .title = <str>$t set { labels += (select Label filter .name = <str>$l) }";

        for (
          const [query, variables] of [[insert, { l: "a", t: "n1" }], [insert, { l: "a", t: "n2" }], [update, { l: "b", t: "n1" }], [update, {
            l: "b",
            t: "n2"
          }]] as const
        ) {
          const data = ok(await post(query, variables), query) as Record<string, unknown>;

          assert(!Array.isArray(data), `a multi-link write answers with the row, not a row set: ${JSON.stringify(data)}`);
          assertEquals(data.title, variables.t);
          assertEquals(Object.keys(data).sort(), ["id", "title"]);
        }

        const links = await pool.query("SELECT count(*)::int AS n FROM note_labels");
        assertEquals((links.rows as { n: number; }[])[0].n, 4);
      });

      // The mutation inside the CTE is compiled by the same mutation compiler
      // as the bare statement, so it carries the caller's policy.
      await t.step("access control on: the owner predicate sits inside the CTE and scopes the rows that are written and returned", async () => {
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

        await pool.query("INSERT INTO doc (owner_id, title) VALUES ($1, 'shared'), ($2, 'shared')", [USER_ID, OTHER_USER_ID]);

        const compiled = compiler.compile(new EdgeQLParser("select (update Doc filter .title = <str>$t set { title := .title ++ '!' }) { id, title }").parse());
        assert(compiled.ok, compiled.ok ? "" : compiled.error.message);
        const sql = new SQLCodeGenerator().generate(compiled.value);
        assertStringIncludes(sql, `owner_id = E'${USER_ID}'`);

        const result = await pool.query(sql, ["shared"]);
        assertEquals((result.rows as { jsonb_build_object: { title: string; }; }[]).map(row => row.jsonb_build_object.title), ["shared!"]);

        const stored = await pool.query("SELECT owner_id, title FROM doc ORDER BY title");
        assertEquals(stored.rows, [{ owner_id: OTHER_USER_ID, title: "shared" }, { owner_id: USER_ID, title: "shared!" }]);

        const denied = compiler.compile(new EdgeQLParser("select (delete Locked filter .name = <str>$n) { id }").parse());
        assert(!denied.ok && /not allowed on Locked/i.test(denied.error.message), JSON.stringify(denied));
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

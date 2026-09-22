/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: bulk insert from a JSON array (Q4 and Q5 of
 * tests/git-forge-acceptance-pg.test.ts).
 *
 *   with rows := <json>$rows
 *   for item in json_array_unpack(rows) union (insert T { … } unless conflict on (…))
 *
 * is one `INSERT … SELECT … FROM jsonb_array_elements($n) … ON CONFLICT …
 * RETURNING id`. The response is the ids of the rows that were inserted — never
 * `content` — so a re-run answers `[]`.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const FIXTURE_URL = new URL("../tests/fixtures/git-forge.disc", import.meta.url);
const PROGRAM_ID = "00000000-0000-0000-0000-0000000000b1";
const OTHER_PROGRAM_ID = "00000000-0000-0000-0000-0000000000b2";
const TIMED_PROGRAM_ID = "00000000-0000-0000-0000-0000000000b3";

const Q4 = "with rows := <json>$rows for item in json_array_unpack(rows) union (" +
  "insert GitObject { program := <Program><uuid>$p, object_id := <str>item['object_id'], object_type := <str>item['object_type'], " +
  "size := <int64>item['size'], content := std::base64_decode(<str>item['content']) } " +
  "unless conflict on ((.program, .object_id)))";

const Q5 = "with rows := <json>$rows for item in json_array_unpack(rows) union (" +
  "insert GitCommit { program := <Program><uuid>$p, object_id := <str>item['object_id'], tree_id := <str>item['tree_id'], " +
  "commit_time := <int64>item['commit_time'], parents := <array<str>>item['parents'] } " +
  "unless conflict on ((.program, .object_id)))";

interface Reply {
  body: { data?: unknown; errors?: { message: string; }[]; };
  status: number;
  text: string;
}

function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, length)));
  }
  return bytes;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

Deno.test({
  name: "PG bulk insert from JSON: 500 rows in one statement, idempotent re-run, array order, all-or-nothing",
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
    await pool.query("INSERT INTO program (id, name) VALUES ($1, 'bulk'), ($2, 'bulk-other'), ($3, 'bulk-timed')", [
      PROGRAM_ID,
      OTHER_PROGRAM_ID,
      TIMED_PROGRAM_ID
    ]);

    // Every statement the handler sends, to count them.
    const statements: string[] = [];
    const recordingPool = new Proxy(pool, {
      get(target, property, receiver) {
        if (property === "query") {
          return (sql: string, params?: unknown[]) => {
            statements.push(sql);
            return target.query(sql, params);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });

    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 8, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: recordingPool, schema })
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
      const text = await response.text();
      return { body: JSON.parse(text), status: response.status, text };
    }

    function ok(reply: Reply, label: string): unknown {
      assertEquals(reply.status, 200, `${label}: ${reply.text.slice(0, 500)}`);
      assertEquals(reply.body.errors, undefined, `${label}: ${reply.text.slice(0, 500)}`);
      return reply.body.data;
    }

    async function count(table: string, program: string): Promise<number> {
      const result = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE program_id = $1`, [program]);
      return (result.rows[0] as { n: number; }).n;
    }

    const contents = Array.from({ length: 500 }, () => randomBytes(64));
    const rows = contents.map((content, i) => ({
      content: encodeBase64(content),
      object_id: oid(i),
      object_type: i % 2 === 0 ? "blob" : "tree",
      size: content.length
    }));

    try {
      await t.step("Q4: 500 rows are one SQL statement; the response is 500 ids and no content", async () => {
        statements.length = 0;
        const reply = await post(Q4, { p: PROGRAM_ID, rows });
        const data = ok(reply, "first run") as { id: string; }[];

        const inserts = statements.filter(sql => /insert into/i.test(sql));
        assertEquals(inserts.length, 1, `expected one INSERT, got: ${inserts.length}`);
        assertStringIncludes(inserts[0].replace(/\s+/g, " "), "FROM JSONB_ARRAY_ELEMENTS(CAST($1 AS jsonb)) AS for_iter(val)");

        assertEquals(data.length, 500);
        assertEquals(Object.keys(data[0]), ["id"]);
        assert(!reply.text.includes(rows[0].content), "the response must not echo object content");
        assertEquals(await count("git_object", PROGRAM_ID), 500);
      });

      await t.step("Q4: content is the decoded bytes, size an int64, in every sampled row", async () => {
        for (const i of [0, 1, 250, 499]) {
          const stored = await pool.query("SELECT content, object_type, size FROM git_object WHERE program_id = $1 AND object_id = $2", [
            PROGRAM_ID,
            oid(i)
          ]);
          const row = stored.rows[0] as { content: Uint8Array; object_type: string; size: bigint | number; };

          assert(sameBytes(row.content, contents[i]), `row ${i}: stored content should be the decoded bytes`);
          assertEquals(row.object_type, rows[i].object_type);
          assertEquals(Number(row.size), 64);
        }
      });

      await t.step("Q4: re-running with the same rows inserts nothing and raises nothing (cache hit)", async () => {
        const again = ok(await post(Q4, { p: PROGRAM_ID, rows }), "re-run");

        assertEquals(again, []);
        assertEquals(await count("git_object", PROGRAM_ID), 500);
      });

      await t.step("Q4: a partly new batch inserts only the new rows and returns only their ids", async () => {
        const mixed = await post(Q4, {
          p: PROGRAM_ID,
          rows: [rows[0], { ...rows[2], content: encodeBase64(randomBytes(8)), object_id: oid(9000), size: 8 }, rows[1]]
        });
        const data = ok(mixed, "mixed") as { id: string; }[];

        assertEquals(data.length, 1);
        assertEquals(await count("git_object", PROGRAM_ID), 501);
      });

      await t.step("Q4: the same object ids under another program are inserted (the conflict target is composite)", async () => {
        const data = ok(await post(Q4, { p: OTHER_PROGRAM_ID, rows: rows.slice(0, 3) }), "other program") as unknown[];

        assertEquals(data.length, 3);
      });

      await t.step("Q4: a row violating the object_id regexp CHECK fails the whole statement", async () => {
        const before = await count("git_object", OTHER_PROGRAM_ID);
        const reply = await post(Q4, { p: OTHER_PROGRAM_ID, rows: [rows[10], { ...rows[11], object_id: "not-a-sha" }, rows[12]] });

        assert(reply.body.errors, `a constraint violation should be reported: ${reply.text.slice(0, 300)}`);
        assert(/check constraint/i.test(reply.body.errors[0].message), reply.body.errors[0].message);
        assertEquals(await count("git_object", OTHER_PROGRAM_ID), before, "no row of the failing statement may be kept");
      });

      await t.step("Q4: an empty array inserts nothing", async () => {
        assertEquals(ok(await post(Q4, { p: PROGRAM_ID, rows: [] }), "empty"), []);
      });

      await t.step("Q5: parents round-trip in order, including []; the re-run is a no-op", async () => {
        const commits = [
          { commit_time: 1700000000, object_id: oid(1), parents: [], tree_id: oid(101) },
          { commit_time: 1700000001, object_id: oid(2), parents: [oid(1)], tree_id: oid(102) },
          { commit_time: 1700000002, object_id: oid(3), parents: [oid(2), oid(1), oid(7), oid(4)], tree_id: oid(103) }
        ];

        assertEquals((ok(await post(Q5, { p: PROGRAM_ID, rows: commits }), "first") as unknown[]).length, 3);
        assertEquals(ok(await post(Q5, { p: PROGRAM_ID, rows: commits }), "re-run"), []);

        const stored = await pool.query("SELECT object_id, tree_id, commit_time, parents FROM git_commit WHERE program_id = $1 ORDER BY object_id", [
          PROGRAM_ID
        ]);
        assertEquals(
          (stored.rows as { commit_time: bigint | number; object_id: string; parents: string[]; tree_id: string; }[])
            .map(row => ({ ...row, commit_time: Number(row.commit_time) })),
          commits
        );
      });

      await t.step("Q5: a missing parents key is NULL, so the required property rejects the statement", async () => {
        const reply = await post(Q5, { p: OTHER_PROGRAM_ID, rows: [{ commit_time: 1, object_id: oid(50), tree_id: oid(51) }] });

        assert(reply.body.errors, "a missing required array should be reported");
        assert(/null value|not-null/i.test(reply.body.errors[0].message), reply.body.errors[0].message);
        assertEquals(await count("git_commit", OTHER_PROGRAM_ID), 0);
      });

      await t.step("array_unpack and range_unpack iterators insert one row per element", async () => {
        const names = ok(
          await post("for n in array_unpack(<array<str>>$names) union (insert Program { name := n })", { names: ["unpack-a", "unpack-b"] }),
          "array"
        ) as unknown[];
        assertEquals(names.length, 2);

        const numbered = ok(await post("for i in range_unpack(range(1, 4)) union (insert Program { name := 'range-' ++ <str>i })", {}), "range") as unknown[];
        assertEquals(numbered.length, 3);

        const stored = await pool.query("SELECT name FROM program WHERE name LIKE 'unpack-%' OR name LIKE 'range-%' ORDER BY name");
        assertEquals((stored.rows as { name: string; }[]).map(row => row.name), ["range-1", "range-2", "range-3", "unpack-a", "unpack-b"]);
      });

      await t.step("timing: Q4 with 500 × 4 KiB rows", async () => {
        const big = Array.from({ length: 500 }, (_, i) => ({
          content: encodeBase64(randomBytes(4096)),
          object_id: oid(i),
          object_type: "blob",
          size: 4096
        }));

        const started = performance.now();
        const data = ok(await post(Q4, { p: TIMED_PROGRAM_ID, rows: big }), "timed") as unknown[];
        const elapsed = performance.now() - started;

        assertEquals(data.length, 500);
        // deno-lint-ignore no-console
        console.log(`    Q4 500 × 4 KiB: ${elapsed.toFixed(0)} ms (request ${(JSON.stringify(big).length / 1048576).toFixed(2)} MiB)`);
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

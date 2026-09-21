/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: the wire format of `bytes` (D9).
 *
 * `bytes` is base64 (RFC 4648, no line breaks) in JSON, in both directions:
 *
 *   in   `<bytes>$p` / `<array<bytes>>$p` variables are decoded before they
 *        are bound; a string starting with `\x` is PostgreSQL hex input and is
 *        passed through; anything else is HTTP 400 naming the variable.
 *   out  a shape encodes in SQL (`translate(encode(…, 'base64'), E'\n', '')`);
 *        unshaped rows (`RETURNING *`, a bare path) are encoded from the
 *        driver's `Uint8Array` where rows become the response.
 *
 * What is stored is checked with raw SQL, byte for byte. Every response path
 * runs twice with the same query text, so the second run is a compiled-query
 * cache hit.
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

const SDL = `
module default {
  type Program { required name: str; }

  type GitObject {
    chunks: array<bytes>;
    content: bytes;
    required object_id: str;
    required link program -> Program;
  }

  type Tag {
    required name: str;
    required link obj -> GitObject;
    multi link objs -> GitObject;
  }
}`;

const PROGRAM_ID = "00000000-0000-0000-0000-0000000000b4";

/*** 300 bytes covering every byte value: long enough that PostgreSQL's encode() would break the line (76 characters = 57 bytes). ***/
const ALL_VALUES = Uint8Array.from({ length: 300 }, (_, i) => i & 0xff);
const GZIP_MAGIC = new Uint8Array([0x1f, 0x8b, 0x00, 0xff]);

const INSERT = "insert GitObject { program := <uuid>$p, object_id := <str>$oid, content := <bytes>$content }";
const INSERT_CHUNKS = "insert GitObject { program := <uuid>$p, object_id := <str>$oid, chunks := <array<bytes>>$chunks }";

interface Reply {
  body: { data?: unknown; error?: string; errors?: { extensions?: { code?: string; }; message: string; }[]; extensions?: { cacheHit?: boolean; }; };
  status: number;
}

function sameBytes(actual: unknown, expected: Uint8Array): boolean {
  return actual instanceof Uint8Array && actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
}

Deno.test({
  name: "PG bytes wire format: base64 in, base64 out, on every response path, on a cache miss and on a cache hit",
  ignore: !canRunPgTests(),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async t => {
    const dsn = await getTestDsn();
    const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 4, minConnections: 1 });
    await pool.initialize();
    await resetTestDatabase(pool);

    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);
    await pool.query("INSERT INTO program (id, name) VALUES ($1, 'bytes-wire-format')", [PROGRAM_ID]);

    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 4, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, schema })
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (server as any).handleRequest(request, info)
    );

    async function post(query: string, variables?: Record<string, unknown>): Promise<Reply> {
      const response = await fetch(`http://127.0.0.1:${listener.addr.port}/query`, {
        body: JSON.stringify({ query, variables }),
        headers: { "Content-Type": "application/json" },
        method: "POST"
      });
      return { body: await response.json(), status: response.status };
    }

    /*** Runs the same query text twice; the second run must be served from the compiled-query cache. ***/
    async function twice(
      query: string,
      variables: (round: number) => Record<string, unknown> | undefined,
      check: (data: unknown, round: number) => void | Promise<void>
    ) {
      for (const round of [0, 1]) {
        const reply = await post(query, variables(round));
        const label = round === 0 ? "cache miss" : "cache hit";
        assertEquals(reply.status, 200, `${label}: ${JSON.stringify(reply.body)}`);
        assertEquals(reply.body.errors, undefined, label);
        assertEquals(reply.body.extensions?.cacheHit, round === 1, label);
        await check(reply.body.data, round);
      }
    }

    async function stored(oid: string): Promise<{ chunks: Uint8Array[] | null; content: Uint8Array | null; }> {
      const result = await pool.query("SELECT content, chunks FROM git_object WHERE program_id = $1 AND object_id = $2", [PROGRAM_ID, oid]);
      assertEquals(result.rows.length, 1, `one row for ${oid}`);
      return result.rows[0] as { chunks: Uint8Array[] | null; content: Uint8Array | null; };
    }

    try {
      await t.step("insert: base64 in is stored as the bytes it stands for; the RETURNING row carries base64", async () => {
        await twice(INSERT, round => ({ content: encodeBase64(ALL_VALUES), oid: `all-${round}`, p: PROGRAM_ID }), async (data, round) => {
          assert(sameBytes((await stored(`all-${round}`)).content, ALL_VALUES), "stored bytes differ from the bytes sent");
          assertEquals((data as Record<string, unknown>).content, encodeBase64(ALL_VALUES));
        });
      });

      await t.step("insert: zero bytes and NULL are different values", async () => {
        assertEquals((await post(INSERT, { content: "", oid: "empty", p: PROGRAM_ID })).status, 200);
        assertEquals((await post(INSERT, { content: null, oid: "null", p: PROGRAM_ID })).status, 200);
        assert(sameBytes((await stored("empty")).content, new Uint8Array(0)));
        assertEquals((await stored("null")).content, null);

        const rows = (await post("select GitObject { object_id, content } filter .object_id in {'empty', 'null'} order by .object_id")).body.data;
        assertEquals(rows, [{ content: "", object_id: "empty" }, { content: null, object_id: "null" }]);
      });

      await t.step("insert: a \\x string is PostgreSQL hex input", async () => {
        const reply = await post(INSERT, { content: "\\x1f8b00ff", oid: "hex", p: PROGRAM_ID });
        assertEquals(reply.status, 200, JSON.stringify(reply.body));
        assert(sameBytes((await stored("hex")).content, GZIP_MAGIC));
        assertEquals((reply.body.data as Record<string, unknown>).content, "H4sA/w==");
      });

      await t.step("insert: invalid base64 is HTTP 400 naming the variable, and nothing is stored", async () => {
        for (const content of ["!!!not-base64!!!", { "0": 31, "1": 139 }]) {
          const reply = await post(INSERT, { content, oid: "bad", p: PROGRAM_ID });
          assertEquals(reply.status, 400, JSON.stringify(reply.body));
          assertEquals(reply.body.errors?.[0].extensions?.code, "VALIDATION_ERROR");
          assertStringIncludes(reply.body.errors![0].message, "$content");
        }
        const result = await pool.query("SELECT count(*)::int AS n FROM git_object WHERE object_id = 'bad'");
        assertEquals((result.rows[0] as { n: number; }).n, 0);
      });

      await t.step("select shape: base64 without line breaks", async () => {
        await twice(
          "select GitObject { object_id, content } filter .object_id = <str>$oid",
          round => ({ oid: round === 0 ? "all-0" : "hex" }),
          (data, round) => {
            assertEquals(data, [round === 0 ? { content: encodeBase64(ALL_VALUES), object_id: "all-0" } : { content: "H4sA/w==", object_id: "hex" }]);
          }
        );
        await twice("select GitObject { * } filter .object_id = 'all-0'", () => undefined, data => {
          assertEquals((data as Record<string, unknown>[])[0].content, encodeBase64(ALL_VALUES));
        });
      });

      await t.step("select shape: a computed element and a bytes-returning function", async () => {
        await twice("select GitObject { c := .content, h := std::sha256(.content) } filter .object_id = 'hex'", () => undefined, data => {
          // sha256 of 1f 8b 00 ff
          assertEquals(data, [{ c: "H4sA/w==", h: "at+BuhbQAcuchPG8vlu0C09rKhHxwKeThrnvEmat0pQ=" }]);
        });
      });

      await t.step("filter: a <bytes> parameter compares as bytes", async () => {
        await twice("select GitObject { object_id } filter .content = <bytes>$c", () => ({ c: "H4sA/w==" }), data => {
          assertEquals(data, [{ object_id: "hex" }]);
        });
      });

      await t.step("nested link shape, single and multi", async () => {
        const ids = await pool.query("SELECT id, object_id FROM git_object WHERE object_id IN ('all-0', 'hex') ORDER BY object_id");
        const [all, hex] = (ids.rows as { id: string; }[]).map(row => row.id);
        const tag = await pool.query("INSERT INTO tag (name, obj_id) VALUES ('v1', $1) RETURNING id", [hex]);
        const tagId = (tag.rows[0] as { id: string; }).id;
        await pool.query("INSERT INTO tag_objs (source_id, target_id) VALUES ($1, $2), ($1, $3)", [tagId, all, hex]);

        await twice("select Tag { name, obj: { content }, objs: { object_id, content } order by .object_id }", () => undefined, data => {
          assertEquals(data, [{
            name: "v1",
            obj: [{ content: "H4sA/w==" }],
            objs: [{ content: encodeBase64(ALL_VALUES), object_id: "all-0" }, { content: "H4sA/w==", object_id: "hex" }]
          }]);
        });
      });

      await t.step("select (insert …) { content }: the shape over the mutation CTE is base64", async () => {
        await twice(
          `select (${INSERT}) { object_id, content }`,
          round => ({ content: encodeBase64(ALL_VALUES), oid: `cte-${round}`, p: PROGRAM_ID }),
          async (data, round) => {
            assertEquals(data, [{ content: encodeBase64(ALL_VALUES), object_id: `cte-${round}` }]);
            assert(sameBytes((await stored(`cte-${round}`)).content, ALL_VALUES));
          }
        );
      });

      await t.step("bare RETURNING rows: update, and a mutation selected without a shape", async () => {
        await twice("update GitObject filter .object_id = 'hex' set { content := <bytes>$content }", () => ({ content: "H4sA/w==" }), data => {
          assertEquals((data as Record<string, unknown>).content, "H4sA/w==");
        });
        await twice("select (update GitObject filter .object_id = 'hex' set { object_id := 'hex' })", () => undefined, data => {
          assertEquals((data as Record<string, unknown>[])[0].content, "H4sA/w==");
        });
      });

      await t.step("unshaped select: a <bytes> parameter goes to PostgreSQL and comes back as the same base64", async () => {
        await twice("select <bytes>$b", () => ({ b: encodeBase64(ALL_VALUES) }), data => {
          assertEquals((data as Record<string, unknown>[]).map(row => Object.values(row)[0]), [encodeBase64(ALL_VALUES)]);
        });
      });

      await t.step("array<bytes>: in, RETURNING and shape, order kept; [] and NULL kept apart", async () => {
        const chunks = [ALL_VALUES, new Uint8Array(0), GZIP_MAGIC];
        const wire = chunks.map(chunk => encodeBase64(chunk));

        await twice(INSERT_CHUNKS, round => ({ chunks: wire, oid: `chunks-${round}`, p: PROGRAM_ID }), async (data, round) => {
          const row = await stored(`chunks-${round}`);
          assertEquals(row.chunks?.length, 3);
          chunks.forEach((chunk, i) => assert(sameBytes(row.chunks![i], chunk), `stored chunk ${i}`));
          assertEquals((data as Record<string, unknown>).chunks, wire);
        });

        assertEquals((await post(INSERT_CHUNKS, { chunks: [], oid: "chunks-empty", p: PROGRAM_ID })).status, 200);
        assertEquals((await post(INSERT_CHUNKS, { chunks: ["\\x1f8b00ff", "AQ=="], oid: "chunks-mixed", p: PROGRAM_ID })).status, 200);

        await twice(
          "select GitObject { object_id, chunks } filter .object_id in {'chunks-0', 'chunks-empty', 'chunks-mixed', 'hex'} order by .object_id",
          () => undefined,
          data => {
            assertEquals(data, [
              { chunks: wire, object_id: "chunks-0" },
              { chunks: [], object_id: "chunks-empty" },
              { chunks: ["H4sA/w==", "AQ=="], object_id: "chunks-mixed" },
              { chunks: null, object_id: "hex" }
            ]);
          }
        );

        const bad = await post(INSERT_CHUNKS, { chunks: ["AQ==", "!!!"], oid: "chunks-bad", p: PROGRAM_ID });
        assertEquals(bad.status, 400, JSON.stringify(bad.body));
        assertStringIncludes(bad.body.errors![0].message, "$chunks");
      });

      await t.step("2 MiB fits the default 4 MiB request limit and round-trips byte for byte", async () => {
        const big = new Uint8Array(2 * 1024 * 1024);
        for (let offset = 0; offset < big.length; offset += 65536) {
          crypto.getRandomValues(big.subarray(offset, offset + 65536));
        }

        const inserted = await post("select (insert GitObject { program := <uuid>$p, object_id := 'big', content := <bytes>$content }) { object_id }", {
          content: encodeBase64(big),
          p: PROGRAM_ID
        });
        assertEquals(inserted.status, 200, JSON.stringify(inserted.body).slice(0, 300));

        const length = await pool.query("SELECT octet_length(content) AS n FROM git_object WHERE object_id = 'big'");
        assertEquals((length.rows[0] as { n: number; }).n, 2097152);
        assert(sameBytes((await stored("big")).content, big));

        const read = await post("select GitObject { content } filter .object_id = 'big'");
        assertEquals(read.status, 200);
        assert((read.body.data as { content: string; }[])[0].content === encodeBase64(big), "2 MiB read back differs");
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

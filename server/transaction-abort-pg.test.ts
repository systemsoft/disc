/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end, over HTTP: a failed statement aborts its transaction (S11).
 *
 * PostgreSQL answers `COMMIT` on an aborted transaction with a `ROLLBACK`
 * command tag and no error, so without the server-side flag the commit
 * route reported `{ok: true}` for work that was thrown away. Here a
 * duplicate insert (23505) fails inside the transaction, the commit must be
 * answered as a failure, and the first insert must not be visible afterwards.
 * The failed statement carries its SQLSTATE (S5), and a commit PostgreSQL
 * rejects at COMMIT time (a deferred constraint) does too.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { DiscClient, DiscTransactionError, UniqueViolationError } from "../sdk/mod.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "../tests/pg-test-harness.ts";
import { EdgeQLProtocolHandler } from "./edgeql-protocol.ts";
import { HttpServer } from "./http.ts";

const FIXTURE_URL = new URL("../tests/fixtures/git-forge.disc", import.meta.url);
const PROGRAM_ID = "00000000-0000-0000-0000-0000000000a7";
const INSERT_REF = "insert GitRef { program := <uuid>$p, name := <str>$n, target := <str>$t }";

interface Envelope {
  data?: unknown;
  error?: string;
  errors?: { message: string; extensions?: Record<string, unknown>; }[];
  ok?: boolean;
  transactionId?: string;
}

interface Reply {
  body: Envelope;
  status: number;
}

Deno.test({
  name: "PG transaction abort: a failed statement poisons the transaction; commit is refused and nothing is kept",
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
    const applied = await manager.applySchema(await Deno.readTextFile(FIXTURE_URL));
    assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
    const schema = manager.getSchema();
    assert(schema);
    await pool.query("INSERT INTO program (id, name) VALUES ($1, 'txn-abort')", [PROGRAM_ID]);

    // One pool for the handler and the transaction manager, as `DiscServer` wires it.
    const server = new HttpServer({
      config: { databaseUrl: dsn, enableCors: false, enableWebsockets: false, host: "127.0.0.1", maxConnections: 4, port: 0, requestTimeout: 30000 },
      protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, schema }),
      transactionPool: pool
    });
    const listener = Deno.serve(
      { hostname: "127.0.0.1", onListen() {}, port: 0 },
      (request: Request, info: Deno.ServeHandlerInfo) =>
        // deno-lint-ignore no-explicit-any
        (server as any).handleRequest(request, info)
    );
    const baseUrl = `http://127.0.0.1:${listener.addr.port}`;

    async function post(path: string, body: unknown, transactionId?: string): Promise<Reply> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (transactionId) {
        headers["X-Transaction-ID"] = transactionId;
      }
      const response = await fetch(`${baseUrl}${path}`, { body: body === undefined ? undefined : JSON.stringify(body), headers, method: "POST" });
      return { body: await response.json(), status: response.status };
    }

    async function begin(): Promise<string> {
      const reply = await post("/transaction/begin", undefined);
      assertEquals(reply.status, 200, JSON.stringify(reply.body));
      return reply.body.transactionId!;
    }

    const refs = async (): Promise<number> => {
      const result = await pool.query("SELECT count(*)::int AS n FROM git_ref WHERE program_id = $1", [PROGRAM_ID]);
      return (result.rows[0] as { n: number; }).n;
    };

    try {
      await t.step("duplicate insert inside the transaction, then commit: 409, rolled back, first insert gone", async () => {
        const transactionId = await begin();

        const first = await post("/query", { query: INSERT_REF, variables: { n: "refs/heads/main", p: PROGRAM_ID, t: "a".repeat(40) } }, transactionId);
        assertEquals(first.status, 200, JSON.stringify(first.body));

        const duplicate = await post("/query", { query: INSERT_REF, variables: { n: "refs/heads/main", p: PROGRAM_ID, t: "b".repeat(40) } }, transactionId);
        assertEquals(duplicate.status, 400, JSON.stringify(duplicate.body));
        assertEquals(duplicate.body.errors?.[0].extensions?.sqlState, "23505");
        assertEquals(duplicate.body.errors?.[0].extensions?.constraint, "uk_git_ref_program_id_name");
        assertEquals(duplicate.body.errors?.[0].extensions?.table, "git_ref");

        const commit = await post("/transaction/commit", undefined, transactionId);
        assertEquals(commit.status, 409, JSON.stringify(commit.body));
        assertEquals(commit.body.errors?.[0].extensions?.code, "TRANSACTION_ABORTED");
        assertEquals(commit.body.ok, undefined);

        assertEquals(await refs(), 0, "the first insert must not have been kept");

        const again = await post("/transaction/commit", undefined, transactionId);
        assertEquals(again.status, 404);
      });

      await t.step("a compile error inside the transaction does not abort it", async () => {
        const transactionId = await begin();

        const inserted = await post("/query", { query: INSERT_REF, variables: { n: "refs/heads/kept", p: PROGRAM_ID, t: "c".repeat(40) } }, transactionId);
        assertEquals(inserted.status, 200, JSON.stringify(inserted.body));

        const bad = await post("/query", { query: "select NoSuchType { id }" }, transactionId);
        assertEquals(bad.status, 400);
        assertEquals(bad.body.errors?.[0].extensions?.code, "COMPILATION_ERROR");

        const commit = await post("/transaction/commit", undefined, transactionId);
        assertEquals(commit.status, 200, JSON.stringify(commit.body));
        assertEquals(await refs(), 1);
      });

      await t.step("through the SDK: the duplicate is a UniqueViolationError naming the constraint, and transaction() rejects", async () => {
        const client = new DiscClient({ baseUrl });
        let caught: unknown;

        await assertRejects(
          () =>
            client.transaction(async tx => {
              await tx.query(INSERT_REF, { n: "refs/heads/sdk", p: PROGRAM_ID, t: "d".repeat(40) });
              try {
                await tx.query(INSERT_REF, { n: "refs/heads/sdk", p: PROGRAM_ID, t: "e".repeat(40) });
              } catch (error) {
                caught = error;
              }
            }),
          DiscTransactionError
        );

        assertInstanceOf(caught, UniqueViolationError);
        assertEquals(caught.constraint, "uk_git_ref_program_id_name");
        assertEquals(caught.table, "git_ref");
        assertEquals(caught.sqlState, "23505");

        const kept = await pool.query("SELECT count(*)::int AS n FROM git_ref WHERE name = 'refs/heads/sdk'");
        assertEquals((kept.rows[0] as { n: number; }).n, 0);
      });

      await t.step("a constraint deferred to COMMIT is reported as a failed commit with its SQLSTATE, and the id is gone", async () => {
        // PostgreSQL only checks a DEFERRABLE INITIALLY DEFERRED constraint at COMMIT.
        await pool.query("CREATE TABLE deferred_check (n int, CONSTRAINT deferred_unique UNIQUE (n) DEFERRABLE INITIALLY DEFERRED)");
        const transactionId = await begin();

        // The statements pass; the transaction is not aborted.
        // deno-lint-ignore no-explicit-any
        const transactionManager = (server as any).transaction_manager;
        await transactionManager.get_transaction_connection(transactionId).execute("INSERT INTO deferred_check (n) VALUES (1), (1)");
        assertEquals(transactionManager.getTransaction(transactionId).aborted, undefined);

        const commit = await post("/transaction/commit", undefined, transactionId);
        assertEquals(commit.status, 500, JSON.stringify(commit.body));
        assertEquals(commit.body.errors?.[0].extensions?.code, "EXECUTION_ERROR");
        assertEquals(commit.body.errors?.[0].extensions?.sqlState, "23505");
        assertEquals(commit.body.errors?.[0].extensions?.constraint, "deferred_unique");
        assertEquals(commit.body.errors?.[0].extensions?.table, "deferred_check");

        const again = await post("/transaction/commit", undefined, transactionId);
        assertEquals(again.status, 404);

        const kept = await pool.query("SELECT count(*)::int AS n FROM deferred_check");
        assertEquals((kept.rows[0] as { n: number; }).n, 0);
      });
    } finally {
      await listener.shutdown();
      await resetTestDatabase(pool);
      await pool.close();
    }
  }
});

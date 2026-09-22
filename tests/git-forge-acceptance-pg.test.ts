/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Git-forge consumer acceptance test.
 *
 * Encodes the contract of Disc's first real consumer — a code forge that
 * stores git objects and refs in Disc and serves `git clone` / `git push` —
 * as one test per contract row (Q1–Q10) plus the by-name variable binding
 * case. Plan: thoughts/shared/plans/2026-09-21-git-forge-consumer-readiness.md.
 *
 * Every request goes through the real stack: `HttpServer.handleRequest` over
 * `Deno.serve`, a real `EdgeQLProtocolHandler` (access policies on) sharing
 * its pool with the transaction manager, and a real `AuthMiddleware` backed
 * by `AuthProvider`. Q8 and Q9 drive it through the SDK; Q8 uses a client
 * generated from the fixture schema, the way `disc codegen` would.
 *
 * Rows that are not due yet are listed in `PENDING`; the phase that turns a
 * row green deletes its entry. Run with `GIT_FORGE_ALL=1` to see every row.
 *
 * Requires PostgreSQL: set DISC_PG_TEST_URL or DISC_PG_AUTO=1.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { encodeBase64 } from "@std/encoding/base64";
import { AuthMiddleware } from "../auth/middleware.ts";
import { PgDatabaseAdapter } from "../auth/pg-database-adapter.ts";
import { AuthProvider } from "../auth/provider.ts";
import { emitTypeScript, schemaToIR } from "../codegen/mod.ts";
import type { Schema } from "../compiler/context.ts";
import { ConnectionPool } from "../lib/connection-pool.ts";
import { DatabaseConnection } from "../lib/database.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { DiscClient } from "../sdk/mod.ts";
import type { DiscClientConfig } from "../sdk/mod.ts";
import { EdgeQLProtocolHandler } from "../server/edgeql-protocol.ts";
import { HttpServer } from "../server/http.ts";
import type { ServerConfig } from "../server/types.ts";
import { canRunPgTests, getTestDsn, resetTestDatabase } from "./pg-test-harness.ts";

const RUN_PG = canRunPgTests();

/**
 * Rows that are known red. `GIT_FORGE_ALL=1` empties the set so the whole
 * contract runs. A phase is not done until its entries are deleted here.
 */
const PENDING = new Set<string>(
  Deno.env.get("GIT_FORGE_ALL") === "1" ? [] : [
    "Q9", // Phase 7 (S3, S11): a failed commit is reported as success
    "Q10" // Phase 6 (D10): no service credential; nested mutations skip policies until Phase 1 (S10)
  ]
);

const FIXTURE_URL = new URL("./fixtures/git-forge.disc", import.meta.url);
const SDK_URL = new URL("../sdk/mod.ts", import.meta.url).href;
const JWT_SECRET = "git-forge-acceptance-jwt-secret-at-least-32-bytes";

/** What Phase 6 will read from `ServerConfig.serviceToken` / `DISC_SERVICE_TOKEN`. */
const SERVICE_TOKEN = "git-forge-acceptance-service-token-0123456789abcdef";

const TEST_PASSWORD = "correct-horse-battery-staple";

const Q1_REF_CAS_UPDATE = "select (update GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old " +
  "set { target := <str>$new }) { id }";

const Q2_REF_CAS_DELETE = "select (delete GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old) { id }";

const Q3_REF_CREATE = "select (insert GitRef { program := <Program><uuid>$p, name := <str>$n, target := <str>$t } " +
  "unless conflict on ((.program, .name))) { id }";

const Q3_REF_CREATE_SUBSELECT = "select (insert GitRef { program := (select Program filter .id = <uuid>$p), name := <str>$n, target := <str>$t } " +
  "unless conflict on ((.program, .name))) { id }";

const Q4_BULK_OBJECTS = "with rows := <json>$rows for item in json_array_unpack(rows) union (" +
  "insert GitObject { program := <Program><uuid>$p, object_id := <str>item['object_id'], object_type := <str>item['object_type'], " +
  "size := <int64>item['size'], content := std::base64_decode(<str>item['content']) } " +
  "unless conflict on ((.program, .object_id)))";

const Q5_BULK_COMMITS = "with rows := <json>$rows for item in json_array_unpack(rows) union (" +
  "insert GitCommit { program := <Program><uuid>$p, object_id := <str>item['object_id'], tree_id := <str>item['tree_id'], " +
  "commit_time := <int64>item['commit_time'], parents := <array<str>>item['parents'] } " +
  "unless conflict on ((.program, .object_id)))";

const Q6_BATCH_READ = "select GitObject { object_id, object_type, size, content } " +
  "filter .program.id = <uuid>$p and .object_id in array_unpack(<array<str>>$ids)";

const Q7_CASCADE = "delete Program filter .id = <uuid>$p";

/*** HARNESS ------------------------------------------ ***/

interface QueryError {
  extensions?: Record<string, unknown>;
  message: string;
}

interface QueryResult {
  body: string;
  data: unknown;
  errors?: QueryError[];
  status: number;
}

interface TestUser {
  id: string;
  token: string;
}

interface Harness {
  baseUrl: string;
  pool: ConnectionPool;
  schema: Schema;
  /** Register an ordinary user (no roles) and return its id and JWT. */
  user: (email: string) => Promise<TestUser>;
}

type Row = Record<string, unknown>;

/**
 * Boot the stack under test on a clean database, run `fn`, tear it all down.
 *
 * One `ConnectionPool` serves the protocol handler, the transaction manager
 * and the test's own raw SQL — sharing it between the first two is what makes
 * `X-Transaction-ID` queries run on the transaction's held connection.
 */
async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const dsn = await getTestDsn();
  const pool = new ConnectionPool({ cleanupInterval: 0, connectionString: dsn, maxConnections: 8, minConnections: 1 });
  await pool.initialize();
  await resetTestDatabase(pool);

  const manager = new SchemaManager({ pool });
  await manager.initialize();
  const applied = await manager.applySchema(await Deno.readTextFile(FIXTURE_URL));
  assert(applied.ok, `applySchema failed: ${JSON.stringify(applied)}`);
  const schema = manager.getSchema();
  assert(schema, "schema should exist after applySchema");

  /*** Auth keeps its own connection, as `DiscServer.initializeAuth` does. bcrypt cost is lowered
       because the test registers users, not because the handler behaves differently. ***/
  const authConnection = new DatabaseConnection(dsn);
  await authConnection.connect();
  const provider = new AuthProvider({ bcryptRounds: 4, jwtSecret: JWT_SECRET }, new PgDatabaseAdapter(authConnection));
  await provider.initialize();

  const config: ServerConfig & { serviceToken: string; } = {
    databaseUrl: dsn,
    enableAccessPolicies: true,
    enableCors: false,
    enableWebsockets: false,
    host: "127.0.0.1",
    maxConnections: 8,
    port: 0,
    requestTimeout: 30000,
    serviceToken: SERVICE_TOKEN
  };

  const server = new HttpServer({
    authMiddleware: new AuthMiddleware(provider),
    config,
    protocolHandler: new EdgeQLProtocolHandler({ connectionPool: pool, enableAccessPolicies: true, schema }),
    transactionPool: pool
  });

  const listener = Deno.serve(
    { hostname: "127.0.0.1", onListen() {}, port: 0 },
    (request: Request, info: Deno.ServeHandlerInfo) =>
      // deno-lint-ignore no-explicit-any
      (server as any).handleRequest(request, info)
  );

  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${listener.addr.port}`,
    pool,
    schema,
    user: async (email: string) => {
      const registered = await provider.register({ email, password: TEST_PASSWORD });
      return { id: registered.user.id, token: registered.token };
    }
  };

  try {
    await fn(harness);
  } finally {
    await listener.shutdown();
    await authConnection.close();
    await resetTestDatabase(pool);
    await pool.close();
  }
}

/** POST /query. `variables` is serialized as given, so its key order reaches the server intact. */
async function runQuery(h: Harness, query: string, variables?: Record<string, unknown>, token?: string): Promise<QueryResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (token)
    headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${h.baseUrl}/query`, {
    body: JSON.stringify(variables ? { query, variables } : { query }),
    headers,
    method: "POST"
  });

  const body = await response.text();
  const parsed = JSON.parse(body) as { data?: unknown; error?: string; errors?: QueryError[]; };
  const errors = parsed.errors ?? (parsed.error ? [{ message: parsed.error }] : undefined);

  return { body, data: parsed.data, errors, status: response.status };
}

/** The row set of a query that must have succeeded. */
function rowsOf(result: QueryResult): Row[] {
  assert(!result.errors, `query failed: ${result.errors?.[0]?.message}`);
  assert(Array.isArray(result.data), `expected a row set, got ${JSON.stringify(result.data)}`);
  return result.data as Row[];
}

function assertSucceeded(result: QueryResult): void {
  assert(!result.errors, `query failed: ${result.errors?.[0]?.message}`);
}

/** An ordinary caller was refused: a policy denial, or a row set the policy filtered to nothing. */
function assertDenied(result: QueryResult, what: string): void {
  if (result.errors) {
    const notDenial = result.errors.find(error => !/not allowed/i.test(error.message));
    assert(!notDenial, `${what}: expected an access denial, got: ${notDenial?.message}`);
    return;
  }

  assertEquals(result.data, [], `${what}: expected the policy to leave no rows`);
}

async function sql<T = Row>(h: Harness, query: string, params: unknown[] = []): Promise<T[]> {
  const result = await h.pool.query(query, params);
  return result.rows as T[];
}

async function count(h: Harness, table: string, where = "TRUE", params: unknown[] = []): Promise<number> {
  const rows = await sql<{ n: number; }>(h, `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params);
  return rows[0].n;
}

async function seedProgram(h: Harness, name: string): Promise<string> {
  const rows = await sql<{ id: string; }>(h, "INSERT INTO program (name) VALUES ($1) RETURNING id", [name]);
  return rows[0].id;
}

async function seedRef(h: Harness, program: string, name: string, target: string): Promise<string> {
  const rows = await sql<{ id: string; }>(
    h,
    "INSERT INTO git_ref (program_id, name, target) VALUES ($1, $2, $3) RETURNING id",
    [program, name, target]
  );
  return rows[0].id;
}

async function seedObject(h: Harness, program: string, objectId: string, content: Uint8Array): Promise<void> {
  await sql(
    h,
    "INSERT INTO git_object (program_id, object_id, object_type, size, content) VALUES ($1, $2, 'blob', $3, $4)",
    [program, objectId, content.length, content]
  );
}

async function refTarget(h: Harness, refId: string): Promise<string | undefined> {
  const rows = await sql<{ target: string; }>(h, "SELECT target FROM git_ref WHERE id = $1", [refId]);
  return rows[0]?.target;
}

/** A 40-character lowercase hex string, unique per `n` — shaped like a git object id. */
function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);

  /*** `getRandomValues` fills at most 65536 bytes per call. ***/
  for (let offset = 0; offset < length; offset += 65536)
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, length)));

  return bytes;
}

/** Byte equality without `assertEquals`, whose diff of two multi-megabyte arrays is unreadable and slow. */
function sameBytes(actual: unknown, expected: Uint8Array): boolean {
  if (!(actual instanceof Uint8Array) || actual.length !== expected.length)
    return false;

  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i])
      return false;
  }

  return true;
}

function describeValue(value: unknown): string {
  if (value instanceof Uint8Array)
    return `Uint8Array(${value.length})`;

  const text = JSON.stringify(value) ?? String(value);
  return `${typeof value} ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`;
}

/*** GENERATED CLIENT --------------------------------- ***/

interface ForgeObjectBuilder {
  filter(filter: Record<string, unknown>): Promise<Row[]>;
  insert(data: Record<string, unknown>): Promise<unknown>;
}

interface ForgeClient extends DiscClient {
  gitobject: ForgeObjectBuilder;
}

/**
 * Generate the typed client for the fixture schema into a temp directory and
 * import it, pointing its SDK import at this repo's `sdk/` so the test runs
 * the SDK at HEAD rather than the copy embedded in a released binary.
 */
async function withGeneratedClient(h: Harness, token: string, fn: (client: ForgeClient) => Promise<void>): Promise<void> {
  const outputDir = await Deno.makeTempDir({ prefix: "disc-git-forge-client-" });

  try {
    const files = emitTypeScript(schemaToIR(h.schema), {
      formatOutput: false,
      includeClient: true,
      includeMutations: true,
      includeQueryBuilders: true,
      outputDir,
      schemaSource: FIXTURE_URL.pathname,
      sdkImportBase: SDK_URL,
      target: "client"
    });

    for (const file of files)
      await Deno.writeTextFile(file.path, file.content);

    const generated = await import(new URL(`file://${outputDir}/client.ts`).href) as {
      DiscClient: new(config: DiscClientConfig) => ForgeClient;
    };

    const client = new generated.DiscClient({ baseUrl: h.baseUrl });
    client.setAuthToken(token);
    await fn(client);
  } finally {
    await Deno.remove(outputDir, { recursive: true });
  }
}

/*** TESTS -------------------------------------------- ***/

function acceptance(row: string, name: string, fn: (t: Deno.TestContext, h: Harness) => Promise<void>): void {
  Deno.test({
    fn: t => withHarness(h => fn(t, h)),
    ignore: !RUN_PG || PENDING.has(row),
    name: `git-forge ${row}: ${name}`,
    sanitizeOps: false,
    sanitizeResources: false
  });
}

acceptance("by-name", "variables bind by name, not by key order", async (_t, h) => {
  const program = await seedProgram(h, "by-name");
  const ref = await seedRef(h, program, "refs/heads/main", oid(1));

  /*** A CAS keyed on `.id` compiles today, so this row isolates binding from the mutation work in
       Phase 3. Keys are sent in the reverse of the order the compiler numbers them. Two rounds: the
       second is served from the compiled-query cache, which must remember the names too. ***/
  const query = "update GitRef filter .id = <uuid>$id and .target = <str>$old set { target := <str>$new }";

  for (const [round, from, to] of [["cache miss", oid(1), oid(2)], ["cache hit", oid(2), oid(3)]]) {
    const result = await runQuery(h, query, { new: to, old: from, id: ref });
    assert(!result.errors, `${round}: ${result.errors?.[0]?.message}`);
    assertEquals(await refTarget(h, ref), to, `${round}: target should have moved`);
  }
});

acceptance("Q1", "ref compare-and-swap", async (t, h) => {
  const program = await seedProgram(h, "q1");
  const name = "refs/heads/main";
  const ref = await seedRef(h, program, name, oid(1));

  await t.step("a matching old target swaps and returns the ref", async () => {
    const rows = rowsOf(await runQuery(h, Q1_REF_CAS_UPDATE, { p: program, n: name, old: oid(1), new: oid(2) }));
    assertEquals(rows, [{ id: ref }]);
    assertEquals(await refTarget(h, ref), oid(2));
  });

  await t.step("a stale old target returns [] and changes nothing", async () => {
    const rows = rowsOf(await runQuery(h, Q1_REF_CAS_UPDATE, { p: program, n: name, old: oid(1), new: oid(9) }));
    assertEquals(rows, []);
    assertEquals(await refTarget(h, ref), oid(2));
  });

  await t.step("another program's ref of the same name is untouched", async () => {
    const other = await seedProgram(h, "q1-other");
    const otherRef = await seedRef(h, other, name, oid(2));
    rowsOf(await runQuery(h, Q1_REF_CAS_UPDATE, { p: program, n: name, old: oid(2), new: oid(3) }));
    assertEquals(await refTarget(h, ref), oid(3));
    assertEquals(await refTarget(h, otherRef), oid(2));
  });

  await t.step("variables sent in the key order {new, old, n, p} behave identically", async () => {
    const rows = rowsOf(await runQuery(h, Q1_REF_CAS_UPDATE, { new: oid(4), old: oid(3), n: name, p: program }));
    assertEquals(rows, [{ id: ref }]);
    assertEquals(await refTarget(h, ref), oid(4));
  });

  await t.step("of 20 concurrent callers with the same old target, exactly one wins", async () => {
    const current = await refTarget(h, ref);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) => runQuery(h, Q1_REF_CAS_UPDATE, { p: program, n: name, old: current, new: oid(1000 + i) }))
    );
    const winners = attempts
      .map((attempt, i) => ({ i, rows: rowsOf(attempt) }))
      .filter(attempt => attempt.rows.length > 0);

    assertEquals(winners.length, 1, "exactly one caller should see a non-empty result");
    assertEquals(await refTarget(h, ref), oid(1000 + winners[0].i), "the stored target should be the winner's");
  });
});

acceptance("Q2", "ref compare-and-swap delete", async (t, h) => {
  const program = await seedProgram(h, "q2");
  const name = "refs/heads/topic";
  const ref = await seedRef(h, program, name, oid(1));

  await t.step("a stale old target returns [] and deletes nothing", async () => {
    const rows = rowsOf(await runQuery(h, Q2_REF_CAS_DELETE, { p: program, n: name, old: oid(9) }));
    assertEquals(rows, []);
    assertEquals(await refTarget(h, ref), oid(1));
  });

  await t.step("of 20 concurrent callers with the matching old target, exactly one deletes", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => runQuery(h, Q2_REF_CAS_DELETE, { p: program, n: name, old: oid(1) }))
    );
    const winners = attempts
      .map(rowsOf)
      .filter(rows => rows.length > 0);

    assertEquals(winners, [[{ id: ref }]]);
    assertEquals(await refTarget(h, ref), undefined, "the ref should be gone");
  });
});

acceptance("Q3", "ref create-if-absent", async (t, h) => {
  const program = await seedProgram(h, "q3");

  await t.step("the database enforces exclusive on ((.program, .name))", async () => {
    await seedRef(h, program, "refs/heads/unique", oid(1));
    await assertRejects(() => seedRef(h, program, "refs/heads/unique", oid(2)), Error, "duplicate key");
    await seedRef(h, await seedProgram(h, "q3-other"), "refs/heads/unique", oid(1));
  });

  const variants = [
    ["<Program><uuid>$p", Q3_REF_CREATE, "refs/heads/cast"],
    ["(select Program filter .id = <uuid>$p)", Q3_REF_CREATE_SUBSELECT, "refs/heads/subselect"]
  ];

  for (const [variant, query, name] of variants) {
    await t.step(`program := ${variant}: inserts once, then returns [] on conflict`, async () => {
      const created = rowsOf(await runQuery(h, query, { p: program, n: name, t: oid(1) }));
      assertEquals(created.length, 1);
      assertEquals(typeof created[0].id, "string");

      const conflicted = rowsOf(await runQuery(h, query, { p: program, n: name, t: oid(2) }));
      assertEquals(conflicted, []);

      const stored = await sql<{ id: string; target: string; }>(
        h,
        "SELECT id, target FROM git_ref WHERE program_id = $1 AND name = $2",
        [program, name]
      );
      assertEquals(stored, [{ id: created[0].id as string, target: oid(1) }]);
    });
  }
});

acceptance("Q4", "bulk object insert from JSON", async (t, h) => {
  const program = await seedProgram(h, "q4");
  const contents = Array.from({ length: 500 }, () => randomBytes(64));
  const rows = contents.map((content, i) => ({
    content: encodeBase64(content),
    object_id: oid(i),
    object_type: i % 2 === 0 ? "blob" : "tree",
    size: content.length
  }));

  await t.step("500 rows arrive in one request, without shipping content back", async () => {
    const result = await runQuery(h, Q4_BULK_OBJECTS, { p: program, rows });
    assertSucceeded(result);
    assert(!result.body.includes(rows[0].content), "the response must not echo object content");
    assertEquals(await count(h, "git_object", "program_id = $1", [program]), 500);

    for (const i of [0, 1, 499]) {
      const stored = await sql<{ content: Uint8Array; object_type: string; size: bigint | number; }>(
        h,
        "SELECT content, object_type, size FROM git_object WHERE program_id = $1 AND object_id = $2",
        [program, oid(i)]
      );
      assertEquals(stored.length, 1);
      assert(sameBytes(stored[0].content, contents[i]), `row ${i}: stored content should be the decoded bytes`);
      assertEquals(stored[0].object_type, rows[i].object_type);
      assertEquals(Number(stored[0].size), 64);
    }
  });

  await t.step("re-running with the same rows inserts nothing and raises nothing", async () => {
    assertSucceeded(await runQuery(h, Q4_BULK_OBJECTS, { p: program, rows }));
    assertEquals(await count(h, "git_object", "program_id = $1", [program]), 500);
  });

  await t.step("a row violating the object_id constraint fails the whole statement", async () => {
    const other = await seedProgram(h, "q4-invalid");
    const result = await runQuery(h, Q4_BULK_OBJECTS, { p: other, rows: [rows[0], { ...rows[1], object_id: "not-a-sha" }] });
    assert(result.errors, "a constraint violation should be reported");
    assert(/chk_git_object_object_id|check constraint/i.test(result.errors[0].message), `unexpected error: ${result.errors[0].message}`);
    assertEquals(await count(h, "git_object", "program_id = $1", [other]), 0);
  });
});

acceptance("Q5", "bulk commit insert from JSON", async (_t, h) => {
  const program = await seedProgram(h, "q5");
  const rows = [
    { commit_time: 1700000000, object_id: oid(1), parents: [], tree_id: oid(101) },
    { commit_time: 1700000001, object_id: oid(2), parents: [oid(1)], tree_id: oid(102) },
    { commit_time: 1700000002, object_id: oid(3), parents: [oid(2), oid(1)], tree_id: oid(103) }
  ];

  assertSucceeded(await runQuery(h, Q5_BULK_COMMITS, { p: program, rows }));
  assertSucceeded(await runQuery(h, Q5_BULK_COMMITS, { p: program, rows }));

  const stored = await sql<{ commit_time: bigint | number; object_id: string; parents: string[]; tree_id: string; }>(
    h,
    "SELECT object_id, tree_id, commit_time, parents FROM git_commit WHERE program_id = $1 ORDER BY object_id",
    [program]
  );

  assertEquals(
    stored.map(row => ({ ...row, commit_time: Number(row.commit_time) })),
    rows.map(row => ({ commit_time: row.commit_time, object_id: row.object_id, parents: row.parents, tree_id: row.tree_id }))
  );
});

acceptance("Q6", "batch read by object id", async (t, h) => {
  const program = await seedProgram(h, "q6");
  const other = await seedProgram(h, "q6-other");
  const contents = [new Uint8Array([0x1f, 0x8b, 0x00, 0xff]), new Uint8Array(0), randomBytes(300)];

  for (const [i, content] of contents.entries())
    await seedObject(h, program, oid(i), content);

  await seedObject(h, other, oid(0), new Uint8Array([1, 2, 3]));

  const rows = rowsOf(await runQuery(h, Q6_BATCH_READ, { p: program, ids: [oid(2), oid(0), oid(77)] }))
    .sort((a, b) => String(a.object_id).localeCompare(String(b.object_id)));

  await t.step("returns exactly the requested rows of that program", () => {
    assertEquals(
      rows.map(row => ({ object_id: row.object_id, object_type: row.object_type, size: row.size })),
      [{ object_id: oid(0), object_type: "blob", size: 4 }, { object_id: oid(2), object_type: "blob", size: 300 }]
    );
  });

  await t.step("content arrives as base64", () => {
    assertEquals(rows.map(row => row.content), [encodeBase64(contents[0]), encodeBase64(contents[2])]);
  });
});

acceptance("Q7", "deleting a program cascades to its git data", async (_t, h) => {
  const program = await seedProgram(h, "q7");
  const kept = await seedProgram(h, "q7-kept");

  for (const owner of [program, kept]) {
    await seedRef(h, owner, "refs/heads/main", oid(1));
    await seedObject(h, owner, oid(1), new Uint8Array([1]));
    await sql(
      h,
      "INSERT INTO git_commit (program_id, object_id, tree_id, commit_time, parents) VALUES ($1, $2, $3, 1, '{}')",
      [owner, oid(1), oid(2)]
    );
  }

  assertSucceeded(await runQuery(h, Q7_CASCADE, { p: program }));

  for (const table of ["git_ref", "git_object", "git_commit"]) {
    assertEquals(await count(h, table, "program_id = $1", [program]), 0, `${table} rows of the deleted program`);
    assertEquals(await count(h, table, "program_id = $1", [kept]), 1, `${table} rows of the other program`);
  }

  assertEquals(await count(h, "program", "id = $1", [program]), 0);
});

acceptance("Q8", "bytes round-trip through the generated client", async (t, h) => {
  const program = await seedProgram(h, "q8");
  const user = await h.user("q8@example.com");
  const cases: Array<[string, Uint8Array]> = [
    ["0 bytes", new Uint8Array(0)],
    ["1 byte", new Uint8Array([0x80])],
    ["all 256 byte values", Uint8Array.from({ length: 256 }, (_, i) => i)],
    ["2 MiB random", randomBytes(2 * 1024 * 1024)]
  ];

  await withGeneratedClient(h, user.token, async client => {
    for (const [i, [label, bytes]] of cases.entries()) {
      await t.step(label, async () => {
        await client.gitobject.insert({ content: bytes, object_id: oid(i), object_type: "blob", program, size: bytes.length });

        const stored = await sql<{ content: Uint8Array; }>(
          h,
          "SELECT content FROM git_object WHERE program_id = $1 AND object_id = $2",
          [program, oid(i)]
        );
        assertEquals(stored.length, 1, "the insert should have stored one row");
        assert(sameBytes(stored[0].content, bytes), `stored ${describeValue(stored[0].content)}, expected the ${bytes.length} bytes sent`);

        const read = await client.gitobject.filter({ object_id: oid(i) });
        assertEquals(read.length, 1);
        assert(sameBytes(read[0].content, bytes), `read back ${describeValue(read[0].content)}, expected Uint8Array(${bytes.length})`);
      });
    }
  });
});

acceptance("Q9", "multi-statement atomicity through the SDK", async (t, h) => {
  const user = await h.user("q9@example.com");
  const client = new DiscClient({ baseUrl: h.baseUrl });
  client.setAuthToken(user.token);

  const insertProgram = "insert Program { name := <str>$name }";
  const programs = (prefix: string) => count(h, "program", "name LIKE $1", [`${prefix}%`]);

  await t.step("two inserts commit together", async () => {
    await client.transaction(async tx => {
      await tx.query(insertProgram, { name: "q9-ok-1" });
      await tx.query(insertProgram, { name: "q9-ok-2" });
    });
    assertEquals(await programs("q9-ok-"), 2);
  });

  await t.step("a throw between two inserts leaves neither row", async () => {
    const failBetween = true;

    await assertRejects(
      () =>
        client.transaction(async tx => {
          await tx.query(insertProgram, { name: "q9-throw-1" });

          if (failBetween)
            throw new Error("boom");

          await tx.query(insertProgram, { name: "q9-throw-2" });
        }),
      Error,
      "boom"
    );
    assertEquals(await programs("q9-throw-"), 0);
  });

  await t.step("commit failure is reported as failure: the server no longer knows the transaction", async () => {
    await assertRejects(() =>
      client.transaction(async tx => {
        await tx.query(insertProgram, { name: "q9-lost-1" });

        /*** End the transaction behind the SDK's back, as a server restart or the abandoned-
             transaction sweep would. The SDK's own commit then gets a 404. ***/
        const response = await fetch(`${h.baseUrl}/transaction/rollback`, {
          headers: { Authorization: `Bearer ${user.token}`, "X-Transaction-ID": tx.getId() },
          method: "POST"
        });
        await response.body?.cancel();
        assertEquals(response.status, 200);
      })
    );
    assertEquals(await programs("q9-lost-"), 0);
  });

  await t.step("commit failure is reported as failure: a caught statement error has aborted the transaction", async () => {
    let statementFailed = false;

    await assertRejects(() =>
      client.transaction(async tx => {
        await tx.query(insertProgram, { name: "q9-aborted-1" });

        try {
          await tx.query("select <int64><str>$x", { x: "not-a-number" });
        } catch {
          statementFailed = true;
        }
      })
    );
    assert(statementFailed, "the bad cast should have failed inside the transaction");
    assertEquals(await programs("q9-aborted-"), 0);
  });
});

acceptance("Q10", "service credential bypasses policies; ordinary users are denied", async (t, h) => {
  const user = await h.user("q10-user@example.com");
  const owner = await h.user("q10-owner@example.com");

  const lockedNames = async () => (await sql<{ name: string; }>(h, "SELECT name FROM locked ORDER BY name")).map(row => row.name);
  const resetLocked = async (...names: string[]) => {
    await sql(h, "DELETE FROM locked");

    for (const name of names)
      await sql(h, "INSERT INTO locked (name) VALUES ($1)", [name]);
  };

  const forms = {
    q1: "select (update Locked filter .name = <str>$n set { name := <str>$new }) { id }",
    q1With: "with m := (update Locked filter .name = <str>$n set { name := <str>$new }) select m { id }",
    q2: "select (delete Locked filter .name = <str>$n) { id }",
    q2With: "with m := (delete Locked filter .name = <str>$n) select m { id }",
    q3: "select (insert Locked { name := <str>$n } unless conflict) { id }",
    q3With: "with m := (insert Locked { name := <str>$n }) select m { id }",
    q4: "with rows := <json>$rows for item in json_array_unpack(rows) union (insert Locked { name := <str>item['name'] })"
  };

  await t.step("service credential: reads a type closed to everyone", async () => {
    await resetLocked("secret");
    const rows = rowsOf(await runQuery(h, "select Locked { name }", undefined, SERVICE_TOKEN));
    assertEquals(rows, [{ name: "secret" }]);
  });

  await t.step("service credential: the Q1–Q4 query forms succeed", async () => {
    await resetLocked("a");

    assertEquals(rowsOf(await runQuery(h, forms.q3, { n: "b" }, SERVICE_TOKEN)).length, 1);
    assertEquals(rowsOf(await runQuery(h, forms.q1, { n: "a", new: "a2" }, SERVICE_TOKEN)).length, 1);
    assertEquals(rowsOf(await runQuery(h, forms.q2, { n: "b" }, SERVICE_TOKEN)).length, 1);
    assertSucceeded(await runQuery(h, forms.q4, { rows: [{ name: "c" }, { name: "d" }] }, SERVICE_TOKEN));
    assertEquals(await lockedNames(), ["a2", "c", "d"]);
  });

  await t.step("ordinary user: a plain select is filtered to nothing", async () => {
    await resetLocked("secret");
    assertDenied(await runQuery(h, "select Locked { name }", undefined, user.token), "select Locked");
  });

  const denied: Array<[string, string, Record<string, unknown>]> = [
    ["Q1 form, select (update …)", forms.q1, { n: "secret", new: "changed" }],
    ["Q1 form, with m := (update …)", forms.q1With, { n: "secret", new: "changed" }],
    ["Q2 form, select (delete …)", forms.q2, { n: "secret" }],
    ["Q2 form, with m := (delete …)", forms.q2With, { n: "secret" }],
    ["Q3 form, select (insert …)", forms.q3, { n: "intruder" }],
    ["Q3 form, with m := (insert …)", forms.q3With, { n: "intruder" }],
    ["Q4 form, for … union (insert …)", forms.q4, { rows: [{ name: "intruder" }] }]
  ];

  for (const [label, query, variables] of denied) {
    await t.step(`ordinary user: ${label} is denied`, async () => {
      await resetLocked("secret");
      const result = await runQuery(h, query, variables, user.token);
      assertEquals(await lockedNames(), ["secret"], "an ordinary user must not be able to write a Locked row");
      assertDenied(result, label);
    });
  }

  const ownedForms: Array<[string, string, Record<string, unknown>]> = [
    ["select (update …)", "select (update Doc filter .title = <str>$t set { title := <str>$new }) { id }", { t: "theirs", new: "taken" }],
    ["with m := (update …)", "with m := (update Doc filter .title = <str>$t set { title := <str>$new }) select m { id }", { t: "theirs", new: "taken" }],
    ["select (delete …)", "select (delete Doc filter .title = <str>$t) { id }", { t: "theirs" }],
    ["with m := (delete …)", "with m := (delete Doc filter .title = <str>$t) select m { id }", { t: "theirs" }]
  ];

  for (const [label, query, variables] of ownedForms) {
    await t.step(`ordinary user: ${label} cannot reach another user's row`, async () => {
      await sql(h, "DELETE FROM doc");
      await sql(h, "INSERT INTO doc (owner_id, title) VALUES ($1, 'theirs')", [owner.id]);

      const result = await runQuery(h, query, variables, user.token);
      assertEquals(
        await sql(h, "SELECT owner_id, title FROM doc"),
        [{ owner_id: owner.id, title: "theirs" }],
        "the owner's row must be unchanged"
      );
      assertDenied(result, label);
    });
  }

  await t.step("ordinary user: the same forms still reach the caller's own row", async () => {
    await sql(h, "DELETE FROM doc");
    await sql(h, "INSERT INTO doc (owner_id, title) VALUES ($1, 'theirs')", [owner.id]);

    for (const [label, query, variables] of ownedForms) {
      const rows = rowsOf(await runQuery(h, query, variables, owner.token));
      assertEquals(rows.length, 1, `${label} as the owner`);
      await sql(h, "DELETE FROM doc");
      await sql(h, "INSERT INTO doc (owner_id, title) VALUES ($1, 'theirs')", [owner.id]);
    }
  });
});

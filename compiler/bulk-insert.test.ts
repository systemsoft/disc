/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Bulk insert from a set-returning iterator (D7):
 *
 *   for item in json_array_unpack(rows) union (insert T { … })
 *
 * compiles to ONE statement, whatever the number of rows:
 *
 *   INSERT INTO t (cols) SELECT <exprs> FROM jsonb_array_elements(…) AS for_iter(val) [ON CONFLICT …] RETURNING id
 *
 * Q4 and Q5 are the queries of tests/git-forge-acceptance-pg.test.ts as written
 * in the consumer's contract, against the same fixture.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AccessContext } from "../access/types.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { buildParameterTypeMap, describeResult, EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const FIXTURE_URL = new URL("../tests/fixtures/git-forge.disc", import.meta.url);
const USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";

const Q4 = "with rows := <json>$rows for item in json_array_unpack(rows) union (" +
  "insert GitObject { program := <Program><uuid>$p, object_id := <str>item['object_id'], object_type := <str>item['object_type'], " +
  "size := <int64>item['size'], content := std::base64_decode(<str>item['content']) } " +
  "unless conflict on ((.program, .object_id)))";

const Q5 = "with rows := <json>$rows for item in json_array_unpack(rows) union (" +
  "insert GitCommit { program := <Program><uuid>$p, object_id := <str>item['object_id'], tree_id := <str>item['tree_id'], " +
  "commit_time := <int64>item['commit_time'], parents := <array<str>>item['parents'] } " +
  "unless conflict on ((.program, .object_id)))";

const Q4_LOCKED = "with rows := <json>$rows for item in json_array_unpack(rows) union (insert Locked { name := <str>item['name'] })";

const DOCS_SDL = `
module default {
  type User {
    required email: str;
    required name: str;
  }
}
`;

/*** vendor/disc.md/documents/edgeql.md, "Batch Operations with FOR", verbatim. ***/
const DOCS_BATCH_EXAMPLE = `
with
  user_data := <json>$users
for item in json_array_unpack(user_data)
union (
  insert User {
    email := <str>json_get(item, "email"),
    name := <str>json_get(item, "name")
  }
);
`;

const schemas = new Map<string, Schema>();

async function schemaOf(sdl: string): Promise<Schema> {
  let schema = schemas.get(sdl);
  if (!schema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(sdl);
    if (!parsed.ok) {
      throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
    }
    schema = manager.modulesToSchema(parsed.value);
    schemas.set(sdl, schema);
  }
  return schema;
}

interface Compiled {
  error?: string;
  parameterTypes?: Map<number, string>;
  sql?: string;
}

/*** Access control is off when `context` is omitted, on otherwise (policies registered as the server does). ***/
async function compile(edgeql: string, context?: AccessContext, sdl?: string): Promise<Compiled> {
  const schema = await schemaOf(sdl ?? await Deno.readTextFile(FIXTURE_URL));
  const compiler = context ?
    new EdgeQLCompiler(schema, {
      accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
      enableAccessControl: true
    }) :
    new EdgeQLCompiler(schema, { enableAccessControl: false });

  if (context) {
    for (const typeDef of schema.types.values()) {
      for (const policy of typeDef.accessPolicies ?? []) {
        compiler.registerAccessPolicy(policy);
      }
    }
    compiler.setAccessContext(context);
  }

  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    return { error: result.error.message };
  }
  return {
    parameterTypes: buildParameterTypeMap(result.value),
    sql: new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ").trim()
  };
}

const ITEM = "for_iter.val";

Deno.test("bulk insert: Q4 is one INSERT … SELECT over the JSON array", async () => {
  const { sql } = await compile(Q4);

  assertEquals(
    sql,
    "INSERT INTO git_object (program_id, object_id, object_type, size, content) " +
      `SELECT CAST($2 AS uuid), (${ITEM} -> 'object_id') #>> '{}', (${ITEM} -> 'object_type') #>> '{}', ` +
      `CAST((${ITEM} -> 'size') #>> '{}' AS bigint), std_base64_decode((${ITEM} -> 'content') #>> '{}') ` +
      "FROM JSONB_ARRAY_ELEMENTS(CAST($1 AS jsonb)) AS for_iter(val) " +
      "ON CONFLICT (program_id, object_id) DO NOTHING RETURNING id"
  );
});

Deno.test("bulk insert: Q4 is a single statement and never ships content back", async () => {
  const { sql } = await compile(Q4);

  assertEquals(sql!.split("INSERT INTO").length - 1, 1);
  assert(!sql!.includes(";"), sql);
  assert(!sql!.includes("VALUES"), sql);
  assert(sql!.endsWith("RETURNING id"), sql);
});

Deno.test("bulk insert: Q5 rebuilds parents in order", async () => {
  const { sql } = await compile(Q5);
  const parents = `${ITEM} -> 'parents'`;

  assertEquals(
    sql,
    "INSERT INTO git_commit (program_id, object_id, tree_id, commit_time, parents) " +
      `SELECT CAST($2 AS uuid), (${ITEM} -> 'object_id') #>> '{}', (${ITEM} -> 'tree_id') #>> '{}', ` +
      `CAST((${ITEM} -> 'commit_time') #>> '{}' AS bigint), ` +
      `CASE WHEN (${parents} IS NULL) OR (JSONB_TYPEOF(${parents}) = 'null') THEN NULL ELSE ` +
      `CAST(ARRAY(SELECT e.v FROM jsonb_array_elements_text(${parents}) WITH ORDINALITY AS e(v, ord) ORDER BY e.ord) AS text[]) END ` +
      "FROM JSONB_ARRAY_ELEMENTS(CAST($1 AS jsonb)) AS for_iter(val) " +
      "ON CONFLICT (program_id, object_id) DO NOTHING RETURNING id"
  );
});

Deno.test("bulk insert: the rows parameter is bound as jsonb", async () => {
  const { parameterTypes } = await compile(Q4);

  assertEquals(parameterTypes?.get(1), "jsonb");
  assertEquals(parameterTypes?.get(2), "uuid");
});

Deno.test("bulk insert: the response is the row set of inserted ids", () => {
  assertEquals(describeResult(new EdgeQLParser(Q4).parse()), { kind: "rows" });
  assertEquals(describeResult(new EdgeQLParser("for x in json_array_unpack(<json>$j) union (insert Program { name := <str>x })").parse()), {
    kind: "rows"
  });
});

Deno.test("bulk insert: a set-literal for-insert keeps its bare-insert response", () => {
  assertEquals(describeResult(new EdgeQLParser("for x in {'a', 'b'} union (insert Program { name := x })").parse()), { kind: "mutation", mutation: "insert" });
});

Deno.test("bulk insert: a Program selected once in the with block is visible in the body", async () => {
  const { sql } = await compile(
    "with rows := <json>$rows, prog := (select Program filter .id = <uuid>$p) " +
      "for item in json_array_unpack(rows) union (insert GitRef { program := prog, name := <str>item['name'], target := <str>item['target'] })"
  );

  assertStringIncludes(sql!, "WITH prog AS ( SELECT * FROM program AS program_1 WHERE program_1.id = CAST($2 AS uuid) ) INSERT INTO git_ref");
  assertStringIncludes(sql!, "SELECT ( SELECT id FROM prog ), (for_iter.val -> 'name') #>> '{}'");
  assertStringIncludes(sql!, "FROM JSONB_ARRAY_ELEMENTS(CAST($1 AS jsonb)) AS for_iter(val)");
});

Deno.test("bulk insert: array_unpack iterates a typed array", async () => {
  const { sql } = await compile("for n in array_unpack(<array<str>>$names) union (insert Program { name := n })");

  assertEquals(sql, "INSERT INTO program (name) SELECT for_iter.val FROM UNNEST(CAST($1 AS text[])) AS for_iter(val) RETURNING id");
});

Deno.test("bulk insert: std::-qualified and range_unpack iterators are accepted", async () => {
  assertStringIncludes(
    (await compile("for x in std::json_array_unpack(<json>$j) union (insert Program { name := <str>x })")).sql!,
    "FROM JSONB_ARRAY_ELEMENTS("
  );
  // PostgreSQL has no unnest(range): an integer range is walked with generate_series.
  assertStringIncludes(
    (await compile("for i in range_unpack(range(1, 4)) union (insert Program { name := <str>i })")).sql!,
    "FROM generate_series(lower(int4range(1, 4)), upper(int4range(1, 4)) - 1) AS for_iter(val)"
  );
});

Deno.test("bulk insert: a subquery iterator with an insert body is INSERT … SELECT too, not an INSERT inside LATERAL", async () => {
  const { sql } = await compile("for x in (select json_array_unpack(<json>$j)) union (insert Program { name := <str>x })");

  assert(!sql!.includes("LATERAL"), sql);
  assertStringIncludes(sql!, "INSERT INTO program (name) SELECT");
  assertStringIncludes(sql!, ") AS for_iter(val) RETURNING id");
});

Deno.test("bulk insert: a select body over a function iterator reads from it laterally", async () => {
  const { sql } = await compile("for x in json_array_unpack(<json>$j) union (select <str>x['name'])");

  assertStringIncludes(sql!, "FROM JSONB_ARRAY_ELEMENTS(CAST($1 AS jsonb)) AS for_iter(val), LATERAL (");
  assertStringIncludes(sql!, "(for_iter.val -> 'name') #>> '{}'");
});

Deno.test("bulk insert: update and delete bodies are rejected, not emitted as invalid SQL", async () => {
  const { error } = await compile("for x in json_array_unpack(<json>$j) union (delete Program filter .name = <str>x)");

  assertStringIncludes(error ?? "", "insert or select");
});

Deno.test("bulk insert: an iterator that is not set-returning is rejected", async () => {
  const { error } = await compile("for x in len('abc') union (insert Program { name := <str>x })");

  assertStringIncludes(error ?? "", "json_array_unpack");
});

Deno.test("bulk insert: a multi-link assignment is rejected", async () => {
  const sdl = "module default { type Tag { required name: str; } type Post { required title: str; multi tags: Tag; } }";
  const { error } = await compile(
    "for item in json_array_unpack(<json>$j) union (insert Post { title := <str>item['t'], tags := (select Tag filter .name = 'x') })",
    undefined,
    sdl
  );

  assertStringIncludes(error ?? "", "multi link");
});

Deno.test("bulk insert: the documented batch example compiles", async () => {
  const { error, sql } = await compile(DOCS_BATCH_EXAMPLE, undefined, DOCS_SDL);

  assertEquals(error, undefined);
  assertEquals(
    sql,
    `INSERT INTO "user" (email, name) SELECT (${ITEM} -> 'email') #>> '{}', (${ITEM} -> 'name') #>> '{}' ` +
      "FROM JSONB_ARRAY_ELEMENTS(CAST($1 AS jsonb)) AS for_iter(val) RETURNING id"
  );
});

// ── Policies (S10, against the INSERT … SELECT emission) ─────────────────

Deno.test("bulk insert policy: an allowed type compiles to the same statement for an ordinary user", async () => {
  const open = await compile(Q4);
  const asUser = await compile(Q4, { userId: USER_ID });

  assertEquals(asUser.error, undefined);
  assertEquals(asUser.sql, open.sql);
});

Deno.test("bulk insert policy: a using (false) type is denied for an ordinary user", async () => {
  const { error, sql } = await compile(Q4_LOCKED, { userId: USER_ID });

  assertEquals(sql, undefined);
  assertStringIncludes(error ?? "", "not allowed");
  assertStringIncludes(error ?? "", "Locked");
});

Deno.test("bulk insert policy: a bypass caller is not denied", async () => {
  const { error, sql } = await compile(Q4_LOCKED, { bypass: true, userId: USER_ID });

  assertEquals(error, undefined);
  assertStringIncludes(sql!, "INSERT INTO locked (name) SELECT (for_iter.val -> 'name') #>> '{}' FROM JSONB_ARRAY_ELEMENTS(");
});

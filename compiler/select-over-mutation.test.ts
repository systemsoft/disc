/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `select (insert|update|delete …) { shape }` and its spelled-out twin
 * `with m := (insert|update|delete …) select m { shape }` compile to a
 * data-modifying CTE with the shape projected over it:
 *
 *   WITH m AS ( <mutation> RETURNING * ) SELECT jsonb_build_object(…) FROM m AS m_1
 *
 * The mutation inside the CTE is the bare statement, byte for byte (same
 * predicate, same conflict target, same access policy); the outer select reads
 * only from the CTE and ships only the fields the shape asks for.
 *
 * The queries are Q1–Q3 of tests/git-forge-acceptance-pg.test.ts as written in
 * the consumer's contract, against the same fixture.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AccessContext } from "../access/types.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { describeResult, EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const FIXTURE_URL = new URL("../tests/fixtures/git-forge.disc", import.meta.url);
const USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OWNER_PREDICATE = `owner_id = E'${USER_ID}'`;

const BARE_Q1 = "update GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old set { target := <str>$new }";
const BARE_Q2 = "delete GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old";
const BARE_Q3 = "insert GitRef { program := <Program><uuid>$p, name := <str>$n, target := <str>$t } unless conflict on ((.program, .name))";
const BARE_Q3_SUBSELECT =
  "insert GitRef { program := (select Program filter .id = <uuid>$p), name := <str>$n, target := <str>$t } unless conflict on ((.program, .name))";

let cachedSchema: Schema | undefined;

async function testSchema(): Promise<Schema> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(await Deno.readTextFile(FIXTURE_URL));
    if (!parsed.ok) {
      throw new Error(`Failed to parse SDL: ${parsed.error.message}`);
    }
    cachedSchema = manager.modulesToSchema(parsed.value);
  }
  return cachedSchema;
}

interface Compiled {
  error?: string;
  sql?: string;
}

/*** Compiles with access control off when `context` is omitted, on otherwise (policies registered as the server does). ***/
async function compile(edgeql: string, context?: AccessContext): Promise<Compiled> {
  const schema = await testSchema();
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
  return { sql: new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ") };
}

async function sqlOf(edgeql: string, context?: AccessContext): Promise<string> {
  const compiled = await compile(edgeql, context);
  assertEquals(compiled.error, undefined, `expected '${edgeql}' to compile`);
  return compiled.sql!;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

interface CteParts {
  /*** The statement inside `WITH <name> AS ( … )`. ***/
  inner: string;
  name: string;
  /*** Everything after the CTE's closing parenthesis. ***/
  outer: string;
}

/*** Splits `WITH <name> AS ( <inner> ) <outer>`; the inner statement ends at its `RETURNING *`. ***/
function cteParts(sql: string): CteParts {
  const match = /^WITH (\w+) AS \( (.*? RETURNING \*) \) (SELECT .*)$/.exec(sql);
  assert(match, `expected one data-modifying CTE followed by a select, got: ${sql}`);
  return { inner: match[2], name: match[1], outer: match[3] };
}

/*** The outer select projects exactly `fields` from the CTE and touches no table. ***/
function assertProjects(parts: CteParts, fields: string[], tables: string[]): void {
  const alias = new RegExp(` FROM ${parts.name} AS (${parts.name}_\\d+)`).exec(parts.outer)?.[1];
  assert(alias, `the outer select must read from the CTE: ${parts.outer}`);

  const expected = fields.map(field => `'${field}', ${alias}.${field}`).join(", ");
  assert(parts.outer.startsWith(`SELECT jsonb_build_object(${expected}) FROM ${parts.name} AS ${alias}`), parts.outer);
  assert(!parts.outer.includes(".*"), `no SELECT * in the outer select: ${parts.outer}`);
  for (const table of tables) {
    assert(!parts.outer.includes(table), `the outer select must read only from the CTE, found '${table}': ${parts.outer}`);
  }
}

// ---------------------------------------------------------------------------
// Q1–Q3 as written in the contract
// ---------------------------------------------------------------------------

Deno.test("select over mutation - Q1: the CAS update is the bare UPDATE inside a CTE; the select reads only the CTE", async () => {
  const sql = await sqlOf(`select (${BARE_Q1}) { id }`);
  const parts = cteParts(sql);

  assertEquals(parts.inner, await sqlOf(BARE_Q1));
  assert(parts.inner.startsWith("UPDATE git_ref SET target = "), parts.inner);
  assertStringIncludes(parts.inner, `"git_ref"."program_id" = CAST($`);
  assertStringIncludes(parts.inner, "git_ref.name = CAST($");
  assertStringIncludes(parts.inner, "git_ref.target = CAST($");
  assert(!/\bIN \(/i.test(sql), `no id-materializing 'id IN (…)': ${sql}`);
  assertEquals(countOf(sql, "WITH "), 1, sql);
  assertProjects(parts, ["id"], ["git_ref"]);
});

Deno.test("select over mutation - Q2: the CAS delete is the bare DELETE inside a CTE", async () => {
  const sql = await sqlOf(`select (${BARE_Q2}) { id }`);
  const parts = cteParts(sql);

  assertEquals(parts.inner, await sqlOf(BARE_Q2));
  assert(parts.inner.startsWith("DELETE FROM git_ref WHERE "), parts.inner);
  assertStringIncludes(parts.inner, `"git_ref"."program_id" = CAST($`);
  assert(!/\bIN \(/i.test(sql), sql);
  assertProjects(parts, ["id"], ["git_ref"]);
});

Deno.test("select over mutation - Q3: create-if-absent keeps its composite conflict target inside the CTE", async () => {
  const sql = await sqlOf(`select (${BARE_Q3}) { id }`);
  const parts = cteParts(sql);

  assertEquals(parts.inner, await sqlOf(BARE_Q3));
  assertStringIncludes(parts.inner, "INSERT INTO git_ref (program_id, name, target) VALUES (CAST($1 AS uuid), ");
  assertStringIncludes(parts.inner, "ON CONFLICT (program_id, name) DO NOTHING RETURNING *");
  assertProjects(parts, ["id"], ["git_ref"]);
});

Deno.test("select over mutation - Q3 with program := (select Program …) compiles the insert exactly as the bare form does", async () => {
  const sql = await sqlOf(`select (${BARE_Q3_SUBSELECT}) { id }`);
  const parts = cteParts(sql);

  assertEquals(parts.inner, await sqlOf(BARE_Q3_SUBSELECT));
  assertStringIncludes(parts.inner, "FROM program AS program_");
  assertStringIncludes(parts.inner, "ON CONFLICT (program_id, name) DO NOTHING RETURNING *");
  assertProjects(parts, ["id"], ["git_ref"]);
});

// ---------------------------------------------------------------------------
// Shape projection over the CTE, for both spellings
// ---------------------------------------------------------------------------

const UPDATE_OBJECT = "update GitObject filter .object_id = <str>$o set { size := 1 }";

Deno.test("select over mutation - only the requested fields leave the CTE: content is not in the SQL", async () => {
  const sql = await sqlOf(`select (${UPDATE_OBJECT}) { object_id, size }`);

  assertProjects(cteParts(sql), ["object_id", "size"], ["git_object"]);
  assert(!sql.includes("content"), `content must not be selected unless asked for: ${sql}`);
});

Deno.test("select over mutation - the with-form projects its shape too, instead of SELECT u.*", async () => {
  const sql = await sqlOf(`with u := (${UPDATE_OBJECT}) select u { object_id, size }`);
  const parts = cteParts(sql);

  assertEquals(parts.name, "u");
  assertEquals(parts.inner, await sqlOf(UPDATE_OBJECT));
  assertProjects(parts, ["object_id", "size"], ["git_object"]);
  assert(!sql.includes("content"), sql);
});

Deno.test("select over mutation - both spellings compile to the same statement apart from the CTE name", async () => {
  for (const mutation of [BARE_Q1, BARE_Q2, BARE_Q3, UPDATE_OBJECT]) {
    const selectForm = await sqlOf(`select (${mutation}) { id }`);
    const withForm = await sqlOf(`with m := (${mutation}) select m { id }`);

    assertEquals(selectForm, withForm);
  }
});

Deno.test("select over mutation - content is shipped when the shape asks for it", async () => {
  const sql = await sqlOf(`select (${UPDATE_OBJECT}) { object_id, content }`);

  assertProjects(cteParts(sql), ["object_id", "content"], ["git_object"]);
});

Deno.test("select over mutation - a nested link in the shape is resolved from the CTE row's FK column", async () => {
  const sql = await sqlOf(`select (${BARE_Q1}) { name, program: { name } }`);
  const parts = cteParts(sql);

  assert(
    /'program', \( SELECT jsonb_agg\(jsonb_build_object\('name', program\.name\)\) FROM program WHERE program\.id = m_\d+\.program_id \)/.test(parts.outer),
    parts.outer
  );
  assert(!parts.outer.includes("git_ref"), parts.outer);
});

Deno.test("select over mutation - filter, order by and limit on the outer select apply to the CTE rows", async () => {
  const sql = await sqlOf("select (update GitRef filter .target = <str>$old set { target := <str>$new }) { id } filter .name = 'main' order by .name limit 5");
  const parts = cteParts(sql);

  assert(/ FROM m AS (m_\d+) WHERE \1\.name = 'main' ORDER BY \1\.name ASC LIMIT 5$/.test(parts.outer), parts.outer);
});

Deno.test("select over mutation - without a shape the row set of the CTE is selected as before", async () => {
  assertStringIncludes(await sqlOf(`with u := (${UPDATE_OBJECT}) select u`), ") SELECT u_1.* FROM u AS u_1");
  assertStringIncludes(await sqlOf(`select (${UPDATE_OBJECT})`), ") SELECT m_1.* FROM m AS m_1");
});

// ---------------------------------------------------------------------------
// Things that must fail loudly instead of dropping the shape
// ---------------------------------------------------------------------------

Deno.test("select over mutation - a shape over an object cast is a compile error, not a silently dropped shape", async () => {
  const shaped = await compile("select (<Program><uuid>$u) { name }");

  assert(/shape/i.test(shaped.error ?? ""), `expected a compile error about the shape, got: ${JSON.stringify(shaped)}`);
  assertStringIncludes(shaped.error ?? "", "select Program { … } filter .id = ");

  // Without a shape there is nothing to drop: the cast is the uuid.
  assertEquals(await sqlOf("select <Program><uuid>$u"), "SELECT CAST($1 AS uuid)");
});

Deno.test("select over mutation - a shape over a parenthesized select is a compile error, not a silently dropped shape", async () => {
  const shaped = await compile("select (select GitRef filter .name = 'main') { name }");

  assert(/shape/i.test(shaped.error ?? ""), `expected a compile error about the shape, got: ${JSON.stringify(shaped)}`);
});

// ---------------------------------------------------------------------------
// Access control ENABLED: the mutation inside the CTE keeps its policy
// ---------------------------------------------------------------------------

Deno.test("select over mutation + policy - update and delete carry the owner predicate inside the CTE, once", async () => {
  const forms = [
    "select (update Doc filter .title = <str>$t set { title := <str>$new }) { id }",
    "with m := (update Doc filter .title = <str>$t set { title := <str>$new }) select m { id }",
    "select (delete Doc filter .title = <str>$t) { id }",
    "with m := (delete Doc filter .title = <str>$t) select m { id }"
  ];

  for (const form of forms) {
    const sql = await sqlOf(form, { userId: USER_ID });
    const parts = cteParts(sql);

    assertEquals(countOf(sql, OWNER_PREDICATE), 1, sql);
    assertStringIncludes(parts.inner, `WHERE ((${OWNER_PREDICATE})) AND (`);
    assertStringIncludes(parts.inner, "doc.title = CAST($");
    assertProjects(parts, ["id"], ["doc"]);
  }
});

Deno.test("select over mutation + policy - every form on Locked is denied", async () => {
  const forms = [
    "select (update Locked filter .name = <str>$n set { name := <str>$new }) { id }",
    "select (delete Locked filter .name = <str>$n) { id }",
    "select (insert Locked { name := <str>$n } unless conflict) { id }",
    "with m := (update Locked filter .name = <str>$n set { name := <str>$new }) select m { id }",
    "with m := (delete Locked filter .name = <str>$n) select m { id }",
    "with m := (insert Locked { name := <str>$n }) select m { id }"
  ];

  for (const form of forms) {
    const compiled = await compile(form, { userId: USER_ID });

    assert(/not allowed on Locked/i.test(compiled.error ?? ""), `expected a denial for '${form}', got: ${JSON.stringify(compiled)}`);
  }
});

Deno.test("select over mutation + policy - a bypass caller gets the same statement with no predicate", async () => {
  const sql = await sqlOf("select (update Doc filter .title = <str>$t set { title := <str>$new }) { id }", { bypass: true, userId: USER_ID });

  assertEquals(countOf(sql, "owner_id"), 0, sql);
  assertProjects(cteParts(sql), ["id"], ["doc"]);

  const locked = await sqlOf("select (delete Locked filter .name = <str>$n) { id }", { bypass: true, userId: USER_ID });
  assertStringIncludes(locked, "WITH m AS ( DELETE FROM locked WHERE ");
});

// ---------------------------------------------------------------------------
// describeResult: what the server needs to shape the response, from the AST
// ---------------------------------------------------------------------------

function describe(edgeql: string): ReturnType<typeof describeResult> {
  return describeResult(new EdgeQLParser(edgeql).parse());
}

Deno.test("describeResult - a select is a row set, whatever it selects from", () => {
  assertEquals(describe("select GitRef { id }"), { kind: "rows" });
  assertEquals(describe(`select (${BARE_Q1}) { id }`), { kind: "rows" });
  assertEquals(describe(`select (${BARE_Q2}) { id }`), { kind: "rows" });
  assertEquals(describe(`select (${BARE_Q3}) { id }`), { kind: "rows" });
  assertEquals(describe(`with m := (${BARE_Q1}) select m { id }`), { kind: "rows" });
  assertEquals(describe("with module default select GitRef { id }"), { kind: "rows" });
});

Deno.test("describeResult - a bare mutation keeps the mutation response and names the type its row maps through", () => {
  assertEquals(describe(BARE_Q1), { kind: "mutation", mutatedType: "GitRef" });
  assertEquals(describe(BARE_Q3), { kind: "mutation", mutatedType: "GitRef" });
  assertEquals(describe("insert default::GitRef { name := 'x' }"), { kind: "mutation", mutatedType: "default::GitRef" });
  assertEquals(describe(BARE_Q2), { kind: "mutation" });
  assertEquals(describe("with module default insert GitRef { name := 'x' }"), { kind: "mutation" });
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Tests for ON CONFLICT DO UPDATE (UPSERT) compilation
 */

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import type { AccessContext } from "../access/types.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { DDLGenerator } from "../migration/ddl.ts";
import { SchemaDiffer } from "../migration/differ.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import { createTestSchema } from "./context.ts";
import type { Schema } from "./context.ts";

const schema = createTestSchema();
const compiler = new EdgeQLCompiler(schema);
const codegen = new SQLCodeGenerator();

function compileEdgeQL(source: string): string {
  const parser = new EdgeQLParser(source);
  const ast = parser.parse();
  const result = compiler.compile(ast);
  if (!result.ok) {
    throw result.error;
  }
  return codegen.generate(result.value);
}

Deno.test("UPSERT - simple upsert with single SET column", () => {
  const source = `
    INSERT User {
      name := "Ada",
      email := "ada@test.com"
    }
    UNLESS CONFLICT ON .email
    ELSE (UPDATE User SET { name := "Ada Updated" })
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("INSERT INTO"),
    true,
    "SQL should contain INSERT INTO"
  );
  assertEquals(
    sql.includes("ON CONFLICT"),
    true,
    "SQL should contain ON CONFLICT"
  );
  assertEquals(
    sql.includes("DO UPDATE SET"),
    true,
    "SQL should contain DO UPDATE SET"
  );
  assertEquals(
    sql.includes("name ="),
    true,
    "SQL should reference the name column in SET clause"
  );
  assertEquals(
    sql.includes("'Ada Updated'"),
    true,
    "SQL should contain the updated value"
  );
  // Should NOT contain DO NOTHING
  assertEquals(
    sql.includes("DO NOTHING"),
    false,
    "SQL should NOT contain DO NOTHING for upsert"
  );
});

Deno.test("UPSERT - multi-column SET", () => {
  const source = `
    INSERT User {
      name := "Billie",
      email := "billie@test.com"
    }
    UNLESS CONFLICT ON .email
    ELSE (UPDATE User SET { name := "Billie Updated", active := true })
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("ON CONFLICT"),
    true,
    "SQL should contain ON CONFLICT"
  );
  assertEquals(
    sql.includes("DO UPDATE SET"),
    true,
    "SQL should contain DO UPDATE SET"
  );
  // Both SET columns should appear in the SQL
  assertEquals(
    sql.includes("'Billie Updated'"),
    true,
    "SQL should contain the updated name value"
  );
  assertEquals(
    sql.includes("active"),
    true,
    "SQL should reference the active column"
  );
  // Verify both SET clauses are comma-separated
  const setMatch = sql.match(/DO UPDATE SET (.+)/);
  assertEquals(setMatch !== null, true, "Should match DO UPDATE SET clause");
  if (setMatch) {
    assertEquals(
      setMatch[1].includes(","),
      true,
      "Multiple SET clauses should be comma-separated"
    );
  }
});

Deno.test("UPSERT - with Post type conflict on title", () => {
  const source = `
    INSERT Post {
      title := "Test",
      body := "Content",
      author := <uuid>"550e8400-e29b-41d4-a716-446655440000"
    }
    UNLESS CONFLICT ON .title
    ELSE (UPDATE Post SET { body := "Updated Content" })
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("ON CONFLICT"),
    true,
    "SQL should contain ON CONFLICT"
  );
  assertEquals(
    sql.includes("DO UPDATE SET"),
    true,
    "SQL should contain DO UPDATE SET"
  );
  assertEquals(
    sql.includes("body"),
    true,
    "SQL should reference the body column"
  );
  assertEquals(
    sql.includes("'Updated Content'"),
    true,
    "SQL should contain the updated body value"
  );
});

Deno.test("UPSERT - DO NOTHING still works (regression)", () => {
  const source = `
    INSERT User {
      name := "Test",
      email := "test@test.com"
    }
    UNLESS CONFLICT ON .email
  `;
  const sql = compileEdgeQL(source);

  assertEquals(
    sql.includes("INSERT INTO"),
    true,
    "SQL should contain INSERT INTO"
  );
  assertEquals(
    sql.includes("ON CONFLICT"),
    true,
    "SQL should contain ON CONFLICT"
  );
  assertEquals(
    sql.includes("DO NOTHING"),
    true,
    "SQL should contain DO NOTHING"
  );
  assertEquals(
    sql.includes("DO UPDATE"),
    false,
    "SQL should NOT contain DO UPDATE for DO NOTHING case"
  );
});

Deno.test("UPSERT - conflict target column is included", () => {
  const source = `
    INSERT User {
      name := "Cher",
      email := "cher@test.com"
    }
    UNLESS CONFLICT ON .email
    ELSE (UPDATE User SET { name := "Cher Updated" })
  `;
  const sql = compileEdgeQL(source);

  // The ON CONFLICT target should reference the email column
  assertEquals(
    sql.includes("ON CONFLICT (email)"),
    true,
    "SQL should contain ON CONFLICT with email column target"
  );
  assertEquals(
    sql.includes("DO UPDATE SET"),
    true,
    "SQL should contain DO UPDATE SET"
  );
});

// ---------------------------------------------------------------------------
// Composite and link conflict targets (D5)
// ---------------------------------------------------------------------------

function oneLine(source: string): string {
  return compileEdgeQL(source).replace(/\s+/g, " ");
}

Deno.test("UNLESS CONFLICT - composite target of a link and a property", () => {
  const sql = oneLine(`insert Post { title := "t", body := "b", author := <uuid>$a } unless conflict on ((.author, .title))`);

  assertStringIncludes(sql, "ON CONFLICT (author_id, title) DO NOTHING");
});

Deno.test("UNLESS CONFLICT - composite target keeps declaration order", () => {
  const sql = oneLine(`insert Post { title := "t", body := "b", author := <uuid>$a } unless conflict on ((.title, .author))`);

  assertStringIncludes(sql, "ON CONFLICT (title, author_id) DO NOTHING");
});

Deno.test("UNLESS CONFLICT - single-parenthesized tuple target", () => {
  const sql = oneLine(`insert Post { title := "t", body := "b", author := <uuid>$a } unless conflict on (.author, .title)`);

  assertStringIncludes(sql, "ON CONFLICT (author_id, title) DO NOTHING");
});

Deno.test("UNLESS CONFLICT - a single link target is its FK column", () => {
  const sql = oneLine(`insert Post { title := "t", body := "b", author := <uuid>$a } unless conflict on .author`);

  assertStringIncludes(sql, "ON CONFLICT (author_id) DO NOTHING");
});

Deno.test("UNLESS CONFLICT - a property target uses its column name", () => {
  const sql = oneLine(`insert Post { title := "t", body := "b" } unless conflict on ((.createdAt, .title))`);

  assertStringIncludes(sql, "ON CONFLICT (created_at, title) DO NOTHING");
});

Deno.test("UNLESS CONFLICT - bare form (no target) is unchanged", () => {
  const sql = oneLine(`insert Post { title := "t", body := "b" } unless conflict`);

  assertStringIncludes(sql, "ON CONFLICT DO NOTHING");
});

Deno.test("UPSERT - else-update filter becomes DO UPDATE … WHERE", () => {
  // Regression: the filter was dropped, so the conflicting row was updated
  // even when the filter excluded it.
  const sql = oneLine(`
    insert User { name := "a", email := "e" }
    unless conflict on .email
    else (update User filter not exists .age set { age := 1 })
  `);

  assertStringIncludes(sql, "ON CONFLICT (email) DO UPDATE SET age = 1 WHERE users.age IS NULL RETURNING *");
});

Deno.test("UPSERT - else-update without a filter has no WHERE", () => {
  const sql = oneLine(`insert User { name := "a", email := "e" } unless conflict on .email else (update User set { age := 1 })`);

  assertStringIncludes(sql, "DO UPDATE SET age = 1 RETURNING *");
});

Deno.test("UPSERT - paths in else-update set and filter qualify with the target table", () => {
  // Regression: `.age` compiled to a bare `age`, which Postgres rejects in
  // ON CONFLICT … DO UPDATE as ambiguous between the row and `excluded`.
  const sql = oneLine(`
    insert User { name := "a", email := "e", age := 1 }
    unless conflict on .email
    else (update User filter .age < 10 set { age := .age + 1, name := .name ++ "!" })
  `);

  assertStringIncludes(sql, "DO UPDATE SET age = users.age + 1, name = users.name || '!' WHERE users.age < 10");
});

Deno.test("UPSERT - composite target emits ON CONFLICT (c1, c2) DO UPDATE SET", () => {
  const sql = oneLine(`
    insert Post { title := "t", body := "b", author := <uuid>$a }
    unless conflict on ((.author, .title))
    else (update Post set { body := "b2" })
  `);

  assertStringIncludes(sql, "ON CONFLICT (author_id, title) DO UPDATE SET body = 'b2'");
});

Deno.test("UNLESS CONFLICT - an unknown target is a compile error", () => {
  assertThrows(
    () => compileEdgeQL(`insert Post { title := "t", body := "b" } unless conflict on .nope`),
    Error,
    "'.nope'"
  );
  assertThrows(
    () => compileEdgeQL(`insert Post { title := "t", body := "b" } unless conflict on ((.author, .nope))`),
    Error,
    "'.nope'"
  );
});

Deno.test("UPSERT - an unknown target is a compile error, never a targetless DO UPDATE", () => {
  assertThrows(
    () => compileEdgeQL(`insert Post { title := "t", body := "b" } unless conflict on ((.author, .nope)) else (update Post set { body := "x" })`),
    Error,
    "'.nope'"
  );
});

Deno.test("UNLESS CONFLICT - a multi link cannot be a conflict target", () => {
  assertThrows(
    () => compileEdgeQL(`insert User { name := "n", email := "e" } unless conflict on .posts`),
    Error,
    "'.posts'"
  );
});

Deno.test("UNLESS CONFLICT - a multi-step path or an expression cannot be a conflict target", () => {
  assertThrows(
    () => compileEdgeQL(`insert Post { title := "t", body := "b" } unless conflict on .author.id`),
    Error,
    "conflict target"
  );
  assertThrows(
    () => compileEdgeQL(`insert Post { title := "t", body := "b" } unless conflict on ((.author, str_lower(.title)))`),
    Error,
    "conflict target"
  );
});

// ---------------------------------------------------------------------------
// The git-forge consumer's ref create-if-absent (Q3) as a bare insert, against
// the consumer fixture: object-type casts (D6) and the conflict target (D5).
// ---------------------------------------------------------------------------

const FIXTURE_URL = new URL("../tests/fixtures/git-forge.disc", import.meta.url);
const USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";

interface Fixture {
  ddl: string;
  schema: Schema;
}

let cachedFixture: Fixture | undefined;

async function gitForge(): Promise<Fixture> {
  if (!cachedFixture) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(await Deno.readTextFile(FIXTURE_URL));
    if (!parsed.ok) {
      throw new Error(`Failed to parse fixture: ${parsed.error.message}`);
    }
    cachedFixture = {
      ddl: new DDLGenerator().generateDDL(new SchemaDiffer().diff([], parsed.value)).join("\n"),
      schema: manager.modulesToSchema(parsed.value)
    };
  }
  return cachedFixture;
}

/*** Access control is off when `context` is omitted; on, with the fixture's policies registered, otherwise. ***/
async function compileGitForge(edgeql: string, context?: AccessContext): Promise<string> {
  const { schema } = await gitForge();
  const forgeCompiler = context ?
    new EdgeQLCompiler(schema, {
      accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
      enableAccessControl: true
    }) :
    new EdgeQLCompiler(schema, { enableAccessControl: false });

  if (context) {
    for (const typeDef of schema.types.values()) {
      for (const policy of typeDef.accessPolicies ?? []) {
        forgeCompiler.registerAccessPolicy(policy);
      }
    }
    forgeCompiler.setAccessContext(context);
  }

  const result = forgeCompiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw result.error;
  }
  return codegen.generate(result.value).replace(/\s+/g, " ");
}

async function compileError(edgeql: string, context?: AccessContext): Promise<string> {
  try {
    const sql = await compileGitForge(edgeql, context);
    return `compiled: ${sql}`;
  } catch (error) {
    return (error as Error).message;
  }
}

const BARE_Q3 = "insert GitRef { program := <Program><uuid>$p, name := <str>$n, target := <str>$t } unless conflict on ((.program, .name))";

Deno.test("git-forge Q3 (bare) - <Program><uuid>$p is the uuid, and the conflict target is (program_id, name)", async () => {
  const sql = await compileGitForge(BARE_Q3);

  assertEquals(
    sql,
    "INSERT INTO git_ref (program_id, name, target) VALUES (CAST($1 AS uuid), CAST($2 AS text), CAST($3 AS text)) " +
      "ON CONFLICT (program_id, name) DO NOTHING RETURNING *"
  );
});

Deno.test("git-forge Q3 (bare) - program := (select Program filter .id = <uuid>$p)", async () => {
  const sql = await compileGitForge(
    "insert GitRef { program := (select Program filter .id = <uuid>$p), name := <str>$n, target := <str>$t } unless conflict on ((.program, .name))"
  );

  assert(/VALUES \(\( SELECT (program_\d+)\.id FROM program AS \1 WHERE \1\.id = CAST\(\$1 AS uuid\) \), /.test(sql), sql);
  assertStringIncludes(sql, "ON CONFLICT (program_id, name) DO NOTHING RETURNING *");
});

Deno.test("git-forge - every composite conflict target matches the unique index the migration creates", async () => {
  const { ddl } = await gitForge();
  const cases = [
    { index: "git_ref (program_id, name)", query: BARE_Q3 },
    {
      index: "git_object (program_id, object_id)",
      query:
        "insert GitObject { program := <Program><uuid>$p, object_id := <str>$o, object_type := 'blob', size := 1 } unless conflict on ((.program, .object_id))"
    },
    {
      index: "git_commit (program_id, object_id)",
      query:
        "insert GitCommit { program := <Program><uuid>$p, object_id := <str>$o, commit_time := 1, parents := <array<str>>$ps, tree_id := 't' } unless conflict on ((.program, .object_id))"
    }
  ];

  for (const { index, query } of cases) {
    const columns = index.slice(index.indexOf("("));
    assert(new RegExp(`CREATE UNIQUE INDEX \\S+ ON ${index.replace(/[()]/g, "\\$&")}`).test(ddl), `no unique index on ${index} in:\n${ddl}`);
    assertStringIncludes(await compileGitForge(query), `ON CONFLICT ${columns} DO NOTHING`);
  }
});

Deno.test("object-type cast - module-qualified type name", async () => {
  const sql = await compileGitForge("insert GitRef { program := <default::Program><uuid>$p, name := 'n', target := 't' }");

  assertStringIncludes(sql, "VALUES (CAST($1 AS uuid), 'n', 't')");
});

Deno.test("object-type cast - .link = <Type><uuid>$x in a select filter compares the FK column", async () => {
  const sql = await compileGitForge("select GitRef { name } filter .program = <Program><uuid>$p");

  assert(/WHERE (gitref_\d+)\.program_id = CAST\(\$1 AS uuid\)/.test(sql), sql);
  assert(!/AS Program/i.test(sql), sql);
});

Deno.test("object-type cast - .link = <Type><uuid>$x in update and delete filters compares the FK column", async () => {
  const update = await compileGitForge("update GitRef filter .program = <Program><uuid>$p and .name = <str>$n set { target := <str>$t }");
  const remove = await compileGitForge("delete GitRef filter .program = <Program><uuid>$p");

  assertStringIncludes(update, "(git_ref.program_id = CAST($1 AS uuid)) AND (git_ref.name = CAST($2 AS text))");
  assertStringIncludes(remove, "WHERE git_ref.program_id = CAST($1 AS uuid) RETURNING");
});

Deno.test("object-type cast - an unknown type is a compile error naming it", async () => {
  const message = await compileError("insert GitRef { program := <Progam><uuid>$p, name := 'n', target := 't' }");

  assertStringIncludes(message, "Unknown type 'Progam'");
});

Deno.test("UPSERT - composite target on a type with a row-level update policy still fails closed (S12)", async () => {
  const upsert = "insert Doc { owner_id := 'me', title := 't' } unless conflict on ((.owner_id, .title)) else (update Doc set { title := 'u' })";

  assertStringIncludes(await compileError(upsert, { userId: USER_ID }), "row-level update policy");
  assertStringIncludes(await compileGitForge(upsert, { bypass: true, userId: USER_ID }), "ON CONFLICT (owner_id, title) DO UPDATE SET title = 'u'");
});

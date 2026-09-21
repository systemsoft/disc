/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * `update` and `delete` compile their `filter` and `set` expressions in a
 * scope that knows the mutated type, the way `select` does: a path through a
 * single link resolves to the FK column (`.program.id` → `program_id`, no
 * join), deeper paths to a correlated subselect, and property names to their
 * column names, all qualified by the mutated table.
 *
 * The queries are the git-forge consumer's ref compare-and-swap (Q1/Q2 of
 * tests/git-forge-acceptance-pg.test.ts) as bare statements.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AccessContext } from "../access/types.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Crew {
    required name: str;
  }

  type Program {
    required name: str;
    link crew -> Crew;
  }

  type GitObject {
    required object_id: str;
    required size: int64;
    required link program -> Program { on target delete cascade; }
    constraint exclusive on ((.program, .object_id));
  }

  type GitRef {
    required name: str;
    required link program -> Program { on target delete cascade; }
    required target: str;
    updatedAt: datetime;
    constraint exclusive on ((.program, .name));
  }

  type Locked {
    required name: str;
    required link program -> Program;
    access policy nobody {
      allow all;
      using (false);
    }
  }

  type Doc {
    required owner_id: str;
    required title: str;
    required link program -> Program;
    access policy owner_only {
      allow all;
      using (.owner_id = global current_user);
    }
  }
}
`;

const USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OWNER_PREDICATE = `owner_id = E'${USER_ID}'`;

const BARE_Q1 = "update GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old set { target := <str>$new }";
const BARE_Q2 = "delete GitRef filter .program.id = <uuid>$p and .name = <str>$n and .target = <str>$old";

let cachedSchema: Schema | undefined;

async function testSchema(): Promise<Schema> {
  if (!cachedSchema) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(SDL);
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

/*** A direct mutation: no CTE, no id-materializing subselect, no join. ***/
function assertDirect(sql: string): void {
  assert(!/\bWITH\b/i.test(sql), `expected no CTE in: ${sql}`);
  assert(!/\bIN \(/i.test(sql), `expected no 'id IN (…)' in: ${sql}`);
  assert(!/\bJOIN\b/i.test(sql), `expected no join in: ${sql}`);
  assert(!/\bSELECT\b/i.test(sql), `expected no subselect in: ${sql}`);
}

Deno.test("mutation scope - bare Q1: update filters through .program.id on the updated table", async () => {
  const sql = await sqlOf(BARE_Q1);

  assert(sql.startsWith("UPDATE git_ref SET target = "), sql);
  assertStringIncludes(sql, `"git_ref"."program_id" = CAST($`);
  assertStringIncludes(sql, "git_ref.name = CAST($");
  assertStringIncludes(sql, "git_ref.target = CAST($");
  assertStringIncludes(sql, "RETURNING *");
  assertDirect(sql);
});

Deno.test("mutation scope - bare Q2: delete filters through .program.id on the deleted table", async () => {
  const sql = await sqlOf(BARE_Q2);

  assert(sql.startsWith("DELETE FROM git_ref WHERE "), sql);
  assertStringIncludes(sql, `"git_ref"."program_id" = CAST($`);
  assertStringIncludes(sql, "git_ref.name = CAST($");
  assertStringIncludes(sql, "git_ref.target = CAST($");
  assertStringIncludes(sql, "RETURNING *");
  assertDirect(sql);
});

Deno.test("mutation scope - a bare link in an update filter is its FK column", async () => {
  const sql = await sqlOf("update GitRef filter .program = <uuid>$p set { target := 'x' }");

  assertStringIncludes(sql, "WHERE git_ref.program_id = CAST($1 AS uuid)");
  assertDirect(sql);
});

Deno.test("mutation scope - a bare link in a delete filter is its FK column", async () => {
  const sql = await sqlOf("delete GitRef filter .program = <uuid>$p");

  assertStringIncludes(sql, "WHERE git_ref.program_id = CAST($1 AS uuid)");
  assertDirect(sql);
});

Deno.test("mutation scope - set expressions can read the row being updated", async () => {
  const sql = await sqlOf("update GitObject filter .object_id = <str>$o set { size := .size + 1 }");

  assertStringIncludes(sql, "SET size = git_object.size + 1 WHERE");
  assertDirect(sql);
});

Deno.test("mutation scope - property names map to column names in filter and set", async () => {
  const sql = await sqlOf("update GitRef filter .updatedAt < <datetime>$t set { updatedAt := .updatedAt + <duration>'1 hour' }");

  assertStringIncludes(sql, "SET updated_at = git_ref.updated_at + ");
  assertStringIncludes(sql, "WHERE git_ref.updated_at < ");
  assert(!sql.includes("updatedAt"), `the EdgeQL property name must not reach the SQL: ${sql}`);
});

Deno.test("mutation scope - update: a path beyond the link's id is a correlated subselect", async () => {
  const sql = await sqlOf("update GitRef filter .program.name = <str>$name set { target := 'x' }");

  assertStringIncludes(sql, `(SELECT "name" FROM "program" WHERE "id" = "git_ref"."program_id") = CAST($1 AS text)`);
  assert(!/\bWITH\b/i.test(sql), sql);
});

Deno.test("mutation scope - delete: a three-step path walks the link chain", async () => {
  const sql = await sqlOf("delete GitRef filter .program.crew.name = <str>$name");

  assertStringIncludes(
    sql,
    `(SELECT "name" FROM "crew" WHERE "id" = (SELECT "crew_id" FROM "program" WHERE "id" = "git_ref"."program_id"))`
  );
});

Deno.test("mutation scope - a subselect in a set expression keeps its own scope", async () => {
  const sql = await sqlOf("update GitRef filter .name = 'main' set { program := (select Program filter .name = 'p') }");

  assertStringIncludes(sql, "WHERE git_ref.name = 'main'");
  assert(/FROM program AS (program_\d+) WHERE \1\.name = 'p'/.test(sql), sql);
});

Deno.test("mutation scope - the scope does not outlive the mutation", async () => {
  const schema = await testSchema();
  const compiler = new EdgeQLCompiler(schema, { enableAccessControl: false });
  const generate = (edgeql: string): string => {
    const result = compiler.compile(new EdgeQLParser(edgeql).parse());
    if (!result.ok) {
      throw result.error;
    }
    return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
  };

  // A failing filter must not leave GitRef registered for the next query.
  const failed = compiler.compile(new EdgeQLParser("update GitRef filter .program.nope = 1 set { target := 'x' }").parse());
  assertEquals(failed.ok, false);

  const sql = generate("update GitObject filter .program.id = <uuid>$p set { size := 1 }");
  assertStringIncludes(sql, `"git_object"."program_id"`);
  assert(!sql.includes("git_ref"), sql);
});

Deno.test("mutation scope - with-bound update keeps the direct predicate inside the CTE", async () => {
  const sql = await sqlOf(`with u := (${BARE_Q1}) select u { id }`);

  assertStringIncludes(sql, "WITH u AS ( UPDATE git_ref SET target = ");
  assertStringIncludes(sql, `"git_ref"."program_id" = CAST($`);
});

// ---------------------------------------------------------------------------
// Access control ENABLED: the policy predicate's columns are unqualified while
// the caller's predicates are now table-qualified. Both must be present, once.
// ---------------------------------------------------------------------------

Deno.test("mutation scope + policy - update carries the owner predicate next to the qualified filter", async () => {
  const sql = await sqlOf(
    "update Doc filter .program.id = <uuid>$p and .title = <str>$t set { title := .title ++ '!' }",
    { userId: USER_ID }
  );

  assert(sql.startsWith("UPDATE doc SET title = "), sql);
  assertEquals(countOf(sql, OWNER_PREDICATE), 1, sql);
  assertStringIncludes(sql, `WHERE ((${OWNER_PREDICATE})) AND (`);
  assertStringIncludes(sql, `"doc"."program_id" = CAST($`);
  assertStringIncludes(sql, "doc.title = CAST($");
  assertDirect(sql);
});

Deno.test("mutation scope + policy - delete carries the owner predicate next to the qualified filter", async () => {
  const sql = await sqlOf("delete Doc filter .program.id = <uuid>$p", { userId: USER_ID });

  assert(sql.startsWith("DELETE FROM doc WHERE "), sql);
  assertEquals(countOf(sql, OWNER_PREDICATE), 1, sql);
  assertStringIncludes(sql, `"doc"."program_id" = CAST($1 AS uuid)`);
  assertDirect(sql);
});

Deno.test("mutation scope + policy - a denied type is still denied before its filter matters", async () => {
  const update = await compile("update Locked filter .program.id = <uuid>$p set { name := 'x' }", { userId: USER_ID });
  const remove = await compile("delete Locked filter .program.id = <uuid>$p", { userId: USER_ID });

  assert(/not allowed on Locked/i.test(update.error ?? ""), `expected a denial, got: ${JSON.stringify(update)}`);
  assert(/not allowed on Locked/i.test(remove.error ?? ""), `expected a denial, got: ${JSON.stringify(remove)}`);
});

Deno.test("mutation scope + policy - a bypass caller gets the qualified filter and no predicate", async () => {
  const sql = await sqlOf("update Doc filter .program.id = <uuid>$p set { title := 'x' }", { bypass: true, userId: USER_ID });

  assertEquals(countOf(sql, "owner_id"), 0, sql);
  assertStringIncludes(sql, `WHERE "doc"."program_id" = CAST($1 AS uuid) RETURNING`);
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Access policies must reach every mutation node, wherever it sits in the
 * query: top level, `with` binding, `for … union (…)` body, `explain`, and the
 * CTE statements that multi-link writes compile to.
 *
 * Access control is ENABLED in every test here. The schema goes through the
 * same SDL → Schema path the server uses, and policies are registered the way
 * `EdgeQLProtocolHandler.createCompiler` registers them.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AccessContext } from "../access/types.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompilerWithAccess } from "./compiler-with-access.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `
module default {
  type Tag {
    required name: str;
  }

  type Locked {
    required name: str;
    multi tags: Tag;
    access policy nobody {
      allow all;
      using (false);
    }
  }

  type Journal {
    required title: str;
    access policy append_only {
      allow select, insert;
    }
  }

  type Doc {
    required owner_id: str;
    required title: str;
    multi tags: Tag;
    access policy owner_only {
      allow all;
      using (.owner_id = global current_user);
    }
  }
}
`;

const USER_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const OWNER_PREDICATE = `owner_id = E'${USER_ID}'`;

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

async function compileAs(context: AccessContext, edgeql: string): Promise<Compiled> {
  const schema = await testSchema();
  const compiler = new EdgeQLCompiler(schema, {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
    enableAccessControl: true
  });

  for (const typeDef of schema.types.values()) {
    for (const policy of typeDef.accessPolicies ?? []) {
      compiler.registerAccessPolicy(policy);
    }
  }

  compiler.setAccessContext(context);
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    return { error: result.error.message };
  }
  return { sql: new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ") };
}

function asUser(edgeql: string): Promise<Compiled> {
  return compileAs({ userId: USER_ID }, edgeql);
}

function asBypass(edgeql: string): Promise<Compiled> {
  return compileAs({ bypass: true, userId: USER_ID }, edgeql);
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/*** Asserts the owner predicate sits inside the mutation itself, exactly once. ***/
function assertOwnerScoped(compiled: Compiled, mutationPrefix: string): void {
  assert(compiled.sql, `expected SQL, got error: ${compiled.error}`);
  assertStringIncludes(compiled.sql, mutationPrefix);
  const mutation = compiled.sql.slice(compiled.sql.indexOf(mutationPrefix));
  const upToReturning = mutation.slice(0, mutation.indexOf("RETURNING"));
  assertStringIncludes(upToReturning, OWNER_PREDICATE, `policy predicate missing from the mutation: ${compiled.sql}`);
  assertEquals(countOf(compiled.sql, OWNER_PREDICATE), 1, `policy applied more than once: ${compiled.sql}`);
}

function assertDenied(compiled: Compiled, operation: string): void {
  assertEquals(compiled.sql, undefined, `expected a denial, got SQL: ${compiled.sql}`);
  assertStringIncludes(compiled.error ?? "", `${operation} not allowed on Locked`);
}

function assertUnfiltered(compiled: Compiled): void {
  assert(compiled.sql, `bypass must compile, got error: ${compiled.error}`);
  assertEquals(compiled.sql.includes("owner_id = E'"), false, `bypass must not carry a policy predicate: ${compiled.sql}`);
}

// ---------------------------------------------------------------------------
// Bare mutations (regression: exactly one predicate, deny and bypass unchanged)
// ---------------------------------------------------------------------------

Deno.test("nested mutation access - bare update carries the owner predicate once", async () => {
  assertOwnerScoped(await asUser("update Doc filter .title = 'x' set { title := 'y' }"), "UPDATE doc");
});

Deno.test("nested mutation access - bare update without a filter carries the owner predicate", async () => {
  assertOwnerScoped(await asUser("update Doc set { title := 'y' }"), "UPDATE doc");
});

Deno.test("nested mutation access - bare delete carries the owner predicate once", async () => {
  assertOwnerScoped(await asUser("delete Doc filter .title = 'x'"), "DELETE FROM doc");
});

Deno.test("nested mutation access - bare insert/update/delete on a using(false) type are denied", async () => {
  assertDenied(await asUser("insert Locked { name := 'x' }"), "INSERT");
  assertDenied(await asUser("update Locked set { name := 'x' }"), "UPDATE");
  assertDenied(await asUser("delete Locked"), "DELETE");
});

Deno.test("nested mutation access - bare mutations are unfiltered for a bypass caller", async () => {
  assertUnfiltered(await asBypass("update Doc filter .title = 'x' set { title := 'y' }"));
  assertUnfiltered(await asBypass("delete Doc filter .title = 'x'"));
  assertUnfiltered(await asBypass("insert Locked { name := 'x' }"));
  assertUnfiltered(await asBypass("update Locked set { name := 'x' }"));
  assertUnfiltered(await asBypass("delete Locked"));
});

Deno.test("nested mutation access - module-qualified type name gets the same policy", async () => {
  assertOwnerScoped(await asUser("update default::Doc filter .title = 'x' set { title := 'y' }"), "UPDATE doc");
  assertOwnerScoped(await asUser("delete default::Doc filter .title = 'x'"), "DELETE FROM doc");
  assertDenied(await asUser("insert default::Locked { name := 'x' }"), "INSERT");
});

Deno.test("nested mutation access - an allowed insert stays allow/deny only, with no policy WHERE (Gel #5504)", async () => {
  const compiled = await asUser("insert Doc { owner_id := 'o', title := 't' } unless conflict on .title");
  assert(compiled.sql, `expected SQL, got error: ${compiled.error}`);
  assertStringIncludes(compiled.sql, "ON CONFLICT (title) DO NOTHING");
  assertEquals(compiled.sql.includes("WHERE"), false, `insert must not carry a policy predicate: ${compiled.sql}`);
});

// ---------------------------------------------------------------------------
// Upsert: `else (update …)` is an update, so it answers to the update policy
// (S12). ON CONFLICT DO UPDATE cannot carry a row predicate yet, so a
// row-level update policy fails closed instead of compiling unfiltered.
// ---------------------------------------------------------------------------

Deno.test("nested mutation access - upsert is denied when the update policy denies", async () => {
  const compiled = await asUser("insert Journal { title := 't' } unless conflict on .title else (update Journal set { title := 'u' })");
  assertEquals(compiled.sql, undefined, `expected a denial, got SQL: ${compiled.sql}`);
  assertStringIncludes(compiled.error ?? "", "UPDATE not allowed on Journal");
});

Deno.test("nested mutation access - upsert on a type with a row-level update policy does not compile", async () => {
  const compiled = await asUser(
    "insert Doc { owner_id := 'me', title := 't' } unless conflict on .title else (update Doc set { owner_id := 'me' })"
  );
  assertEquals(compiled.sql, undefined, `an upsert must not overwrite rows the update policy hides: ${compiled.sql}`);
  assertStringIncludes(compiled.error ?? "", "row-level update policy");
  assertStringIncludes(compiled.error ?? "", "Doc");
});

Deno.test("nested mutation access - upsert compiles unchanged where update is allowed unconditionally", async () => {
  const compiled = await asUser("insert Tag { name := 't' } unless conflict on .name else (update Tag set { name := 'u' })");
  assert(compiled.sql, `expected SQL, got error: ${compiled.error}`);
  assertStringIncludes(compiled.sql, "ON CONFLICT (name) DO UPDATE SET name = 'u'");
});

Deno.test("nested mutation access - upsert is unfiltered for a bypass caller", async () => {
  const doc = await asBypass("insert Doc { owner_id := 'me', title := 't' } unless conflict on .title else (update Doc set { owner_id := 'me' })");
  assert(doc.sql, `bypass must compile, got error: ${doc.error}`);
  assertStringIncludes(doc.sql, "ON CONFLICT (title) DO UPDATE SET");

  const journal = await asBypass("insert Journal { title := 't' } unless conflict on .title else (update Journal set { title := 'u' })");
  assert(journal.sql, `bypass must compile, got error: ${journal.error}`);
  assertStringIncludes(journal.sql, "ON CONFLICT (title) DO UPDATE SET");
});

// ---------------------------------------------------------------------------
// with-form
// ---------------------------------------------------------------------------

Deno.test("nested mutation access - with-form update carries the owner predicate inside the CTE", async () => {
  assertOwnerScoped(await asUser("with u := (update Doc filter .title = 'x' set { title := 'y' }) select u"), "UPDATE doc");
});

Deno.test("nested mutation access - with-form delete carries the owner predicate inside the CTE", async () => {
  assertOwnerScoped(await asUser("with d := (delete Doc filter .title = 'x') select d"), "DELETE FROM doc");
});

Deno.test("nested mutation access - with-form insert/update/delete on a using(false) type are denied", async () => {
  assertDenied(await asUser("with m := (insert Locked { name := 'x' }) select m"), "INSERT");
  assertDenied(await asUser("with m := (update Locked set { name := 'x' }) select m"), "UPDATE");
  assertDenied(await asUser("with m := (delete Locked) select m"), "DELETE");
});

Deno.test("nested mutation access - with-form is unfiltered for a bypass caller", async () => {
  assertUnfiltered(await asBypass("with u := (update Doc filter .title = 'x' set { title := 'y' }) select u"));
  assertUnfiltered(await asBypass("with d := (delete Doc filter .title = 'x') select d"));
  assertUnfiltered(await asBypass("with m := (insert Locked { name := 'x' }) select m"));
  assertUnfiltered(await asBypass("with m := (update Locked set { name := 'x' }) select m"));
});

// ---------------------------------------------------------------------------
// for … union (…)
// ---------------------------------------------------------------------------

Deno.test("nested mutation access - for-insert on a using(false) type is denied", async () => {
  assertDenied(await asUser("for n in {'a', 'b'} union (insert Locked { name := n })"), "INSERT");
  assertDenied(await asUser("for n in {'a'} union (insert Locked { name := n })"), "INSERT");
});

Deno.test("nested mutation access - for-insert is allowed where the insert policy allows it", async () => {
  const compiled = await asUser("for t in {'a', 'b'} union (insert Doc { owner_id := 'o', title := t })");
  assert(compiled.sql, `expected SQL, got error: ${compiled.error}`);
  assertStringIncludes(compiled.sql, "INSERT INTO doc");
});

Deno.test("nested mutation access - for-update carries the owner predicate in every branch", async () => {
  const compiled = await asUser("for t in {'a', 'b'} union (update Doc filter .title = t set { title := 'z' })");
  assert(compiled.sql, `expected SQL, got error: ${compiled.error}`);
  assertEquals(countOf(compiled.sql, "UPDATE doc"), 2);
  assertEquals(countOf(compiled.sql, OWNER_PREDICATE), 2, `every branch needs the predicate: ${compiled.sql}`);
});

Deno.test("nested mutation access - for-insert is unfiltered for a bypass caller", async () => {
  const compiled = await asBypass("for n in {'a', 'b'} union (insert Locked { name := n })");
  assert(compiled.sql, `bypass must compile, got error: ${compiled.error}`);
  assertStringIncludes(compiled.sql, "INSERT INTO locked");
});

// ---------------------------------------------------------------------------
// Multi-link writes (CTEStatement)
// ---------------------------------------------------------------------------

Deno.test("nested mutation access - multi-link update with scalar sets scopes the UPDATE inside the CTE", async () => {
  assertOwnerScoped(
    await asUser("update Doc filter .title = 'x' set { title := 'q', tags := (select Tag filter .name = 't') }"),
    "UPDATE doc"
  );
});

Deno.test("nested mutation access - multi-link-only update scopes the source row SELECT", async () => {
  const compiled = await asUser("update Doc filter .title = 'x' set { tags += (select Tag filter .name = 't') }");
  assert(compiled.sql, `expected SQL, got error: ${compiled.error}`);
  const sourceCte = compiled.sql.slice(compiled.sql.indexOf("upd AS ("), compiled.sql.indexOf("link_0 AS ("));
  assertStringIncludes(sourceCte, "FROM doc");
  assertStringIncludes(sourceCte, OWNER_PREDICATE, `junction rows must only be written for rows the caller may update: ${compiled.sql}`);
  assertEquals(countOf(compiled.sql, OWNER_PREDICATE), 1);
});

Deno.test("nested mutation access - multi-link update and insert on a using(false) type are denied", async () => {
  assertDenied(await asUser("update Locked set { tags += (select Tag) }"), "UPDATE");
  assertDenied(await asUser("update Locked set { name := 'x', tags := (select Tag) }"), "UPDATE");
  assertDenied(await asUser("insert Locked { name := 'x', tags := (select Tag) }"), "INSERT");
});

Deno.test("nested mutation access - multi-link update is unfiltered for a bypass caller", async () => {
  assertUnfiltered(await asBypass("update Doc filter .title = 'x' set { tags += (select Tag filter .name = 't') }"));
  assertUnfiltered(await asBypass("update Locked set { name := 'x', tags := (select Tag) }"));
  assertUnfiltered(await asBypass("insert Locked { name := 'x', tags := (select Tag) }"));
});

// ---------------------------------------------------------------------------
// explain
// ---------------------------------------------------------------------------

Deno.test("nested mutation access - explain analyze of a mutation carries the policy", async () => {
  assertOwnerScoped(await asUser("explain analyze update Doc set { title := 'y' }"), "UPDATE doc");
  assertDenied(await asUser("explain analyze delete Locked"), "DELETE");
});

// ---------------------------------------------------------------------------
// Top-level select is untouched
// ---------------------------------------------------------------------------

Deno.test("nested mutation access - top-level select policy behavior is unchanged", async () => {
  const owned = await asUser("select Doc { title }");
  assert(owned.sql);
  assertEquals(countOf(owned.sql, OWNER_PREDICATE), 1);

  const locked = await asUser("select Locked { name }");
  assert(locked.sql);
  assertStringIncludes(locked.sql, "WHERE FALSE");

  const bypassed = await asBypass("select Doc { title }");
  assert(bypassed.sql);
  assertEquals(bypassed.sql.includes("WHERE"), false);
});

// S13: policies are registered under TypeDef.name, so the lookup must not use
// the spelling from the query.
Deno.test("nested mutation access - module-qualified select gets the same policy as the bare name", async () => {
  const owned = await asUser("select default::Doc { title }");
  assert(owned.sql, `expected SQL, got error: ${owned.error}`);
  assertEquals(countOf(owned.sql, OWNER_PREDICATE), 1, `select default::Doc must be owner-scoped: ${owned.sql}`);
  assertEquals(owned.sql, (await asUser("select Doc { title }")).sql);

  const locked = await asUser("select default::Locked { name }");
  assert(locked.sql, `expected SQL, got error: ${locked.error}`);
  assertStringIncludes(locked.sql, "WHERE FALSE");

  const bypassed = await asBypass("select default::Doc { title }");
  assert(bypassed.sql);
  assertEquals(bypassed.sql.includes("WHERE"), false);
});

// ---------------------------------------------------------------------------
// The twin in compiler-with-access.ts
// ---------------------------------------------------------------------------

// EdgeQLCompilerWithAccess is a select-only prototype that nothing outside its
// own test imports. It has the same top-level-only applyAccessControl, which is
// harmless only as long as it cannot compile a mutation in any position. Pin
// that, so whoever teaches it mutations has to bring the policy along.
Deno.test("nested mutation access - the select-only twin compiler refuses every mutation form", async () => {
  const twin = new EdgeQLCompilerWithAccess(await testSchema());

  const forms = [
    "insert Locked { name := 'x' }",
    "update Doc set { title := 'y' }",
    "delete Doc",
    "with u := (update Doc set { title := 'y' }) select u",
    "for n in {'a', 'b'} union (insert Locked { name := n })"
  ];

  for (const edgeql of forms) {
    const result = twin.compile(new EdgeQLParser(edgeql).parse());
    assertEquals(result.ok, false, `the twin compiled a mutation without a policy: ${edgeql}`);
  }
});

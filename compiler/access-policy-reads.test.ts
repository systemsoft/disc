/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * Select policies narrow every read of an object type's table (see
 * `restrictObjectReads`); a query that reads no narrowed type compiles to the
 * same SQL as with access control off. The results against PostgreSQL are in
 * `pg-access-policy-reads.test.ts`.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { AccessContext } from "../access/mod.ts";
import { EdgeQLParser } from "../edgeql/parser.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const SDL = `module default {
  type Comment {
    required body: str;
  }
  type Post {
    required title: str;
    published: bool;
    author: User;
    multi comments: Comment;
    access policy visible {
      allow all;
      using (.published ?= true);
    };
  }
  type User {
    required name: str;
    best: Post;
    multi posts: Post;
  }
}`;

const USER = "01234567-89ab-7cde-8f01-000000000001";

let cached: Schema | undefined;

async function schema(): Promise<Schema> {
  if (!cached) {
    const manager = new SchemaManager({ dryRun: true });
    await manager.initialize();
    const parsed = manager.parseSDL(SDL);
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    cached = manager.modulesToSchema(parsed.value);
  }
  return cached;
}

/*** SQL of `edgeql`, with access control off, or on with the schema's policies registered. ***/
async function sqlOf(edgeql: string, access: "off" | AccessContext): Promise<string> {
  const compiler = access === "off" ?
    new EdgeQLCompiler(await schema(), { enableAccessControl: false }) :
    new EdgeQLCompiler(await schema(), {
      accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
      accessContext: access,
      enableAccessControl: true
    });
  if (access !== "off") {
    for (const typeDef of (await schema()).types.values()) {
      for (const policy of typeDef.accessPolicies ?? []) {
        compiler.registerAccessPolicy(policy);
      }
    }
  }
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw new Error(`${edgeql}: ${result.error.message}`);
  }
  return new SQLCodeGenerator().generate(result.value).replace(/\s+/g, " ");
}

// Queries that read only User and Comment, which no policy narrows.
const UNNARROWED = [
  "select User { name }",
  "with u := User select u { name }",
  "with u := (select User filter .name = 'a') select u.name",
  "for u in (select User) union (select u { name })",
  "for u in (select User) union (update u set { name := 'x' })",
  "select Comment { body } filter .body = 'x'",
  "select count(User)",
  "select exists (select User filter .name = 'a')"
];

Deno.test("access policy reads - a query reading no narrowed type compiles as with access control off", async () => {
  for (const edgeql of UNNARROWED) {
    assertEquals(await sqlOf(edgeql, { userId: USER }), await sqlOf(edgeql, "off"), edgeql);
  }
});

Deno.test("access policy reads - a bypass caller's SQL is unfiltered wherever the narrowed type is read", async () => {
  for (
    const edgeql of [
      ...UNNARROWED,
      "select Post { title }",
      "select User.posts.comments { body }",
      "select User { titles := .posts.title, best: { title }, posts, n := count(.posts) } filter .posts.title = 'x'",
      "with p := Post select p { title }",
      "for p in (select Post) union (select p.title)"
    ]
  ) {
    assertEquals(await sqlOf(edgeql, { bypass: true, userId: USER }), await sqlOf(edgeql, "off"), edgeql);
  }
});

Deno.test("access policy reads - each read of a narrowed table is wrapped once, the top-level select included", async () => {
  const sql = await sqlOf("select Post { title }", { userId: USER });
  assertEquals(
    sql,
    "SELECT jsonb_build_object('title', post_1.title) FROM ( SELECT * FROM post AS __policy_rows WHERE __policy_rows.published IS NOT DISTINCT FROM TRUE ) AS post_1"
  );

  // A path's intermediate hop through Post reads the visible posts, then the comments.
  const path = await sqlOf("select User.posts.comments { body }", { userId: USER });
  assertEquals(path.split("FROM post AS __policy_rows WHERE __policy_rows.published IS NOT DISTINCT FROM TRUE").length - 1, 1, path);
  assert(!path.includes("SELECT * FROM ( SELECT *"), path);
});

Deno.test("access policy reads - a with binding named like a narrowed table reads the binding in the body", async () => {
  const sql = await sqlOf("with post := (select Post filter .title = 'x') select post { title }", { userId: USER });
  // The binding's own query reads the table, narrowed; the body reads the CTE.
  assertStringIncludes(
    sql,
    "WITH post AS ( SELECT * FROM ( SELECT * FROM post AS __policy_rows WHERE __policy_rows.published IS NOT DISTINCT FROM TRUE ) AS post_1"
  );
  assertStringIncludes(sql, "FROM post AS post_2");
});

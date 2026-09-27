/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: a policy's condition is any EdgeQL expression over the
 * object, and Gel's `when`, deny filtering and globals.
 *
 * As in Gel:
 * - a condition may follow links (single and multi), backlinks, call
 *   functions and read globals; the objects it reads are not narrowed by
 *   their own policies ("policy expressions themselves do not take other
 *   policies into account");
 * - `when (<cond>)` limits the objects a policy applies to;
 * - "all allow policies collectively form a union of allowed sets; all deny
 *   policies subtract from that union": a deny's condition removes the
 *   objects it holds for from a select, update or delete;
 * - a `str` global may be set to the empty string, which is a value.
 *
 * Seed (current user: ann):
 *   users ann, bob (bob hidden by `me`);
 *   projects P1 (ann, team T1), P2 (bob, members {ann}), P3 (bob, 'Public'), P4 (bob, 'secret', team T2);
 *   teams T1, T2, T3 (visible while some project is on them);
 *   tasks K1 (P1), K2 (P2); nodes root ← child ← grandchild.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  global apx_role: str;
  global apx_note: str;
  global apx_label: str {
    default := 'dflt';
  };
  required global apx_level: int64 {
    default := 1;
  };
  type ApxUser {
    required name: str {
      constraint exclusive;
    };
    access policy me {
      allow all;
      using (.id ?= global current_user);
    };
  }
  type ApxTeam {
    required name: str;
    access policy with_projects
      allow select
      using (exists .<team[is ApxProject]);
  }
  type ApxProject {
    required title: str;
    owner: ApxUser;
    team: ApxTeam;
    multi members: ApxUser;
    access policy owned
      allow all
      using (.owner.id ?= global current_user) {
        errmessage := 'not your project';
      };
    access policy member
      allow select
      using (global current_user in .members.id);
    access policy bobs_public
      allow select
      using (.owner.name ?= 'bob' and str_lower(.title) = 'public');
  }
  type ApxTask {
    required title: str;
    project: ApxProject;
    access policy via_project
      allow all
      using (.project.owner.name ?= 'ann');
  }
  type ApxNode {
    required name: str;
    parent: ApxNode;
    access policy rooted
      allow all
      using (.name = 'root' or .parent.name ?= 'root');
  }
  type ApxWhen {
    required title: str;
    locked: bool;
    public: bool;
    access policy everyone
      allow select
      using (.public ?= true);
    access policy admins
      when (global apx_role ?= 'admin')
      allow all;
    access policy no_locked
      when (.locked ?= true)
      deny update, delete;
    access policy editors {
      when (global apx_role ?= 'editor');
      allow select;
    };
  }
  type ApxSecret {
    required title: str;
    secret: bool;
    access policy open
      allow all;
    access policy hide
      deny select
      using (.secret ?= true);
  }
  type ApxTagged {
    required tag: str;
    access policy by_note
      allow select
      using (.tag ?= global apx_note);
  }
}`;

const TABLES = [
  "apx_project_members",
  "apx_task",
  "apx_project",
  "apx_team",
  "apx_user",
  "apx_node",
  "apx_when",
  "apx_secret",
  "apx_tagged"
];

const ID = (n: number): string => `01234567-89ab-7cde-8f01-${n.toString().padStart(12, "0")}`;
const [ANN, BOB] = [ID(1), ID(2)];
const [P1, P2, P3, P4] = [ID(11), ID(12), ID(13), ID(14)];
const [T1, T2, T3] = [ID(21), ID(22), ID(23)];
const [ROOT, CHILD] = [ID(31), ID(32)];

async function withSchema(run: (pool: ConnectionPool, schema: Schema) => Promise<void>): Promise<void> {
  const pool = makePool(await getTestDsn());
  await pool.initialize();
  try {
    await dropAll(pool);
    const manager = new SchemaManager({ pool });
    await manager.initialize();
    const applied = await manager.applySchema(SDL);
    assertEquals(applied.ok, true, `applySchema failed: ${applied.ok ? "" : applied.error.message}`);
    const schema = manager.getSchema();
    if (!schema) {
      throw new Error("no schema after applySchema");
    }
    await pool.query(`INSERT INTO apx_user (id, name) VALUES ('${ANN}', 'ann'), ('${BOB}', 'bob')`);
    await pool.query(`INSERT INTO apx_team (id, name) VALUES ('${T1}', 'T1'), ('${T2}', 'T2'), ('${T3}', 'T3')`);
    await pool.query(
      `INSERT INTO apx_project (id, title, owner_id, team_id) VALUES
        ('${P1}', 'P1', '${ANN}', '${T1}'), ('${P2}', 'P2', '${BOB}', NULL), ('${P3}', 'Public', '${BOB}', NULL), ('${P4}', 'secret', '${BOB}', '${T2}')`
    );
    await pool.query(`INSERT INTO apx_project_members (source_id, target_id) VALUES ('${P2}', '${ANN}')`);
    await pool.query(`INSERT INTO apx_task (title, project_id) VALUES ('K1', '${P1}'), ('K2', '${P2}')`);
    await pool.query(`INSERT INTO apx_node (id, name, parent_id) VALUES ('${ROOT}', 'root', NULL), ('${CHILD}', 'child', '${ROOT}')`);
    await pool.query(`INSERT INTO apx_node (name, parent_id) VALUES ('grandchild', '${CHILD}')`);
    await pool.query("INSERT INTO apx_when (title, locked, public) VALUES ('W1', false, true), ('W2', false, false), ('W3', true, false)");
    await pool.query("INSERT INTO apx_secret (title, secret) VALUES ('S1', false), ('S2', true)");
    await pool.query("INSERT INTO apx_tagged (tag) VALUES (''), ('x')");
    await run(pool, schema);
    await manager.close();
  } finally {
    await dropAll(pool);
    await pool.close();
  }
}

async function dropAll(pool: ConnectionPool): Promise<void> {
  for (const table of TABLES) {
    await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  }
  await pool.query("DROP TABLE IF EXISTS disc_migrations CASCADE");
  await pool.query("DROP TABLE IF EXISTS disc_migration_checkpoints CASCADE");
}

/*** Compile `edgeql` as ann, with every type's policies registered the way the server does. ***/
function compileAsAnn(edgeql: string, schema: Schema): string {
  const compiler = new EdgeQLCompiler(schema, {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
    accessContext: { userId: ANN },
    enableAccessControl: true
  });
  for (const typeDef of schema.types.values()) {
    for (const policy of typeDef.accessPolicies ?? []) {
      compiler.registerAccessPolicy(policy);
    }
  }
  const result = compiler.compile(new EdgeQLParser(edgeql).parse());
  if (!result.ok) {
    throw new Error(`Compilation failed for ${edgeql}: ${result.error.message}`);
  }
  return new SQLCodeGenerator().generate(result.value);
}

/*** Run `edgeql` statements as ann in one transaction (so `set global` holds); the single column of the last one's rows, sorted. ***/
async function run(pool: ConnectionPool, schema: Schema, ...edgeql: string[]): Promise<unknown[]> {
  const rows = await pool.transaction(async connection => {
    let last: Record<string, unknown>[] = [];
    for (const statement of edgeql) {
      last = (await connection.query(compileAsAnn(statement, schema))).rows as Record<string, unknown>[];
    }
    return last;
  });
  return rows
    .map(row => {
      const value = Object.values(row)[0];
      return typeof value === "bigint" ? Number(value) : value;
    })
    .sort();
}

/*** Run `edgeql` as ann and expect Gel's access policy violation, with `message`. ***/
async function assertViolation(pool: ConnectionPool, schema: Schema, message: string, ...edgeql: string[]): Promise<void> {
  const error = await assertRejects(() => run(pool, schema, ...edgeql)) as Error & { fields?: { code?: string; }; };
  assertStringIncludes(error.message, message);
  assertEquals(error.fields?.code, "42501", error.message);
}

async function column(pool: ConnectionPool, sql: string): Promise<unknown[]> {
  return (await pool.query(sql)).rows.map(row => Object.values(row)[0]).sort();
}

Deno.test({
  name: "PG access policy expressions: a condition follows single links, multi links and function calls",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // P1 is ann's; ann is a member of P2; P3 is bob's and public — read through bob, whom ann cannot see.
      assertEquals(await run(pool, schema, "select ApxProject.title"), ["P1", "P2", "Public"]);
      assertEquals(await run(pool, schema, "select ApxUser.name"), ["ann"]);
      // Two hops: a task is ann's when its project's owner is.
      assertEquals(await run(pool, schema, "select ApxTask.title"), ["K1"]);
    })
});

Deno.test({
  name: "PG access policy expressions: a condition over a backlink ignores the policies of the objects it reads",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // T2's only project (P4) is hidden from ann, but the policy still sees it.
      assertEquals(await run(pool, schema, "select ApxTeam.name"), ["T1", "T2"]);
    })
});

Deno.test({
  name: "PG access policy expressions: a condition over a self link does not recurse",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select ApxNode.name"), ["child", "root"]);
      assertEquals(
        await run(pool, schema, "select ApxNode { name, parent: { name } } filter .name = 'child'"),
        [{ name: "child", parent: [{ name: "root" }] }]
      );
    })
});

Deno.test({
  name: "PG access policy expressions: update and delete reach only objects whose condition holds through links",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // P2 and Public are visible, but only P1 is ann's to update or delete.
      await run(pool, schema, "update ApxProject set { title := .title ++ '!' }");
      assertEquals(await column(pool, "SELECT title FROM apx_project"), ["P1!", "P2", "Public", "secret"]);
      await run(pool, schema, "delete ApxTask");
      assertEquals(await column(pool, "SELECT title FROM apx_task"), ["K2"]);
    })
});

Deno.test({
  name: "PG access policy expressions: written objects are checked through links",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "insert ApxProject { title := 'mine', owner := (select ApxUser filter .name = 'ann') }");
      await assertViolation(pool, schema, "access policy violation on insert of default::ApxProject (not your project)", "insert ApxProject { title := 'x' }");
      await assertViolation(
        pool,
        schema,
        "access policy violation on update of default::ApxProject (not your project)",
        "update ApxProject filter .title = 'P1' set { owner := {} }"
      );
      // P2 is visible (ann is a member) but bob's: a task on it is not ann's.
      await assertViolation(
        pool,
        schema,
        "access policy violation on insert of default::ApxTask",
        "insert ApxTask { title := 'k', project := (select ApxProject filter .title = 'P2') }"
      );
      await run(pool, schema, "insert ApxTask { title := 'k', project := (select ApxProject filter .title = 'P1') }");
      assertEquals(await column(pool, "SELECT title FROM apx_project"), ["P1", "P2", "Public", "mine", "secret"]);
      assertEquals(await column(pool, "SELECT title FROM apx_task"), ["K1", "K2", "k"]);
    })
});

Deno.test({
  name: "PG access policy when: a policy applies only to the objects its when holds for",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select ApxWhen.title"), ["W1"]);
      assertEquals(await run(pool, schema, "set global apx_role := 'admin'", "select ApxWhen.title"), ["W1", "W2", "W3"]);
      assertEquals(await run(pool, schema, "set global apx_role := 'editor'", "select ApxWhen.title"), ["W1", "W2", "W3"]);

      // The deny applies to locked objects only.
      await run(pool, schema, "set global apx_role := 'admin'", "update ApxWhen set { title := .title ++ '!' }");
      assertEquals(await column(pool, "SELECT title FROM apx_when"), ["W1!", "W2!", "W3"]);
      await run(pool, schema, "set global apx_role := 'admin'", "delete ApxWhen");
      assertEquals(await column(pool, "SELECT title FROM apx_when"), ["W3"]);

      // Locking an object on update is denied by the deny's write half.
      await run(pool, schema, "set global apx_role := 'admin'", "insert ApxWhen { title := 'W4', locked := false }");
      await assertViolation(
        pool,
        schema,
        "access policy violation on update of default::ApxWhen",
        "set global apx_role := 'admin'",
        "update ApxWhen filter .title = 'W4' set { locked := true }"
      );
    })
});

Deno.test({
  name: "PG access policy deny: a deny's condition removes the objects it holds for from select, update and delete",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select ApxSecret.title"), ["S1"]);
      assertEquals(await run(pool, schema, "select count(ApxSecret)"), [1]);
      await run(pool, schema, "update ApxSecret set { title := .title ++ '!' }");
      assertEquals(await column(pool, "SELECT title FROM apx_secret"), ["S1!", "S2"]);
      await run(pool, schema, "delete ApxSecret");
      assertEquals(await column(pool, "SELECT title FROM apx_secret"), ["S2"]);
      // Denying select does not deny insert.
      await run(pool, schema, "insert ApxSecret { title := 'S3', secret := true }");
      assertEquals(await column(pool, "SELECT title FROM apx_secret"), ["S2", "S3"]);
    })
});

Deno.test({
  name: "PG access policy globals: a str global set to the empty string holds it",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select global apx_note"), [null]);
      assertEquals(await run(pool, schema, "set global apx_note := ''", "select global apx_note"), [""]);
      assertEquals(await run(pool, schema, "set global apx_label := ''", "select global apx_label"), [""]);
      assertEquals(await run(pool, schema, "select global apx_label"), ["dflt"]);
      assertEquals(await run(pool, schema, "set global apx_note := 'x'", "set global apx_note := {}", "select global apx_note"), [null]);
      // And a policy reads it.
      assertEquals(await run(pool, schema, "select ApxTagged.tag"), []);
      assertEquals(await run(pool, schema, "set global apx_note := ''", "select ApxTagged.tag"), [""]);
      assertEquals(await run(pool, schema, "set global apx_note := 'x'", "select ApxTagged.tag"), ["x"]);
      // `required global` (Gel's order) is declared with its default.
      assertEquals(await run(pool, schema, "select global apx_level"), [1]);
      assert(schema.globals?.get("apx_level")?.required ?? schema.globals?.get("default::apx_level")?.required);
    })
});

/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: insert and update write policies check the objects a
 * statement writes, after the write.
 *
 * As in Gel, `allow insert` and `allow update write` (`allow update` is
 * `update read` + `update write`) are "post-insert" / "post-update" checks:
 * every object the statement inserts or updates must satisfy an allowing
 * policy and no denying one, with its new values, or the statement fails with
 * "access policy violation on <insert|update> of <module::Type>" (plus the
 * policies' errmessages) and writes nothing.
 *
 * Seed (current user: ann): docs ann-doc (ann), bob-doc (bob); notes
 * n-open (unlocked), n-locked (locked); tags t1.
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
  type AcwTag {
    required name: str;
  }
  type AcwDoc {
    required title: str {
      constraint exclusive;
    };
    owner: uuid;
    multi tags: AcwTag;
    access policy own {
      allow all;
      using (.owner ?= global current_user);
      errmessage := 'only your own docs';
    };
  }
  type AcwNote {
    required body: str;
    locked: bool;
    multi tags: AcwTag;
    access policy read_all {
      allow select, update read;
    };
    access policy write_unlocked {
      allow insert, update write;
      using (.locked ?= false);
    };
  }
  type AcwPost {
    required title: str;
    access policy open {
      allow all;
    };
    access policy no_forbidden {
      deny insert, update write;
      using (.title ?= 'forbidden');
      errmessage := 'forbidden title';
    };
  }
  type AcwScore {
    score: int64;
    access policy nonnegative {
      allow all;
      with check (.score >= 0);
    };
  }
  abstract type AcwOwned {
    required title: str;
    owner: uuid;
    access policy owned {
      allow all;
      using (.owner ?= global current_user);
    };
  }
  type AcwSheet extending AcwOwned {}
  global acw_tenant: uuid;
  type AcwTenantRow {
    required label: str;
    tenant: uuid;
    access policy tenant_rows {
      allow all;
      using (.tenant ?= global acw_tenant);
    };
  }
  type AcwFree {
    required name: str;
  }
  type AcwFrozen {
    required name: str;
    access policy reach {
      allow select, update read;
    };
  }
  type AcwHolder {
    required name: str;
    doc: AcwDoc;
    multi docs: AcwDoc;
  }
}`;

const TABLES = [
  "acw_holder_docs",
  "acw_holder",
  "acw_doc_tags",
  "acw_note_tags",
  "acw_doc",
  "acw_note",
  "acw_tag",
  "acw_post",
  "acw_score",
  "acw_sheet",
  "acw_owned",
  "acw_tenant_row",
  "acw_free",
  "acw_frozen"
];

const ID = (n: number): string => `01234567-89ab-7cde-8f01-${n.toString().padStart(12, "0")}`;
const [ANN, BOB] = [ID(1), ID(2)];
const [TENANT_1, TENANT_2] = [ID(51), ID(52)];

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
    await pool.query(`INSERT INTO acw_doc (title, owner) VALUES ('ann-doc', '${ANN}'), ('bob-doc', '${BOB}')`);
    await pool.query("INSERT INTO acw_note (body, locked) VALUES ('n-open', false), ('n-locked', true)");
    await pool.query("INSERT INTO acw_tag (name) VALUES ('t1')");
    await pool.query("INSERT INTO acw_frozen (name) VALUES ('f1')");
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

/*** Run `edgeql` statements as ann in one transaction (so `set global` holds). ***/
async function run(pool: ConnectionPool, schema: Schema, ...edgeql: string[]): Promise<void> {
  await pool.transaction(async connection => {
    for (const statement of edgeql) {
      await connection.query(compileAsAnn(statement, schema));
    }
  });
}

/*** Run `edgeql` as ann and expect Gel's access policy violation, with `message`. ***/
async function assertViolation(pool: ConnectionPool, schema: Schema, message: string, ...edgeql: string[]): Promise<void> {
  const error = await assertRejects(() => run(pool, schema, ...edgeql)) as Error & { fields?: { code?: string; }; cause?: unknown; };
  assertStringIncludes(error.message, message);
  assert(
    JSON.stringify(error.fields ?? error.cause ?? error).includes("42501") || error.message.includes("42501"),
    `expected SQLSTATE 42501: ${error.message}`
  );
}

async function column(pool: ConnectionPool, sql: string): Promise<unknown[]> {
  return (await pool.query(sql)).rows.map(row => Object.values(row)[0]);
}

const DOC_UPDATE = "access policy violation on update of default::AcwDoc (only your own docs)";
const DOC_INSERT = "access policy violation on insert of default::AcwDoc (only your own docs)";

Deno.test({
  name: "PG access policy writes: an update cannot give an object away (update write check)",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await assertViolation(pool, schema, DOC_UPDATE, `update AcwDoc filter .title = 'ann-doc' set { owner := <uuid>'${BOB}' }`);
      await assertViolation(pool, schema, DOC_UPDATE, "update AcwDoc set { owner := <uuid>{} }");
      assertEquals(await column(pool, "SELECT owner::text FROM acw_doc ORDER BY title"), [ANN, BOB]);

      // A write that keeps the object passing is allowed.
      await run(pool, schema, "update AcwDoc set { title := 'ann-doc-2' }");
      assertEquals(await column(pool, "SELECT title FROM acw_doc ORDER BY title"), ["ann-doc-2", "bob-doc"]);
    })
});

Deno.test({
  name: "PG access policy writes: an insert cannot create an object owned by someone else",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await assertViolation(pool, schema, DOC_INSERT, `insert AcwDoc { title := 'x', owner := <uuid>'${BOB}' }`);
      await assertViolation(pool, schema, DOC_INSERT, "insert AcwDoc { title := 'x' }");
      await run(pool, schema, `insert AcwDoc { title := 'mine', owner := <uuid>'${ANN}' }`);
      assertEquals(await column(pool, "SELECT title FROM acw_doc ORDER BY title"), ["ann-doc", "bob-doc", "mine"]);
    })
});

Deno.test({
  name: "PG access policy writes: a bulk insert or for body fails as a whole when one object fails",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await assertViolation(pool, schema, DOC_INSERT, `for t in {'a', 'b'} union (insert AcwDoc { title := t, owner := <uuid>'${BOB}' })`);
      await assertViolation(
        pool,
        schema,
        DOC_INSERT,
        `for o in {<uuid>'${ANN}', <uuid>'${BOB}'} union (insert AcwDoc { title := <str>o, owner := o })`
      );
      assertEquals(await column(pool, "SELECT count(*)::int FROM acw_doc"), [2]);

      await assertViolation(pool, schema, DOC_UPDATE, `for d in AcwDoc union (update d set { owner := <uuid>'${BOB}' })`);
      await assertViolation(pool, schema, DOC_UPDATE, `for x in {1} union (update AcwDoc set { owner := <uuid>'${BOB}' })`);
      assertEquals(await column(pool, "SELECT owner::text FROM acw_doc ORDER BY title"), [ANN, BOB]);

      await run(pool, schema, `for t in {'a', 'b'} union (insert AcwDoc { title := t, owner := <uuid>'${ANN}' })`);
      assertEquals(await column(pool, "SELECT count(*)::int FROM acw_doc"), [4]);
    })
});

Deno.test({
  name: "PG access policy writes: both branches of an upsert are checked",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      // Insert branch: no conflict, the new object must pass the insert policy.
      await assertViolation(
        pool,
        schema,
        DOC_INSERT,
        `insert AcwDoc { title := 'new', owner := <uuid>'${BOB}' } unless conflict on .title else (update AcwDoc set { title := 'x' })`
      );
      // Else branch: the updated object must pass the update write policy.
      await assertViolation(
        pool,
        schema,
        DOC_UPDATE,
        `insert AcwDoc { title := 'ann-doc', owner := <uuid>'${ANN}' } unless conflict on .title else (update AcwDoc set { owner := <uuid>'${BOB}' })`
      );
      assertEquals(await column(pool, "SELECT title || ':' || owner FROM acw_doc ORDER BY title"), [`ann-doc:${ANN}`, `bob-doc:${BOB}`]);

      await run(
        pool,
        schema,
        `insert AcwDoc { title := 'ann-doc', owner := <uuid>'${ANN}' } unless conflict on .title else (update AcwDoc set { title := 'ann-upserted' })`
      );
      await run(pool, schema, `insert AcwDoc { title := 'fresh', owner := <uuid>'${ANN}' } unless conflict on .title`);
      assertEquals(await column(pool, "SELECT title FROM acw_doc ORDER BY title"), ["ann-upserted", "bob-doc", "fresh"]);
    })
});

Deno.test({
  name: "PG access policy writes: a mutation in a with binding or under a shape is checked",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await assertViolation(pool, schema, DOC_INSERT, `select (insert AcwDoc { title := 'x', owner := <uuid>'${BOB}' }) { title }`);
      await assertViolation(pool, schema, DOC_UPDATE, `with d := (update AcwDoc set { owner := <uuid>'${BOB}' }) select d { title }`);
      // A multi-link insert writes its junction rows in the same statement: all or nothing.
      await assertViolation(
        pool,
        schema,
        DOC_INSERT,
        `insert AcwDoc { title := 'x', owner := <uuid>'${BOB}', tags := (select AcwTag) }`
      );
      assertEquals(await column(pool, "SELECT count(*)::int FROM acw_doc_tags"), [0]);
      assertEquals(await column(pool, "SELECT count(*)::int FROM acw_doc"), [2]);
    })
});

Deno.test({
  name: "PG access policy writes: update read picks the objects, update write checks them after the write",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const violation = "access policy violation on update of default::AcwNote";
      // Both notes may be updated (update read), but none may end up locked (update write).
      await assertViolation(pool, schema, violation, "update AcwNote filter .body = 'n-open' set { locked := true }");
      await assertViolation(pool, schema, violation, "update AcwNote filter .body = 'n-locked' set { body := 'x' }");
      // A multi-link-only update still updates the object.
      await assertViolation(pool, schema, violation, "update AcwNote filter .body = 'n-locked' set { tags += (select AcwTag) }");
      assertEquals(await column(pool, "SELECT count(*)::int FROM acw_note_tags"), [0]);

      await run(pool, schema, "update AcwNote filter .body = 'n-locked' set { locked := false }");
      await run(pool, schema, "update AcwNote set { body := 'edited' }");
      assertEquals(await column(pool, "SELECT body FROM acw_note"), ["edited", "edited"]);

      await assertViolation(pool, schema, "access policy violation on insert of default::AcwNote", "insert AcwNote { body := 'b', locked := true }");
      await run(pool, schema, "insert AcwNote { body := 'b', locked := false }");
      assertEquals(await column(pool, "SELECT count(*)::int FROM acw_note"), [3]);
    })
});

Deno.test({
  name: "PG access policy writes: a deny policy wins over an allow for the objects it matches",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "insert AcwPost { title := 'fine' }");
      await assertViolation(pool, schema, "access policy violation on insert of default::AcwPost (forbidden title)", "insert AcwPost { title := 'forbidden' }");
      await assertViolation(
        pool,
        schema,
        "access policy violation on update of default::AcwPost (forbidden title)",
        "update AcwPost set { title := 'forbidden' }"
      );
      assertEquals(await column(pool, "SELECT title FROM acw_post"), ["fine"]);
    })
});

Deno.test({
  name: "PG access policy writes: a with check clause is checked on written objects",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "insert AcwScore { score := 1 }");
      await assertViolation(pool, schema, "access policy violation on insert of default::AcwScore", "insert AcwScore { score := -1 }");
      await assertViolation(pool, schema, "access policy violation on update of default::AcwScore", "update AcwScore set { score := -5 }");
      assertEquals(await column(pool, "SELECT score::int FROM acw_score"), [1]);
    })
});

Deno.test({
  name: "PG access policy writes: inherited policies and custom globals check written objects",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await assertViolation(
        pool,
        schema,
        "access policy violation on insert of default::AcwSheet",
        `insert AcwSheet { title := 's', owner := <uuid>'${BOB}' }`
      );
      await run(pool, schema, `insert AcwSheet { title := 's', owner := <uuid>'${ANN}' }`);
      assertEquals(await column(pool, "SELECT title FROM acw_sheet"), ["s"]);

      await assertViolation(
        pool,
        schema,
        "access policy violation on insert of default::AcwTenantRow",
        `set global acw_tenant := <uuid>'${TENANT_1}'`,
        `insert AcwTenantRow { label := 'r', tenant := <uuid>'${TENANT_2}' }`
      );
      await run(pool, schema, `set global acw_tenant := <uuid>'${TENANT_1}'`, `insert AcwTenantRow { label := 'r', tenant := <uuid>'${TENANT_1}' }`);
      await assertViolation(
        pool,
        schema,
        "access policy violation on update of default::AcwTenantRow",
        `set global acw_tenant := <uuid>'${TENANT_1}'`,
        `update AcwTenantRow set { tenant := <uuid>'${TENANT_2}' }`
      );
      assertEquals(await column(pool, "SELECT tenant::text FROM acw_tenant_row"), [TENANT_1]);
    })
});

Deno.test({
  name: "PG access policy writes: with no update write policy every updated object fails, and a write of none succeeds",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "update AcwFrozen filter .name = 'none' set { name := 'x' }");
      await assertViolation(pool, schema, "access policy violation on update of default::AcwFrozen", "update AcwFrozen set { name := 'x' }");
      assertEquals(await column(pool, "SELECT name FROM acw_frozen"), ["f1"]);
    })
});

Deno.test({
  name: "PG access policy writes: a type without policies is written unchecked",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const sql = compileAsAnn("insert AcwFree { name := 'x' }", schema);
      assertEquals(sql.includes("disc_access_check"), false, sql);
      await run(pool, schema, "insert AcwFree { name := 'x' }", "update AcwFree set { name := 'y' }");
      assertEquals(await column(pool, "SELECT name FROM acw_free"), ["y"]);
    })
});

Deno.test({
  name: "PG access policy writes: an update through the abstract parent is checked per concrete subtype",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, `insert AcwSheet { title := 's', owner := <uuid>'${ANN}' }`);

      await assertViolation(
        pool,
        schema,
        "access policy violation on update of default::AcwSheet",
        `update AcwOwned set { owner := <uuid>'${BOB}' }`
      );
      assertEquals(await column(pool, "SELECT owner::text FROM acw_sheet"), [ANN]);

      await run(pool, schema, "update AcwOwned set { title := 's2' }");
      assertEquals(await column(pool, "SELECT title FROM acw_sheet"), ["s2"]);
    })
});

Deno.test({
  name: "PG access policy writes: an insert nested in a link assignment is checked, and the statement links only visible objects",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      const doc = (title: string, owner: string): string => `(insert AcwDoc { title := '${title}', owner := <uuid>'${owner}' })`;
      const holderDoc = "SELECT h.name || ':' || d.title FROM acw_holder h JOIN acw_doc d ON d.id = h.doc_id ORDER BY 1";
      const holderDocs =
        "SELECT h.name || ':' || d.title FROM acw_holder_docs j JOIN acw_holder h ON h.id = j.source_id JOIN acw_doc d ON d.id = j.target_id ORDER BY 1";

      // A nested object that fails the insert policy fails the whole statement.
      await assertViolation(pool, schema, DOC_INSERT, `insert AcwHolder { name := 'h', doc := ${doc("n1", BOB)} }`);
      await assertViolation(pool, schema, DOC_INSERT, `insert AcwHolder { name := 'h', docs := {${doc("n2", ANN)}, ${doc("n3", BOB)}} }`);
      assertEquals(await column(pool, "SELECT count(*)::int FROM acw_holder"), [0]);
      assertEquals(await column(pool, "SELECT title FROM acw_doc ORDER BY title"), ["ann-doc", "bob-doc"]);

      // Selected targets are the ones the select policy shows: bob-doc is not linked.
      await run(
        pool,
        schema,
        `insert AcwHolder { name := 'h', doc := ${doc("mine", ANN)}, docs := {${doc("mine2", ANN)}, (select AcwDoc filter .title in {'ann-doc', 'bob-doc'})} }`
      );
      assertEquals(await column(pool, holderDoc), ["h:mine"]);
      assertEquals(await column(pool, holderDocs), ["h:ann-doc", "h:mine2"]);

      // An update's nested inserts are checked the same way.
      await assertViolation(pool, schema, DOC_INSERT, `update AcwHolder set { doc := ${doc("n4", BOB)} }`);
      await assertViolation(pool, schema, DOC_INSERT, `update AcwHolder set { docs += ${doc("n5", BOB)} }`);
      await run(pool, schema, `update AcwHolder set { doc := ${doc("mine3", ANN)}, docs += ${doc("mine4", ANN)} }`);
      assertEquals(await column(pool, holderDoc), ["h:mine3"]);
      assertEquals(await column(pool, holderDocs), ["h:ann-doc", "h:mine2", "h:mine4"]);
      assertEquals(await column(pool, "SELECT title FROM acw_doc ORDER BY title"), ["ann-doc", "bob-doc", "mine", "mine2", "mine3", "mine4"]);
    })
});

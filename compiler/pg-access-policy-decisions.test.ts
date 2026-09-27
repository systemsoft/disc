/*** SPDX-License-Identifier: Apache-2.0
     Copyright 2026 Ideas Never Cease ***/

/**
 * PG end-to-end: what a policy decides, and where.
 *
 * As in Gel:
 * - an unconditional `deny` on select, update or delete leaves nothing to
 *   read, update or delete (no error); on insert, each object the statement
 *   inserts fails with "access policy violation on insert of <Type>";
 * - a condition is decided for each object by its SQL: never in memory, where
 *   a global compared as a boolean, or a guard requiring the globals it reads,
 *   would decide it wrongly;
 * - an insert or update write check sees the object's links as the statement
 *   leaves them, including the multi-link rows it writes;
 * - a policy inherited from an abstract type may follow a backlink whose link
 *   points at that abstract type.
 *
 * Requires PostgreSQL — set DISC_PG_AUTO=1 or DISC_PG_TEST_URL.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { EdgeQLParser } from "../edgeql/parser.ts";
import type { AccessContext } from "../access/types.ts";
import type { ConnectionPool } from "../lib/connection-pool.ts";
import { SchemaManager } from "../migration/schema-manager.ts";
import { canRunPgTests, getTestDsn, makePool } from "../tests/pg-test-harness.ts";
import { SQLCodeGenerator } from "./codegen.ts";
import { EdgeQLCompiler } from "./compiler.ts";
import type { Schema } from "./context.ts";

const RUN_PG = canRunPgTests();

const SDL = `module default {
  type AcdNoDelete {
    required name: str;
    access policy open {
      allow all;
    };
    access policy no_delete {
      deny delete;
    };
    access policy no_update {
      deny update;
    };
  }
  type AcdNoInsert {
    required name: str;
    access policy open {
      allow all;
    };
    access policy no_insert {
      deny insert;
      errmessage := 'no inserts';
    };
  }
  type AcdHidden {
    required name: str;
    access policy open {
      allow all;
    };
    access policy hide {
      deny select;
    };
  }
  type AcdRole {
    required name: str;
    access policy not_guests {
      allow all;
      using (global current_role != 'guest');
    };
  }
  type AcdPublic {
    required name: str;
    public: bool;
    owner: uuid;
    access policy visible {
      allow select;
      using (.public ?= true or .owner ?= global current_user);
    };
  }
  type AcdTag {
    required name: str;
  }
  type AcdTagged {
    required name: str;
    multi tags: AcdTag;
    access policy tagged {
      allow all;
      using (exists .tags);
    };
  }
  type AcdLabelled {
    required name: str;
    multi tags: AcdTag;
    access policy t1_only {
      allow all;
      using ('t1' in .tags.name);
    };
  }
  abstract type AcdOwned {
    required name: str;
    access policy referenced {
      allow all;
      using (exists .<item[is AcdRef].item);
    };
  }
  type AcdThing extending AcdOwned {}
  type AcdRef {
    required label: str;
    item: AcdOwned;
  }
}`;

const TABLES = [
  "acd_no_delete",
  "acd_no_insert",
  "acd_hidden",
  "acd_role",
  "acd_public",
  "acd_tagged_tags",
  "acd_labelled_tags",
  "acd_labelled",
  "acd_tagged",
  "acd_tag",
  "acd_ref",
  "acd_thing",
  "acd_owned"
];

const ID = (n: number): string => `01234567-89ab-7cde-8f01-${n.toString().padStart(12, "0")}`;
const [ANN, THING_1, THING_2] = [ID(1), ID(11), ID(12)];

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
    await pool.query("INSERT INTO acd_no_delete (name) VALUES ('d1')");
    await pool.query("INSERT INTO acd_hidden (name) VALUES ('h1')");
    await pool.query("INSERT INTO acd_role (name) VALUES ('r1')");
    await pool.query(`INSERT INTO acd_public (name, public, owner) VALUES ('pub', true, NULL), ('ann', false, '${ANN}'), ('other', false, NULL)`);
    await pool.query("INSERT INTO acd_tag (name) VALUES ('t1'), ('t2')");
    await pool.query(`INSERT INTO acd_thing (id, name) VALUES ('${THING_1}', 'thing-1'), ('${THING_2}', 'thing-2')`);
    await pool.query(`INSERT INTO acd_ref (label, item_id) VALUES ('ref', '${THING_1}')`);
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

/*** Compile `edgeql` for `context`, with every type's policies registered the way the server does. ***/
function compileFor(edgeql: string, schema: Schema, context: AccessContext): string {
  const compiler = new EdgeQLCompiler(schema, {
    accessConfig: { defaultAllow: true, enableAudit: false, enableRLS: true, mode: "permissive" },
    accessContext: context,
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

/*** Run `edgeql` for `context`; the single column of its rows, sorted. ***/
async function run(pool: ConnectionPool, schema: Schema, edgeql: string, context: AccessContext = { userId: ANN }): Promise<unknown[]> {
  const rows = (await pool.query(compileFor(edgeql, schema, context))).rows as Record<string, unknown>[];
  return rows
    .map(row => {
      const value = Object.values(row)[0];
      return typeof value === "bigint" ? Number(value) : value;
    })
    .sort();
}

/*** Run `edgeql` and expect Gel's access policy violation (SQLSTATE 42501), with `message`. ***/
async function assertViolation(pool: ConnectionPool, schema: Schema, message: string, edgeql: string): Promise<void> {
  const error = await assertRejects(() => run(pool, schema, edgeql)) as Error & { fields?: { code?: string; }; };
  assertStringIncludes(error.message, message);
  assertEquals(error.fields?.code, "42501", error.message);
}

async function column(pool: ConnectionPool, sql: string): Promise<unknown[]> {
  return (await pool.query(sql)).rows.map(row => Object.values(row)[0]).sort();
}

Deno.test({
  name: "PG access policy decisions: an unconditional deny on update or delete modifies nothing, without an error",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select AcdNoDelete.name"), ["d1"]);
      assertEquals(await run(pool, schema, "delete AcdNoDelete"), []);
      assertEquals(await run(pool, schema, "update AcdNoDelete set { name := 'changed' }"), []);
      assertEquals(await column(pool, "SELECT name FROM acd_no_delete"), ["d1"]);
    })
});

Deno.test({
  name: "PG access policy decisions: an unconditional deny on select leaves nothing to read",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select AcdHidden.name"), []);
      assertEquals(await run(pool, schema, "select count(AcdHidden)"), [0]);
    })
});

Deno.test({
  name: "PG access policy decisions: an unconditional deny on insert fails each inserted object with an access policy violation",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await assertViolation(pool, schema, "access policy violation on insert of default::AcdNoInsert (no inserts)", "insert AcdNoInsert { name := 'x' }");
      assertEquals(await column(pool, "SELECT name FROM acd_no_insert"), []);
    })
});

Deno.test({
  name: "PG access policy decisions: a comparison of a global is decided by its value, not as a boolean",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select AcdRole.name", { userRole: "admin" }), ["r1"]);
      assertEquals(await run(pool, schema, "select AcdRole.name", { userRole: "guest" }), []);
      await run(pool, schema, "insert AcdRole { name := 'r2' }", { userRole: "admin" });
      assertEquals(await column(pool, "SELECT name FROM acd_role"), ["r1", "r2"]);
    })
});

Deno.test({
  name: "PG access policy decisions: a condition reading current_user holds for an anonymous caller where its SQL does",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select AcdPublic.name", {}), ["other", "pub"]);
      assertEquals(await run(pool, schema, "select AcdPublic.name"), ["ann", "pub"]);
    })
});

Deno.test({
  name: "PG access policy decisions: a write check sees the multi-link rows the statement writes",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      await run(pool, schema, "insert AcdTagged { name := 'a', tags := (select AcdTag filter .name = 't1') }");
      await assertViolation(pool, schema, "access policy violation on insert of default::AcdTagged", "insert AcdTagged { name := 'b' }");
      assertEquals(await run(pool, schema, "select AcdTagged.name"), ["a"]);

      // Replacing the tags keeps the object tagged; removing them all does not.
      await run(pool, schema, "update AcdTagged filter .name = 'a' set { tags := (select AcdTag filter .name = 't2') }");
      assertEquals(await run(pool, schema, "select AcdTagged.tags.name"), ["t2"]);
      await assertViolation(pool, schema, "access policy violation on update of default::AcdTagged", "update AcdTagged filter .name = 'a' set { tags := {} }");
      await assertViolation(
        pool,
        schema,
        "access policy violation on update of default::AcdTagged",
        "update AcdTagged filter .name = 'a' set { tags -= (select AcdTag filter .name = 't2') }"
      );
      await run(pool, schema, "update AcdTagged filter .name = 'a' set { tags += (select AcdTag filter .name = 't1') }");
      assertEquals(await run(pool, schema, "select AcdTagged.tags.name"), ["t1", "t2"]);

      // A condition reading the linked objects' properties through the new links.
      await run(pool, schema, "insert AcdLabelled { name := 'l', tags := (select AcdTag filter .name = 't1') }");
      await assertViolation(
        pool,
        schema,
        "access policy violation on insert of default::AcdLabelled",
        "insert AcdLabelled { name := 'm', tags := (select AcdTag filter .name = 't2') }"
      );
      await assertViolation(
        pool,
        schema,
        "access policy violation on update of default::AcdLabelled",
        "update AcdLabelled set { tags := (select AcdTag filter .name = 't2') }"
      );
      assertEquals(await column(pool, "SELECT name FROM acd_labelled"), ["l"]);
    })
});

Deno.test({
  name: "PG access policy decisions: a policy inherited from an abstract type follows a backlink whose link targets it",
  ignore: !RUN_PG,
  fn: () =>
    withSchema(async (pool, schema) => {
      assertEquals(await run(pool, schema, "select AcdThing.name"), ["thing-1"]);
      assertEquals(await run(pool, schema, "select AcdOwned.name"), ["thing-1"]);
      await run(pool, schema, "update AcdThing set { name := .name ++ '!' }");
      assertEquals(await column(pool, "SELECT name FROM acd_thing"), ["thing-1!", "thing-2"]);
    })
});
